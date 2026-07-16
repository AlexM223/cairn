import { describe, it, expect } from 'vitest';
import { canOfferSpeedUp } from './speedUp';

describe('canOfferSpeedUp (cairn-iare)', () => {
	it('offers CPFP when the parent fee is known', () => {
		expect(canOfferSpeedUp({ action: 'cpfp', parentFeeUnknown: false })).toBe(true);
	});

	it('hides CPFP when the parent fee is unknown — deterministically unbuildable', () => {
		expect(canOfferSpeedUp({ action: 'cpfp', parentFeeUnknown: true })).toBe(false);
	});

	it('always offers RBF regardless of parentFeeUnknown — RBF never reads the parent fee', () => {
		expect(canOfferSpeedUp({ action: 'rbf', parentFeeUnknown: true })).toBe(true);
		expect(canOfferSpeedUp({ action: 'rbf', parentFeeUnknown: false })).toBe(true);
	});
});
