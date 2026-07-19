// Address watcher (Unit 8, docs/NOTIFICATION-PLAN.md §3) — the single largest
// piece of net-new plumbing in the notification plan. It is the first and only
// consumer of ElectrumClient.subscribeScripthash().
//
// What it does:
//   • On startup (and whenever refreshWatches() is called after a wallet or
//     multisig is created), it derives every address in each wallet's current
//     gap-limit window (receive + change) and subscribes to its scripthash over
//     Electrum, remembering scripthash → { kind, walletId, userId, address }.
//   • On a 'scripthash' change event, it fetches that address's history and
//     diffs the txids against the notified_txids table (db.ts). A genuinely new
//     txid → tx_received (and tx_large when its inbound value clears the user's
//     configured threshold). The table means a server restart never re-notifies
//     for transactions that predate this feature.
//   • On each new block ('header'), it re-checks every not-yet-confirmed
//     notified txid's confirmation count against the user's threshold and fires
//     one tx_confirmed when it crosses.
//
// Everything here is best-effort: a derivation, network, or DB error for one
// address/wallet is logged and skipped, never thrown — this runs in the
// background and must never take the process down.
//
// Started once from hooks.server.ts. It pins the ElectrumClient it starts with
// (like the SSE endpoint) and re-attaches on reconfigureChain via refreshWatches.

import { db, withTransaction } from './db';
import { getChain } from './chain/index';
import { parseXpub, deriveAddress, addressToScripthash, scriptPubKeyHex } from './bitcoin/xpub';
import { createMultisigDeriver } from './bitcoin/multisig';
import { GAP_LIMIT } from './bitcoin/gapLimitScanner';
import { toMultisigConfig, type MultisigRow, type MultisigKeyRow } from './wallets/multisig';
import { notify } from './notifications';
import { escalateBackupNudge, BACKUP_NUDGE_BUCKET } from './backups';
import { publish as livePublish } from './liveHub';
import { verifyTxInclusion, parseBlockHeader, blockHash, meetsTarget, bitsToTarget } from './bitcoin/spv';
import type { BlockHeader } from './bitcoin/spv';
import { childLogger } from './logger';
import type { ChainService } from './chain/index';
import type { ElectrumHeader, ElectrumHistoryItem } from './electrum/client';
import type { ElectrumPool } from './electrum/pool';

const log = childLogger('notify:txwatch');

// The FLOOR of how many addresses to watch per chain (receive/change). For a
// never-scanned wallet we watch this fixed window from index 0. For a wallet that
// HAS been scanned, watchDepthFor() raises the per-chain depth to cover the whole
// scanned set (highest used index + GAP_LIMIT) — see the cairn-wcxw fix below.
//
// Before that fix this was a FIXED window from index 0, so a wallet with more than
// WATCH_WINDOW used addresses on one chain had live addresses beyond index 30 that
// were never subscribed: a deposit there fired no scripthash event (a live
// notification miss) and — once dirty-tracking keys off scripthash events — would
// never mark the wallet dirty (a false-clean stale-balance bug). Making the watch
// set a strict function of the scan set is a PREREQUISITE for the dirty signal
// being sound, not a bonus.
const WATCH_WINDOW = 30;

// Confirmation thresholds. tx_confirmed fires once a watched tx reaches the
// first threshold; a per-user override can live in notification_preferences
// (config.confirmations) later — for now this is the default from §3 ([1,6],
// we fire on the first: 1 confirmation).
const CONFIRM_THRESHOLD = 1;

// cairn-ieilg: with CONFIRM_THRESHOLD = 1, a payment can fire tx_confirmed and
// then be REORGED OUT one block later — and a row excluded from the block scan
// the moment confirmed=1 would keep its stale "Payment received" (and the
// inflated balance) forever. So recently-confirmed rows stay in the scan for a
// bounded window: any 'notified' row whose confirmed_height is within this many
// blocks of the current tip is still re-checked, and a disappearance routes
// through the same reconcileDisappeared correction as an unconfirmed vanish.
// 6 blocks ≈ the conventional "settled" depth; deeper reorgs are chain-level
// emergencies no per-wallet watcher can honestly paper over.
const REORG_RECHECK_DEPTH = 6;

// How often to re-enumerate wallets and pick up newly created ones. See
// startAddressWatcher for why this is a poll rather than a wallet-creation hook.
const REFRESH_INTERVAL_MS = 5 * 60_000;

// How many recently observed tip headers to keep for the self-calibrating
// difficulty floor (cairn-8kbw). ~144 is a day of mainnet blocks — plenty to
// smooth over normal difficulty-adjustment swings while still being cheap.
const TIP_CACHE_SIZE = 144;

// A header's own bits are self-consistent by definition (that's what
// meetsTarget checks) — that alone only proves SOME real hashpower was spent,
// not "at current difficulty". This factor caps how much easier than the
// hardest recently observed tip a header may claim to be before SPV
// verification refuses to trust it against a live single Electrum server, and
// also gates which new tips are admitted into the cache in the first place, so
// one bad tip can't drag the floor down for the ones after it. 4x is loose
// enough to ride out normal retargets (mainnet retargets by at most 4x in
// either direction every 2016 blocks) while still making casual forgery cost
// real mining work.
const DIFFICULTY_FLOOR_FACTOR = 4n;

type WalletKind = 'wallet' | 'multisig';

interface Watched {
	kind: WalletKind;
	walletId: number;
	userId: number;
	address: string;
}

interface WatchState {
	/** scripthash → the address it belongs to. */
	byScripthash: Map<string, Watched>;
	electrum: ElectrumPool | null;
	onScripthash: ((sh: string, status: string | null) => void) | null;
	onHeader: ((header: ElectrumHeader) => void) | null;
	started: boolean;
	/** True once the startup baseline pass has completed (even partially), so
	 *  scripthash changes that fire during startup don't notify for old txs. */
	baselined: boolean;
	/** Scripthashes whose pre-existing history has been successfully recorded
	 *  (confirmed=1, no notification). A scripthash NOT in this set must never be
	 *  treated as live by handleScripthashChange — a mid-scan Electrum drop
	 *  (cairn-u7bw) used to leave addresses un-baselined behind the single global
	 *  flag, so their real old txids flooded out as "payment received" +
	 *  "transaction confirmed" (cairn-3bt1). */
	baselinedScripthashes: Set<string>;
	/** In-flight change handling per scripthash, so overlapping notifications for
	 *  the same address don't double-process. Keyed to the specific `Watched`
	 *  object reference the in-flight handler captured at entry (not just the
	 *  scripthash string) — cairn-1hb0: when the SAME scripthash is reused
	 *  across a delete+recreate (or an xpub shared by two wallets), a handler
	 *  still winding down for the OLD owner must not clear a NEW handler's
	 *  in-flight marker out from under it just because the map key matches. The
	 *  object identity doubles as a lightweight per-ownership generation token —
	 *  refreshWatches installs a fresh `Watched` object whenever ownership
	 *  changes (see the subscribe loop below), so an old and new owner never
	 *  share a reference even though their scripthash key does. */
	inFlight: Map<string, Watched>;
	/** Best known chain-tip height, updated on every 'header' event. Used as the
	 *  upper bound for SPV proofs (reject a tx claiming a height above the tip). */
	tipHeight: number;
	/** Rolling cache of the last ~TIP_CACHE_SIZE headers this watcher has itself
	 *  observed and accepted straight off the live Electrum header stream:
	 *  height → { blockHash, expanded target }. This is the self-calibrating
	 *  difficulty floor for cairn-8kbw — verifyTxInclusion's own-bits PoW check
	 *  proves a header is internally self-consistent, not that it reflects real
	 *  network difficulty; a proof for a height we've directly observed is
	 *  pinned to that exact hash, and a proof for any other height must clear
	 *  DIFFICULTY_FLOOR_FACTOR × the hardest target we've actually seen. */
	tipCache: Map<number, { hash: string; target: bigint }>;
}

const state: WatchState = {
	byScripthash: new Map(),
	electrum: null,
	onScripthash: null,
	onHeader: null,
	started: false,
	baselined: false,
	baselinedScripthashes: new Set(),
	inFlight: new Map(),
	tipHeight: 0,
	tipCache: new Map()
};

// ---------------------------------------------------------------- scan progress

export interface WatcherScanProgress {
	/** startAddressWatcher() has been called (scan begins ~10s later). */
	started: boolean;
	/** The startup baseline pass has completed at least once. */
	baselined: boolean;
	/** Addresses currently watched across all wallets. */
	totalAddresses: number;
	/** Watched addresses whose history has been recorded (baselined). */
	scannedAddresses: number;
}

