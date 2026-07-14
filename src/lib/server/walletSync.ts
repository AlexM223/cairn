// Stale-while-revalidate (SWR) wallet sync (cairn-2zxt).
//
// The wallet detail / list pages used to STREAM a full gap-limit Electrum scan on
// every navigation (epic cairn-vknb) — non-blocking for the shell, but still a
// fresh multi-second scan each time, which reads as "the app froze" on a busy
// Umbrel node. This module replaces that with true SWR:
//
//   • load() reads a persisted SNAPSHOT (readWalletSnapshot / readMultisigSnapshot)
//     synchronously from SQLite — zero Electrum, so navigation never blocks.
//   • The client fires refreshWalletSnapshot / refreshMultisigSnapshot in the
//     background (via the /refresh API routes). That does the real scan, rewrites
//     the snapshot row, and the client re-invalidates the loader to pick it up.
//
// Two guards keep the refresh cheap and safe under concurrency:
//   • Single-flight — a module-level Map<key, Promise> so concurrent requests /
//     tabs / a new-block nudge all await ONE in-flight scan instead of each
//     kicking off its own.
//   • Throttle — a snapshot younger than THROTTLE_MS is returned as-is without
//     re-scanning, so a burst of navigations doesn't hammer Electrum.
//
// A refresh that fails (Electrum down/slow) NEVER overwrites the last good
// snapshot and NEVER throws to the page — it rejects to the API route, which keeps
// serving the cached data with its now-stale last_synced_at. The send/PSBT flow
// deliberately does NOT read snapshots (it always re-scans live for fresh UTXOs).

import QRCode from 'qrcode';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { DEFAULT_BACKGROUND_LANE_SIZE } from './electrum/pool';
import { childLogger } from './logger';
import type { WalletAddress, WalletTx, WalletSummary } from '$lib/types';
import { scanWallet } from './bitcoin/walletScan';
import {
	getWallet,
	listWalletRows,
	peekReceiveAddress,
	toWalletSummaryFromCache,
	type WalletRow
} from './wallets';
import {
	getWalletUtxos,
	detectUnconfirmedInflows,
	ownBroadcastTxids,
	type UnconfirmedInflow
} from './transactions';
import type { SpendableUtxo, CoinbaseStatus } from './bitcoin/psbt';
import { isWalletWatched } from './addressWatcher';
import { getChain } from './chain';
import { getViewableMultisig, listMultisigs, type MultisigRow } from './wallets/multisig';
import {
	getMultisigDetail,
	peekMultisigReceiveAddress,
	toMultisigSummaryFromCache,
	type MultisigScanAddress,
	type MultisigTx,
	type MultisigSummary
} from './multisigScan';
import { ownMultisigTxids } from './multisigTransactions';
import { listSharedMultisigs } from './multisigShares';
import { assemblePortfolio, type AggregateInput } from './portfolio';
import { writePortfolioSnapshot } from './portfolioSnapshot';
import { coinbaseMaturity } from '$lib/shared/coinbase';

const log = childLogger('wallet-sync');

/** Re-scan is skipped (cached snapshot returned as-is) when the last sync is
 *  younger than this. ~20s per the SWR design — long enough that a burst of
 *  navigations coalesces, short enough that data never feels stale. */
export const THROTTLE_MS = 20_000;

/**
 * Dirty-tracking clean-skip ceiling (cairn-wcxw, sync engine Phase 1). A wallet
 * whose persisted snapshot is CLEAN (`wallet_snapshots.dirty_since IS NULL` — no
 * Electrum scripthash status change has been observed since the last scan) is
 * returned from cache WITHOUT re-scanning until it is this old, instead of the
 * 20 s `THROTTLE_MS`. The scripthash subscription the app already holds for every
 * watched address is what flips a wallet dirty on a real change (new tx,
 * confirmation, reorg, RBF, reconnect delta), so a genuinely idle wallet costs
 * ~zero Electrum work between changes; this TTL is only the self-healing net that
 * bounds the worst-case stale window if a signal is ever missed. 30 min balances
 * "claws back nearly all the idle-scan savings" against "bounded staleness."
 * Dirty wallets are unaffected — they still coalesce on `THROTTLE_MS` and scan.
 */
export const MAX_CLEAN_TTL_MS = 30 * 60_000;

/**
 * Ops kill-switch for the clean-skip (cairn-wcxw). Set the env var to any truthy
 * value to collapse `MAX_CLEAN_TTL` back to `THROTTLE_MS`, i.e. revert to the old
 * "always re-scan past 20 s" behavior instantly without a redeploy — the escape
 * hatch for the medium false-clean risk (a missed status signal showing a stale
 * balance). Read once at module load; a restart re-reads it. The dirty-MARKING
 * path (watcher persistence) always runs regardless, so flipping this off/on
 * never leaves stale baselines behind.
 */
const CLEAN_SKIP_DISABLED = /^(1|true|yes|on)$/i.test(
	(env.CAIRN_SYNC_DISABLE_DIRTY_SKIP ?? env.HEARTWOOD_SYNC_DISABLE_DIRTY_SKIP ?? '').trim()
);

/** The effective clean-skip window: `MAX_CLEAN_TTL_MS` normally, or `THROTTLE_MS`
 *  when the kill-switch is set (dirty-tracking clean-skip disabled). */
export function cleanSkipWindowMs(): number {
	return CLEAN_SKIP_DISABLED ? THROTTLE_MS : MAX_CLEAN_TTL_MS;
}

/** QR options — copied from the page loaders so a snapshot's stored QR matches
 *  what the receive panel would have rendered live (Heartwood parchment on
 *  transparent). */
const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#E4D8CC', light: '#00000000' }
};

// --------------------------------------------------------------- snapshot shapes

type CoinbaseUtxo = { txid: string; vout: number; value: number; height: number };

/**
 * A spendable coin persisted in the snapshot so the SEND page can render its
 * coin-control list + spendable balance WITHOUT a live Electrum re-scan when the
 * wallet is provably clean (cairn-g1u2). Raw fields only — `unconfirmedTrust` is
 * NOT stored: it is re-derived at read time from the live transactions table
 * (ownBroadcastTxids), so a coin's own-change/received badge is never frozen
 * stale. `coinbase` carries the full tri-state (`true`/`false`/`'unknown'`) so the
 * maturity subtraction the send page does is identical to the live path — an
 * unverifiable coinbase stays conservatively immature, never silently spendable.
 */
export type SnapshotUtxo = {
	txid: string;
	vout: number;
	value: number;
	height: number;
	coinbase: CoinbaseStatus;
};

/** Map live spendable coins to the lean shape persisted for the send fast path
 *  (cairn-g1u2). `coinbase` defaults CONSERVATIVELY to `'unknown'` (never `false`)
 *  if a scan ever left it undetermined, so a coin can never be mis-persisted as a
 *  mature spendable when its coinbase-ness wasn't actually resolved. */
