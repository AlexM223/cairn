import { describe, it, expect } from 'vitest';
import { formatHashrate, estimateHashrate, soloOdds } from './hashrate';

describe('formatHashrate ladder', () => {
	it('renders unknown/empty as em-dash, never a false 0', () => {
		expect(formatHashrate(null)).toBe('—');
		expect(formatHashrate(undefined)).toBe('—');
		expect(formatHashrate(0)).toBe('—');
		expect(formatHashrate(-5)).toBe('—');
		expect(formatHashrate(NaN)).toBe('—');
		expect(formatHashrate(Infinity)).toBe('—');
	});

	it('renders a Bitaxe-scale miner in GH/s and TH/s (the past-bug case)', () => {
		// ~490 GH/s Bitaxe — must NOT collapse to "0.0 PH/s".
		expect(formatHashrate(490e9)).toBe('490 GH/s');
		// 1.2 TH/s Bitaxe Gamma.
		expect(formatHashrate(1.2e12)).toBe('1.2 TH/s');
	});

	it('picks the largest applicable unit with correct precision', () => {
		expect(formatHashrate(1)).toBe('1.0 H/s');
		expect(formatHashrate(999)).toBe('999 H/s');
		expect(formatHashrate(1500)).toBe('1.5 kH/s');
		expect(formatHashrate(2.5e6)).toBe('2.5 MH/s');
		expect(formatHashrate(12.3e9)).toBe('12.3 GH/s');
		expect(formatHashrate(5e17)).toBe('500 PH/s');
		expect(formatHashrate(5e18)).toBe('5.0 EH/s');
		// Network scale renders in EH/s, capped there for huge inputs.
		expect(formatHashrate(6e20)).toBe('600 EH/s');
	});

	it('switches from 1 decimal to 0 at 100 in the chosen unit', () => {
		expect(formatHashrate(99e9)).toBe('99.0 GH/s');
		expect(formatHashrate(100e9)).toBe('100 GH/s');
	});
});

describe('estimateHashrate', () => {
	it('= sumDifficulty · 2^32 / windowSec', () => {
		expect(estimateHashrate(1, 1)).toBeCloseTo(2 ** 32, 6);
		// 600 difficulty over a 600s window → 2^32 H/s average.
		expect(estimateHashrate(600, 600)).toBeCloseTo(2 ** 32, 6);
	});

	it('returns 0 for empty/invalid windows or share sums (never NaN/Infinity)', () => {
		expect(estimateHashrate(0, 600)).toBe(0);
		expect(estimateHashrate(100, 0)).toBe(0);
		expect(estimateHashrate(100, -1)).toBe(0);
		expect(estimateHashrate(NaN, 600)).toBe(0);
		expect(estimateHashrate(100, Infinity)).toBe(0);
	});
});

describe('soloOdds', () => {
	it('is null when either rate is missing or non-positive', () => {
		expect(soloOdds(0, 1e18)).toBeNull();
		expect(soloOdds(1e12, 0)).toBeNull();
		expect(soloOdds(-1, 1e18)).toBeNull();
		expect(soloOdds(1e12, NaN)).toBeNull();
	});

	it('computes expected years and daily probability from the hashrate fraction', () => {
		const userHps = 1e12; // 1 TH/s
		const networkHps = 6e20; // 600 EH/s
		const odds = soloOdds(userHps, networkHps)!;
		expect(odds).not.toBeNull();
		const fraction = userHps / networkHps;
		expect(odds.expectedYearsPerBlock).toBeCloseTo(1 / (fraction * 52560), 3);
		expect(odds.probPerDayPct).toBeCloseTo((1 - Math.exp(-fraction * 144)) * 100, 10);
		// A tiny fraction → an astronomically long wait and a near-zero daily chance.
		expect(odds.expectedYearsPerBlock).toBeGreaterThan(1000);
		expect(odds.probPerDayPct).toBeLessThan(1);
	});

	it('a dominant miner has short expected time and high daily odds', () => {
		const odds = soloOdds(3e20, 6e20)!; // half the network
		expect(odds.expectedYearsPerBlock).toBeLessThan(0.001);
		expect(odds.probPerDayPct).toBeGreaterThan(99);
	});
});
