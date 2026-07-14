import { describe, it, expect } from 'vitest';
import {
	coinbaseMaturity,
	isImmatureCoinbase,
	formatMaturityEta,
	COINBASE_MATURITY
} from './coinbase';

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

// cairn-oae1.4: MiningRewards.svelte's "spendable in ~N blocks (~Xh)" countdown.
describe('formatMaturityEta', () => {
	it("matches Alex's 42-of-100 example (58 blocks remaining)", () => {
		expect(formatMaturityEta(58)).toBe('~9.7 hours');
	});

	it('a freshly-mined reward (100 blocks remaining) reads ~16.7 hours', () => {
		expect(formatMaturityEta(100)).toBe('~16.7 hours');
	});

	it('the 99-confirmation edge (1 block remaining) drops to minutes, not "~0.2 hours"', () => {
		expect(formatMaturityEta(1)).toBe('~10 minutes');
	});

	it('zero blocks remaining (mature) reads as no wait', () => {
		expect(formatMaturityEta(0)).toBe('~0 minutes');
	});

	it('rounds sub-minute fragments to whole minutes below the 1-hour boundary', () => {
		expect(formatMaturityEta(5)).toBe('~50 minutes');
	});
});