/**
 * True when the watcher currently holds a LIVE subscription for at least one
 * address of this wallet/multisig — i.e. the dirty-tracking signal is active for
 * it, so a CLEAN `dirty_since` can be trusted as "provably unchanged on-chain".
 * Requires the watcher to be started, past its baseline pass, attached to an
 * Electrum pool, and to have this (kind, walletId) in its scripthash map. Gates
 * walletSync.sendSnapshot's send-page fast path (cairn-g1u2): if the wallet isn't
 * being watched, nothing would flip it dirty, so the send load must re-scan live
 * rather than trust a possibly-stale clean flag. O(watched addresses); called only
 * before the (far more expensive) live-scan fallback it may avoid.
 */
export function isWalletWatched(kind: WalletKind, walletId: number): boolean {
	if (!state.started || !state.baselined || !state.electrum) return false;
	for (const w of state.byScripthash.values()) {
		if (w.walletId === walletId && w.kind === kind) return true;
	}
	return false;
}

/**
 * Live view of the initial address-history scan, read by the first-sync
 * screen (cairn-koy4.11). Observation only. baselinedScripthashes can retain
 * entries for scripthashes dropped from the watch set (client swap), so the
 * scanned count is clamped to the current total.
 */
export function getWatcherScanProgress(): WatcherScanProgress {
	let scanned = 0;
	for (const sh of state.byScripthash.keys()) {
		if (state.baselinedScripthashes.has(sh)) scanned++;
	}
	return {
		started: state.started,
		baselined: state.baselined,
		totalAddresses: state.byScripthash.size,
		scannedAddresses: scanned
	};
}

// ------------------------------------------------------------- address enumeration

interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	xpub: string;
}

/**
 * Per-chain watch depth for a wallet/multisig (cairn-wcxw). Returns how many
 * addresses to subscribe on [receive, change]. For a wallet that has a persisted
 * snapshot, this is `highestUsedIndex + GAP_LIMIT + 1` per chain — exactly the
 * scanner's own forward window (gapLimitScanner trims to `lastUsed + GAP_LIMIT`),
 * so the watch set covers the scan set and no live address is left unsubscribed.
 * Floored at WATCH_WINDOW so a brand-new / never-scanned wallet still watches the
 * first 30. Reads the snapshot JSON directly (no walletSync import → no cycle);
 * any parse/shape hiccup falls back to the floor, which is safe (the periodic
 * refresh re-derives it once the next scan lands). Both snapshot shapes carry
 * `{ index, used }` with a chain discriminator (`change` boolean for single-sig,
 * `chain` 0|1 for multisig).
 */
function watchDepthFor(kind: WalletKind, walletId: number): [number, number] {
	const maxUsed: [number, number] = [-1, -1];
	try {
		const row = db
			.prepare('SELECT snapshot FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?')
			.get(kind, walletId) as { snapshot: string } | undefined;
		if (row) {
			const snap = JSON.parse(row.snapshot) as {
				scan?: { addresses?: { index?: number; change?: boolean; used?: boolean }[] };
				detail?: { addresses?: { index?: number; chain?: number; used?: boolean }[] };
			};
			const addrs =
				kind === 'wallet'
					? (snap.scan?.addresses ?? []).map((a) => ({
							index: a.index,
							chain: a.change ? 1 : 0,
							used: a.used
						}))
					: (snap.detail?.addresses ?? []).map((a) => ({
							index: a.index,
							chain: a.chain === 1 ? 1 : 0,
							used: a.used
						}));
			for (const a of addrs) {
				if (a.used && typeof a.index === 'number' && a.index > maxUsed[a.chain]) {
					maxUsed[a.chain] = a.index;
				}
			}
		}
	} catch (e) {
		log.debug({ err: e, kind, walletId }, 'watch-depth read failed; using floor');
	}
	return [
		Math.max(WATCH_WINDOW, maxUsed[0] + GAP_LIMIT + 1),
		Math.max(WATCH_WINDOW, maxUsed[1] + GAP_LIMIT + 1)
	];
}

/** Derive the watched addresses (receive + change) for one single-sig wallet. */
function walletAddresses(row: WalletRow): Watched[] {
	const out: Watched[] = [];
	let parsed;
	try {
		parsed = parseXpub(row.xpub);
	} catch (e) {
		log.warn({ err: e, walletId: row.id }, 'skip wallet: xpub parse failed');
		return out;
	}
	const depth = watchDepthFor('wallet', row.id);
	for (const change of [0, 1] as const) {
		for (let i = 0; i < depth[change]; i++) {
			try {
				const { address } = deriveAddress(parsed, change, i);
				out.push({ kind: 'wallet', walletId: row.id, userId: row.user_id, address });
			} catch {
				// A single bad index shouldn't abort the wallet.
			}
		}
	}
	return out;
}

/** Derive the watched addresses (receive + change) for one multisig wallet. */
function multisigAddresses(multisig: MultisigRow): Watched[] {
	const out: Watched[] = [];
	let config;
	try {
		config = toMultisigConfig(multisig);
	} catch (e) {
		log.warn({ err: e, multisigId: multisig.id }, 'skip multisig: config build failed');
		return out;
	}
	// One deriver for the whole wallet: resolve/validate once, hoist the chain nodes,
	// then derive every watched index off that shared state (cairn-8ubd) instead of
	// re-parsing all N cosigner xpubs per address.
	//
	// cairn-zltwz part (a): this used to run OUTSIDE any try/catch. enumerateAll's
	// per-multisig loop has no per-iteration guard of its own — it relies entirely
	// on multisigAddresses() to contain a bad wallet's failure — so an uncaught
	// throw here (e.g. a key encoded for the wrong network after a chain
	// reconfigure) propagated up through the `for (const m of multisigRows)` loop
	// and was caught by enumerateAll's OUTER try/catch, which aborts the whole
	// multisig pass: every multisig wallet after the bad one in iteration order
	// silently lost its watch subscriptions. Catching it here, like the
	// toMultisigConfig call just above, means one bad wallet is skipped —
	// everyone else keeps their watches.
	let deriver;
	try {
		deriver = createMultisigDeriver(config);
	} catch (e) {
		log.warn(
			{ err: e, multisigId: multisig.id, name: multisig.name },
			'skip multisig: deriver creation failed'
		);
		return out;
	}
	const depth = watchDepthFor('multisig', multisig.id);
	for (const change of [0, 1] as const) {
		for (let i = 0; i < depth[change]; i++) {
			try {
				const { address } = deriver.deriveAddress(change, i);
				out.push({ kind: 'multisig', walletId: multisig.id, userId: multisig.userId, address });
			} catch {
				// Skip a bad index.
			}
		}
	}
	return out;
}

interface MultisigDbRow {
	id: number;
	user_id: number;
	name: string;
	threshold: number;
	script_type: string;
	receive_cursor: number;
	created_at: string;
}

/** Yield to the event loop so a queued HTTP request can interleave between batches. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Enumerate every watched address across every wallet and multisig, all users.
 *
 * Each wallet/multisig runs ~60 synchronous EC derivations; without yielding,
 * the whole (W + M) pass hogs the single-threaded event loop and stalls any
 * in-flight HTTP request (see load test Scenario 5). We yield once per
 * wallet/multisig batch so requests can interleave between batches. Because we
 * now read the desired set across multiple event-loop turns it is no longer an
 * atomic snapshot, but refreshWatches' subscribe/unsubscribe diffing already
 * tolerates eventual consistency (5-min refresh cadence).
 */
async function enumerateAll(): Promise<Watched[]> {
	const all: Watched[] = [];

	try {
		const wallets = db
			.prepare('SELECT id, user_id, name, xpub FROM wallets')
			.all() as unknown as WalletRow[];
		for (const w of wallets) {
			all.push(...walletAddresses(w));
			await yieldToEventLoop();
		}
	} catch (e) {
		log.error({ err: e }, 'failed to enumerate single-sig wallets');
	}

	try {
		const multisigRows = db
			.prepare('SELECT * FROM multisigs')
			.all() as unknown as MultisigDbRow[];

		// Batch the per-multisig keys lookup into one query (was an N+1 pattern).
		const keysByMultisig = new Map<number, Record<string, unknown>[]>();
		const allKeys = db
			.prepare('SELECT * FROM multisig_keys ORDER BY multisig_id, position')
			.all() as Record<string, unknown>[];
		for (const k of allKeys) {
			const mid = k.multisig_id as number;
			let bucket = keysByMultisig.get(mid);
			if (!bucket) {
				bucket = [];
				keysByMultisig.set(mid, bucket);
			}
			bucket.push(k);
		}

		for (const m of multisigRows) {
			const keys = keysByMultisig.get(m.id) ?? [];
			const multisig: MultisigRow = {
				id: m.id,
				userId: m.user_id,
				name: m.name,
				threshold: m.threshold,
				scriptType: m.script_type as MultisigRow['scriptType'],
				receiveCursor: m.receive_cursor,
				createdAt: m.created_at,
				keys: keys.map(mapKeyRow)
			};
			all.push(...multisigAddresses(multisig));
			await yieldToEventLoop();
		}
	} catch (e) {
		log.error({ err: e }, 'failed to enumerate multisigs');
	}

	return all;
}