function toSnapshotUtxos(utxos: SpendableUtxo[]): SnapshotUtxo[] {
	return utxos.map((u) => ({
		txid: u.txid,
		vout: u.vout,
		value: u.value,
		height: u.height,
		coinbase: u.coinbase ?? 'unknown'
	}));
}

/** Sum of coinbase-UTXO value that is NOT yet mature at `tipHeight` (cairn-oae1.3).
 *  `confirmed`/`detail.balance.confirmed` below come straight from Electrum, which
 *  counts an immature coinbase output as confirmed — this is the piece callers
 *  subtract to get a truly-spendable figure without changing `confirmed`'s
 *  existing meaning (still the full net-worth total the portfolio aggregate and
 *  list summaries rely on). Zero when there's no coinbase or the tip is unknown
 *  (tipHeight 0 reads every coinbase height as immature, which is safe — it just
 *  means the maturing figure over-reports until the tip resolves, never under). */
function sumImmatureCoinbase(coinbaseUtxos: CoinbaseUtxo[], tipHeight: number): number {
	let total = 0;
	for (const u of coinbaseUtxos) {
		if (!coinbaseMaturity(u.height, tipHeight).mature) total += u.value;
	}
	return total;
}

/** The scan-derived slice of the single-sig wallet detail page, persisted as one
 *  JSON blob. Mirrors the old streamed `WalletChainData` so the page renders
 *  identically — just instantly, from cache. `scanError` is always null in a
 *  PERSISTED snapshot (a failed scan never overwrites the last good one); it
 *  stays in the shape so the page's degraded-state branch keeps type-checking. */
export interface WalletSnapshot {
	scan: {
		addresses: WalletAddress[];
		txs: WalletTx[];
		confirmed: number;
		unconfirmed: number;
	} | null;
	receive: { address: string; path: string; index: number; qr: string } | null;
	coinbaseUtxos: CoinbaseUtxo[];
	/** Full spendable coin set for the SEND page's clean-wallet fast path
	 *  (cairn-g1u2). Optional: a snapshot written before this field existed parses
	 *  with it `undefined`, which `sendSnapshot` treats as "can't serve from cache"
	 *  ⇒ live re-scan, so the rollout is self-healing (the next background refresh
	 *  backfills it). */
	spendableUtxos?: SnapshotUtxo[];
	tipHeight: number;
	/** Sum of `coinbaseUtxos` value not yet mature at `tipHeight` — the slice of
	 *  `scan.confirmed` a wallet doesn't actually hold spendable yet (cairn-oae1.3).
	 *  `scan.confirmed` itself is UNCHANGED (still the full net-worth total). */
	maturingTotal: number;
	speedUp: UnconfirmedInflow[];
	scanError: string | null;
}

/** The scan-derived slice of the multisig detail page. `savedTxs` is NOT stored
 *  here — it's a cheap local (and viewer-scoped) DB read the loader adds fresh. */
export interface MultisigSnapshot {
	detail: {
		balance: { confirmed: number; unconfirmed: number };
		addresses: MultisigScanAddress[];
		history: MultisigTx[];
		utxoCount: number;
	} | null;
	receive: { address: string; index: number; qr: string } | null;
	coinbaseUtxos: CoinbaseUtxo[];
	/** Full spendable coin set for the SEND page's clean-wallet fast path — see the
	 *  single-sig WalletSnapshot field of the same name (cairn-g1u2). */
	spendableUtxos?: SnapshotUtxo[];
	tipHeight: number;
	/** Sum of `coinbaseUtxos` value not yet mature at `tipHeight` — see the
	 *  single-sig WalletSnapshot field of the same name (cairn-oae1.3). */
	maturingTotal: number;
	speedUp: UnconfirmedInflow[];
	scanError: string | null;
}

/** An empty (never-synced) single-sig snapshot — what the loader returns before
 *  the first background refresh completes. */
export const EMPTY_WALLET_SNAPSHOT: WalletSnapshot = {
	scan: null,
	receive: null,
	coinbaseUtxos: [],
	tipHeight: 0,
	maturingTotal: 0,
	speedUp: [],
	scanError: null
};

/** An empty (never-synced) multisig snapshot. */
export const EMPTY_MULTISIG_SNAPSHOT: MultisigSnapshot = {
	detail: null,
	receive: null,
	coinbaseUtxos: [],
	tipHeight: 0,
	maturingTotal: 0,
	speedUp: [],
	scanError: null
};

type SnapshotKind = 'wallet' | 'multisig';

export interface StoredSnapshot<T> {
	snapshot: T;
	/** ms epoch of the scan that produced this snapshot. */
	lastSyncedAt: number;
	/** Dirty flag (cairn-wcxw): NULL/`null` = clean; ms epoch = marked-dirty-at.
	 *  Read by the refresh gate to decide clean-skip vs rescan. */
	dirtySince: number | null;
}

// -------------------------------------------------------- list-view summary blob

/**
 * The tiny slice of a snapshot the wallets-LIST page actually needs: a balance
 * and enough to compute "last activity" — NOT the full address/tx arrays. Stored
 * denormalized in `wallet_snapshots.summary` so listCachedPortfolio can render N
 * wallets without SELECTing + JSON.parsing N whole snapshots on every navigation
 * (cairn-2zxt list-payload trim). `hasPending` + `latestConfirmedTime` (rather
 * than a frozen lastActivity) so the read path can recompute the live "just now"
 * for a wallet with an in-flight tx, exactly as toWalletSummary does.
 */
export interface CachedSummary {
	confirmed: number;
	unconfirmed: number;
	hasPending: boolean;
	latestConfirmedTime: number | null;
}

/** Derive the summary from a tx list. Mirrors wallets.ts `lastActivityOf` — keep
 *  the two in sync (both: pending → live now; else newest confirmed time). */
