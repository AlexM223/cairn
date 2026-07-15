// Portfolio aggregation for the dashboard: total balance, per-wallet
// allocation, cross-wallet recent activity, plus balance-over-time series and
// per-wallet sparklines backed by the balance_snapshots table.
//
// Single-sig wallets and multisig wallets are scanned side by side and merged
// into one view — the dashboard is "all your bitcoin at a glance", regardless
// of which flavor each wallet is.

import { db } from './db';
import { scanWallet, type WalletScanResult } from './bitcoin/walletScan';
import { scanMultisig, type MultisigScanResult } from './multisigScan';
import { listMultisigs, type MultisigRow } from './wallets/multisig';
import { getChain } from './chain';
import { childLogger } from './logger';
import {
	changesFromHorizonSeries,
	historyFromTxDeltas,
	type HorizonChange,
	type HorizonSeriesPoint
} from '$lib/horizonDelta';
import type {
	AllocationSlice,
	BalancePoint,
	PortfolioActivity,
	PortfolioDetail,
	WalletKind
} from '$lib/types';

const log = childLogger('portfolio');

/** How often a portfolio fetch is allowed to record a new snapshot tick. */
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // once per hour

/**
 * Per-wallet budget for a dashboard scan (cairn-3gvb / cairn-hy8z / cairn-xsuq).
 * The dashboard aggregates every wallet with Promise.all, so its response can
 * only be as fast as the SLOWEST wallet's scan settles. A single unreachable
 * wallet — or, worse, a broken SOCKS5/Tor proxy that makes every dial hang or
 * slowly get rejected (observed 16–135s per request) — otherwise drags the
 * whole dashboard to that worst case, leaving the balance stuck on a skeleton
 * for tens of seconds (or, if a dial simply never settles, forever). Racing
 * each scan against this bound means a slow/unreachable wallet degrades
 * gracefully (excluded from totals, exactly as a hard scan failure already is)
 * instead of blocking everyone else. Comfortably above a healthy scan (a warm/
 * cached scan returns instantly; a cold gap-limit pass over a responsive
 * server is a few seconds) yet far below the pathological worst case. The
 * timed-out scan keeps running in the background and populates the 60s scan
 * cache, so the next dashboard load can show the full balance once it
 * completes.
 */
export const PORTFOLIO_SCAN_TIMEOUT_MS = 10_000;

/** The tip lookup is best-effort and only feeds confirmation counts; never let
 *  a hung explorer/proxy hold the dashboard past the same per-item budget. */
const TIP_LOOKUP_TIMEOUT_MS = PORTFOLIO_SCAN_TIMEOUT_MS;

/**
 * Reject with a clear timeout error if `p` doesn't settle within `ms`. Does not
 * cancel `p` (promises aren't cancellable) — the underlying scan runs on and
 * still warms the cache; this only bounds how long the CALLER waits.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		timer.unref?.();
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		);
	});
}

interface ScannedWallet {
	kind: WalletKind;
	id: number;
	name: string;
	href: string;
	scan: WalletScanResult | MultisigScanResult;
}

/** Confirmations from a block height and the chain tip; 0 when unconfirmed. */
function confirmationsOf(height: number, tipHeight: number): number {
	return height > 0 ? Math.max(0, tipHeight - height + 1) : 0;
}

/** Newest activity: latest confirmed tx time, or "now" if anything is pending. */
function lastActivityOf(txs: { height: number; time: number | null }[]): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of txs) {
		if (tx.height <= 0) pending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	if (pending) return Math.floor(Date.now() / 1000);
	return latest;
}

// ------------------------------------------------------------------ snapshots

/**
 * True when any entry's live balance contradicts that wallet's latest snapshot.
 * Used to bypass the hourly snapshot throttle (cairn-qt1g): without it, the
 * chart's newest point can disagree with the live balance card for up to an
 * hour after any balance change — most visibly after switching the node
 * connection to a different chain, where the live total re-scans to a new
 * number but the chart keeps carrying the old chain's last snapshot forward.
 */
