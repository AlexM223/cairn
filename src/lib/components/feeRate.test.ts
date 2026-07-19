// FeeRate pure-logic tests (UX-REDESIGN-SPEC.md §2.5, cairn-gt05.4): the
// rate→plain-time mapping and the number/unit split behind the shared FeeRate
// component. The mapping must never invent a time for an unknown rate, and the
// split must never strand a gloss on a dash.

import { describe, expect, it } from 'vitest';
import { feeRatePlainTime, feeRateParts, type FeeEstimates } from './feeRate';

const fees: FeeEstimates = { fastest: 10, halfHour: 5, hour: 2, economy: 1 };

describe('feeRatePlainTime', () => {
	it('maps a rate at/above the fastest estimate to the next block', () => {
		expect(feeRatePlainTime(10, fees)).toBe('≈ next block');
		expect(feeRatePlainTime(250, fees)).toBe('≈ next block');
	});

	it('maps the tiers between estimates to plain times', () => {
		expect(feeRatePlainTime(5, fees)).toBe('≈ 30 min');
		expect(feeRatePlainTime(9.9, fees)).toBe('≈ 30 min');
		expect(feeRatePlainTime(2, fees)).toBe('≈ 1 hour');
		expect(feeRatePlainTime(4.5, fees)).toBe('≈ 1 hour');
		expect(feeRatePlainTime(1, fees)).toBe('a few hours');
		expect(feeRatePlainTime(1.9, fees)).toBe('a few hours');
	});

	it('is honest below the economy rate', () => {
		expect(feeRatePlainTime(0.5, fees)).toBe('a long wait');
		expect(feeRatePlainTime(0, fees)).toBe('a long wait');
	});

	it('never invents a time when either side is unknown', () => {
		expect(feeRatePlainTime(null, fees)).toBeNull();
		expect(feeRatePlainTime(undefined, fees)).toBeNull();
		expect(feeRatePlainTime(3, null)).toBeNull();
		expect(feeRatePlainTime(3, undefined)).toBeNull();
	});

	it('treats non-finite or negative rates as unknown, not as cheap', () => {
		expect(feeRatePlainTime(Number.NaN, fees)).toBeNull();
		expect(feeRatePlainTime(Number.POSITIVE_INFINITY, fees)).toBeNull();
		expect(feeRatePlainTime(Number.NEGATIVE_INFINITY, fees)).toBeNull();
		expect(feeRatePlainTime(-1, fees)).toBeNull();
	});
});

describe('feeRateParts', () => {
	it('splits a whole-number rate into number + unit', () => {
		expect(feeRateParts(12, null)).toEqual({ num: '12', unit: 'sat/vB' });
	});

	it('keeps sub-10 and sub-1 precision from formatFeeRate', () => {
		expect(feeRateParts(2.5, null)).toEqual({ num: '2.5', unit: 'sat/vB' });
		expect(feeRateParts(0.1, null)).toEqual({ num: '0.1', unit: 'sat/vB' });
	});

	it('renders a range as "a–b" with one unit', () => {
		expect(feeRateParts(null, [1, 34])).toEqual({ num: '1–34', unit: 'sat/vB' });
	});

	it('a range wins over a rate when both are given', () => {
		expect(feeRateParts(7, [1, 2])).toEqual({ num: '1–2', unit: 'sat/vB' });
	});

	it('returns null (a plain dash, no gloss) when nothing is known', () => {
		expect(feeRateParts(null, null)).toBeNull();
		expect(feeRateParts(undefined, undefined)).toBeNull();
	});

	it('a zero rate still renders as a number, not a dash', () => {
		expect(feeRateParts(0, null)).toEqual({ num: '0', unit: 'sat/vB' });
	});
});
