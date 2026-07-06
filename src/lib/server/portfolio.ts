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
 * Record a snapshot tick (one row per wallet, shared timestamp) if the last one
 * is older than SNAPSHOT_INTERVAL_MS. Reuses balances already computed by a
 * portfolio fetch, so it costs one cheap write and no chain calls. Callers pass
 * only fully-scanned balances so the summed total series stays accurate.
 */
export function recordSnapshot(
	userId: number,
	entries: { kind: WalletKind; id: number; balance: number }[]
): void {
	if (entries.length === 0) return;
	const last = db
		.prepare('SELECT taken_at FROM balance_snapshots WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1')
		.get(userId) as { taken_at: string } | undefined;
	if (last && Date.now() - Date.parse(last.taken_at) < SNAPSHOT_INTERVAL_MS) return;

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

/** Total confirmed sats over time (oldest first), summed across wallets per tick. */
export function getBalanceSeries(userId: number): BalancePoint[] {
	const rows = db
		.prepare(
			`SELECT taken_at, SUM(balance_sats) AS total
			 FROM balance_snapshots WHERE user_id = ?
			 GROUP BY taken_at ORDER BY taken_at ASC`
		)
		.all(userId) as { taken_at: string; total: number }[];
	return rows.map((r) => ({ t: Math.floor(Date.parse(r.taken_at) / 1000), sats: r.total }));
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
		tipHeight = (await getChain().getTip()).height;
	} catch {
		tipHeight = 0;
	}

	const scanned = await Promise.all<ScannedWallet | null>([
		...wallets.map((w) =>
			scanWallet(w.xpub).then(
				(scan): ScannedWallet => ({
					kind: 'wallet',
					id: w.id,
					name: w.name,
					href: `/wallets/${w.id}`,
					scan
				}),
				(err) => {
					// A scan failure (e.g. Electrum down) silently drops this wallet from
					// the dashboard totals, understating the balance — at least leave a
					// trace to diagnose the partial outage (cairn-ednl).
					log.warn({ err, walletId: w.id, kind: 'wallet' }, 'portfolio scan failed; wallet excluded from totals');
					return null;
				}
			)
		),
		...multisigs.map((m) =>
			scanMultisig(m).then(
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
