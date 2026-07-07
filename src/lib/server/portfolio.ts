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
 * Per-wallet budget for a dashboard scan (cairn-3gvb/cairn-hy8z): a full
 * gap-limit scan makes many sequential Electrum round-trips, each individually
 * bounded by the client's own 15s request timeout, but a stuck proxy/server
 * can chain enough retries+fallbacks to stall a single wallet for minutes —
 * and since every wallet scan runs concurrently, ONE stuck wallet used to hang
 * the entire dashboard response (Promise.all only resolves once every promise
 * settles). Racing each scan against this timeout guarantees the whole
 * response always settles in bounded time; a timed-out wallet is excluded
 * from totals exactly like any other scan failure, and can complete "for
 * real" on the next poll if its ScanCache entry lands in the meantime.
 */
export const PORTFOLIO_SCAN_TIMEOUT_MS = 20_000;

/** The tip lookup is a single cheap Electrum call, not a full scan — a much
 *  tighter budget is enough, and it must not be allowed to stall the wallet
 *  scans that follow it in this function. */
const TIP_LOOKUP_TIMEOUT_MS = 8_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race `promise` against a timeout that rejects, never resolves. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		sleep(ms).then((): never => {
			throw new Error(`${label} timed out after ${ms}ms`);
		})
	]);
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
function lastActivityOf(scan: WalletScanResult | MultisigScanResult): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of scan.txs) {
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
 * Total confirmed sats over time (oldest first). Snapshot rows are per wallet
 * and — since historical backfill — NOT taken at shared timestamps, so the
 * total at each instant is the sum of every wallet's latest-known balance
 * (carry-forward), not a naive GROUP BY taken_at. Rows for since-deleted
 * wallets are excluded, matching what the retention sweep does permanently.
 */
export function getBalanceSeries(userId: number): BalancePoint[] {
	const rows = db
		.prepare(
			`SELECT wallet_kind, wallet_id, taken_at, balance_sats
			 FROM balance_snapshots
			 WHERE user_id = ?
			   AND ((wallet_kind = 'wallet' AND wallet_id IN (SELECT id FROM wallets))
			     OR (wallet_kind = 'multisig' AND wallet_id IN (SELECT id FROM multisigs)))
			 ORDER BY taken_at ASC, id ASC`
		)
		.all(userId) as {
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
	return out;
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
function backfillSnapshots(userId: number, w: ScannedWallet): void {
	const existing = db
		.prepare(
			'SELECT 1 FROM balance_snapshots WHERE user_id = ? AND wallet_kind = ? AND wallet_id = ? LIMIT 1'
		)
		.get(userId, w.kind, w.id);
	if (existing) return;

	const points = buildBackfillPoints(w.scan.txs, w.scan.confirmed, Date.now());
	if (points === null) {
		log.warn(
			{ kind: w.kind, walletId: w.id },
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
			insert.run(userId, w.kind, w.id, new Date(p.t * 1000).toISOString(), p.sats);
		}
		db.prepare('COMMIT').run();
		log.info({ kind: w.kind, walletId: w.id, points: points.length }, 'balance history backfilled');
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
 * Net change vs the snapshot nearest each lookback window. For "N days ago" we
 * take the most recent snapshot at or before that instant; null when no
 * snapshot reaches that far back.
 */
function changesFromSeries(
	series: BalancePoint[],
	currentTotal: number
): { d1: number | null; d7: number | null; d30: number | null } {
	const nowS = Math.floor(Date.now() / 1000);
	const at = (days: number): number | null => {
		const cutoff = nowS - days * 86400;
		let value: number | null = null;
		for (const p of series) {
			if (p.t <= cutoff) value = p.sats; // series is oldest-first
			else break;
		}
		return value === null ? null : currentTotal - value;
	};
	return { d1: at(1), d7: at(7), d30: at(30) };
}

// ------------------------------------------------------------------ aggregate

/**
 * The full dashboard portfolio. Scans every wallet concurrently (cached
 * per-xpub / per-descriptor), records a snapshot when everything is reachable,
 * and assembles allocation, recent activity, the balance series, sparklines,
 * and lookback changes.
 */
export async function getPortfolioDetail(userId: number): Promise<PortfolioDetail> {
	const wallets = db
		.prepare('SELECT id, name, xpub FROM wallets WHERE user_id = ? ORDER BY created_at ASC, id ASC')
		.all(userId) as { id: number; name: string; xpub: string }[];
	const multisigs: MultisigRow[] = listMultisigs(userId);
	const walletCount = wallets.length + multisigs.length;

	// Tip height for confirmations — best-effort; unconfirmed rows report 0 anyway.
	let tipHeight = 0;
	try {
		tipHeight = (await withTimeout(getChain().getTip(), TIP_LOOKUP_TIMEOUT_MS, 'tip lookup')).height;
	} catch {
		tipHeight = 0;
	}

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
					// A scan failure (e.g. Electrum down, or the timeout above) silently
					// drops this wallet from the dashboard totals, understating the
					// balance — at least leave a trace to diagnose the partial outage
					// (cairn-ednl), and never let one stuck wallet hang the whole
					// dashboard response (cairn-3gvb/cairn-hy8z): every branch of this
					// Promise.all is now guaranteed to settle within
					// PORTFOLIO_SCAN_TIMEOUT_MS regardless of how long the underlying
					// scan actually takes.
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

	let confirmed = 0;
	let unconfirmed = 0;
	let scannedCount = 0;
	const allocation: AllocationSlice[] = [];
	const activity: PortfolioActivity[] = [];
	const snapshotEntries: { kind: WalletKind; id: number; balance: number }[] = [];

	for (const w of scanned) {
		if (!w) continue;
		scannedCount++;
		// First-ever scan of this wallet: derive its balance history from the
		// tx list so an imported wallet charts from day one (cairn-ittq).
		try {
			backfillSnapshots(userId, w);
		} catch (err) {
			log.warn({ err, kind: w.kind, walletId: w.id }, 'balance history backfill failed');
		}
		confirmed += w.scan.confirmed;
		unconfirmed += w.scan.unconfirmed;
		const key = `${w.kind}-${w.id}`;
		allocation.push({
			key,
			kind: w.kind,
			id: w.id,
			name: w.name,
			href: w.href,
			balance: w.scan.confirmed,
			lastActivity: lastActivityOf(w.scan)
		});
		snapshotEntries.push({ kind: w.kind, id: w.id, balance: w.scan.confirmed });
		for (const tx of w.scan.txs) {
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
	if (walletCount > 0 && scannedCount === walletCount) {
		try {
			recordSnapshot(userId, snapshotEntries);
		} catch {
			/* snapshots are best-effort; never fail the dashboard over one */
		}
	}

	const balanceSeries = getBalanceSeries(userId);
	return {
		walletCount,
		scannedCount,
		confirmed,
		unconfirmed,
		allocation,
		recentActivity: activity.slice(0, 10),
		balanceSeries,
		sparklines: getSparklines(userId),
		change: changesFromSeries(balanceSeries, confirmed)
	};
}
