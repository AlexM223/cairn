// Multi-horizon balance delta — the shared, framework-agnostic core behind
// DESIGN-MANIFESTO.md's "Notification & delta-display rules" (MUST):
//
//   "No naked point-deltas. Any value-change display shows 1d / 30d / 1yr /
//   all-time together (Wealthfront/Betterment multi-horizon) so a red day
//   can't dominate the emotional read... Lead growth stories with percent
//   framing ('+8% this month'); keep absolute sats one layer down... Down is
//   neutral, never red — price wobble is not a decision."
//
// Two producers feed the same renderer:
//   - portfolio.ts (server): computes HorizonChange from the persisted
//     cross-wallet balance_snapshots series (changesFromHorizonSeries).
//   - the wallet-detail page (client): has no balance_snapshots wired to its
//     loader, but it already has the wallet's confirmed-tx list (the same
//     data WalletStepChart reconstructs its balance line from) — so
//     historyFromTxDeltas derives an equally honest point-in-time series from
//     that, using the identical "walk the deltas, verify they sum to the
//     scanned balance" trust check portfolio.ts's own backfill uses.
//
// No `$lib/server` imports here on purpose — this file runs on both sides.

export interface HorizonSeriesPoint {
	t: number; // unix seconds
	sats: number; // total balance at that instant
}

/** Net sats change vs the balance nearest each horizon's start, and vs the
 *  very first known point (all-time). `null` means "no data reaches back
 *  that far" — never a fabricated zero (Cardinal rule: a missing value
 *  renders as nothing, never a fake number). */
export interface HorizonChange {
	d1: number | null;
	d30: number | null;
	d365: number | null;
	all: number | null;
}

/**
 * Net change vs the point nearest each lookback window's start. For "N days
 * ago" this takes the most recent point at or before that instant (series is
 * oldest-first); `all` compares against the very first point. Shared by both
 * producers so "how far back can we honestly claim" is defined exactly once.
 */
export function changesFromHorizonSeries(
	series: HorizonSeriesPoint[],
	currentTotal: number,
	nowMs: number = Date.now()
): HorizonChange {
	const nowS = Math.floor(nowMs / 1000);
	const at = (days: number): number | null => {
		const cutoff = nowS - days * 86400;
		let value: number | null = null;
		for (const p of series) {
			if (p.t <= cutoff) value = p.sats; // series is oldest-first
			else break;
		}
		return value === null ? null : currentTotal - value;
	};
	const all = series.length > 0 ? currentTotal - series[0].sats : null;
	return { d1: at(1), d30: at(30), d365: at(365), all };
}

/** One confirmed-tx delta, as already carried by wallet scan results
 *  (WalletScanResult['txs'] / MultisigScanResult['txs']). */
export interface TxDeltaPoint {
	time: number | null;
	height: number;
	delta: number;
}

/**
 * Derive a point-in-time balance series from a wallet's own confirmed
 * transactions — the same honest reconstruction portfolio.ts's
 * buildBackfillPoints uses server-side, adapted for a single wallet with no
 * persisted snapshot table of its own. Returns `null` when the history can't
 * be trusted to reconstruct the balance (a confirmed tx missing a timestamp,
 * or deltas that don't sum to the scanned confirmed balance) — better to show
 * nothing than a number that contradicts the live balance.
 */
export function historyFromTxDeltas(
	txs: TxDeltaPoint[],
	confirmedBalance: number
): HorizonSeriesPoint[] | null {
	const confirmed = txs.filter((tx) => tx.height > 0);
	if (confirmed.length === 0) return [];
	if (confirmed.some((tx) => tx.time == null)) return null;

	const sorted = confirmed
		.map((tx) => ({ time: tx.time as number, delta: tx.delta }))
		.sort((a, b) => a.time - b.time);

	let running = 0;
	const points: HorizonSeriesPoint[] = [];
	for (const tx of sorted) {
		running += tx.delta;
		const prev = points[points.length - 1];
		if (prev && prev.t === tx.time) {
			prev.sats = running; // same-second txs collapse to the final balance
		} else {
			points.push({ t: tx.time, sats: running });
		}
	}
	if (running !== confirmedBalance) return null; // can't reconcile — say nothing
	return points;
}

export type HorizonDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface HorizonRow {
	key: 'd1' | 'd30' | 'd365' | 'all';
	label: string;
	/** Net sats change, or null when this horizon has no data yet. */
	sats: number | null;
	/** Percent change vs the baseline at the start of the window, or null
	 *  when the baseline was 0 (no meaningful percentage). */
	pct: number | null;
	dir: HorizonDirection;
}

const HORIZON_LABELS: Record<HorizonRow['key'], string> = {
	d1: '1d',
	d30: '30d',
	d365: '1yr',
	all: 'All time'
};

/** Below this baseline, a computed percentage swings wildly on tiny absolute
 *  moves — same threshold rationale as the chart's per-range delta chip
 *  (components/portfolio/balanceDelta.ts's DUST_BASELINE_SATS). */
const PCT_BASELINE_FLOOR_SATS = 10_000;

function rowFor(key: HorizonRow['key'], sats: number | null, currentTotal: number): HorizonRow {
	if (sats === null) return { key, label: HORIZON_LABELS[key], sats: null, pct: null, dir: 'unknown' };
	const baseline = currentTotal - sats;
	const pct = baseline >= PCT_BASELINE_FLOOR_SATS ? (sats / baseline) * 100 : null;
	const dir: HorizonDirection = sats > 0 ? 'up' : sats < 0 ? 'down' : 'flat';
	return { key, label: HORIZON_LABELS[key], sats, pct, dir };
}

/**
 * Turn a HorizonChange into the four rows the UI renders together (MUST: all
 * four always shown as one set, never a single horizon alone). Pure and
 * shared by Home and wallet-detail so both surfaces read identically.
 */
export function buildHorizonRows(change: HorizonChange, currentTotal: number): HorizonRow[] {
	return [
		rowFor('d1', change.d1, currentTotal),
		rowFor('d30', change.d30, currentTotal),
		rowFor('d365', change.d365, currentTotal),
		rowFor('all', change.all, currentTotal)
	];
}
