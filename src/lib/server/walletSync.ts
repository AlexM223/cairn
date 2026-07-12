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
	detectWalletUnconfirmedInflows,
	type UnconfirmedInflow
} from './transactions';
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
import { detectMultisigUnconfirmedInflows } from './multisigTransactions';
import { listSharedMultisigs } from './multisigShares';
import { assemblePortfolio, type AggregateInput } from './portfolio';
import { writePortfolioSnapshot } from './portfolioSnapshot';

const log = childLogger('wallet-sync');

/** Re-scan is skipped (cached snapshot returned as-is) when the last sync is
 *  younger than this. ~20s per the SWR design — long enough that a burst of
 *  navigations coalesces, short enough that data never feels stale. */
export const THROTTLE_MS = 20_000;

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
	tipHeight: number;
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
	tipHeight: number;
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
	speedUp: [],
	scanError: null
};

/** An empty (never-synced) multisig snapshot. */
export const EMPTY_MULTISIG_SNAPSHOT: MultisigSnapshot = {
	detail: null,
	receive: null,
	coinbaseUtxos: [],
	tipHeight: 0,
	speedUp: [],
	scanError: null
};

type SnapshotKind = 'wallet' | 'multisig';

export interface StoredSnapshot<T> {
	snapshot: T;
	/** ms epoch of the scan that produced this snapshot. */
	lastSyncedAt: number;
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
	'SELECT snapshot, last_synced_at FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/** Read + parse a stored snapshot, or null when absent/corrupt. Never throws. */
function readSnapshot<T>(kind: SnapshotKind, id: number): StoredSnapshot<T> | null {
	try {
		const row = readStmt.get(kind, id) as
			| { snapshot: string; last_synced_at: number }
			| undefined;
		if (!row) return null;
		return { snapshot: JSON.parse(row.snapshot) as T, lastSyncedAt: row.last_synced_at };
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read wallet snapshot failed (ignored)');
		return null;
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
 * The shared single-flight + throttle engine. Exported for direct testing.
 *
 * Returns the CACHED value without calling `doScan` when a snapshot exists and is
 * younger than `throttleMs`. Otherwise, if a scan for this key is already in
 * flight, returns that same promise (single-flight); if not, starts one, records
 * it in `map`, and clears it when settled. Deliberately NOT an `async` function:
 * the map get/set must run synchronously (before any await) so two concurrent
 * callers can never both start a scan.
 */
export function singleFlightThrottled<T>(
	map: Map<string, Promise<T>>,
	key: string,
	opts: {
		force?: boolean;
		throttleMs?: number;
		/** last_synced_at of the currently persisted snapshot, or null if none. */
		lastSyncedAt: number | null;
		/** Return the persisted snapshot — only called on a throttle hit. */
		readCached: () => T;
		/** The real (expensive) scan + persist. */
		doScan: () => Promise<T>;
		/** Injectable clock for tests. */
		now?: () => number;
	}
): Promise<T> {
	const now = opts.now ?? Date.now;
	const throttleMs = opts.throttleMs ?? THROTTLE_MS;

	if (!opts.force && opts.lastSyncedAt !== null && now() - opts.lastSyncedAt < throttleMs) {
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
	// Core scan first — this is the one that must succeed to have anything worth
	// persisting. A failure here throws (see above). Runs on the BACKGROUND lane
	// so its ~200 pipelined history/balance calls never fill the socket an
	// interactive request (a send, a tx page) needs (cairn — HOL blocking).
	const scan = await scanWallet(row.xpub, { lane: 'background' });
	const receive = await peekReceiveAddress(row);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	// Mining-reward (coinbase) UTXOs + chain tip — tolerate a hiccup; the balance
	// and receive card are what matter. Empty for almost every wallet.
	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		const [utxos, tip] = await Promise.all([
			getWalletUtxos(row.xpub, 'background'),
			getChain().getTip()
		]);
		tipHeight = tip.height;
		// Strict equality: u.coinbase can be 'unknown' (unverifiable, truthy in
		// JS) as well as true/false. Only a DEFINITE coinbase belongs in this
		// bucket — 'unknown' must never render as a mining reward.
		coinbaseUtxos = utxos
			.filter((u) => u.coinbase === true)
			.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
	} catch {
		coinbaseUtxos = [];
		tipHeight = 0;
	}

	// Which unconfirmed txs can be sped up (RBF vs CPFP). Tolerate a hiccup — the
	// button just doesn't appear.
	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = (await detectWalletUnconfirmedInflows(userId, row.id)) ?? [];
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
		tipHeight,
		speedUp,
		scanError: null
	};
	writeSnapshot('wallet', row.id, snapshot, summarizeWalletSnapshot(snapshot));
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
		readCached: () => cached!.snapshot,
		// Only the real Electrum work goes through the global semaphore — a throttle
		// hit (readCached) and the single-flight bookkeeping stay outside it.
		doScan: () => scanLimit(() => doWalletScan(userId, row))
	});
}

