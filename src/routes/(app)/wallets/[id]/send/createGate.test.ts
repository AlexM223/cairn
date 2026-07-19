// Zero-balance empty-state logic for the Send create step (cairn-gt05.2,
// spec §2.3 — "Zero-balance bare '0' → real empty state + Receive CTA").

import { describe, it, expect } from 'vitest';
import { sendCreateGate } from './createGate';

const base = {
	liveLoaded: true,
	scanError: null as string | null,
	confirmed: 0 as number | null,
	maturingTotal: 0,
	resuming: false
};

describe('sendCreateGate (gt05.2 zero-balance empty state)', () => {
	it('an empty wallet gets the empty state, not the form', () => {
		expect(sendCreateGate({ ...base })).toBe('empty');
	});

	it('a funded wallet gets the form', () => {
		expect(sendCreateGate({ ...base, confirmed: 50_000 })).toBe('form');
	});

	it('never walls off the page while the live scan is still streaming', () => {
		expect(sendCreateGate({ ...base, liveLoaded: false })).toBe('form');
	});

	it('never claims "empty" when the node was unreachable (unknown ≠ empty)', () => {
		expect(
			sendCreateGate({ ...base, scanError: 'Could not reach your node.' })
		).toBe('form');
		expect(sendCreateGate({ ...base, confirmed: null })).toBe('form');
	});

	it('a resumed draft always renders the flow (the draft is preserved)', () => {
		expect(sendCreateGate({ ...base, resuming: true })).toBe('form');
	});

	it('0 spendable with a maturing coinbase says "maturing", not "empty"', () => {
		expect(sendCreateGate({ ...base, maturingTotal: 312_500_000 })).toBe('maturing');
	});
});
