import { describe, it, expect } from 'vitest';
import { shouldShowNetworkFee } from './txRow';

describe('shouldShowNetworkFee (cairn-jcwb)', () => {
	it('hides the fee line on a received (incoming) row — it is the SENDER\'s cost, not what this wallet got', () => {
		// Real report: delta +323,800 sats ($207.73) received, fee 113 sats
		// ($0.07) — the fee is a real number but unrelated to the receive amount,
		// and rendering it right beside "Received" reads as two amounts.
		expect(shouldShowNetworkFee({ delta: 323_800, fee: 113 })).toBe(false);
	});

	it('shows the fee line on a sent (outgoing) row — it genuinely left this wallet', () => {
		expect(shouldShowNetworkFee({ delta: -50_000, fee: 300 })).toBe(true);
	});

	it('hides the fee line when the fee could not be resolved, regardless of direction', () => {
		expect(shouldShowNetworkFee({ delta: -50_000, fee: null })).toBe(false);
		expect(shouldShowNetworkFee({ delta: 50_000, fee: null })).toBe(false);
	});

	it('treats a zero delta as non-outgoing (no fee line) — nothing left this wallet', () => {
		expect(shouldShowNetworkFee({ delta: 0, fee: 300 })).toBe(false);
	});
});