function summarizeTxs(
	confirmed: number,
	unconfirmed: number,
	txs: { height: number; time: number | null }[]
): CachedSummary {
	let hasPending = false;
	let latest: number | null = null;
	for (const tx of txs) {
		if (tx.height <= 0) hasPending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	return { confirmed, unconfirmed, hasPending, latestConfirmedTime: latest };
}

export function summarizeWalletSnapshot(snap: WalletSnapshot): CachedSummary | null {
	if (!snap.scan) return null;
	return summarizeTxs(snap.scan.confirmed, snap.scan.unconfirmed, snap.scan.txs);
}

export function summarizeMultisigSnapshot(snap: MultisigSnapshot): CachedSummary | null {
	if (!snap.detail) return null;
	return summarizeTxs(
		snap.detail.balance.confirmed,
		snap.detail.balance.unconfirmed,
		snap.detail.history
	);
}

/** Collapse a summary into the final list-row balance fields, computing the live
 *  "just now" for a wallet with an unconfirmed tx (parity with toWalletSummary). */
export function finalizeCachedBalance(
	s: CachedSummary | null
): { confirmed: number; unconfirmed: number; lastActivity: number | null } | null {
	if (!s) return null;
	return {
		confirmed: s.confirmed,
		unconfirmed: s.unconfirmed,
		lastActivity: s.hasPending ? Math.floor(Date.now() / 1000) : s.latestConfirmedTime
	};
}

// --------------------------------------------------------------- persistence

const upsertStmt = db.prepare(
	`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
	 VALUES (?, ?, ?, ?, ?)
	 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET
	   snapshot = excluded.snapshot, summary = excluded.summary,
	   last_synced_at = excluded.last_synced_at`
);

/** Persist (or replace) a wallet's snapshot with a fresh last_synced_at. Writes
 *  the small `summary` blob alongside the full snapshot in the SAME row/write so
 *  the list path can read balances without parsing the whole snapshot. One row,
 *  one write. Best-effort — a persistence hiccup must never sink a scan. Returns
 *  the timestamp written so callers can report it without a re-read. */
function writeSnapshot(
	kind: SnapshotKind,
	id: number,
	snapshot: unknown,
	summary: CachedSummary | null
): number {
	const now = Date.now();
	try {
		upsertStmt.run(kind, id, JSON.stringify(snapshot), summary ? JSON.stringify(summary) : null, now);
	} catch (e) {
		log.debug({ err: e, kind, id }, 'persist wallet snapshot failed (ignored)');
	}
	return now;
}

const readStmt = db.prepare(
	'SELECT snapshot, last_synced_at, dirty_since FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/** Read + parse a stored snapshot, or null when absent/corrupt. Never throws. */
function readSnapshot<T>(kind: SnapshotKind, id: number): StoredSnapshot<T> | null {
	try {
		const row = readStmt.get(kind, id) as
			| { snapshot: string; last_synced_at: number; dirty_since: number | null }
			| undefined;
		if (!row) return null;
		return {
			snapshot: JSON.parse(row.snapshot) as T,
			lastSyncedAt: row.last_synced_at,
			dirtySince: row.dirty_since ?? null
		};
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read wallet snapshot failed (ignored)');
		return null;
	}
}

// -------------------------------------------------------------- dirty tracking
//
// cairn-wcxw sync engine Phase 1. The address watcher marks a wallet dirty (sets
// `wallet_snapshots.dirty_since`) the instant an Electrum scripthash status
// actually changes; this module READS that flag to skip clean rescans, and
// CLEARS it after a successful scan persist — but only if no NEW change landed
// while the scan was in flight (compare-and-swap on the exact flag value), so a
// deposit that races a scan is never silently swallowed into a "clean" snapshot.

const readDirtyStmt = db.prepare(
	'SELECT dirty_since FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/** The current dirty_since for a wallet/multisig (null = clean or no snapshot). */
export function readDirtySince(kind: SnapshotKind, id: number): number | null {
	try {
		const row = readDirtyStmt.get(kind, id) as { dirty_since: number | null } | undefined;
		return row?.dirty_since ?? null;
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read dirty_since failed (ignored)');
		return null;
	}
}

const readSyncMetaStmt = db.prepare(
	'SELECT last_synced_at, dirty_since FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/** last_synced_at + dirty_since for the refresh pass, WITHOUT parsing the full
 *  snapshot JSON (cairn-wcxw). Returns null when never synced. Never throws.
 *  Lighter than readWalletSnapshot/readMultisigSnapshot (which JSON.parse the
 *  whole address+tx blob just to read two integers), so the coalesced pass — run
 *  for every wallet of every user at boot — does one indexed read per item. */
export function readSyncMeta(
	kind: SnapshotKind,
	id: number
): { lastSyncedAt: number; dirtySince: number | null } | null {
	try {
		const row = readSyncMetaStmt.get(kind, id) as
			| { last_synced_at: number; dirty_since: number | null }
			| undefined;
		if (!row) return null;
		return { lastSyncedAt: row.last_synced_at, dirtySince: row.dirty_since ?? null };
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read sync meta failed (ignored)');
		return null;
	}
}

// `dirty_since IS ?` is a null-safe equality (SQLite): it matches a stored NULL
// when `expected` is null and an exact timestamp otherwise — so this only clears
// the flag if it is byte-for-byte what the scan saw at its start. A status change
// that landed mid-scan rewrote dirty_since to a fresh timestamp, so the WHERE no
// longer matches and the wallet correctly stays dirty for another scan.
const clearDirtyStmt = db.prepare(
	`UPDATE wallet_snapshots SET dirty_since = NULL
	  WHERE wallet_kind = ? AND wallet_id = ? AND dirty_since IS ?`
);

/**
 * Clear a wallet's dirty flag after a successful scan persist — but ONLY if the
 * flag is unchanged from `expected` (the value read at scan start). Returns true
 * when it actually cleared. A mid-scan status change (which bumped dirty_since to
 * a newer timestamp) fails the compare-and-swap and leaves the wallet dirty, so
 * the next refresh rescans and captures that change. Best-effort; never throws.
 */
export function clearDirtyIfUnchanged(
	kind: SnapshotKind,
	id: number,
	expected: number | null
): boolean {
	try {
		return clearDirtyStmt.run(kind, id, expected).changes > 0;
	} catch (e) {
		log.debug({ err: e, kind, id }, 'clear dirty_since failed (ignored)');
		return false;
	}
}

// A plain (non-CAS) dirty stamp: unconditionally sets dirty_since = now. Used by
// the broadcast paths (cairn-g1u2) where the wallet's coins provably just changed
// (we spent one), so the send fast path MUST re-scan on the next load rather than
// serve the pre-spend snapshot. A no-op (0 rows) when no snapshot exists yet — a
// never-synced wallet already scans by absence. Overwriting an existing
// dirty_since with a newer value is harmless: the refresh gate reads it as a
// boolean, and clearDirtyIfUnchanged's CAS still refuses to clear a value that
// moved after a scan started.
const stampDirtyStmt = db.prepare(
	'UPDATE wallet_snapshots SET dirty_since = ? WHERE wallet_kind = ? AND wallet_id = ?'
);

/**
 * Mark a wallet/multisig dirty as of now (cairn-g1u2). Called on a successful
 * broadcast so the very next send load bypasses the clean-wallet snapshot fast
 * path and re-scans live — we know a coin was just spent, and the async watcher
 * notification for that status change may not have landed yet. Best-effort; never
 * throws.
 */
export function markWalletDirty(kind: SnapshotKind, id: number): void {
	try {
		stampDirtyStmt.run(Date.now(), kind, id);
	} catch (e) {
		log.debug({ err: e, kind, id }, 'mark wallet dirty failed (ignored)');
	}
}

/** The persisted single-sig snapshot for a wallet, or null when never synced. */
export function readWalletSnapshot(walletId: number): StoredSnapshot<WalletSnapshot> | null {
	return readSnapshot<WalletSnapshot>('wallet', walletId);
}

/** The persisted multisig snapshot, or null when never synced. */
export function readMultisigSnapshot(multisigId: number): StoredSnapshot<MultisigSnapshot> | null {
	return readSnapshot<MultisigSnapshot>('multisig', multisigId);
}

// ----------------------------------------------------- send-page snapshot fast path
//
// cairn-g1u2. Every send GET used to stream loadSendLiveData, which does a LIVE
// Electrum re-scan (getWalletDetail + getWalletUtxos → scanWallet + listunspent +
// coinbase annotation) on every request — the dominant per-request cost that
// collapsed mixed load at tier 200. But a wallet whose subscribed scripthash
// statuses are unchanged is PROVABLY unchanged on-chain (the Electrum protocol's
// contract, wired into dirty-tracking by cairn-wcxw), so a CLEAN wallet's
// snapshot coins are exactly as fresh as a live scan. sendSnapshot serves them
// from cache when — and ONLY when — that provable-freshness holds, and returns
// null (⇒ the caller re-scans live, exactly as before) on ANY doubt. The
// build/broadcast path (buildDraft / buildMultisigDraft) re-scans live
// regardless, so this only ever affects the DISPLAYED coin list + balance, never
// what a PSBT actually spends.

/** Confirmed balance + tip + spendable coins served from a clean snapshot. */
export interface SendSnapshotData {
	/** Raw confirmed balance from the scan (immature-coinbase subtraction is the
	 *  caller's job — done identically to the live path). */
	confirmed: number;
	tipHeight: number;
	utxos: SnapshotUtxo[];
}

/**
 * The send-page fast path (cairn-g1u2): a CLEAN wallet's persisted spendable
 * coins + confirmed balance + tip, or null when the send load must re-scan live.
 * Returns null — failing toward the live scan — on ANY of:
 *   • kill-switch set (CAIRN_SYNC_DISABLE_DIRTY_SKIP) — reverts to always-live;
 *   • the wallet is not actively watched — nothing would flip its dirty flag, so a
 *     clean flag can't be trusted (Electrum down, watcher not yet subscribed, …);
 *   • no snapshot, or a scan-less / errored snapshot;
 *   • DIRTY (dirty_since set) — a status change has landed since the last scan;
 *   • older than MAX_CLEAN_TTL — the self-healing staleness bound (a missed signal
 *     never strands the page on stale coins longer than this);
 *   • a pre-cairn-g1u2 snapshot with no persisted spendable set.
 */
export function sendSnapshot(kind: SnapshotKind, id: number): SendSnapshotData | null {
	// Kill-switch: collapse straight to the live path (the ops escape hatch shared
	// with the refresh-gate clean-skip). CLEAN_SKIP_DISABLED already folds both env
	// var spellings, read once at module load.
	if (CLEAN_SKIP_DISABLED) return null;
	// The dirty signal is only sound while a live subscription is watching this
	// wallet's addresses to flip it. No watch ⇒ don't trust "clean".
	if (!isWalletWatched(kind, id)) return null;

	const stored = readSnapshot<WalletSnapshot | MultisigSnapshot>(kind, id);
	if (!stored) return null;
	if (stored.dirtySince != null) return null; // a change landed since the last scan
	if (Date.now() - stored.lastSyncedAt >= MAX_CLEAN_TTL_MS) return null; // TTL guard

	const snap = stored.snapshot;
	if (snap.scanError !== null) return null; // never serve a degraded snapshot
	// Pre-cairn-g1u2 row: no persisted spendable set ⇒ can't serve, re-scan live.
	if (!Array.isArray(snap.spendableUtxos)) return null;

	const confirmed =
		kind === 'wallet'
			? (snap as WalletSnapshot).scan?.confirmed
			: (snap as MultisigSnapshot).detail?.balance.confirmed;
	if (confirmed == null) return null; // scan-less snapshot ⇒ nothing to serve

	return { confirmed, tipHeight: snap.tipHeight, utxos: snap.spendableUtxos };
}

const readSummaryStmt = db.prepare(
	'SELECT summary, last_synced_at FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/**
 * Read ONLY the small list-view summary for a wallet/multisig — no full snapshot
 * SELECT or parse (the list path's optimization). Returns null when never synced.
 * For a row written before the `summary` column existed (summary IS NULL) it
 * lazily falls back to deriving the summary from the full snapshot, so the list
 * stays correct until the next refresh backfills the column. Never throws.
 */
function readCachedSummary(
	kind: SnapshotKind,
	id: number
): { summary: CachedSummary | null; lastSyncedAt: number } | null {
	try {
		const row = readSummaryStmt.get(kind, id) as
			| { summary: string | null; last_synced_at: number }
			| undefined;
		if (!row) return null;
		if (row.summary) {
			return { summary: JSON.parse(row.summary) as CachedSummary, lastSyncedAt: row.last_synced_at };
		}
		// Lazy backfill: older row with no summary — derive from the full snapshot.
		const full = readSnapshot<WalletSnapshot | MultisigSnapshot>(kind, id);
		const summary = full
			? kind === 'wallet'
				? summarizeWalletSnapshot(full.snapshot as WalletSnapshot)
				: summarizeMultisigSnapshot(full.snapshot as MultisigSnapshot)
			: null;
		return { summary, lastSyncedAt: row.last_synced_at };
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read wallet summary failed (ignored)');
		return null;
	}
}

// ------------------------------------------------- single-flight + throttle core

/**
 * The dirty-aware skip decision shared by `singleFlightThrottled` and
 * `runPortfolioRefreshPass` (cairn-wcxw). Returns true when a scan can be SKIPPED
 * and the cached snapshot returned as-is. Exported pure for direct testing.
 *
 * Rules, in order:
 *   • `force` ⇒ never skip.
 *   • no snapshot (`lastSyncedAt === null`) ⇒ never skip — the first scan of a
 *     wallet always runs (the money-grade invariant: never fabricate "clean" for
 *     an address/wallet we've never actually scanned).
 *   • otherwise skip iff the snapshot is younger than the applicable window:
 *       – DIRTY (`dirtySince != null`) ⇒ the short `throttleMs` burst-coalescing
 *         floor only (a dirty wallet must rescan promptly);
 *       – CLEAN (`dirtySince == null`) ⇒ the long `cleanSkipMs` ceiling (skip
 *         idle wallets), defaulting to `throttleMs` when a caller opts out of
 *         dirty-tracking so the plain throttle semantics are unchanged.
 */
export function shouldSkipScan(opts: {
	force?: boolean;
	lastSyncedAt: number | null;
	dirtySince?: number | null;
	throttleMs?: number;
	cleanSkipMs?: number;
	now?: () => number;
}): boolean {
	if (opts.force) return false;
	if (opts.lastSyncedAt === null) return false;
	const now = opts.now ?? Date.now;
	const throttleMs = opts.throttleMs ?? THROTTLE_MS;
	const cleanSkipMs = opts.cleanSkipMs ?? throttleMs;
	const window = opts.dirtySince != null ? throttleMs : cleanSkipMs;
	return now() - opts.lastSyncedAt < window;
}

/**
 * The shared single-flight + throttle engine. Exported for direct testing.
 *
 * Returns the CACHED value without calling `doScan` when {@link shouldSkipScan}
 * says the snapshot is fresh enough (a clean wallet skips for up to `cleanSkipMs`;
 * a dirty one only coalesces within `throttleMs`). Otherwise, if a scan for this
 * key is already in flight, returns that same promise (single-flight); if not,
 * starts one, records it in `map`, and clears it when settled. Deliberately NOT
 * an `async` function: the map get/set must run synchronously (before any await)
 * so two concurrent callers can never both start a scan.
 */
export function singleFlightThrottled<T>(
	map: Map<string, Promise<T>>,
	key: string,
	opts: {
		force?: boolean;
		throttleMs?: number;
		/** Clean-skip ceiling (cairn-wcxw); defaults to `throttleMs` (no dirty-skip). */
		cleanSkipMs?: number;
		/** last_synced_at of the currently persisted snapshot, or null if none. */
		lastSyncedAt: number | null;
		/** dirty_since of the persisted snapshot (null = clean); drives the window. */
		dirtySince?: number | null;
		/** Return the persisted snapshot — only called on a throttle hit. */
		readCached: () => T;
		/** The real (expensive) scan + persist. */
		doScan: () => Promise<T>;
		/** Injectable clock for tests. */
		now?: () => number;
	}
): Promise<T> {
	if (
		shouldSkipScan({
			force: opts.force,
			lastSyncedAt: opts.lastSyncedAt,
			dirtySince: opts.dirtySince,
			throttleMs: opts.throttleMs,
			cleanSkipMs: opts.cleanSkipMs,
			now: opts.now
		})
	) {
		return Promise.resolve(opts.readCached());
	}

	const inflight = map.get(key);
	if (inflight) return inflight;

	const p = (async () => {
		try {
			return await opts.doScan();
		} finally {
			map.delete(key);
		}
	})();
	map.set(key, p);
	return p;
}

const inFlightWallet = new Map<string, Promise<WalletSnapshot>>();
const inFlightMultisig = new Map<string, Promise<MultisigSnapshot>>();

// ------------------------------------------------------ global scan concurrency

/**
 * A minimal FIFO concurrency limiter — no dependency. `run(fn)` queues `fn` and
 * resolves/rejects with its result, guaranteeing no more than `concurrency`
 * wrapped calls run at once. Exported for direct testing.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
	const max = Math.max(1, Math.floor(concurrency) || 1);
	let active = 0;
	const queue: (() => void)[] = [];
	const pump = () => {
		while (active < max && queue.length > 0) {
			const start = queue.shift()!;
			active++;
			start();
		}
	};
	return function run<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			queue.push(() => {
				// `Promise.resolve().then(fn)` so a synchronous throw in `fn` rejects
				// the returned promise (instead of escaping) AND still releases the slot.
				Promise.resolve()
					.then(fn)
					.then(resolve, reject)
					.finally(() => {
						active--;
						pump();
					});
			});
			pump();
		});
	};
}

/**
 * Global cap on concurrent Electrum-hitting wallet/multisig scans. Pegged to the
 * BACKGROUND-LANE width (pool.ts) — the number of sockets a scan may actually
 * use — NOT the raw pool size. Scans now run on the background lane (see
 * doWalletScan/doMultisigScan), which is barred from the one socket reserved for
 * interactive traffic; capping scan concurrency at that same width keeps the
 * background lane busy without ever having more scans in flight than there are
 * sockets to serve them. Deliberately decoupled from DEFAULT_POOL_SIZE so a
 * future pool-size bump doesn't silently raise scan pressure without a deliberate
 * decision (task 3). Every real scan (list refresh, detail-page refresh,
 * new-block nudge, startup warm) funnels through this one limiter — the original
 * reason it exists: without it, opening /wallets with N wallets fired N
 * concurrent full gap-limit scans that monopolized the pool and starved
 * interactive requests, the leading cause of "the app is unresponsive".
 */
export const SCAN_CONCURRENCY = DEFAULT_BACKGROUND_LANE_SIZE;
const scanLimit = createLimiter(SCAN_CONCURRENCY);

// -------------------------------------------------------------- single-sig scan

/** The real single-sig scan. Throws when the core wallet scan is unreachable —
 *  so a failure rejects to the API route (which keeps serving cached data)
 *  rather than persisting an error snapshot over the last good one. */
async function doWalletScan(userId: number, row: WalletRow): Promise<WalletSnapshot> {
	// Snapshot the dirty flag BEFORE any Electrum work (cairn-wcxw): a status change
	// that lands while this scan is in flight bumps dirty_since to a newer value, so
	// the compare-and-swap clear at the end won't match and the wallet correctly
	// stays dirty for a follow-up scan. Read once, up front, with nothing async
	// between here and the read.
	const dirtyAtStart = readDirtySince('wallet', row.id);

	// Core scan first — this is the one that must succeed to have anything worth
	// persisting. A failure here throws (see above). Runs on the BACKGROUND lane
	// so its ~200 pipelined history/balance calls never fill the socket an
	// interactive request (a send, a tx page) needs (cairn — HOL blocking).
	const scan = await scanWallet(row.xpub, { lane: 'background' });
	const receive = await peekReceiveAddress(row);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	// One UTXO fetch feeds BOTH the coinbase section and the speed-up (RBF/CPFP)
	// detection below. Previously the coinbase read called getWalletUtxos and the
	// speed-up read called detectWalletUnconfirmedInflows, which fetched the UTXO
	// set AGAIN internally — so a single refresh did two full listunspent-per-
	// used-address round-trips against the same wallet (cairn-zdgt). Fetch once
	// here (background lane), on the chain tip too; a hiccup degrades both
	// features together (empty coinbase, no speed-up button) rather than being
	// caught in two separate places.
	let utxos: SpendableUtxo[] = [];
	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		const [fetched, tip] = await Promise.all([
			getWalletUtxos(row.xpub, 'background'),
			getChain().getTip()
		]);
		utxos = fetched;
		tipHeight = tip.height;
		// Strict equality: u.coinbase can be 'unknown' (unverifiable, truthy in
		// JS) as well as true/false. Only a DEFINITE coinbase belongs in this
		// bucket — 'unknown' must never render as a mining reward.
		coinbaseUtxos = utxos
			.filter((u) => u.coinbase === true)
			.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
	} catch {
		utxos = [];
		coinbaseUtxos = [];
		tipHeight = 0;
	}

	// Which unconfirmed txs can be sped up (RBF vs CPFP), from the SAME UTXO set
	// fetched above — no second Electrum round-trip (cairn-zdgt). Tolerate a
	// hiccup — the button just doesn't appear.
	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = await detectUnconfirmedInflows(utxos, ownBroadcastTxids(row.id));
	} catch {
		speedUp = [];
	}

	const snapshot: WalletSnapshot = {
		scan: {
			addresses: scan.addresses,
			txs: scan.txs,
			confirmed: scan.confirmed,
			unconfirmed: scan.unconfirmed
		},
		receive: { ...receive, qr },
		coinbaseUtxos,
		// Persist the FULL spendable set (not just the coinbase subset) so the send
		// page renders coin control + spendable balance from cache when the wallet is
		// clean (cairn-g1u2). Empty on a UTXO-fetch hiccup above — which also zeroes
		// `coinbaseUtxos`/`tipHeight`, so the send fast path just serves an empty coin
		// list against a still-correct `scan.confirmed`.
		spendableUtxos: toSnapshotUtxos(utxos),
		tipHeight,
		maturingTotal: sumImmatureCoinbase(coinbaseUtxos, tipHeight),
		speedUp,
		scanError: null
	};
	writeSnapshot('wallet', row.id, snapshot, summarizeWalletSnapshot(snapshot));
	// A fresh successful scan reflects on-chain state as of scan start, so clear the
	// dirty flag — unless a status change raced this scan (CAS on dirtyAtStart).
	clearDirtyIfUnchanged('wallet', row.id, dirtyAtStart);
	return snapshot;
}

/**
 * Refresh (or return the throttled cache of) a single-sig wallet's snapshot.
 * Returns null when the wallet doesn't exist or isn't owned by userId. Rejects
 * when the live scan fails — the caller keeps serving the last good snapshot.
 */
export function refreshWalletSnapshot(
	userId: number,
	walletId: number,
	opts: { force?: boolean } = {}
): Promise<WalletSnapshot | null> {
	const row = getWallet(userId, walletId);
	if (!row) return Promise.resolve(null);
	const cached = readWalletSnapshot(walletId);
	return singleFlightThrottled(inFlightWallet, `wallet:${walletId}`, {
		force: opts.force,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		dirtySince: cached?.dirtySince ?? null,
		cleanSkipMs: cleanSkipWindowMs(),
		readCached: () => cached!.snapshot,
		// Only the real Electrum work goes through the global semaphore — a throttle
		// hit (readCached) and the single-flight bookkeeping stay outside it.
		doScan: () => scanLimit(() => doWalletScan(userId, row))
	});
}

// ---------------------------------------------------------------- multisig scan

/** The real multisig scan. Throws when the core detail scan is unreachable. */
async function doMultisigScan(userId: number, multisig: MultisigRow): Promise<MultisigSnapshot> {
	// Snapshot the dirty flag before any Electrum work — see doWalletScan (cairn-wcxw).
	const dirtyAtStart = readDirtySince('multisig', multisig.id);

	// Background lane: the multisig gap-limit scan + UTXO fetch are bulk work that
	// must not queue an interactive request behind them (cairn — HOL blocking).
	const detail = await getMultisigDetail(multisig, 'background');
	const receive = await peekMultisigReceiveAddress(multisig);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		// getMultisigDetail already fetched the UTXO set (detail.utxos), so reuse
		// it for the coinbase bucket rather than a second listunspent pass; guard
		// the tip separately so a tip hiccup just hides the coinbase section.
		const tip = await getChain().getTip();
		tipHeight = tip.height;
		// Strict equality — see the single-sig scan above: 'unknown' is truthy
		// but must not be bucketed as a mining reward.
		coinbaseUtxos = detail.utxos
			.filter((u) => u.coinbase === true)
			.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
	} catch {
		coinbaseUtxos = [];
		tipHeight = 0;
	}

	// Speed-up detection reuses detail.utxos too (cairn-zdgt): the previous
	// detectMultisigUnconfirmedInflows call re-fetched the UTXO set via
	// getMultisigUtxos, so a single multisig refresh did two listunspent passes
	// even though only scanMultisig — not listunspent — is cached.
	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = await detectUnconfirmedInflows(detail.utxos, ownMultisigTxids(multisig.id));
	} catch {
		speedUp = [];
	}

	const snapshot: MultisigSnapshot = {
		detail: {
			balance: detail.balance,
			addresses: detail.addresses,
			history: detail.history,
			utxoCount: detail.utxos.length
		},
		receive: { ...receive, qr },
		coinbaseUtxos,
		// Full spendable set for the send fast path (cairn-g1u2) — getMultisigDetail
		// already fetched detail.utxos, so this reuses it with no extra Electrum work.
		spendableUtxos: toSnapshotUtxos(detail.utxos),
		tipHeight,
		maturingTotal: sumImmatureCoinbase(coinbaseUtxos, tipHeight),
		speedUp,
		scanError: null
	};
	writeSnapshot('multisig', multisig.id, snapshot, summarizeMultisigSnapshot(snapshot));
	// Clear dirty on a successful persist unless a status change raced the scan.
	clearDirtyIfUnchanged('multisig', multisig.id, dirtyAtStart);
	return snapshot;
}

/**
 * Refresh (or return the throttled cache of) a multisig's snapshot. Any
 * participant (owner / viewer / cosigner) may trigger it — the snapshot is the
 * same for all of them (it's derived from the wallet's coins, not the caller).
 * Returns null when the multisig isn't visible to userId.
 */
export function refreshMultisigSnapshot(
	userId: number,
	multisigId: number,
	opts: { force?: boolean } = {}
): Promise<MultisigSnapshot | null> {
	const multisig = getViewableMultisig(userId, multisigId);
	if (!multisig) return Promise.resolve(null);
	const cached = readMultisigSnapshot(multisigId);
	return singleFlightThrottled(inFlightMultisig, `multisig:${multisigId}`, {
		force: opts.force,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		dirtySince: cached?.dirtySince ?? null,
		cleanSkipMs: cleanSkipWindowMs(),
		readCached: () => cached!.snapshot,
		doScan: () => scanLimit(() => doMultisigScan(userId, multisig))
	});
}

// ----------------------------------------------------------- cached list summaries

/**
 * The wallets-list payload, built SYNCHRONOUSLY from persisted snapshots — zero
 * Electrum, so the list page never blocks on navigation. Reads ONLY the small
 * `summary` column per wallet (not the full snapshot), so a large tx/address
 * history never gets SELECTed + JSON.parsed just to render one balance row. A
 * wallet with no snapshot yet simply shows zeroed balances until the background
 * refresh fills it in (it is NOT flagged unreachable — that's reserved for an
 * actual scan error, which the cache-first path never produces). `lastSyncedAt`
 * is the OLDEST sync across all wallets (the freshness the aggregate indicator
 * should honour), or null when nothing has synced yet.
 */
export function listCachedPortfolio(userId: number): {
	wallets: WalletSummary[];
	errors: Record<number, string>;
	multisigs: MultisigSummary[];
	multisigErrors: Record<number, string>;
	lastSyncedAt: number | null;
} {
	let oldest: number | null = null;
	const note = (ts: number | null) => {
		if (ts === null) return;
		oldest = oldest === null ? ts : Math.min(oldest, ts);
	};

	const wallets = listWalletRows(userId).map((row) => {
		const cached = readCachedSummary('wallet', row.id);
		note(cached?.lastSyncedAt ?? null);
		return toWalletSummaryFromCache(row, finalizeCachedBalance(cached?.summary ?? null));
	});

	const multisigs: MultisigSummary[] = [];
	for (const row of listMultisigs(userId)) {
		const cached = readCachedSummary('multisig', row.id);
		note(cached?.lastSyncedAt ?? null);
		multisigs.push(toMultisigSummaryFromCache(row, finalizeCachedBalance(cached?.summary ?? null)));
	}
	// Multisigs shared WITH this user render exactly like owned ones, tagged with
	// the share role + owner name.
	for (const s of listSharedMultisigs(userId)) {
		const row = getViewableMultisig(userId, s.multisigId);
		if (!row) continue;
		const cached = readCachedSummary('multisig', row.id);
		note(cached?.lastSyncedAt ?? null);
		multisigs.push(
			toMultisigSummaryFromCache(row, finalizeCachedBalance(cached?.summary ?? null), {
				role: s.role,
				sharedBy: s.ownerName
			})
		);
	}

	return { wallets, errors: {}, multisigs, multisigErrors: {}, lastSyncedAt: oldest };
}

// ------------------------------------------------- coalesced portfolio refresh

/**
 * True for a connect/timeout-class Electrum failure — the signal that the chain
 * backend is unreachable rather than a single wallet being odd. A coalesced pass
 * aborts its remaining queue on one of these instead of retrying N more times
 * against a dead server. Matched on ElectrumClient's own error strings
 * (electrum/client.ts) plus the common OS-level socket errno codes.
 */
export function isConnectClassError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /timed out|not connected|connection (?:error|closed|lost)|client (?:is )?closed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN/i.test(
		msg
	);
}

export interface PortfolioRefreshItem {
	kind: SnapshotKind;
	id: number;
	/** last_synced_at of the persisted snapshot, or null when never synced. */
	lastSyncedAt: number | null;
	/** dirty_since of the persisted snapshot (cairn-wcxw): null/absent = clean, so
	 *  the pass skips it for up to `cleanSkipMs` instead of the short throttle. A
	 *  dirty item (timestamp) rescans as soon as it clears the throttle floor. */
	dirtySince?: number | null;
}

export interface PortfolioRefreshSummary {
	refreshed: number;
	skipped: number;
	failed: number;
	/** True when a connect-class failure aborted the remaining queue. */
	aborted: boolean;
}

/**
 * Drive a coalesced refresh across a set of wallets + multisigs.
 *
 * Pure w.r.t. IO — the caller injects `scan` (in production
 * refreshWalletSnapshot / refreshMultisigSnapshot), so ordering, throttle,
 * concurrency and abort are all unit-testable without a DB or Electrum. Contract:
 *   • most-stale-first — a never-synced item (null) sorts ahead of the oldest
 *     timestamp, so the wallets a user is most likely staring at a blank for get
 *     refreshed first;
 *   • throttle — an item synced < `throttleMs` ago is skipped (counted, never
 *     scanned), reusing the same window as the per-wallet single-flight guard;
 *   • concurrency — at most `concurrency` scans run at once (default matches the
 *     scan semaphore / Electrum pool) so the pass itself never floods the backend;
 *   • abort — a connect-class failure (`isFatal`) stops pulling new work and
 *     returns what already succeeded rather than hammering a dead server N times.
 */
export async function runPortfolioRefreshPass(
	items: PortfolioRefreshItem[],
	scan: (item: PortfolioRefreshItem) => Promise<unknown | null>,
	opts: {
		concurrency?: number;
		throttleMs?: number;
		/** Clean-skip ceiling (cairn-wcxw); defaults to `throttleMs` (no dirty-skip).
		 *  Production passes `cleanSkipWindowMs()` so an idle CLEAN wallet is skipped
		 *  for up to MAX_CLEAN_TTL — the biggest lever for the startup warm pass and
		 *  the periodic portfolio refresh, which otherwise re-scan every wallet. */
		cleanSkipMs?: number;
		now?: () => number;
		isFatal?: (err: unknown) => boolean;
	} = {}
): Promise<PortfolioRefreshSummary> {
	const now = opts.now ?? Date.now;
	const throttleMs = opts.throttleMs ?? THROTTLE_MS;
	const cleanSkipMs = opts.cleanSkipMs ?? throttleMs;
	const isFatal = opts.isFatal ?? isConnectClassError;
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? SCAN_CONCURRENCY) || 1);

	const summary: PortfolioRefreshSummary = { refreshed: 0, skipped: 0, failed: 0, aborted: false };

	// Skip up front (counted, never scanned): a fresh-enough CLEAN item within the
	// clean ceiling and a DIRTY item within the throttle floor both skip here; the
	// rest go through most-stale-first (cairn-wcxw dirty-aware).
	const due: PortfolioRefreshItem[] = [];
	for (const it of items) {
		if (
			shouldSkipScan({
				lastSyncedAt: it.lastSyncedAt,
				dirtySince: it.dirtySince,
				throttleMs,
				cleanSkipMs,
				now
			})
		) {
			summary.skipped++;
		} else {
			due.push(it);
		}
	}
	due.sort((a, b) => (a.lastSyncedAt ?? -Infinity) - (b.lastSyncedAt ?? -Infinity));

	let next = 0;
	const worker = async (): Promise<void> => {
		while (!summary.aborted) {
			const item = due[next++];
			if (!item) return;
			try {
				const result = await scan(item);
				if (result) summary.refreshed++;
				else summary.skipped++; // vanished / not owned — not an error
			} catch (err) {
				summary.failed++;
				if (isFatal(err)) {
					summary.aborted = true;
					return;
				}
			}
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, due.length) }, () => worker());
	await Promise.all(workers);
	return summary;
}