function contradictsLatestSnapshot(
	userId: number,
	entries: { kind: WalletKind; id: number; balance: number }[]
): boolean {
	const latest = db.prepare(
		`SELECT balance_sats FROM balance_snapshots
		  WHERE user_id = ? AND wallet_kind = ? AND wallet_id = ?
		  ORDER BY taken_at DESC LIMIT 1`
	);
	for (const e of entries) {
		const row = latest.get(userId, e.kind, e.id) as { balance_sats: number } | undefined;
		if (row !== undefined && row.balance_sats !== e.balance) return true;
	}
	return false;
}

/**
 * Record a snapshot tick (one row per wallet, shared timestamp) if the last one
 * is older than SNAPSHOT_INTERVAL_MS — or immediately, throttle bypassed, when
 * the live balances contradict the latest snapshots (cairn-qt1g), so the chart
 * catches up to reality on the next portfolio fetch instead of showing a stale
 * number under a fresh balance card for up to an hour. Reuses balances already
 * computed by a portfolio fetch, so it costs cheap reads/writes and no chain
 * calls; callers pass only fully-scanned balances so the summed total series
 * stays accurate (and a partial-outage scan can never fake a "contradiction").
 */
export function recordSnapshot(
	userId: number,
	entries: { kind: WalletKind; id: number; balance: number }[]
): void {
	if (entries.length === 0) return;
	const last = db
		.prepare('SELECT taken_at FROM balance_snapshots WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1')
		.get(userId) as { taken_at: string } | undefined;
	if (
		last &&
		Date.now() - Date.parse(last.taken_at) < SNAPSHOT_INTERVAL_MS &&
		!contradictsLatestSnapshot(userId, entries)
	)
		return;

	const takenAt = new Date().toISOString();
	const insert = db.prepare(
		'INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, ?, ?, ?, ?)'
	);
	const tx = db.prepare('BEGIN');
	try {
		tx.run();
		for (const e of entries) insert.run(userId, e.kind, e.id, takenAt, e.balance);
		db.prepare('COMMIT').run();
	} catch (err) {
		db.prepare('ROLLBACK').run();
		throw err;
	}
}

/**
 * How far back the balance-over-time series reads. Bounds the rows a single
 * computation reads (and carries forward in JS) so the series can never grow
 * unbounded and block the event loop on a busy account (cairn — dashboard
 * event-loop blocking). Aligned with the retention horizon (dataRetention
 * purgeBalanceSnapshots hard-deletes past ~13 months), so in practice this
 * window already covers every retained row — it just makes the bound explicit
 * and keeps the read cheap if retention is ever relaxed. The 30d/1yr lookback
 * changes (changesFromSeries) sit comfortably inside it.
 */
const BALANCE_SERIES_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

/** Hard cap on the number of points the chart series carries. A busy account
 *  accumulates up to ~1,000 hourly/daily snapshot rows PER wallet; emitting one
 *  point per distinct timestamp would send (and JSON-serialize into the persisted
 *  aggregate) thousands of points for a chart that only renders a few hundred
 *  pixels wide. Downsample to this many, always preserving the newest point so
 *  the chart's latest value matches the live balance. */
const MAX_BALANCE_SERIES_POINTS = 400;

/**
 * Stride-downsample an oldest-first series to at most `max` points, always
 * keeping the first and last. A no-op when already within the cap. Exported for
 * direct testing.
 */
export function downsampleSeries(series: BalancePoint[], max: number): BalancePoint[] {
	if (max < 2 || series.length <= max) return series;
	const out: BalancePoint[] = [];
	const stride = (series.length - 1) / (max - 1);
	for (let i = 0; i < max - 1; i++) out.push(series[Math.round(i * stride)]);
	out.push(series[series.length - 1]); // always keep the newest point exactly
	return out;
}

