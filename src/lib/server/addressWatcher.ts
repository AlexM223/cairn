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

import { db } from './db';
import { getChain } from './chain/index';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import { deriveMultisigAddress } from './bitcoin/multisig';
import { toMultisigConfig, type MultisigRow, type MultisigKeyRow } from './wallets/multisig';
import { notify } from './notifications';
import { verifyTxInclusion } from './bitcoin/spv';
import { childLogger } from './logger';
import type { ChainService } from './chain/index';
import type { ElectrumClient, ElectrumHeader, ElectrumHistoryItem } from './electrum/client';

const log = childLogger('notify:txwatch');

// How far past the last-known cursor to watch. The scanners use a gap limit of
// 20; we watch a fixed window from index 0 so a fresh deposit to any of the
// first WATCH_WINDOW addresses on each chain is seen. Kept modest to bound the
// number of live subscriptions (WATCH_WINDOW × 2 chains per wallet).
const WATCH_WINDOW = 30;

// Confirmation thresholds. tx_confirmed fires once a watched tx reaches the
// first threshold; a per-user override can live in notification_preferences
// (config.confirmations) later — for now this is the default from §3 ([1,6],
// we fire on the first: 1 confirmation).
const CONFIRM_THRESHOLD = 1;

// How often to re-enumerate wallets and pick up newly created ones. See
// startAddressWatcher for why this is a poll rather than a wallet-creation hook.
const REFRESH_INTERVAL_MS = 5 * 60_000;

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
	electrum: ElectrumClient | null;
	onScripthash: ((sh: string, status: string | null) => void) | null;
	onHeader: ((header: ElectrumHeader) => void) | null;
	started: boolean;
	/** True once the startup baseline pass has recorded pre-existing history, so
	 *  scripthash changes that fire during startup don't notify for old txs. */
	baselined: boolean;
	/** In-flight change handling per scripthash, so overlapping notifications for
	 *  the same address don't double-process. */
	inFlight: Set<string>;
	/** Best known chain-tip height, updated on every 'header' event. Used as the
	 *  upper bound for SPV proofs (reject a tx claiming a height above the tip). */
	tipHeight: number;
}

const state: WatchState = {
	byScripthash: new Map(),
	electrum: null,
	onScripthash: null,
	onHeader: null,
	started: false,
	baselined: false,
	inFlight: new Set(),
	tipHeight: 0
};

// ------------------------------------------------------------- address enumeration

interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	xpub: string;
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
	for (const change of [0, 1] as const) {
		for (let i = 0; i < WATCH_WINDOW; i++) {
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
	for (const change of [0, 1] as const) {
		for (let i = 0; i < WATCH_WINDOW; i++) {
			try {
				const { address } = deriveMultisigAddress(config, change, i);
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

/** Enumerate every watched address across every wallet and multisig, all users. */
function enumerateAll(): Watched[] {
	const all: Watched[] = [];

	try {
		const wallets = db
			.prepare('SELECT id, user_id, name, xpub FROM wallets')
			.all() as unknown as WalletRow[];
		for (const w of wallets) all.push(...walletAddresses(w));
	} catch (e) {
		log.error({ err: e }, 'failed to enumerate single-sig wallets');
	}

	try {
		const multisigRows = db
			.prepare('SELECT * FROM multisigs')
			.all() as unknown as MultisigDbRow[];
		for (const m of multisigRows) {
			const keys = db
				.prepare('SELECT * FROM multisig_keys WHERE multisig_id = ? ORDER BY position')
				.all(m.id) as Record<string, unknown>[];
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

/** Has this (kind, wallet, txid) already been notified about? */
function alreadyNotified(kind: WalletKind, walletId: number, txid: string): boolean {
	const row = db
		.prepare(
			'SELECT confirmed FROM notified_txids WHERE wallet_kind = ? AND wallet_id = ? AND txid = ?'
		)
		.get(kind, walletId, txid) as { confirmed: number } | undefined;
	return row !== undefined;
}

/** Record a first sighting. Ignores the race where another handler inserted first. */
function recordTxid(w: Watched, txid: string): boolean {
	try {
		const res = db
			.prepare(
				`INSERT OR IGNORE INTO notified_txids (wallet_kind, wallet_id, user_id, txid)
				 VALUES (?, ?, ?, ?)`
			)
			.run(w.kind, w.walletId, w.userId, txid);
		return res.changes > 0;
	} catch (e) {
		log.error({ err: e, walletId: w.walletId, txid }, 'failed to record notified txid');
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

/**
 * True only when `txid` at `height` is provably confirmed: the Electrum server
 * supplies a merkle branch and the block header, and both the header's PoW and
 * the branch check out. On any fetch/verify failure we return false (fail
 * closed: do not notify, do not record — a later event can retry).
 */
async function spvVerifyConfirmed(txid: string, height: number): Promise<boolean> {
	if (height <= 0) return false; // mempool: no inclusion proof is possible yet
	try {
		const chain = getChain();
		const [proof, headerHex, tipHeight] = await Promise.all([
			chain.electrum.getMerkleProof(txid, height),
			chain.electrum.getBlockHeader(height),
			tipHeightNow(chain)
		]);
		const res = verifyTxInclusion({
			txid,
			height,
			proof: { merkle: proof.merkle, pos: proof.pos },
			headerHex,
			tipHeight
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
	if (state.inFlight.has(scripthash)) return;
	state.inFlight.add(scripthash);
	try {
		const chain = getChain();
		let history: ElectrumHistoryItem[];
		try {
			history = await chain.electrum.getHistory(scripthash);
		} catch (e) {
			log.warn({ err: e, walletId: w.walletId }, 'history fetch failed');
			return;
		}

		for (const item of history) {
			const txid = item.tx_hash;
			if (alreadyNotified(w.kind, w.walletId, txid)) continue;

			// SPV gate (cairn-7zj6): only ever notify for a transaction we can
			// independently prove is confirmed in a PoW-valid block. An unconfirmed
			// (mempool) tx can't be proven yet, so we defer — when it confirms, this
			// address's scripthash status changes and this handler re-runs, at which
			// point the proof exists. A confirmed tx that fails verification (a
			// server feeding a forged txid) is skipped WITHOUT recording, so a later
			// legitimate event can still be picked up.
			if (!(await spvVerifyConfirmed(txid, item.height))) continue;

			// Compute the inbound value to THIS wallet's addresses. We attribute a
			// tx to the wallet by output address membership against the watched set,
			// summing outputs paying any of this wallet's addresses.
			let receivedSats = 0;
			try {
				const tx = await chain.getTx(txid);
				const walletAddrs = walletAddressSet(w);
				for (const out of tx.vout) {
					if (out.address && walletAddrs.has(out.address)) receivedSats += out.value;
				}
			} catch (e) {
				log.warn({ err: e, txid }, 'tx detail fetch failed; recording without amount');
			}

			// First sighting wins the insert (guards the reconnect re-emit race).
			if (!recordTxid(w, txid)) continue;

			const label = walletLabel(w);
			const link = walletLink(w);

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
		}
	} finally {
		state.inFlight.delete(scripthash);
	}
}

/**
 * All watched addresses belonging to the same wallet as `w`. Used to attribute
 * a tx's outputs to the wallet. Small (WATCH_WINDOW × 2), so a linear pass over
 * the map is fine and avoids a second index.
 */
function walletAddressSet(w: Watched): Set<string> {
	const set = new Set<string>();
	for (const watched of state.byScripthash.values()) {
		if (watched.kind === w.kind && watched.walletId === w.walletId) set.add(watched.address);
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
}

/**
 * On each new block, re-check every not-yet-confirmed notified txid. When a tx
 * reaches CONFIRM_THRESHOLD confirmations, fire one tx_confirmed and flip its
 * `confirmed` flag so it never fires again.
 */
async function handleNewBlock(): Promise<void> {
	let pending: PendingTxidRow[];
	try {
		pending = db
			.prepare(
				`SELECT id, wallet_kind, wallet_id, user_id, txid
				   FROM notified_txids WHERE confirmed = 0`
			)
			.all() as unknown as PendingTxidRow[];
	} catch (e) {
		log.error({ err: e }, 'confirmation scan query failed');
		return;
	}
	if (pending.length === 0) return;

	const chain = getChain();
	const markConfirmed = db.prepare('UPDATE notified_txids SET confirmed = 1 WHERE id = ?');

	for (const row of pending) {
		try {
			const tx = await chain.getTx(row.txid);
			if (!tx.confirmed || tx.confirmations < CONFIRM_THRESHOLD) continue;

			markConfirmed.run(row.id);
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
		} catch (e) {
			// A mempool-dropped or unreachable tx: leave it pending for a later block.
			log.debug({ err: e, txid: row.txid }, 'confirmation check skipped');
		}
	}
}

// --------------------------------------------------------------------- lifecycle

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
		state.electrum = electrum;
		attachListeners(electrum);
	}

	const addresses = enumerateAll();
	const desired = new Map<string, Watched>();
	for (const w of addresses) {
		try {
			desired.set(addressToScripthash(w.address), w);
		} catch {
			// Undecodable address — skip.
		}
	}

	let subscribed = 0;
	for (const [scripthash, w] of desired) {
		if (state.byScripthash.has(scripthash)) continue;
		state.byScripthash.set(scripthash, w);
		try {
			// subscribeScripthash resolves with the current status; we don't diff it
			// here (initial history is the baseline — recorded lazily on first change
			// only for NEW txids, which is what we want post-launch). Subscribing is
			// what arms future 'scripthash' events.
			await electrum.subscribeScripthash(scripthash);
			subscribed++;
		} catch (e) {
			// Leave it in the map: a reconnect resubscribe or a later refresh retries.
			log.debug({ err: e }, 'scripthash subscribe failed (will retry on refresh)');
		}
	}

	if (subscribed > 0) {
		log.info({ subscribed, total: state.byScripthash.size }, 'address subscriptions updated');
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
	const chain = getChain();
	const seen = new Set<string>(); // wallet+txid keys handled this pass
	const insert = db.prepare(
		`INSERT OR IGNORE INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed)
		 VALUES (?, ?, ?, ?, 1)`
	);
	for (const [scripthash, w] of state.byScripthash) {
		try {
			const history = await chain.electrum.getHistory(scripthash);
			for (const item of history) {
				const key = `${w.kind}:${w.walletId}:${item.tx_hash}`;
				if (seen.has(key)) continue;
				seen.add(key);
				insert.run(w.kind, w.walletId, w.userId, item.tx_hash);
			}
		} catch {
			// Skip an address whose history we couldn't fetch at startup.
		}
	}
	if (seen.size > 0) log.info({ baselined: seen.size }, 'baselined existing transactions');
	state.baselined = true;
}

function attachListeners(electrum: ElectrumClient): void {
	state.onScripthash = (sh: string) => {
		void handleScripthashChange(sh).catch((e) =>
			log.error({ err: e }, 'scripthash handler threw')
		);
	};
	state.onHeader = (header: ElectrumHeader) => {
		if (header && typeof header.height === 'number' && header.height > state.tipHeight) {
			state.tipHeight = header.height;
		}
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
	// cycle, since this module imports the wallet layer). New addresses are
	// baselined-on-subscribe implicitly: their history is only recorded once a
	// 'scripthash' change fires, and only for txids not already in notified_txids.
	// A brand-new wallet has no history, so its first real deposit is a genuine
	// tx_received. Unref'd so it never holds the process open.
	const refresh = setInterval(() => {
		void refreshWatches().catch((e) => log.error({ err: e }, 'periodic refresh failed'));
	}, REFRESH_INTERVAL_MS);
	refresh.unref?.();
}
