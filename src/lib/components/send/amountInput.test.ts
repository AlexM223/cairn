import { describe, it, expect } from 'vitest';
import { sanitizeDecimal, textToSats, SATS_PER_BTC } from './amountInput';

describe('sanitizeDecimal', () => {
	it('strips letters, keeping digits and a single decimal point (cairn-wi8a)', () => {
		expect(sanitizeDecimal('0.001hello')).toBe('0.001');
		expect(sanitizeDecimal('abc')).toBe('');
		expect(sanitizeDecimal('12ab34')).toBe('1234');
	});

	it('keeps only the first decimal point', () => {
		expect(sanitizeDecimal('1.2.3')).toBe('1.23');
		expect(sanitizeDecimal('1..2')).toBe('1.2');
	});

	it('drops commas / grouping separators', () => {
		expect(sanitizeDecimal('1,000.5')).toBe('1000.5');
		expect(sanitizeDecimal('1 000')).toBe('1000');
	});

	it('passes clean numeric strings through unchanged', () => {
		expect(sanitizeDecimal('0.005')).toBe('0.005');
		expect(sanitizeDecimal('.5')).toBe('.5');
		expect(sanitizeDecimal('')).toBe('');
	});
});

describe('textToSats', () => {
	it('returns 0 for non-numeric or non-positive input', () => {
		expect(textToSats('abc', 'btc', null)).toBe(0);
		expect(textToSats('', 'btc', null)).toBe(0);
		expect(textToSats('0', 'btc', null)).toBe(0);
		expect(textToSats('-1', 'btc', null)).toBe(0);
	});

	it('converts BTC to sats', () => {
		expect(textToSats('1', 'btc', null)).toBe(SATS_PER_BTC);
		expect(textToSats('0.001', 'btc', null)).toBe(100_000);
	});

	it('rounds sats input to an integer', () => {
		expect(textToSats('1860', 'sats', null)).toBe(1860);
		expect(textToSats('1,860', 'sats', null)).toBe(1860);
	});

	it('converts fiat at the given price, and needs a positive price', () => {
		expect(textToSats('100', 'fiat', 100_000)).toBe(100_000);
		expect(textToSats('100', 'fiat', null)).toBe(0);
		expect(textToSats('100', 'fiat', 0)).toBe(0);
	});
});