// ---------------------------------------------------------------- multisig scan

/** The real multisig scan. Throws when the core detail scan is unreachable. */
async function doMultisigScan(userId: number, multisig: MultisigRow): Promise<MultisigSnapshot> {
	// Background lane: the multisig gap-limit scan + UTXO fetch are bulk work that
	// must not queue an interactive request behind them (cairn — HOL blocking).
	const detail = await getMultisigDetail(multisig, 'background');
	const receive = await peekMultisigReceiveAddress(multisig);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		// getMultisigDetail already ran the scan, so getMultisigUtxos hits the cache;
		// guard the tip separately so a tip hiccup just hides the coinbase section.
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

	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = (await detectMultisigUnconfirmedInflows(userId, multisig.id)) ?? [];
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
		tipHeight,
		speedUp,
		scanError: null
	};
	writeSnapshot('multisig', multisig.id, snapshot, summarizeMultisigSnapshot(snapshot));
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
		now?: () => number;
		isFatal?: (err: unknown) => boolean;
	} = {}
): Promise<PortfolioRefreshSummary> {
	const now = opts.now ?? Date.now;
	const throttleMs = opts.throttleMs ?? THROTTLE_MS;
	const isFatal = opts.isFatal ?? isConnectClassError;
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? SCAN_CONCURRENCY) || 1);

	const summary: PortfolioRefreshSummary = { refreshed: 0, skipped: 0, failed: 0, aborted: false };

	// Throttle-skip up front (counted, never scanned); the rest, most-stale-first.
	const due: PortfolioRefreshItem[] = [];
	for (const it of items) {
		if (it.lastSyncedAt !== null && now() - it.lastSyncedAt < throttleMs) summary.skipped++;
		else due.push(it);
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
		items.push({
			kind: 'wallet',
			id: row.id,
			lastSyncedAt: readWalletSnapshot(row.id)?.lastSyncedAt ?? null
		});
	}

	// Owned + shared multisigs, de-duplicated by id (a share row can point at a
	// multisig the caller also owns).
	const seenMultisig = new Set<number>();
	const noteMultisig = (id: number) => {
		if (seenMultisig.has(id)) return;
		seenMultisig.add(id);
		items.push({ kind: 'multisig', id, lastSyncedAt: readMultisigSnapshot(id)?.lastSyncedAt ?? null });
	};
	for (const row of listMultisigs(userId)) noteMultisig(row.id);
	for (const s of listSharedMultisigs(userId)) {
		if (seenMultisig.has(s.multisigId)) continue;
		if (getViewableMultisig(userId, s.multisigId)) noteMultisig(s.multisigId);
	}

	const summary = await runPortfolioRefreshPass(items, (item) =>
		item.kind === 'wallet'
			? refreshWalletSnapshot(userId, item.id)
			: refreshMultisigSnapshot(userId, item.id)
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