/**
 * Total confirmed sats over time (oldest first). Snapshot rows are per wallet
 * and — since historical backfill — NOT taken at shared timestamps, so the
 * total at each instant is the sum of every wallet's latest-known balance
 * (carry-forward), not a naive GROUP BY taken_at. Rows for since-deleted
 * wallets are excluded, matching what the retention sweep does permanently.
 *
 * Reads are bounded two ways so a large history never blocks the event loop:
 * only rows within BALANCE_SERIES_WINDOW_MS are read, and the emitted series is
 * downsampled to MAX_BALANCE_SERIES_POINTS.
 */
export function getBalanceSeries(userId: number, nowMs: number = Date.now()): BalancePoint[] {
	const cutoffIso = new Date(nowMs - BALANCE_SERIES_WINDOW_MS).toISOString();
	const rows = db
		.prepare(
			`SELECT wallet_kind, wallet_id, taken_at, balance_sats
			 FROM balance_snapshots
			 WHERE user_id = ?
			   AND taken_at >= ?
			   AND ((wallet_kind = 'wallet' AND wallet_id IN (SELECT id FROM wallets))
			     OR (wallet_kind = 'multisig' AND wallet_id IN (SELECT id FROM multisigs)))
			 ORDER BY taken_at ASC, id ASC`
		)
		.all(userId, cutoffIso) as {
		wallet_kind: string;
		wallet_id: number;
		taken_at: string;
		balance_sats: number;
	}[];

	const latest = new Map<string, number>();
	const out: BalancePoint[] = [];
	const emit = (takenAt: string) => {
		let sum = 0;
		for (const v of latest.values()) sum += v;
		out.push({ t: Math.floor(Date.parse(takenAt) / 1000), sats: sum });
	};
	let current: string | null = null;
	for (const r of rows) {
		if (current !== null && r.taken_at !== current) emit(current);
		current = r.taken_at;
		latest.set(`${r.wallet_kind}-${r.wallet_id}`, r.balance_sats);
	}
	if (current !== null) emit(current);
	return downsampleSeries(out, MAX_BALANCE_SERIES_POINTS);
}

// ------------------------------------------------------------------- backfill
//
// A wallet imported with existing on-chain history used to chart nothing:
// snapshots only accumulate from the moment Cairn starts sampling (cairn-ittq).
// Its full balance history is already implied by the scan, though — the
// running sum of confirmed tx deltas over confirmation time — so the first
// time a wallet is scanned, that derived history is written into
// balance_snapshots and the chart is populated on day one.

/** Mirror of the retention policy (dataRetention.purgeBalanceSnapshots):
 *  hourly resolution for the last 30 days, daily beyond that, nothing past
 *  ~13 months — no point inserting rows the next sweep would delete. */
const BACKFILL_DAILY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const BACKFILL_HORIZON_MS = 396 * 24 * 60 * 60 * 1000;

/**
 * Derive historical balance points from a wallet's confirmed transactions.
 * Returns null when the history can't be trusted to reconstruct the balance:
 * a confirmed tx with no timestamp, or deltas that don't sum to the scanned
 * confirmed balance (both would draw a chart that contradicts the real
 * number). Points follow the retention policy's resolution; history older
 * than the horizon contributes a single carry-in point at the horizon edge.
 */