function mapKeyRow(r: Record<string, unknown>): MultisigKeyRow {
	return {
		id: r.id as number,
		multisigId: r.multisig_id as number,
		position: r.position as number,
		name: r.name as string,
		category: r.category as MultisigKeyRow['category'],
		deviceType: (r.device_type ?? null) as MultisigKeyRow['deviceType'],
		xpub: r.xpub as string,
		fingerprint: r.fingerprint as string,
		path: r.path as string,
		lastVerifiedAt: (r.last_verified_at ?? null) as string | null,
		assignedUserId: (r.assigned_user_id ?? null) as number | null
	};
}

// ------------------------------------------------------------- notified-txid store

/**
 * Has a user-facing notification (tx_received / tx_confirmed) already been raised
 * for this (kind, wallet, user, txid)? A row whose status is 'pending' does NOT
 * count: that is an unconfirmed inbound the watcher is only TRACKING (so it can
 * later detect a double-spend / RBF-away, cairn-a2p1) and has intentionally not
 * surfaced yet, so the SPV-gated tx_received must still be allowed to fire once
 * the tx confirms. A NULL status (legacy / baselined row) or any non-pending
 * status suppresses, exactly as the pre-cairn-a2p1 row-existence check did.
 */
function alreadyNotified(
	kind: WalletKind,
	walletId: number,
	userId: number,
	txid: string
): boolean {
	const row = db
		.prepare(
			'SELECT status FROM notified_txids WHERE wallet_kind = ? AND wallet_id = ? AND user_id = ? AND txid = ?'
		)
		.get(kind, walletId, userId, txid) as { status: string | null } | undefined;
	return row !== undefined && row.status !== 'pending';
}

/**
 * Claim the tx_received notification for a confirmed, SPV-verified inbound.
 * Inserts a fresh 'notified' row, OR transitions an existing 'pending' tracking
 * row (cairn-a2p1) to 'notified' — returning true in BOTH those cases (this call
 * is the one that should fire the notification). Returns false when a non-pending
 * row already exists (another handler won the race, or it was already notified),
 * so the caller suppresses a duplicate. amount_sats is only written when known
 * (> 0), never overwriting a prior tracked value with null.
 */
function claimReceived(w: Watched, txid: string, amountSats: number | null): boolean {
	try {
		const res = db
			.prepare(
				`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
				 VALUES (?, ?, ?, ?, 0, 'notified', ?)
				 ON CONFLICT(wallet_kind, wallet_id, user_id, txid) DO UPDATE SET
				   status = 'notified',
				   amount_sats = COALESCE(excluded.amount_sats, notified_txids.amount_sats)
				 WHERE notified_txids.status = 'pending'`
			)
			.run(w.kind, w.walletId, w.userId, txid, amountSats);
		return res.changes > 0;
	} catch (e) {
		log.error({ err: e, walletId: w.walletId, txid }, 'failed to record notified txid');
		return false;
	}
}

/**
 * Track an UNCONFIRMED inbound sighting so a later disappearance (double-spend /
 * RBF'd away) can be detected (cairn-a2p1) WITHOUT surfacing a user-facing
 * "payment received" — the SPV gate still defers that until the tx confirms.
 * Idempotent (skips a txid already tracked or notified) and value-gated (only a
 * genuine credit to this wallet is worth tracking). The getTx round-trip to value
 * the output is only paid on the FIRST sighting of a given txid.
 */
async function trackPendingInbound(scripthash: string, w: Watched, txid: string): Promise<void> {
	// Already tracked or already handled? Any existing row → nothing to do here.
	const existing = db
		.prepare(
			'SELECT 1 FROM notified_txids WHERE wallet_kind = ? AND wallet_id = ? AND user_id = ? AND txid = ?'
		)
		.get(w.kind, w.walletId, w.userId, txid);
	if (existing) return;

	let receivedSats = 0;
	try {
		const tx = await getChain().getTx(txid);
		const walletScripts = walletScriptSet(w);
		for (const out of tx.vout) {
			if (out.scriptPubKey && walletScripts.has(out.scriptPubKey.toLowerCase()))
				receivedSats += out.value;
		}
	} catch {
		// Can't value it (mempool tx unfetchable / detail hiccup) — don't track a
		// zero-value guess; a later change event retries.
		return;
	}
	if (receivedSats <= 0) return; // not a credit to us (change / own-spend / foreign)

	// cairn-mo36 liveness recheck: the wallet may have been deleted during the
	// getTx await. Every removal path clears state.byScripthash synchronously.
	if (!state.byScripthash.has(scripthash)) return;

	try {
		db.prepare(
			`INSERT OR IGNORE INTO notified_txids
			   (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES (?, ?, ?, ?, 0, 'pending', ?)`
		).run(w.kind, w.walletId, w.userId, txid, receivedSats);
	} catch (e) {
		log.error({ err: e, walletId: w.walletId, txid }, 'failed to record pending inbound');
	}
}

/**
 * True when the wallet/multisig `w` refers to still has a DB row backing it.
 * Belt-and-braces guard (cairn-uzgu / cairn-gakd Phase 1) for handleScripthashChange:
 * refreshWatches' desired-vs-current diff and deleteWallet/deleteMultisig's
 * unwatch calls are the normal ways a stale entry gets dropped from
 * state.byScripthash, but a delete path that bypasses both (e.g. account
 * deletion's FK cascade, which never touches this module) can still leave one
 * lingering until the next periodic refresh. This check stops that lingering
 * entry from ever notifying in the meantime. Fails closed on a query error —
 * treated the same as "gone" — since a missed notification is far cheaper
 * than one that deep-links to a 404, and the entry simply re-baselines on the
 * next refresh if the wallet is actually still there.
 */
function walletStillExists(w: Watched): boolean {
	try {
		const table = w.kind === 'multisig' ? 'multisigs' : 'wallets';
		const row = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(w.walletId);
		return row !== undefined;
	} catch (e) {
		log.warn(
			{ err: e, walletId: w.walletId, kind: w.kind },
			'existence check failed; treating as deleted'
		);
		return false;
	}
}

// --------------------------------------------------------------------- helpers

/** A wallet-relative name for the notification body (best-effort, plain). */
function walletLabel(w: Watched): string {
	try {
		const table = w.kind === 'multisig' ? 'multisigs' : 'wallets';
		const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(w.walletId) as
			| { name: string }
			| undefined;
		return row?.name ?? (w.kind === 'multisig' ? 'your multisig wallet' : 'your wallet');
	} catch {
		return w.kind === 'multisig' ? 'your multisig wallet' : 'your wallet';
	}
}

/** Relative deep-link to the wallet the tx landed in. */
function walletLink(w: Watched): string {
	return w.kind === 'multisig' ? `/wallets/multisig/${w.walletId}` : `/wallets/${w.walletId}`;
}

/** The user's large-tx threshold in sats for tx_large, or null when unset. */
function largeThresholdSats(userId: number): number | null {
	try {
		const row = db
			.prepare(
				`SELECT config FROM notification_preferences
				  WHERE user_id = ? AND event_type = 'tx_large' AND channel = 'inapp'`
			)
			.get(userId) as { config: string | null } | undefined;
		if (!row?.config) return null;
		const parsed = JSON.parse(row.config) as { thresholdSats?: unknown };
		const t = Number(parsed.thresholdSats);
		return Number.isFinite(t) && t > 0 ? t : null;
	} catch {
		return null;
	}
}

function formatBtc(sats: number): string {
	return `${(sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} BTC`;
}

// ------------------------------------------------------------------------- SPV
//
// Before raising ANY payment notification off an Electrum-reported transaction,
// independently prove the tx really is confirmed in a proof-of-work-valid block
// (cairn-7zj6). A hostile or buggy server can otherwise invent a txid and Cairn
// would fire a "payment received" alert for a transaction that never existed.
// Forging the proof would require mining a real block at current difficulty.

/** Best-known tip height, falling back to a live tip fetch the first time. */
async function tipHeightNow(chain: ChainService): Promise<number> {
	if (state.tipHeight > 0) return state.tipHeight;
	try {
		const tip = await chain.getTip();
		if (tip.height > 0) state.tipHeight = tip.height;
		return tip.height;
	} catch {
		return 0; // unknown tip → verifyTxInclusion skips only the height-vs-tip check
	}
}

/** The hardest (numerically smallest) target among the cached tips, or 0n if empty. */
function maxCachedTarget(): bigint {
	let max = 0n;
	for (const { target } of state.tipCache.values()) {
		if (target > max) max = target;
	}
	return max;
}

/**
 * Fold a freshly streamed chain-tip header into the difficulty-floor cache
 * (cairn-8kbw). Every header the pool emits already had to satisfy its own
 * `bits` before Electrum would relay it as a tip, but we re-check that here
 * too rather than trusting the emitter — and, once the cache holds anything,
 * also reject a tip whose target is more than DIFFICULTY_FLOOR_FACTOR easier
 * than the hardest tip we've already accepted. That keeps one bad/weak header
 * from dragging the floor down for every proof after it. Purely additive to
 * the cache: a rejected header is just never recorded, never thrown.
 */
