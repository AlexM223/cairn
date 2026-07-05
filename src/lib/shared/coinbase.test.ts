import { describe, it, expect } from 'vitest';
import { coinbaseMaturity, isImmatureCoinbase, COINBASE_MATURITY } from './coinbase';

describe('coinbase maturity', () => {
	it('requires 100 confirmations', () => {
		expect(COINBASE_MATURITY).toBe(100);
	});

	it('reports immature just below the threshold', () => {
		// Mined at height 900000, tip at 900098 → 99 confirmations.
		const m = coinbaseMaturity(900000, 900098);
		expect(m.confirmations).toBe(99);
		expect(m.mature).toBe(false);
		expect(m.blocksRemaining).toBe(1);
		expect(m.etaHours).toBe(1); // ~10 min → rounds up to 1h
		expect(isImmatureCoinbase(900000, 900098)).toBe(true);
	});

	it('reports mature at exactly 100 confirmations', () => {
		// Mined at 900000, tip at 900099 → 100 confirmations.
		const m = coinbaseMaturity(900000, 900099);
		expect(m.confirmations).toBe(100);
		expect(m.mature).toBe(true);
		expect(m.blocksRemaining).toBe(0);
		expect(m.etaHours).toBe(0);
		expect(isImmatureCoinbase(900000, 900099)).toBe(false);
	});

	it('stays mature well past the threshold', () => {
		expect(coinbaseMaturity(800000, 900000).mature).toBe(true);
	});

	it('a freshly-mined reward needs the full window', () => {
		const m = coinbaseMaturity(900000, 900000); // 1 confirmation
		expect(m.confirmations).toBe(1);
		expect(m.blocksRemaining).toBe(99);
		expect(m.mature).toBe(false);
		// ~99 * 10 min = 990 min = 16.5h → rounds up to 17h
		expect(m.etaHours).toBe(17);
	});

	it('treats an unconfirmed output (height 0) as 0 confirmations', () => {
		const m = coinbaseMaturity(0, 900000);
		expect(m.confirmations).toBe(0);
		expect(m.mature).toBe(false);
	});

	it('never reports negative confirmations if the tip is behind', () => {
		const m = coinbaseMaturity(900010, 900000);
		expect(m.confirmations).toBe(0);
		expect(m.mature).toBe(false);
	});
});