export function buildBackfillPoints(
	txs: { height: number; time: number | null; delta: number }[],
	confirmedBalance: number,
	nowMs: number
): { t: number; sats: number }[] | null {
	const confirmed = txs.filter((tx) => tx.height > 0);
	if (confirmed.length === 0) return [];
	if (confirmed.some((tx) => tx.time == null)) return null;
	let total = 0;
	for (const tx of confirmed) total += tx.delta;
	if (total !== confirmedBalance) return null;

	confirmed.sort((a, b) => a.time! - b.time!);

	const horizonS = Math.floor((nowMs - BACKFILL_HORIZON_MS) / 1000);
	const dailyBeforeS = Math.floor((nowMs - BACKFILL_DAILY_AFTER_MS) / 1000);

	let running = 0;
	let carryIn: number | null = null; // balance entering the horizon window
	const points: { t: number; sats: number }[] = [];
	for (const tx of confirmed) {
		running += tx.delta;
		const t = tx.time!;
		if (t < horizonS) {
			carryIn = running;
			continue;
		}
		// Same-second txs collapse to the final balance at that instant; in the
		// daily band, keep only the first point of each UTC day (what the
		// retention downsampler would keep anyway).
		const prev = points[points.length - 1];
		if (prev && prev.t === t) {
			prev.sats = running;
		} else if (
			prev &&
			t < dailyBeforeS &&
			Math.floor(prev.t / 86400) === Math.floor(t / 86400)
		) {
			continue; // this day already has its point
		} else {
			points.push({ t, sats: running });
		}
	}
	if (carryIn !== null) points.unshift({ t: horizonS, sats: carryIn });
	return points;
}

/**
 * One-time per wallet: if it has no snapshot rows at all, write its derived
 * history. Guarded by row existence, so subsequent scans cost one SELECT.
 */
function backfillSnapshots(
	userId: number,
	kind: WalletKind,
	id: number,
	txs: { height: number; time: number | null; delta: number }[],
	confirmedBalance: number
): void {
	const existing = db
		.prepare(
			'SELECT 1 FROM balance_snapshots WHERE user_id = ? AND wallet_kind = ? AND wallet_id = ? LIMIT 1'
		)
		.get(userId, kind, id);
	if (existing) return;

	const points = buildBackfillPoints(txs, confirmedBalance, Date.now());
	if (points === null) {
		log.warn(
			{ kind, walletId: id },
			'balance backfill skipped: tx history cannot reconstruct the confirmed balance'
		);
		return;
	}
	if (points.length === 0) return;

	const insert = db.prepare(
		'INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, ?, ?, ?, ?)'
	);
	db.prepare('BEGIN').run();
	try {
		for (const p of points) {
			insert.run(userId, kind, id, new Date(p.t * 1000).toISOString(), p.sats);
		}
		db.prepare('COMMIT').run();
		log.info({ kind, walletId: id, points: points.length }, 'balance history backfilled');
	} catch (err) {
		db.prepare('ROLLBACK').run();
		throw err;
	}
}

/** Per-wallet balance history keyed by `${kind}-${id}` (oldest first). */
export function getSparklines(userId: number): Record<string, number[]> {
	const rows = db
		.prepare(
			`SELECT wallet_kind, wallet_id, balance_sats
			 FROM balance_snapshots WHERE user_id = ? ORDER BY taken_at ASC`
		)
		.all(userId) as { wallet_kind: string; wallet_id: number; balance_sats: number }[];
	const out: Record<string, number[]> = {};
	for (const r of rows) {
		const key = `${r.wallet_kind}-${r.wallet_id}`;
		(out[key] ??= []).push(r.balance_sats);
	}
	return out;
}

/**
 * Net change vs the snapshot nearest each lookback window (1d / 30d / 1yr /
 * all-time — DESIGN-MANIFESTO.md's multi-horizon MUST). Thin wrapper: the
 * actual cutoff-walk logic lives in the shared, client-safe
 * `$lib/horizonDelta` module so the wallet-detail page's client-derived
 * (tx-based) horizons are computed identically.
 */
function changesFromSeries(series: BalancePoint[], currentTotal: number) {
	return changesFromHorizonSeries(series, currentTotal);
}

/**
 * Merge several already-carry-forward-summed per-wallet series (oldest first)
 * into one cross-wallet total series, in memory — the same "latest known
 * value per key, summed at every distinct timestamp" carry-forward
 * `getBalanceSeries` does over DB rows, just applied to in-memory points
 * instead. Exported for direct testing.
 */
