import { describe, it, expect } from 'vitest';
import {
	coinbaseMaturity,
	isImmatureCoinbase,
	formatMaturityEta,
	classifyCoinMaturity,
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

// cairn-8lwa6 root primitive: the shared display-side maturity classification.
// The send path already failed closed on unverifiable coinbase-ness; this is
// the display path's single shared answer (used by walletSync's snapshot
// derivation for wallet detail, Home, and the send fast path alike).
describe('classifyCoinMaturity', () => {
	const TIP = 1000;

	it('a definite non-coinbase coin is spendable at any age', () => {
		expect(classifyCoinMaturity(false, TIP, TIP)).toBe('spendable'); // 1 conf
		expect(classifyCoinMaturity(false, 1, TIP)).toBe('spendable');
	});

	it('a definite coinbase coin is maturing until COINBASE_MATURITY confs, spendable after', () => {
		expect(classifyCoinMaturity(true, TIP, TIP)).toBe('maturing'); // 1 conf
		expect(classifyCoinMaturity(true, TIP - COINBASE_MATURITY + 2, TIP)).toBe('maturing'); // 99 confs
		expect(classifyCoinMaturity(true, TIP - COINBASE_MATURITY + 1, TIP)).toBe('spendable'); // 100 confs
	});

	it('a definite coinbase coin with the tip unknown stays maturing (safe over-report)', () => {
		expect(classifyCoinMaturity(true, 500, 0)).toBe('maturing');
	});

	it("an 'unknown' young coin is unverified — never silently spendable (cairn-8lwa6)", () => {
		expect(classifyCoinMaturity('unknown', TIP, TIP)).toBe('unverified'); // 1 conf
		expect(classifyCoinMaturity('unknown', TIP - COINBASE_MATURITY + 2, TIP)).toBe('unverified'); // 99 confs
	});

	it("an 'unknown' coin past COINBASE_MATURITY confs is provably spendable either way", () => {
		expect(classifyCoinMaturity('unknown', TIP - COINBASE_MATURITY + 1, TIP)).toBe('spendable');
		expect(classifyCoinMaturity('unknown', 1, TIP)).toBe('spendable');
	});

	it("an 'unknown' coin with the tip unknown is unverified (fail closed)", () => {
		expect(classifyCoinMaturity('unknown', 500, 0)).toBe('unverified');
	});

	it('an unannotated (undefined) coin behaves like unknown', () => {
		expect(classifyCoinMaturity(undefined, TIP, TIP)).toBe('unverified');
		expect(classifyCoinMaturity(undefined, 1, TIP)).toBe('spendable');
	});
});