/**
 * Recompute and persist the user's dashboard portfolio aggregate
 * (portfolioSnapshot.ts) FROM the per-wallet snapshots the refresh pass just
 * rewrote — no extra Electrum work (it reads confirmed/unconfirmed/txs and the
 * tip height straight out of the persisted snapshots). This is what makes GET
 * /api/portfolio a synchronous cache read: one coordinated refresh produces both
 * the per-wallet snapshots AND the dashboard aggregate, rather than the old
 * second, live-scanning path (getPortfolioDetail) firing on every GET.
 *
 * Scope mirrors the historical dashboard exactly: the user's OWN single-sig
 * wallets + OWN multisigs (not multisigs merely shared WITH them — those show on
 * the wallets LIST but were never part of the home total). Best-effort; the
 * caller wraps it so a build hiccup never sinks the refresh response. Exported
 * for direct testing.
 */
export function buildPortfolioAggregate(userId: number): void {
	const inputs: AggregateInput[] = [];
	let tipHeight = 0;
	let walletCount = 0;

	for (const row of listWalletRows(userId)) {
		walletCount++;
		const stored = readWalletSnapshot(row.id);
		const scan = stored?.snapshot.scan;
		if (!scan) continue; // never synced yet — excluded, understating like a live miss
		tipHeight = Math.max(tipHeight, stored.snapshot.tipHeight ?? 0);
		inputs.push({
			kind: 'wallet',
			id: row.id,
			name: row.name,
			href: `/wallets/${row.id}`,
			confirmed: scan.confirmed,
			unconfirmed: scan.unconfirmed,
			txs: scan.txs
		});
	}

	for (const row of listMultisigs(userId)) {
		walletCount++;
		const stored = readMultisigSnapshot(row.id);
		const detail = stored?.snapshot.detail;
		if (!detail) continue;
		tipHeight = Math.max(tipHeight, stored.snapshot.tipHeight ?? 0);
		inputs.push({
			kind: 'multisig',
			id: row.id,
			name: row.name,
			href: `/wallets/multisig/${row.id}`,
			confirmed: detail.balance.confirmed,
			unconfirmed: detail.balance.unconfirmed,
			txs: detail.history
		});
	}

	const aggregate = assemblePortfolio(userId, walletCount, tipHeight, inputs);
	writePortfolioSnapshot(userId, aggregate, Date.now());
}