export function mergeWalletSeries(perWallet: HorizonSeriesPoint[][]): HorizonSeriesPoint[] {
	const tagged: { t: number; sats: number; w: number }[] = [];
	perWallet.forEach((series, w) => {
		for (const p of series) tagged.push({ t: p.t, sats: p.sats, w });
	});
	tagged.sort((a, b) => a.t - b.t);

	const latest = new Array<number>(perWallet.length).fill(0);
	const out: HorizonSeriesPoint[] = [];
	const emit = (t: number) => out.push({ t, sats: latest.reduce((a, b) => a + b, 0) });
	let current: number | null = null;
	for (const p of tagged) {
		if (current !== null && p.t !== current) emit(current);
		current = p.t;
		latest[p.w] = p.sats;
	}
	if (current !== null) emit(current);
	return out;
}

/**
 * Recompute d365/all from each scanned wallet's live confirmed-tx history —
 * the exact `historyFromTxDeltas` derivation the wallet-detail page already
 * relies on for its own (unpersisted) multi-horizon view (see
 * `$lib/horizonDelta`'s module doc) — and prefer that over the persisted
 * balance_snapshots-derived values for those two fields specifically. d1/d30
 * pass through unchanged.
 *
 * Why this is needed (cairn-ht11): `getBalanceSeries` reads from
 * balance_snapshots, and the one-time backfill (`buildBackfillPoints`)
 * synthesizes a single carry-in point at the 1yr-horizon edge so a wallet
 * imported with older history still has SOMETHING there. But
 * `BACKFILL_HORIZON_MS` sits right at dataRetention's ~13-month purge
 * boundary, so that fixed-in-time carry-in point is guaranteed to fall out of
 * the retention window on some later sweep — and since the backfill only
 * ever runs once per wallet (guarded by "any rows exist"), the anchor is
 * never rewritten afterward. The persisted series then starts more recently
 * than it should for 1yr/all-time.
 *
 * That's not just a "1yr regresses to null" problem: `all` always reads
 * `series[0]`, so once the true earliest point is purged, `all` silently
 * reports the change since whatever the next-oldest SURVIVING row happens to
 * be — a wrong number (it can even flip sign), not an honest "no data". Only
 * d365's cutoff-walk can degrade cleanly to null; `all` can't, so both need
 * the live reconstruction, not just a null-fill.
 *
 * d1/d30 are never exposed to this: retention always keeps the last 30 days
 * at full hourly resolution, so the persisted values for those stay accurate
 * regardless of how the >30-day history ages.
 *
 * Deliberately does NOT touch the retention purge itself or persist anything:
 * dataRetention's ~13-month cap on stored balance_snapshots rows is a
 * privacy-motivated policy (2026-07-06 data audit), and it should keep
 * dropping old rows exactly as documented. This only patches the READ side so
 * a purge can never make Home show a horizon that contradicts what's still
 * honestly reconstructable from data every wallet page already trusts. Falls
 * back to the persisted d365/all (rather than guessing) when even the live
 * tx history can't reconstruct a trustworthy total — one wallet's tx data
 * failing the honesty check (missing timestamps, deltas that don't reconcile
 * with its scanned balance) makes the CROSS-wallet total untrustworthy too,
 * so the whole reconstruction is skipped rather than silently omitting that
 * wallet's share.
 */
function changeWithTxFallback(
	change: HorizonChange,
	scanned: AggregateInput[],
	currentTotal: number
): HorizonChange {
	if (scanned.length === 0) return change;

	const perWallet: HorizonSeriesPoint[][] = [];
	for (const w of scanned) {
		const series = historyFromTxDeltas(w.txs, w.confirmed);
		if (series === null) return change;
		perWallet.push(series);
	}

	const txSeries = mergeWalletSeries(perWallet);
	const txChange = changesFromHorizonSeries(txSeries, currentTotal);
	return {
		d1: change.d1,
		d30: change.d30,
		d365: txChange.d365,
		all: txChange.all
	};
}

// ------------------------------------------------------------------ aggregate

