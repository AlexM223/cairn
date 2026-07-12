import { describe, it, expect } from 'vitest';
import { computeBalanceDelta, DUST_BASELINE_SATS, DUST_END_BALANCE_SATS } from './balanceDelta';

describe('computeBalanceDelta', () => {
	it('computes an up/down/flat direction and a percentage off a real baseline', () => {
		const up = computeBalanceDelta(100_000, 150_000);
		expect(up.sats).toBe(50_000);
		expect(up.pct).toBe(50);
		expect(up.dir).toBe('up');
		expect(up.dust).toBe(false);

		const down = computeBalanceDelta(150_000, 100_000);
		expect(down.sats).toBe(-50_000);
		expect(down.dir).toBe('down');

		const flat = computeBalanceDelta(100_000, 100_000);
		expect(flat.sats).toBe(0);
		expect(flat.dir).toBe('flat');
	});

	it('falls back to a null percentage when the baseline is zero', () => {
		const d = computeBalanceDelta(0, 5_000);
		expect(d.pct).toBeNull();
		expect(d.sats).toBe(5_000);
	});

	it('is not dust when both baseline and end balance clear the thresholds', () => {
		const d = computeBalanceDelta(DUST_BASELINE_SATS, DUST_END_BALANCE_SATS + 1);
		expect(d.dust).toBe(false);
	});

	it('is dust when the baseline is below the dust-baseline threshold, even with a healthy end balance', () => {
		const d = computeBalanceDelta(DUST_BASELINE_SATS - 1, 1_000_000);
		expect(d.dust).toBe(true);
	});

	it('is dust when the end balance is below the dust-end threshold, even with a healthy baseline', () => {
		const d = computeBalanceDelta(1_000_000, DUST_END_BALANCE_SATS - 1);
		expect(d.dust).toBe(true);
	});

	it('is dust at the boundary values themselves (strictly-less-than thresholds)', () => {
		expect(computeBalanceDelta(DUST_BASELINE_SATS, DUST_END_BALANCE_SATS).dust).toBe(false);
		expect(computeBalanceDelta(DUST_BASELINE_SATS - 1, DUST_END_BALANCE_SATS).dust).toBe(true);
		expect(computeBalanceDelta(DUST_BASELINE_SATS, DUST_END_BALANCE_SATS - 1).dust).toBe(true);
	});

	it('is dust for an all-zero (brand new, untouched) window', () => {
		const d = computeBalanceDelta(0, 0);
		expect(d.dust).toBe(true);
		expect(d.dir).toBe('flat');
	});
});