function acceptHeaderIntoCache(header: ElectrumHeader | null | undefined): void {
	if (!header || typeof header.height !== 'number' || typeof header.hex !== 'string') return;
	if (!Number.isInteger(header.height) || header.height <= 0) return;

	let parsed: BlockHeader;
	try {
		parsed = parseBlockHeader(header.hex);
	} catch {
		log.warn({ height: header.height }, 'rejected streamed tip header: unparseable');
		return;
	}

	const hash = blockHash(header.hex);
	if (!meetsTarget(hash, parsed.bits)) {
		log.warn({ height: header.height }, 'rejected streamed tip header: fails its own PoW target');
		return;
	}

	const target = bitsToTarget(parsed.bits);
	const priorMax = maxCachedTarget();
	if (priorMax > 0n && target > priorMax * DIFFICULTY_FLOOR_FACTOR) {
		log.warn(
			{ height: header.height, target: target.toString(), priorMax: priorMax.toString() },
			'rejected streamed tip header: target implausibly weak vs recently observed chain'
		);
		return;
	}

	state.tipCache.set(header.height, { hash, target });

	// Prune down to the newest TIP_CACHE_SIZE entries (keyed by height, so a
	// reorg that replaces a cached height simply overwrites it above).
	if (state.tipCache.size > TIP_CACHE_SIZE) {
		const heights = [...state.tipCache.keys()].sort((a, b) => a - b);
		for (let i = 0; i < heights.length - TIP_CACHE_SIZE; i++) {
			state.tipCache.delete(heights[i]);
		}
	}
}

/**
 * True only when `txid` at `height` is provably confirmed: the Electrum server
 * supplies a merkle branch and the block header, and both the header's PoW and
 * the branch check out. On any fetch/verify failure we return false (fail
 * closed: do not notify, do not record — a later event can retry).
 *
 * Checking a header's hash against its own `bits` alone (verifyTxInclusion's
 * base check) only proves internal self-consistency, not real network
 * difficulty — a hostile Electrum server can invent a trivially-easy header
 * and "confirm" a forged tx in milliseconds (cairn-8kbw). Since this watcher
 * has only one Electrum server as its source of truth (ElectrumPool is many
 * sockets to that one server, not independent sources), there's no second feed
 * to cross-check against. Instead we anchor against the live header stream
 * this watcher already consumes (state.tipCache, see acceptHeaderIntoCache):
 * a proof for a height we've directly observed must match that exact block
 * hash; a proof for any other height must clear the difficulty floor
 * calibrated off recently observed real tips. A cold cache (no tips accepted
 * yet — e.g. right at startup, before headersSubscribe's first callback)
 * defers rather than guessing.
 */
async function spvVerifyConfirmed(txid: string, height: number): Promise<boolean> {
	if (height <= 0) return false; // mempool: no inclusion proof is possible yet
	try {
		const chain = getChain();
		const [proof, headerHex, tipHeight] = await Promise.all([
			chain.electrum.getMerkleProof(txid, height, 'background'),
			chain.electrum.getBlockHeader(height, 'background'),
			tipHeightNow(chain)
		]);

		const cached = state.tipCache.get(height);
		if (cached) {
			// We observed this exact height ourselves off the live header stream —
			// the proof's header must be that same block, byte for byte. A mismatch
			// here means either a forged header or a legitimate reorg since we
			// cached it; either way we fail closed (defer, don't blacklist) and the
			// next event retries against fresh data as the cache rolls forward.
			if (blockHash(headerHex) !== cached.hash) {
				log.warn(
					{ txid, height },
					'SPV verification deferred — header does not match the block we independently observed at this height (forged header or reorg)'
				);
				return false;
			}
		} else if (state.tipCache.size === 0) {
			// No calibrated difficulty floor yet at all — don't trust any header's
			// own-bits claim on its own. Defer; headersSubscribe seeds the cache
			// shortly after connect and the next confirmation event retries.
			log.warn({ txid, height }, 'SPV verification deferred — no observed chain tips yet to calibrate against');
			return false;
		}

		const res = verifyTxInclusion({
			txid,
			height,
			proof: { merkle: proof.merkle, pos: proof.pos },
			headerHex,
			tipHeight,
			// Only needed for the not-independently-observed-height path; harmless
			// (redundant with the exact-hash check above) when cached is set.
			maxTarget: cached ? undefined : maxCachedTarget() * DIFFICULTY_FLOOR_FACTOR
		});
		if (!res.ok) {
			log.warn(
				{ txid, height, reason: res.reason },
				'SPV verification failed — not trusting this transaction for a notification'
			);
		}
		return res.ok;
	} catch (e) {
		log.warn({ err: e, txid, height }, 'SPV proof could not be fetched — deferring notification');
		return false;
	}
}

// --------------------------------------------------------- dirty-tracking (wcxw)
//
// Sync engine Phase 1. Electrum's scripthash subscription hands us a STATUS HASH
// that changes iff the address's history changes (new tx, confirmation, reorg,
// RBF). We persist the last-seen status per (wallet, scripthash) and mark the
// OWNING WALLET dirty whenever a fresh status differs from — or is absent versus —
// that baseline, so walletSync can skip re-scanning a wallet whose every watched
// address is unchanged. This runs on BOTH the live 'scripthash' event and the
// subscribe/resubscribe return value (initial subscribe, client swap, and the
// reconnect-after-outage replay), which is what makes reconnect a free
// reconciliation checkpoint rather than a blind full rescan.
//
// Conservative by construction (a false-clean silently shows a stale balance):
//   • ABSENT baseline ⇒ treated as changed ⇒ dirty. We only ever call a wallet
//     clean once we have positively recorded a status we can compare against.
//   • unchanged status ⇒ no-op (the efficiency win: an idle reconnect replay
//     doesn't re-dirty anything).
// Independent of the notification baseline gate (state.baselined): it must run
// during the startup subscribe pass to seed baselines and mark existing wallets
// dirty for their one cold-start scan, and it never notifies.

/** SELECT/UPSERT the per-scripthash status baseline; module-level so the hot
 *  event path doesn't re-prepare on every status change. */
const readStatusStmt = db.prepare(
	'SELECT status FROM scripthash_status WHERE wallet_kind = ? AND wallet_id = ? AND scripthash = ?'
);
const upsertStatusStmt = db.prepare(
	`INSERT INTO scripthash_status (wallet_kind, wallet_id, scripthash, status, updated_at)
	 VALUES (?, ?, ?, ?, ?)
	 ON CONFLICT(wallet_kind, wallet_id, scripthash) DO UPDATE SET
	   status = excluded.status, updated_at = excluded.updated_at`
);
const markDirtyStmt = db.prepare(
	'UPDATE wallet_snapshots SET dirty_since = ? WHERE wallet_kind = ? AND wallet_id = ?'
);

/**
 * Reconcile a freshly observed Electrum status for a watched scripthash against
 * the persisted baseline; on a real change (or absent baseline) update the
 * baseline and mark the owning wallet dirty. Synchronous, best-effort, never
 * throws into the emitter. See the section header for the correctness contract.
 */
function reconcileStatus(scripthash: string, status: string | null): void {
	const w = state.byScripthash.get(scripthash);
	if (!w) return; // not (or no longer) watched — ignore
	// Don't seed baseline/dirty rows for a wallet that's already been deleted: its
	// snapshot + scripthash_status were swept by the delete trigger, and re-inserting
	// here would orphan a row (walletStillExists fails closed, same as the notify path).
	if (!walletStillExists(w)) return;
	try {
		const prior = readStatusStmt.get(w.kind, w.walletId, scripthash) as
			| { status: string | null }
			| undefined;
		// Unchanged status against an EXISTING baseline ⇒ nothing changed on-chain.
		if (prior !== undefined && prior.status === status) return;
		const now = Date.now();
		upsertStatusStmt.run(w.kind, w.walletId, scripthash, status, now);
		// Mark the owning wallet dirty. A no-op (0 rows) for a never-synced wallet
		// with no snapshot row yet — harmless, it already scans by absence.
		markDirtyStmt.run(now, w.kind, w.walletId);
	} catch (e) {
		log.debug({ err: e, walletId: w.walletId, kind: w.kind }, 'status reconcile failed (ignored)');
	}
}

// -------------------------------------------------------------- change handling

/**
 * A watched address's status changed: fetch its history, and for any txid we
 * haven't seen, compute the inbound value to this wallet and notify. We only
 * care about NEW txids (diffed against notified_txids), so a status change that
 * merely reflects a confirmation doesn't re-fire tx_received.
 */
