import { describe, it, expect } from 'vitest';
import { blockSubsidy, feeOutlook, addressTypeInfo, ADDRESS_TYPES } from './bitcoin';

describe('blockSubsidy', () => {
	it.each([
		[0, 5_000_000_000], // genesis: 50 BTC
		[209_999, 5_000_000_000], // last block before the first halving
		[210_000, 2_500_000_000], // first halving
		[420_000, 1_250_000_000], // second halving
		[840_000, 312_500_000], // fourth halving: 3.125 BTC
		[6_930_000, 0], // 33rd halving: sub-satoshi, floored to 0
		[10_000_000, 0],
		[64 * 210_000, 0] // >= 64 halvings short-circuit
	])('height %i -> %i sats', (height, expected) => {
		expect(blockSubsidy(height)).toBe(expected);
	});

	it('halves exactly at each 210,000-block boundary', () => {
		for (let halving = 1; halving <= 6; halving++) {
			const boundary = halving * 210_000;
			expect(blockSubsidy(boundary)).toBe(Math.floor(5_000_000_000 / 2 ** halving));
			expect(blockSubsidy(boundary - 1)).toBe(Math.floor(5_000_000_000 / 2 ** (halving - 1)));
		}
	});
});

describe('feeOutlook', () => {
	const fees = { fastest: 100, halfHour: 50, hour: 20, economy: 5 };

	it.each([
		[150, 'likely in the next block (~10 min)'],
		[100, 'likely in the next block (~10 min)'], // boundary is inclusive
		[99, 'likely within ~30 minutes'],
		[50, 'likely within ~30 minutes'],
		[49, 'likely within ~1 hour'],
		[20, 'likely within ~1 hour'],
		[19, 'may take several hours'],
		[5, 'may take several hours'],
		[4.9, 'below the economy rate — could wait a long time or be dropped'],
		[0, 'below the economy rate — could wait a long time or be dropped']
	])('%d sat/vB -> %s', (rate, phrase) => {
		expect(feeOutlook(rate, fees)).toBe(phrase);
	});
});

describe('addressTypeInfo', () => {
	it('returns info for known script types', () => {
		expect(addressTypeInfo('p2pkh')?.label).toBe('Legacy');
		expect(addressTypeInfo('p2wpkh')?.label).toBe('Native SegWit');
		expect(addressTypeInfo('p2tr')?.label).toBe('Taproot');
		expect(addressTypeInfo('p2sh-p2wpkh')?.label).toBe('Nested SegWit');
	});

	it('returns null for unknown or missing types', () => {
		expect(addressTypeInfo('p2unknown')).toBeNull();
		expect(addressTypeInfo(null)).toBeNull();
		expect(addressTypeInfo(undefined)).toBeNull();
		expect(addressTypeInfo('')).toBeNull();
	});

	it('every entry has a label, prefix and explanation', () => {
		for (const [key, info] of Object.entries(ADDRESS_TYPES)) {
			expect(info.label, key).toBeTruthy();
			expect(info.prefix, key).toBeTruthy();
			expect(info.explanation, key).toBeTruthy();
		}
	});
});