/**
 * ONE coalesced pass over everything the user can see — their wallets, their
 * multisigs, and multisigs shared with them — most-stale-first and capped at
 * SCAN_CONCURRENCY concurrent scans. This replaces the wallets-list page firing
 * a separate POST /refresh per wallet/multisig (each a full gap-limit scan that
 * could monopolize the pool). Each per-item scan is still single-flighted +
 * throttled, so a detail page refreshing the same wallet coalesces with this
 * pass instead of duplicating its work. Awaits the whole pass; returns counts.
 *
 * After the per-wallet snapshots are refreshed, it recomputes the dashboard
 * portfolio aggregate from those snapshots (buildPortfolioAggregate) so the home
 * page's GET /api/portfolio is a synchronous cache read — the same single pass
 * feeds the wallets list AND the dashboard, never two competing scan paths.
 */
export async function refreshPortfolio(userId: number): Promise<PortfolioRefreshSummary> {
	const items: PortfolioRefreshItem[] = [];

	for (const row of listWalletRows(userId)) {
		const meta = readSyncMeta('wallet', row.id);
		items.push({
			kind: 'wallet',
			id: row.id,
			lastSyncedAt: meta?.lastSyncedAt ?? null,
			dirtySince: meta?.dirtySince ?? null
		});
	}

	// Owned + shared multisigs, de-duplicated by id (a share row can point at a
	// multisig the caller also owns).
	const seenMultisig = new Set<number>();
	const noteMultisig = (id: number) => {
		if (seenMultisig.has(id)) return;
		seenMultisig.add(id);
		const meta = readSyncMeta('multisig', id);
		items.push({
			kind: 'multisig',
			id,
			lastSyncedAt: meta?.lastSyncedAt ?? null,
			dirtySince: meta?.dirtySince ?? null
		});
	};
	for (const row of listMultisigs(userId)) noteMultisig(row.id);
	for (const s of listSharedMultisigs(userId)) {
		if (seenMultisig.has(s.multisigId)) continue;
		if (getViewableMultisig(userId, s.multisigId)) noteMultisig(s.multisigId);
	}

	const summary = await runPortfolioRefreshPass(
		items,
		(item) =>
			item.kind === 'wallet'
				? refreshWalletSnapshot(userId, item.id)
				: refreshMultisigSnapshot(userId, item.id),
		// Clean idle wallets skip for up to MAX_CLEAN_TTL here too (cairn-wcxw), so
		// the warm/periodic pass stops re-scanning every wallet on every trigger.
		{ cleanSkipMs: cleanSkipWindowMs() }
	);

	// Rebuild the dashboard aggregate from the freshly-persisted snapshots. Pure
	// SQLite work, no chain calls; best-effort so it never sinks the refresh.
	try {
		buildPortfolioAggregate(userId);
	} catch (e) {
		log.debug({ err: e, userId }, 'portfolio aggregate build failed (ignored)');
	}

	return summary;
}

/**
 * Startup warm of the persisted snapshot table for EVERY user's wallets +
 * multisigs, so the wallets list / detail pages render a real balance on the
 * first navigation after a cold start instead of a zeroed placeholder waiting on
 * the client-triggered refresh. Runs through the same scan semaphore + coalesced
 * pass as an interactive refresh (so it never floods Electrum), one user at a
 * time. Best-effort: a per-user failure is logged and skipped; a connect-class
 * abort stops the whole warm rather than churning every remaining user against a
 * dead server.
 */
export async function warmAllSnapshots(): Promise<void> {
	let userIds: number[] = [];
	try {
		userIds = (db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id);
	} catch (e) {
		log.debug({ err: e }, 'warm snapshots: listing users failed (skipped)');
		return;
	}

	let refreshed = 0;
	for (const userId of userIds) {
		try {
			const summary = await refreshPortfolio(userId);
			refreshed += summary.refreshed;
			if (summary.aborted) break; // Electrum is down — stop the warm pass.
		} catch (e) {
			log.debug({ err: e, userId }, 'warm snapshots: user pass failed (skipped)');
		}
	}
	if (refreshed) log.info({ refreshed }, 'wallet snapshots warmed');
}