async function handleScripthashChange(scripthash: string): Promise<void> {
	// Until the startup baseline has recorded pre-existing history, ignore change
	// events — otherwise the initial subscribe's status callbacks would notify for
	// transactions that predate this feature.
	if (!state.baselined) return;
	const w = state.byScripthash.get(scripthash);
	if (!w) return;
	// cairn-uzgu / cairn-gakd Phase 1: never notify for a wallet/multisig that no
	// longer exists, and drop the stale subscription from state right here — the
	// belt-and-braces stop for the QA-visible symptom (a 404-deep-link
	// notification) even when a lingering entry hasn't been pruned yet by
	// refreshWatches' diff or an unwatch call. See walletStillExists.
	if (!walletStillExists(w)) {
		state.byScripthash.delete(scripthash);
		state.baselinedScripthashes.delete(scripthash);
		state.inFlight.delete(scripthash);
		releaseSubscription(scripthash);
		return;
	}
	if (state.inFlight.has(scripthash)) return;
	state.inFlight.set(scripthash, w);
	try {
		// Per-scripthash baseline gate (cairn-3bt1): if this address's pre-existing
		// history was never successfully recorded (its startup baseline fetch
		// failed, or it was subscribed after startup), we cannot distinguish old
		// txids from new ones — so baseline it NOW, silently, and stop. The rare
		// cost is one missed notification for a deposit that races the baseline;
		// the alternative was a flood of false "payment received"/"confirmed"
		// notifications for the address's entire real history.
		if (!state.baselinedScripthashes.has(scripthash)) {
			try {
				await baselineScripthash(scripthash, w);
			} catch (e) {
				log.debug({ err: e, walletId: w.walletId }, 'on-demand baseline failed; will retry');
			}
			return;
		}
		const chain = getChain();
		let history: ElectrumHistoryItem[];
		try {
			history = await chain.electrum.getHistory(scripthash, 'background');
		} catch (e) {
			log.warn({ err: e, walletId: w.walletId }, 'history fetch failed');
			return;
		}

		for (const item of history) {
			const txid = item.tx_hash;

			// Unconfirmed (mempool) inbound: the SPV gate can't prove it yet, so we do
			// NOT surface a "payment received" here — that still waits for the
			// confirmed, SPV-verified sighting handled below. But we DO record it as a
			// 'pending' tracking row so a later disappearance from the mempool
			// (double-spent / RBF'd away) can be detected and corrected (cairn-a2p1).
			if (item.height <= 0) {
				await trackPendingInbound(scripthash, w, txid);
				continue;
			}

			if (alreadyNotified(w.kind, w.walletId, w.userId, txid)) continue;

			// SPV gate (cairn-7zj6): only ever notify for a transaction we can
			// independently prove is confirmed in a PoW-valid block. An unconfirmed
			// (mempool) tx can't be proven yet, so we defer — when it confirms, this
			// address's scripthash status changes and this handler re-runs, at which
			// point the proof exists. A confirmed tx that fails verification (a
			// server feeding a forged txid) is skipped WITHOUT recording, so a later
			// legitimate event can still be picked up.
			if (!(await spvVerifyConfirmed(txid, item.height))) continue;

			// Compute the inbound value to THIS wallet's addresses. Attribute a tx to
			// the wallet by scriptPubKey membership, NOT by address string: the chain
			// backend reports addresses in its own network encoding (bcrt1…/tb1… on
			// regtest/testnet) which never equals Cairn's mainnet-derived address
			// strings, silently zeroing every deposit. scriptPubKey is
			// network-independent — same fix as walletScan/multisigScan (cairn-v13r,
			// cairn-j6fv).
			let receivedSats = 0;
			try {
				const tx = await chain.getTx(txid);
				const walletScripts = walletScriptSet(w);
				for (const out of tx.vout) {
					if (out.scriptPubKey && walletScripts.has(out.scriptPubKey.toLowerCase()))
						receivedSats += out.value;
				}
			} catch (e) {
				log.warn({ err: e, txid }, 'tx detail fetch failed; recording without amount');
			}

			// cairn-mo36: re-check liveness immediately before the write, after the
			// last await on this path (getTx above) and with nothing async between
			// this check and recordTxid/notify below. Closes the TOCTOU window where
			// a synchronous delete (deleteWallet/deleteMultisig's unwatch calls, or
			// refreshWatches' periodic prune) lands in one of this handler's earlier
			// awaits (baselineScripthash/getHistory/spvVerifyConfirmed/getTx) after it
			// already passed the top-of-function walletStillExists check. Every
			// removal path clears state.byScripthash synchronously, so this one
			// in-memory check catches all of them without a DB round-trip. The rest
			// of `history` belongs to the same now-gone wallet, so bail out of the
			// whole handler rather than just this txid.
			if (!state.byScripthash.has(scripthash)) return;

			// First sighting (or a pending→notified transition, cairn-a2p1) wins; an
			// already-notified/duplicate row suppresses (guards the reconnect re-emit
			// race). receivedSats===0 keeps any prior tracked amount (COALESCE).
			//
			// cairn-fzqpe: the claim and the notification writes (in-app activity row
			// + external queue rows, all synchronous SQLite inside notify()) commit as
			// ONE transaction. Previously the claim committed first, so a process
			// crash in the microseconds before notify() ran left the txid permanently
			// 'notified' with no alert ever recorded anywhere — a silently lost
			// payment notification (alreadyNotified suppresses every retry). Rolling
			// the claim back on a crash means the next scripthash event simply
			// re-claims and re-notifies. notify()'s internal per-stage catches
			// (cairn-s0p5) still apply: a stage FAILURE never throws, so it never
			// rolls back the claim — only a process death mid-unit does.
			const label = walletLabel(w);
			const link = walletLink(w);
			let wasLarge = false;
			const claimed = withTransaction(() => {
				if (!claimReceived(w, txid, receivedSats > 0 ? receivedSats : null)) return false;

				if (receivedSats > 0) {
					notify({
						type: 'tx_received',
						userId: w.userId,
						level: 'success',
						title: 'Payment received',
						body: `${formatBtc(receivedSats)} received to ${label}.`,
						detail: { txid, amountSats: receivedSats, walletId: w.walletId, walletKind: w.kind },
						link
					});
					const threshold = largeThresholdSats(w.userId);
					if (threshold !== null && receivedSats >= threshold) {
						wasLarge = true;
						notify({
							type: 'tx_large',
							userId: w.userId,
							level: 'info',
							title: 'Large payment received',
							body: `${formatBtc(receivedSats)} received to ${label} — above your large-transaction threshold.`,
							detail: {
								txid,
								amountSats: receivedSats,
								thresholdSats: threshold,
								walletId: w.walletId,
								walletKind: w.kind
							},
							link
						});
					}
				} else {
					// A new txid we couldn't value (detail fetch failed, or it's a spend
					// with no output back to us). Record it so we don't loop, but only
					// surface a generic "activity" note for inbound-looking history.
					notify({
						type: 'tx_received',
						userId: w.userId,
						level: 'info',
						title: 'New wallet activity',
						body: `A new transaction touched ${label}.`,
						detail: { txid, walletId: w.walletId, walletKind: w.kind },
						link
					});
				}
				return true;
			});
			if (!claimed) continue;

			// In-memory / best-effort side effects stay OUTSIDE the transaction: a
			// live nudge can't be rolled back, and none of them belong to the
			// claim+enqueue atomicity contract.
			if (receivedSats > 0) {
				// cairn-gt05.5: an unbacked wallet that just took real money is the
				// highest-value backup-nudge escalation — re-nudge now rather than
				// waiting out a decay window that can run to 90 days. Best-effort and
				// silent (no-ops for single-sig / imported / already-backed-up
				// wallets); see escalateBackupNudge in ./backups.
				escalateBackupNudge(w.userId, w.walletId, BACKUP_NUDGE_BUCKET.FUNDED);
				// Live frame (Wave 2, LIVE-UPDATES-DESIGN.md §3.4): every field is already
				// in hand here — no new DB read on the publish path (§3.1 invariant).
				// User-scoped; the client debounces it into a tag-scoped reload.
				livePublish(
					'wallet',
					{ userId: w.userId },
					{ walletKind: w.kind, walletId: w.walletId, txid, event: 'received', amountSats: receivedSats }
				);
				if (wasLarge) {
					livePublish(
						'wallet',
						{ userId: w.userId },
						{ walletKind: w.kind, walletId: w.walletId, txid, event: 'large', amountSats: receivedSats }
					);
				}
			} else {
				// Unvalued receive path — amountSats omitted (§3.4: publish what's cheaply
				// in hand, add no queries). Still a `received` nudge so the tx list reloads.
				livePublish(
					'wallet',
					{ userId: w.userId },
					{ walletKind: w.kind, walletId: w.walletId, txid, event: 'received' }
				);
			}
		}
	} finally {
		// cairn-1hb0: only clear OUR OWN marker. If this scripthash was reassigned
		// to a new owner (delete+recreate reusing the same xpub/address) while we
		// were awaiting above, refreshWatches already installed a fresh `Watched`
		// object and a NEW handler may already be in flight against it — deleting
		// unconditionally here would clear that new handler's marker out from
		// under it, not ours.
		if (state.inFlight.get(scripthash) === w) state.inFlight.delete(scripthash);
	}
}

