import { describe, it, expect } from 'vitest';
import {
	changesFromHorizonSeries,
	historyFromTxDeltas,
	buildHorizonRows,
	type HorizonSeriesPoint
} from './horizonDelta';

const DAY = 86400;

describe('changesFromHorizonSeries', () => {
	it('returns null for a horizon with no data reaching that far back', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const series: HorizonSeriesPoint[] = [{ t: nowS - 5 * DAY, sats: 100_000 }];
		const change = changesFromHorizonSeries(series, 150_000);
		expect(change.d1).toBe(50_000); // the only point is before the 1d cutoff
		expect(change.d30).toBeNull(); // history doesn't reach back 30d
		expect(change.d365).toBeNull();
		expect(change.all).toBe(50_000); // vs the earliest known point
	});

	it('takes the most recent point at or before each cutoff', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const series: HorizonSeriesPoint[] = [
			{ t: nowS - 400 * DAY, sats: 10_000 },
			{ t: nowS - 40 * DAY, sats: 60_000 },
			{ t: nowS - 5 * DAY, sats: 90_000 }
		];
		const change = changesFromHorizonSeries(series, 100_000);
		expect(change.d1).toBe(10_000); // vs the 5d-ago point (nearest at/before 1d cutoff)
		expect(change.d30).toBe(40_000); // vs the 40d-ago point (nearest at/before 30d cutoff)
		expect(change.d365).toBe(90_000); // vs the 400d-ago point (nearest at/before 365d cutoff)
		expect(change.all).toBe(90_000); // vs the very first point
	});

	it('returns all-null when there is no history at all', () => {
		const change = changesFromHorizonSeries([], 100_000);
		expect(change).toEqual({ d1: null, d30: null, d365: null, all: null });
	});
});

describe('historyFromTxDeltas', () => {
	it('walks confirmed tx deltas into a point-in-time series', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const history = historyFromTxDeltas(
			[
				{ time: nowS - 10 * DAY, height: 100, delta: 50_000 },
				{ time: nowS - 2 * DAY, height: 200, delta: -10_000 },
				{ time: null, height: 0, delta: 20_000 } // unconfirmed, excluded
			],
			40_000
		);
		expect(history).toEqual([
			{ t: nowS - 10 * DAY, sats: 50_000 },
			{ t: nowS - 2 * DAY, sats: 40_000 }
		]);
	});

	it('collapses same-second txs into the final running balance', () => {
		const t = 1_700_000_000;
		const history = historyFromTxDeltas(
			[
				{ time: t, height: 10, delta: 10_000 },
				{ time: t, height: 10, delta: -4_000 }
			],
			6_000
		);
		expect(history).toEqual([{ t, sats: 6_000 }]);
	});

	it('returns null when a confirmed tx is missing a timestamp (can\'t trust the walk)', () => {
		const history = historyFromTxDeltas([{ time: null, height: 50, delta: 10_000 }], 10_000);
		expect(history).toBeNull();
	});

	it("returns null when the deltas don't reconcile with the scanned balance", () => {
		const history = historyFromTxDeltas(
			[{ time: 1_700_000_000, height: 10, delta: 10_000 }],
			99_999 // doesn't match the running total
		);
		expect(history).toBeNull();
	});

	it('returns an empty series (not null) when there are no confirmed txs yet', () => {
		expect(historyFromTxDeltas([{ time: null, height: 0, delta: 5_000 }], 0)).toEqual([]);
	});
});

describe('buildHorizonRows', () => {
	it('leads with percent, marks growth "up" and everything else neutral', () => {
		const rows = buildHorizonRows({ d1: 0, d30: 20_000, d365: -5_000, all: null }, 220_000);
		expect(rows).toHaveLength(4);

		const d1 = rows.find((r) => r.key === 'd1')!;
		expect(d1.dir).toBe('flat');
		expect(d1.sats).toBe(0);

		const d30 = rows.find((r) => r.key === 'd30')!;
		expect(d30.dir).toBe('up');
		expect(d30.sats).toBe(20_000);
		// baseline = 220000 - 20000 = 200000 -> pct = 10
		expect(d30.pct).toBeCloseTo(10);

		const d365 = rows.find((r) => r.key === 'd365')!;
		expect(d365.dir).toBe('down'); // never "down-red" at this layer — color is a UI concern
		expect(d365.sats).toBe(-5_000);

		const all = rows.find((r) => r.key === 'all')!;
		expect(all.dir).toBe('unknown');
		expect(all.sats).toBeNull();
		expect(all.pct).toBeNull();
	});

	it('omits a percentage when the baseline is below the dust floor', () => {
		const rows = buildHorizonRows({ d1: 5_000, d30: null, d365: null, all: null }, 5_000);
		const d1 = rows.find((r) => r.key === 'd1')!;
		// baseline = 5000 - 5000 = 0 -> no meaningful percent, sats still honest
		expect(d1.pct).toBeNull();
		expect(d1.sats).toBe(5_000);
		expect(d1.dir).toBe('up');
	});

	it('always returns all four horizons in a fixed order, even with zero data', () => {
		const rows = buildHorizonRows({ d1: null, d30: null, d365: null, all: null }, 0);
		expect(rows.map((r) => r.key)).toEqual(['d1', 'd30', 'd365', 'all']);
		expect(rows.every((r) => r.dir === 'unknown')).toBe(true);
	});
});
