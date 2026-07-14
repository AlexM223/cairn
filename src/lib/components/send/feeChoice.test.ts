import { describe, it, expect } from 'vitest';
import { nodeFloorFrom, resolveFeeRate, belowFloorMessage } from './feeChoice';
import type { FeeEstimates } from '$lib/types';

// A capable node relaying sub-1 (floor 0.1); an incapable/unknown node (floor 1).
const CAPABLE: FeeEstimates = { fastest: 5, halfHour: 3, hour: 2, economy: 0.5, minFeeRate: 0.1 };
const INCAPABLE: FeeEstimates = { fastest: 5, halfHour: 3, hour: 2, economy: 1, minFeeRate: 1 };

describe('nodeFloorFrom', () => {
	it('reads the node floor from the estimates payload', () => {
		expect(nodeFloorFrom(CAPABLE)).toBe(0.1);
		expect(nodeFloorFrom(INCAPABLE)).toBe(1);
	});

	it('falls back to 1 when estimates or the field are missing', () => {
		expect(nodeFloorFrom(null)).toBe(1);
		expect(nodeFloorFrom({ fastest: 5, halfHour: 3, hour: 2, economy: 1 })).toBe(1);
	});

	it('treats a negative or non-finite floor as the 1 fallback', () => {
		expect(nodeFloorFrom({ ...INCAPABLE, minFeeRate: -2 })).toBe(1);
		expect(nodeFloorFrom({ ...INCAPABLE, minFeeRate: NaN })).toBe(1);
	});

	// A floor of exactly 0 is NOT "unknown" — the server rounds the raw floor to
	// 2 decimals before sending it, so an ultra-low-but-real relay floor (e.g. a
	// node with minrelaytxfee=0.00000001 BTC/kvB = 0.001 sat/vB) legitimately
	// displays as 0. Silently re-imposing the 1 sat/vB fallback here defeated the
	// sub-1 feature on exactly that setup (found verifying cairn-eacw.8 on
	// regtest) — 0 must pass through unchanged.
	it('passes a floor of exactly 0 through unchanged (a real ultra-low floor, not unknown)', () => {
		expect(nodeFloorFrom({ ...INCAPABLE, minFeeRate: 0 })).toBe(0);
	});
});

describe('resolveFeeRate: named tiers', () => {
	it('returns the live tier value for priority/standard/economy', () => {
		expect(resolveFeeRate('priority', '5', CAPABLE)).toBe(5);
		expect(resolveFeeRate('standard', '5', CAPABLE)).toBe(3);
		// Economy can itself be sub-1 post-eacw.4 — passed straight through.
		expect(resolveFeeRate('economy', '5', CAPABLE)).toBe(0.5);
	});

	it('falls back to the custom box when the chosen tier is unavailable', () => {
		expect(resolveFeeRate('priority', '7', null)).toBe(7);
	});
});

describe('resolveFeeRate: custom clamp to the node floor (cairn-eacw.5)', () => {
	it('honors a sub-1 custom entry when the node relays below 1', () => {
		expect(resolveFeeRate('custom', '0.5', CAPABLE)).toBe(0.5);
		expect(resolveFeeRate('custom', '0.1', CAPABLE)).toBe(0.1);
	});

	it('clamps a below-floor custom entry up to the floor', () => {
		expect(resolveFeeRate('custom', '0.05', CAPABLE)).toBe(0.1); // below 0.1 floor
		expect(resolveFeeRate('custom', '0.5', INCAPABLE)).toBe(1); // incapable node
	});

	it('lets a custom rate at or above 1 through unchanged on either node', () => {
		expect(resolveFeeRate('custom', '12', CAPABLE)).toBe(12);
		expect(resolveFeeRate('custom', '2.5', INCAPABLE)).toBe(2.5);
	});

	it('an empty/zero custom box resolves to the node floor, never below', () => {
		expect(resolveFeeRate('custom', '', CAPABLE)).toBe(0.1);
		expect(resolveFeeRate('custom', '0', INCAPABLE)).toBe(1);
	});

	it('respects an elevated floor (busy mempool, floor > 1)', () => {
		const busy: FeeEstimates = { fastest: 20, halfHour: 12, hour: 8, economy: 3, minFeeRate: 3 };
		expect(resolveFeeRate('custom', '2', busy)).toBe(3);
		expect(resolveFeeRate('custom', '5', busy)).toBe(5);
	});
});

describe('belowFloorMessage', () => {
	it('is null unless Custom is chosen', () => {
		expect(belowFloorMessage('priority', '0.01', CAPABLE)).toBeNull();
		expect(belowFloorMessage('economy', '0.01', CAPABLE)).toBeNull();
	});

	it('is null when the entry is at/above the floor or empty', () => {
		expect(belowFloorMessage('custom', '0.5', CAPABLE)).toBeNull();
		expect(belowFloorMessage('custom', '0.1', CAPABLE)).toBeNull();
		expect(belowFloorMessage('custom', '', CAPABLE)).toBeNull();
		expect(belowFloorMessage('custom', '0', CAPABLE)).toBeNull();
	});

	it('explains an incapable/unknown node (floor 1) with the plain 1 sat/vB copy', () => {
		const msg = belowFloorMessage('custom', '0.5', INCAPABLE);
		expect(msg).toContain("doesn't relay fees below 1 sat/vB");
	});

	it('names the specific sub-1 floor when the node relays below it', () => {
		const msg = belowFloorMessage('custom', '0.05', CAPABLE);
		expect(msg).toContain('0.1 sat/vB');
	});
});