/**
 * The scriptPubKey hexes (lowercased) of all watched addresses belonging to the
 * same wallet as `w`. Used to attribute a tx's outputs to the wallet by
 * scriptPubKey rather than by network-dependent address string (cairn-v13r).
 * Small (WATCH_WINDOW × 2), so a linear pass over the map is fine.
 */
function walletScriptSet(w: Watched): Set<string> {
	const set = new Set<string>();
	for (const watched of state.byScripthash.values()) {
		if (watched.kind === w.kind && watched.walletId === w.walletId) {
			try {
				set.add(scriptPubKeyHex(watched.address).toLowerCase());
			} catch {
				// An address we can't re-encode to a scriptPubKey is simply not matched.
			}
		}
	}
	return set;
}

// ---------------------------------------------------------- confirmation pass

interface PendingTxidRow {
	id: number;
	wallet_kind: WalletKind;
	wallet_id: number;
	user_id: number;
	txid: string;
	status: string | null;
	amount_sats: number | null;
	/** 1 once tx_confirmed has fired. Rows re-checked within the reorg window
	 *  (cairn-ieilg) arrive here with confirmed = 1. */
	confirmed: number;
	/** Chain-tip height when `confirmed` flipped to 1; NULL on legacy rows. */
	confirmed_height: number | null;
}

/** A tx-not-found style error from ChainService.getTx — the tx is neither in a
 *  block nor in the mempool. Distinct from a connect/transient failure, which
 *  must NEVER be read as a disappearance. Matches ChainService's "Transaction
 *  not found" message and common backend phrasings. */
function isNotFoundError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /not found|no such|unknown transaction|missing transaction|txn-mempool-conflict/i.test(msg);
}

/** True when this txid is one of OUR OWN outgoing transactions (single-sig or
 *  multisig). Such a txid disappearing is a self-RBF / fee-bump the send flow
 *  already tracks via its superseded lineage — never an inbound "cancelled by the
 *  sender". Fails open (returns false) so a lookup error can't gate a real cancel. */
function isOwnSend(txid: string): boolean {
	try {
		const row = db
			.prepare(
				`SELECT 1 FROM transactions WHERE txid = ?
				 UNION ALL
				 SELECT 1 FROM multisig_transactions WHERE txid = ?
				 LIMIT 1`
			)
			.get(txid, txid);
		return row !== undefined;
	} catch {
		return false;
	}
}

/** Force a fresh wallet/multisig snapshot so a corrected (phantom-inflow-dropped)
 *  balance lands promptly instead of waiting for the next navigation refresh.
 *  Dynamic import avoids a static import cycle (walletSync → wallets →
 *  addressWatcher). Best-effort. */
async function forceSnapshotRefresh(row: PendingTxidRow): Promise<void> {
	try {
		const walletSync = await import('./walletSync');
		if (row.wallet_kind === 'multisig') {
			await walletSync.refreshMultisigSnapshot(row.user_id, row.wallet_id, { force: true });
		} else {
			await walletSync.refreshWalletSnapshot(row.user_id, row.wallet_id, { force: true });
		}
	} catch (e) {
		log.debug({ err: e, walletId: row.wallet_id }, 'balance refresh after replacement failed');
	}
}

/**
 * A tracked inbound txid came back not-found from getTx. Before acting, CONFIRM it
 * is genuinely gone — a single getTx miss can be a transient blip or a no-txindex
 * Core lookup gap for a still-confirmed tx — by re-reading the wallet's watched
 * scripthash histories: only conclude "gone" when at least one history fetch
 * SUCCEEDS and the txid appears in NONE of them. On confirmation:
 *   • mark the row 'replaced' (stops the endless getTx retries), and
 *   • force a balance refresh so the phantom inflow drops out, and
 *   • notify the user ("payment cancelled") — but ONLY for a genuine EXTERNAL
 *     inbound with a known value, and NOT when a replacement unconfirmed tx is
 *     already sitting on the same addresses (an inbound fee-bump that still pays
 *     us surfaces via its own tx_received; a "cancelled" alert then would mislead).
 */
async function reconcileDisappeared(row: PendingTxidRow): Promise<void> {
	// Watched scripthashes for this wallet — the authoritative "does the server
	// still know this tx" cross-check against a false positive.
	const scripthashes: string[] = [];
	for (const [sh, w] of state.byScripthash) {
		if (w.kind === row.wallet_kind && w.walletId === row.wallet_id) scripthashes.push(sh);
	}
	if (scripthashes.length === 0) return; // not tracking this wallet's addresses — can't confirm

	let anyFetched = false;
	let found = false;
	let replacementUnconfirmed = false;
	for (const sh of scripthashes) {
		try {
			const history = await getChain().electrum.getHistory(sh, 'background');
			anyFetched = true;
			for (const it of history) {
				if (it.tx_hash === row.txid) found = true;
				else if (it.height <= 0) replacementUnconfirmed = true;
			}
		} catch {
			// One address's history failed — try the others; only a TOTAL failure
			// (anyFetched stays false) defers the whole decision to a later block.
		}
	}
	if (!anyFetched) return; // Electrum unreachable — retry on a later block
	if (found) return; // still present (confirmed elsewhere / no-txindex miss) — not gone

	// Confirmed gone. It is a USER-FACING cancellation only when it was a genuine
	// external inbound with a known value AND nothing already replaced it on our
	// addresses AND it isn't one of our own sends being bumped. Otherwise it is a
	// SILENT drop ('dropped'): still stop re-checking it and still correct the
	// balance, but never notify and never surface it as a "cancelled" row (an
	// inbound fee-bump that still pays us, or our own self-RBF, must not read as a
	// lost payment). Either terminal status is excluded from the block re-scan.
	const amount = row.amount_sats ?? 0;
	const silent = amount <= 0 || replacementUnconfirmed || isOwnSend(row.txid);
	db.prepare('UPDATE notified_txids SET status = ? WHERE id = ?').run(
		silent ? 'dropped' : 'replaced',
		row.id
	);
	void forceSnapshotRefresh(row);
	if (silent) return;

	const w: Watched = {
		kind: row.wallet_kind,
		walletId: row.wallet_id,
		userId: row.user_id,
		address: ''
	};
	// Live frame (Wave 2, §3.4): the vanished inbound's amount is already on the
	// row; no txid (the tx no longer exists on-chain). Client reloads the wallet.
	livePublish(
		'wallet',
		{ userId: row.user_id },
		{ walletKind: row.wallet_kind, walletId: row.wallet_id, event: 'replaced', amountSats: amount }
	);
	// A row that had already fired tx_confirmed (reorg-window re-check,
	// cairn-ieilg) disappeared AFTER confirming — say so honestly rather than
	// pretending it "never confirmed".
	const wasConfirmed = row.confirmed === 1;
	notify({
		type: 'tx_replaced',
		userId: row.user_id,
		level: 'warn',
		title: wasConfirmed ? 'Confirmed payment reversed' : 'Incoming payment cancelled',
		body: wasConfirmed
			? `A payment of ${formatBtc(amount)} to ${walletLabel(w)} was removed from the chain in a reorganization. Your balance has been updated.`
			: `A payment of ${formatBtc(amount)} to ${walletLabel(w)} was cancelled before it confirmed. Your balance has been updated.`,
		// No txid (the tx no longer exists on-chain — a deep link would 404) and no
		// amountSats key (the amount is stated in the body; a bare +amount in the
		// feed's amount column would misread as a receipt). link goes to the wallet.
		detail: { walletId: row.wallet_id, walletKind: row.wallet_kind, replaced: true },
		link: walletLink(w)
	});
}

/** The recent double-spent/RBF'd-away INBOUND transactions for one wallet, so the
 *  detail page can render a "cancelled" row that reconciles the vanished balance.
 *  Value-gated + capped; never throws. */
export function listReplacedInbound(
	kind: WalletKind,
	walletId: number
): { txid: string; amountSats: number }[] {
	try {
		const rows = db
			.prepare(
				`SELECT txid, amount_sats FROM notified_txids
				  WHERE wallet_kind = ? AND wallet_id = ? AND status = 'replaced' AND amount_sats > 0
				  ORDER BY id DESC LIMIT 20`
			)
			.all(kind, walletId) as { txid: string; amount_sats: number }[];
		return rows.map((r) => ({ txid: r.txid, amountSats: r.amount_sats }));
	} catch {
		return [];
	}
}

/**
 * On each new block, re-check every not-yet-confirmed tracked txid. A tx that
 * reaches CONFIRM_THRESHOLD confirmations fires one tx_confirmed (and flips its
 * `confirmed` flag so it never fires again); a tracked inbound that has VANISHED
 * from the mempool without confirming (double-spent / RBF'd away) is reconciled
 * as 'replaced' with a correcting notification (cairn-a2p1). 'replaced' rows are
 * excluded so a settled cancellation isn't re-checked forever.
 */