/**
 * One fully-scanned wallet, reduced to exactly what the aggregate needs. The
 * dashboard is "all your bitcoin at a glance", so both flavors collapse to the
 * same shape: a confirmed/unconfirmed balance plus the tx list (for allocation,
 * recent activity, and first-scan backfill). Produced two ways — live in
 * getPortfolioDetail, and (the SWR path) from persisted per-wallet snapshots in
 * walletSync.buildPortfolioAggregate.
 */
export interface AggregateInput {
	kind: WalletKind;
	id: number;
	name: string;
	href: string;
	confirmed: number;
	unconfirmed: number;
	txs: { txid: string; height: number; time: number | null; delta: number }[];
}

/**
 * Assemble the dashboard portfolio from already-scanned wallets — the pure
 * aggregation half, with NO Electrum work of its own. Records a snapshot when
 * every wallet was reachable, back-fills first-scan history, and builds
 * allocation, recent activity, the (bounded, downsampled) balance series,
 * sparklines, and lookback changes.
 *
 * `walletCount` is the number of wallets the user HAS (so scannedCount <
 * walletCount signals a partial outage); `scanned` carries only the ones that
 * produced data. This runs OFF the request-serving path — in the background
 * refresh pass — so its synchronous SQLite work (backfill, recordSnapshot,
 * getBalanceSeries) never blocks a GET (cairn — dashboard event-loop blocking).
 */
export function assemblePortfolio(
	userId: number,
	walletCount: number,
	tipHeight: number,
	scanned: AggregateInput[]
): PortfolioDetail {
	let confirmed = 0;
	let unconfirmed = 0;
	const allocation: AllocationSlice[] = [];
	const activity: PortfolioActivity[] = [];
	const snapshotEntries: { kind: WalletKind; id: number; balance: number }[] = [];

	for (const w of scanned) {
		// First-ever scan of this wallet: derive its balance history from the
		// tx list so an imported wallet charts from day one (cairn-ittq).
		try {
			backfillSnapshots(userId, w.kind, w.id, w.txs, w.confirmed);
		} catch (err) {
			log.warn({ err, kind: w.kind, walletId: w.id }, 'balance history backfill failed');
		}
		confirmed += w.confirmed;
		unconfirmed += w.unconfirmed;
		const key = `${w.kind}-${w.id}`;
		allocation.push({
			key,
			kind: w.kind,
			id: w.id,
			name: w.name,
			href: w.href,
			balance: w.confirmed,
			lastActivity: lastActivityOf(w.txs)
		});
		snapshotEntries.push({ kind: w.kind, id: w.id, balance: w.confirmed });
		for (const tx of w.txs) {
			activity.push({
				key: `${key}-${tx.txid}`,
				walletName: w.name,
				walletHref: w.href,
				txid: tx.txid,
				direction: tx.delta >= 0 ? 'in' : 'out',
				sats: Math.abs(tx.delta),
				time: tx.time,
				confirmations: confirmationsOf(tx.height, tipHeight)
			});
		}
	}

	// Newest first: unconfirmed (no time) ahead of confirmed, then by time desc.
	activity.sort((a, b) => {
		if (a.time === null && b.time === null) return 0;
		if (a.time === null) return -1;
		if (b.time === null) return 1;
		return b.time - a.time;
	});
	// Largest allocation first so the bar/donut reads big-to-small.
	allocation.sort((a, b) => b.balance - a.balance);

	// Only snapshot a complete picture, so the summed total series never dips
	// just because one wallet was briefly unreachable.
	if (walletCount > 0 && scanned.length === walletCount) {
		try {
			recordSnapshot(userId, snapshotEntries);
		} catch {
			/* snapshots are best-effort; never fail the dashboard over one */
		}
	}

	const balanceSeries = getBalanceSeries(userId);
	return {
		walletCount,
		scannedCount: scanned.length,
		confirmed,
		unconfirmed,
		allocation,
		recentActivity: activity.slice(0, 10),
		balanceSeries,
		sparklines: getSparklines(userId),
		change: changeWithTxFallback(changesFromSeries(balanceSeries, confirmed), scanned, confirmed)
	};
}

