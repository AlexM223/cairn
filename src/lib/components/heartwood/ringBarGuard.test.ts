import { describe, it, expect } from 'vitest';
import { ringBarVisible, ringBarPct } from './ringBarGuard';

describe('ringBarVisible', () => {
	it('is false for null (unknown, Electrum-only baseline)', () => {
		expect(ringBarVisible(null)).toBe(false);
	});

	it('is false for undefined (missing key on an imperfect/synthetic snapshot, cairn-6efi.11)', () => {
		expect(ringBarVisible(undefined)).toBe(false);
	});

	it('is false for non-finite values', () => {
		expect(ringBarVisible(NaN)).toBe(false);
		expect(ringBarVisible(Infinity)).toBe(false);
	});

	it('is false for 0 (a real block is never 0% full at a known weight — 0 means unknown)', () => {
		expect(ringBarVisible(0)).toBe(false);
	});

	it('is false for negative values', () => {
		expect(ringBarVisible(-0.1)).toBe(false);
	});

	it('is true for a real fraction', () => {
		expect(ringBarVisible(0.42)).toBe(true);
		expect(ringBarVisible(1)).toBe(true);
	});
});

describe('ringBarPct', () => {
	it('is 0 for null/undefined/NaN/0/negative', () => {
		expect(ringBarPct(null)).toBe(0);
		expect(ringBarPct(undefined)).toBe(0);
		expect(ringBarPct(NaN)).toBe(0);
		expect(ringBarPct(0)).toBe(0);
		expect(ringBarPct(-1)).toBe(0);
	});

	it('rounds to a 0..100 integer, clamped', () => {
		expect(ringBarPct(0.5)).toBe(50);
		expect(ringBarPct(1)).toBe(100);
		expect(ringBarPct(1.5)).toBe(100); // clamped, not 150
	});
});