async function handleNewBlock(): Promise<void> {
	// Same startup gate as handleScripthashChange (cairn-3bt1): reconnects re-emit
	// the current header, so without this guard a header event arriving mid-
	// baseline would sweep confirmed=0 rows into "Transaction confirmed"
	// notifications before the baseline pass has protected pre-existing history.
	if (!state.baselined) return;
	let pending: PendingTxidRow[];
	try {
		// Two populations (cairn-ieilg): the not-yet-confirmed rows (the original
		// scan), plus RECENTLY-confirmed 'notified' rows still inside the reorg
		// window — those exist purely so a post-confirmation reorg-out is caught
		// and reconciled instead of leaving a stale "Payment received" forever.
		// Legacy confirmed rows (confirmed_height NULL — incl. every baselined
		// row, which also has status NULL) are never re-checked.
		pending = db
			.prepare(
				`SELECT id, wallet_kind, wallet_id, user_id, txid, status, amount_sats,
				        confirmed, confirmed_height
				   FROM notified_txids
				  WHERE (confirmed = 0 AND (status IS NULL OR status IN ('pending', 'notified')))
				     OR (confirmed = 1 AND status = 'notified'
				         AND confirmed_height IS NOT NULL AND confirmed_height > ?)`
			)
			.all(state.tipHeight - REORG_RECHECK_DEPTH) as unknown as PendingTxidRow[];
	} catch (e) {
		log.error({ err: e }, 'confirmation scan query failed');
		return;
	}
	if (pending.length === 0) return;

	const chain = getChain();
	const markConfirmed = db.prepare(
		'UPDATE notified_txids SET confirmed = 1, confirmed_height = ? WHERE id = ?'
	);

	for (const row of pending) {
		try {
			const tx = await chain.getTx(row.txid);

			// Reorg-window re-check of an already-confirmed row (cairn-ieilg): the tx
			// is still fetchable, so nothing disappeared. If it slid back into the
			// mempool (reorged but re-broadcastable) it will simply re-confirm; the
			// already-sent tx_confirmed is not re-fired either way.
			if (row.confirmed === 1) continue;

			if (!tx.confirmed || tx.confirmations < CONFIRM_THRESHOLD) continue;

			// A 'pending' row hasn't surfaced as "received" yet — leave tx_confirmed to
			// a later block, AFTER the scripthash-change handler flips it to 'notified'
			// (firing tx_received), so the user never sees "confirmed" before "received".
			if (row.status === 'pending') continue;

			markConfirmed.run(state.tipHeight, row.id);
			const w: Watched = {
				kind: row.wallet_kind,
				walletId: row.wallet_id,
				userId: row.user_id,
				address: ''
			};
			notify({
				type: 'tx_confirmed',
				userId: row.user_id,
				level: 'success',
				title: 'Transaction confirmed',
				body: `A transaction in ${walletLabel(w)} now has ${tx.confirmations} confirmation${tx.confirmations === 1 ? '' : 's'}.`,
				detail: {
					txid: row.txid,
					confirmations: tx.confirmations,
					walletId: row.wallet_id,
					walletKind: row.wallet_kind
				},
				link: walletLink(w)
			});
			// Live frame (Wave 2, §3.4): amount comes from the tracked row already
			// in hand for this scan — no new DB read. Client debounces into a reload.
			livePublish(
				'wallet',
				{ userId: row.user_id },
				{
					walletKind: row.wallet_kind,
					walletId: row.wallet_id,
					txid: row.txid,
					event: 'confirmed',
					amountSats: row.amount_sats ?? undefined
				}
			);
		} catch (e) {
			// Not-found ⇒ the tx may have vanished (double-spend / RBF'd away): confirm
			// it and reconcile. Any other error (connect/transient) is left for a later
			// block, exactly as before.
			if (isNotFoundError(e)) {
				await reconcileDisappeared(row);
			} else {
				log.debug({ err: e, txid: row.txid }, 'confirmation check skipped');
			}
		}
	}
}

// --------------------------------------------------------------------- lifecycle

/**
 * Drop every scripthash currently watched for one wallet/multisig from local
 * state — byScripthash, baselinedScripthashes, and inFlight. Local-only, no
 * Electrum I/O: unsubscribing the underlying socket-level subscription is
 * Phase 2 (cairn-gakd), so the server may still push a status change for a
 * scripthash we've forgotten — walletStillExists in handleScripthashChange is
 * what makes that harmless once it arrives.
 */
function forgetWatchesFor(kind: WalletKind, walletId: number): number {
	let removed = 0;
	for (const [scripthash, w] of state.byScripthash) {
		if (w.kind === kind && w.walletId === walletId) {
			state.byScripthash.delete(scripthash);
			state.baselinedScripthashes.delete(scripthash);
			state.inFlight.delete(scripthash);
			releaseSubscription(scripthash);
			removed++;
		}
	}
	return removed;
}

/**
 * Release the Electrum-side subscription for a scripthash we've stopped watching
 * (cairn-gakd Phase 2). Fire-and-forget: the local-state removal the callers
 * just did is what actually stops notifications, so this only needs to drop the
 * upstream sub off the primary's resubscribe replay set (and best-effort tell
 * the server), which is what keeps reconnect cost proportional to the CURRENT
 * watch set instead of cumulative wallet churn. Never throws into the caller;
 * unsubscribeScripthash already swallows wire errors, and the catch is belt-and-
 * braces for the no-client / mid-swap window.
 */
function releaseSubscription(scripthash: string): void {
	const electrum = state.electrum;
	if (!electrum) return;
	void electrum
		.unsubscribeScripthash(scripthash)
		.catch((e) => log.debug({ err: e }, 'scripthash unsubscribe failed'));
}

/**
 * Forget a deleted single-sig wallet's watched addresses immediately
 * (cairn-uzgu / cairn-gakd Phase 1). Called from wallets.ts's deleteWallet
 * right after its DB delete succeeds. Synchronous and side-effect-free beyond
 * the local Maps/Sets above, so it's safe to call from a non-async caller.
 */
export function unwatchWallet(walletId: number): void {
	const removed = forgetWatchesFor('wallet', walletId);
	if (removed > 0) log.info({ walletId, removed }, 'dropped watcher state for deleted wallet');
}

/**
 * Forget a deleted multisig's watched addresses immediately (cairn-uzgu /
 * cairn-gakd Phase 1). Called from wallets/multisig.ts's deleteMultisig right
 * after its DB delete succeeds.
 */
export function unwatchMultisig(multisigId: number): void {
	const removed = forgetWatchesFor('multisig', multisigId);
	if (removed > 0) log.info({ multisigId, removed }, 'dropped watcher state for deleted multisig');
}

/**
 * (Re)build the watch set and (re)subscribe. Safe to call repeatedly — after a
 * new wallet is created, or after reconfigureChain swapped the Electrum client.
 * Subscribes only scripthashes we aren't already watching on the current client.
 */