/**
 * The full dashboard portfolio, computed by LIVE-scanning every wallet
 * concurrently (cached per-xpub / per-descriptor). Retained for the warm/test
 * paths; the request-serving GET /api/portfolio no longer calls this — it reads
 * the persisted aggregate (portfolioSnapshot.ts) produced by the coalesced
 * background refresh pass (walletSync), which builds the same PortfolioDetail
 * from the per-wallet snapshots it already scanned, so there is one coordinated
 * refresh rather than a second competing scan path.
 */
export async function getPortfolioDetail(userId: number): Promise<PortfolioDetail> {
	const wallets = db
		.prepare('SELECT id, name, xpub FROM wallets WHERE user_id = ? ORDER BY created_at ASC, id ASC')
		.all(userId) as { id: number; name: string; xpub: string }[];
	const multisigs: MultisigRow[] = listMultisigs(userId);
	const walletCount = wallets.length + multisigs.length;

	// Tip height for confirmations — best-effort; unconfirmed rows report 0 anyway.
	// Bounded so a hung explorer/proxy can't stall the dashboard before scans even
	// start (cairn-3gvb).
	let tipHeight = 0;
	try {
		tipHeight = (
			await withTimeout(getChain().getTip(), TIP_LOOKUP_TIMEOUT_MS, 'portfolio tip lookup')
		).height;
	} catch {
		tipHeight = 0;
	}

	// Each scan is raced against SCAN_BUDGET_MS (cairn-3gvb / cairn-xsuq): a
	// slow/unreachable wallet — or every wallet, when a broken proxy makes each
	// dial hang — settles as null within the budget and is excluded from totals,
	// instead of dragging the whole Promise.all to the slowest wallet's timeout.
	const scanned = await Promise.all<ScannedWallet | null>([
		...wallets.map((w) =>
			withTimeout(scanWallet(w.xpub), PORTFOLIO_SCAN_TIMEOUT_MS, `wallet ${w.id} scan`).then(
				(scan): ScannedWallet => ({
					kind: 'wallet',
					id: w.id,
					name: w.name,
					href: `/wallets/${w.id}`,
					scan
				}),
				(err) => {
					// A scan failure (Electrum down, proxy rejected, or over-budget)
					// silently drops this wallet from the dashboard totals, understating
					// the balance — at least leave a trace to diagnose the partial
					// outage (cairn-ednl) / slow transport (cairn-xsuq), and never let
					// one stuck wallet hang the whole dashboard response (cairn-3gvb /
					// cairn-hy8z): every branch of this Promise.all is now guaranteed to
					// settle within PORTFOLIO_SCAN_TIMEOUT_MS regardless of how long the
					// underlying scan actually takes.
					log.warn({ err, walletId: w.id, kind: 'wallet' }, 'portfolio scan failed; wallet excluded from totals');
					return null;
				}
			)
		),
		...multisigs.map((m) =>
			withTimeout(scanMultisig(m), PORTFOLIO_SCAN_TIMEOUT_MS, `multisig ${m.id} scan`).then(
				(scan): ScannedWallet => ({
					kind: 'multisig',
					id: m.id,
					name: m.name,
					href: `/wallets/multisig/${m.id}`,
					scan
				}),
				(err) => {
					log.warn({ err, multisigId: m.id, kind: 'multisig' }, 'portfolio scan failed; multisig excluded from totals');
					return null;
				}
			)
		)
	]);

	const inputs: AggregateInput[] = [];
	for (const w of scanned) {
		if (!w) continue;
		inputs.push({
			kind: w.kind,
			id: w.id,
			name: w.name,
			href: w.href,
			confirmed: w.scan.confirmed,
			unconfirmed: w.scan.unconfirmed,
			txs: w.scan.txs
		});
	}

	return assemblePortfolio(userId, walletCount, tipHeight, inputs);
}
