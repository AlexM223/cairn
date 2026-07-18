// Pure unit matrix for confirmationsFor (docs/LIVE-UPDATES-DESIGN.md §8) — the
// single confirmation-math source the whole app renders through.

import { describe, it, expect } from 'vitest';
import { confirmationsFor } from './confirmations';

describe('confirmationsFor', () => {
	it('treats a null block height as unconfirmed (0)', () => {
		expect(confirmationsFor(null, 800_000)).toBe(0);
	});

	it('treats an undefined block height as unconfirmed (0)', () => {
		expect(confirmationsFor(undefined, 800_000)).toBe(0);
	});

	it('treats a zero block height as unconfirmed (0)', () => {
		expect(confirmationsFor(0, 800_000)).toBe(0);
	});

	it('treats a negative block height as unconfirmed (0)', () => {
		expect(confirmationsFor(-1, 800_000)).toBe(0);
	});

	it('is 1 confirmation when the tip equals the inclusion height', () => {
		expect(confirmationsFor(800_000, 800_000)).toBe(1);
	});

	it('counts N confirmations for a buried tx', () => {
		// tip 800_010, included at 800_000 → 800_010 - 800_000 + 1 = 11.
		expect(confirmationsFor(800_000, 800_010)).toBe(11);
	});

	it('clamps to 0 on a reorg where the tip has moved below the tx height', () => {
		// A deep reorg dropped the tip below the tx's block — never negative.
		expect(confirmationsFor(800_000, 799_999)).toBe(0);
	});

	it('returns 0 when the tip is unknown (0)', () => {
		expect(confirmationsFor(800_000, 0)).toBe(0);
	});

	it('returns 0 when the tip is negative (unknown/uninitialised)', () => {
		expect(confirmationsFor(800_000, -5)).toBe(0);
	});
});