export async function refreshWatches(): Promise<void> {
	const chain = getChain();
	const electrum = chain.electrum;

	// If the client was swapped (reconfigureChain), the old subscriptions are
	// gone with it; rebuild from scratch against the new client.
	if (state.electrum !== electrum) {
		detachListeners();
		state.byScripthash.clear();
		// A swapped client may point at a different server (or, in tests, a
		// different chain entirely) — last-observed-tip data from the old client
		// isn't a valid difficulty floor for headers the new one reports.
		state.tipCache.clear();
		state.electrum = electrum;
		attachListeners(electrum);
	}

	const addresses = await enumerateAll();
	const desired = new Map<string, Watched>();
	for (const w of addresses) {
		try {
			desired.set(addressToScripthash(w.address), w);
		} catch {
			// Undecodable address — skip.
		}
	}

	// Prune anything we're holding that's no longer desired (cairn-uzgu /
	// cairn-gakd Phase 1): general sweep that catches every deletion path, not
	// just deleteWallet/deleteMultisig's direct unwatch calls above — e.g.
	// account deletion's FK cascade, which never reaches this module. Local
	// state only; the Electrum-side subscription itself lives on until the
	// socket cycles (unsubscribe RPC is Phase 2), but a pruned entry can never
	// notify again (it's gone from byScripthash) and walletStillExists in
	// handleScripthashChange covers the gap for anything not yet pruned.
	let pruned = 0;
	for (const scripthash of state.byScripthash.keys()) {
		if (!desired.has(scripthash)) {
			state.byScripthash.delete(scripthash);
			state.baselinedScripthashes.delete(scripthash);
			state.inFlight.delete(scripthash);
			releaseSubscription(scripthash);
			pruned++;
		}
	}
	if (pruned > 0) {
		log.info({ pruned, total: state.byScripthash.size }, 'stale address subscriptions pruned');
	}

	let subscribed = 0;
	for (const [scripthash, w] of desired) {
		const existing = state.byScripthash.get(scripthash);
		if (existing) {
			// cairn-1hb0: byScripthash is keyed purely by scripthash string, with no
			// per-entry generation/ownership tag. A scripthash can be reassigned to a
			// DIFFERENT (kind, walletId) — a delete+recreate that reuses the same
			// xpub/address, or an xpub shared across two wallets — while the prune
			// pass above never drops it (the key is still `desired`, just now
			// pointing at a different owner). Without this check the stale entry
			// would live on forever: the new wallet's deposits would keep
			// attributing to the wallet that used to own this scripthash until
			// walletStillExists happens to self-prune it, silently dropping
			// notifications in the meantime.
			if (existing.kind === w.kind && existing.walletId === w.walletId) continue; // same owner — already watched
			// Ownership changed. Reset per-scripthash state for it so the NEW owner
			// gets its own fresh baseline pass (never inherit the old owner's
			// "already baselined" status, which would silently swallow the new
			// wallet's real deposit history) rather than a stale in-flight marker
			// left over from the old owner (see handleScripthashChange's finally).
			state.baselinedScripthashes.delete(scripthash);
			state.inFlight.delete(scripthash);
			log.info(
				{ scripthash, from: { kind: existing.kind, walletId: existing.walletId }, to: { kind: w.kind, walletId: w.walletId } },
				'scripthash reassigned to a different wallet — resetting its watcher state'
			);
		}
		state.byScripthash.set(scripthash, w);
		try {
			// subscribeScripthash resolves with the current status. Subscribing arms
			// future 'scripthash' events; the returned status is the dirty-tracking
			// reconciliation checkpoint (cairn-wcxw) — on the initial subscribe it
			// seeds the baseline (and marks existing wallets dirty for their cold-start
			// scan), and on a client swap it catches any change that happened while we
			// were detached. (The NOTIFICATION baseline is still recorded separately and
			// lazily; reconcileStatus only drives the balance-refresh dirty flag.)
			const status = await electrum.subscribeScripthash(scripthash);
			reconcileStatus(scripthash, status);
			subscribed++;
		} catch (e) {
			// Leave it in the map: a reconnect resubscribe or a later refresh retries.
			log.debug({ err: e }, 'scripthash subscribe failed (will retry on refresh)');
		}
	}

	if (subscribed > 0) {
		log.info({ subscribed, total: state.byScripthash.size }, 'address subscriptions updated');
	}

	// Retry sweep (cairn-3bt1): baseline anything still pending — addresses whose
	// startup baseline fetch failed (e.g. an Electrum drop mid-pass) and addresses
	// subscribed after startup (new or imported wallets — an imported wallet's
	// pre-existing history must be recorded silently, not notified as new). Only
	// after the startup pass, which owns the first full sweep.
	if (state.baselined) {
		const { done, failed } = await baselinePendingScripthashes();
		if (done > 0 || failed > 0) {
			log.info({ baselinedAddresses: done, failed }, 'baseline retry sweep');
		}
	}
}

/**
 * Baseline the notified_txids table for every watched address WITHOUT notifying,
 * so that pre-existing transactions (which predate this feature, or a wallet
 * imported with history) never trigger a flood of "payment received" alerts on
 * first run. Called once at startup after the first subscribe pass. Best-effort
 * and rate-limited by WATCH_WINDOW; a failure for one address is skipped.
 */
async function baselineExisting(): Promise<void> {
	const { done, failed } = await baselinePendingScripthashes();
	if (done > 0 || failed > 0) {
		log.info({ baselinedAddresses: done, failed }, 'baseline pass complete');
	}
	// The global flag only means "the startup pass has run" — per-scripthash
	// liveness is tracked in state.baselinedScripthashes, so addresses whose
	// history fetch failed mid-pass (e.g. an Electrum socket drop, cairn-u7bw)
	// stay quarantined until a later retry succeeds, instead of leaking their old
	// history out as brand-new transactions (cairn-3bt1).
	state.baselined = true;
}

/**
 * Record one scripthash's current history as already-notified (confirmed=1,
 * no notification) and mark it baselined. Throws on a failed history fetch so
 * callers can decide to retry — the scripthash is only added to
 * baselinedScripthashes after a fully successful pass.
 */
async function baselineScripthash(scripthash: string, w: Watched): Promise<number> {
	const chain = getChain();
	const insert = db.prepare(
		`INSERT OR IGNORE INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed)
		 VALUES (?, ?, ?, ?, 1)`
	);
	const history = await chain.electrum.getHistory(scripthash, 'background');
	// cairn-mo36: the wallet/multisig this scripthash belongs to can be deleted
	// (deleteWallet/deleteMultisig's unwatch calls, or refreshWatches' periodic
	// prune) while the getHistory round-trip above was in flight. Every removal
	// path clears state.byScripthash synchronously (forgetWatchesFor), so
	// re-checking it here — with no further await before the inserts below —
	// closes that window: a since-deleted wallet never gets confirmed=1 rows
	// written for it.
	if (!state.byScripthash.has(scripthash)) return 0;
	for (const item of history) {
		insert.run(w.kind, w.walletId, w.userId, item.tx_hash);
	}
	state.baselinedScripthashes.add(scripthash);
	return history.length;
}

/**
 * Baseline every watched scripthash that isn't yet baselined. Best-effort per
 * address: a failure is logged and left un-baselined for the next retry (the
 * 5-minute refreshWatches cadence, or on-demand when a change event arrives for
 * it). Used both for the startup pass and as the retry sweep afterwards.
 */
async function baselinePendingScripthashes(): Promise<{ done: number; failed: number }> {
	let done = 0;
	let failed = 0;
	for (const [scripthash, w] of state.byScripthash) {
		if (state.baselinedScripthashes.has(scripthash)) continue;
		try {
			await baselineScripthash(scripthash, w);
			done++;
		} catch (e) {
			failed++;
			log.debug(
				{ err: e, walletId: w.walletId },
				'baseline history fetch failed; address stays quarantined until retry'
			);
		}
	}
	return { done, failed };
}

function attachListeners(electrum: ElectrumPool): void {
	state.onScripthash = (sh: string, status: string | null) => {
		// Dirty-tracking first (synchronous, cairn-wcxw): persist the new status and
		// mark the wallet dirty on a real change. This fires on live changes AND on
		// the reconnect resubscribe replay (client.ts resubscribe re-emits each sub's
		// current status), so an outage during which the chain moved is reconciled
		// the moment we reconnect. Independent of — and ahead of — the notification
		// path, which stays gated on state.baselined.
		reconcileStatus(sh, status);
		void handleScripthashChange(sh).catch((e) =>
			log.error({ err: e }, 'scripthash handler threw')
		);
	};
	state.onHeader = (header: ElectrumHeader) => {
		if (header && typeof header.height === 'number' && header.height > state.tipHeight) {
			state.tipHeight = header.height;
		}
		acceptHeaderIntoCache(header);
		void handleNewBlock().catch((e) => log.error({ err: e }, 'new-block handler threw'));
	};
	electrum.on('scripthash', state.onScripthash);
	electrum.on('header', state.onHeader);
}

function detachListeners(): void {
	if (state.electrum) {
		if (state.onScripthash) state.electrum.off('scripthash', state.onScripthash);
		if (state.onHeader) state.electrum.off('header', state.onHeader);
	}
	state.onScripthash = null;
	state.onHeader = null;
}

/**
 * Start the address watcher. Idempotent. Runs the first subscribe + baseline
 * pass asynchronously after a short delay (so the app finishes booting and the
 * Electrum client has a chance to connect first) and never throws into the
 * caller — hooks.server.ts wraps it in try/catch too.
 */
export function startAddressWatcher(): void {
	if (state.started) return;
	state.started = true;

	const delay = setTimeout(() => {
		void (async () => {
			try {
				await refreshWatches();
				await baselineExisting();
			} catch (e) {
				log.error({ err: e }, 'initial address watcher setup failed');
			}
		})();
	}, 10_000);
	delay.unref?.();

	// Periodic refresh picks up wallets/multisigs created since the last pass and
	// re-subscribes after a reconfigureChain swapped the Electrum client — without
	// coupling wallet-creation code to this module (which would form an import
	// cycle, since this module imports the wallet layer). Newly subscribed
	// addresses are explicitly baselined by refreshWatches' retry sweep before
	// they go live: a brand-new wallet has no history (cheap no-op), and an
	// imported wallet's pre-existing history is recorded silently instead of
	// flooding out as new (cairn-3bt1). Unref'd so it never holds the process
	// open.
	const refresh = setInterval(() => {
		void refreshWatches().catch((e) => log.error({ err: e }, 'periodic refresh failed'));
	}, REFRESH_INTERVAL_MS);
	refresh.unref?.();
}

// Exported for tests (cairn-8kbw difficulty-floor cache: addressWatcherSpv.test.ts).
export const _internals = {
	state,
	acceptHeaderIntoCache,
	spvVerifyConfirmed,
	maxCachedTarget,
	TIP_CACHE_SIZE,
	DIFFICULTY_FLOOR_FACTOR,
	// cairn-wcxw dirty-tracking seams (addressWatcherDirty.test.ts).
	reconcileStatus,
	watchDepthFor,
	WATCH_WINDOW
};
