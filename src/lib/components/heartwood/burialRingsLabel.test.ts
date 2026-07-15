// Unit tests for the burial-ring glyph's accompanying label copy.
//
// The visual glyph (rings) stays brand-themed, but the text label next to it
// must be plain language, never jargon like "buried N rings deep" or "six
// rings deep" — that copy leaked into the Home screen's activity list
// (cairn-0ifm). This locks the plain-language output in place.

import { describe, it, expect } from 'vitest';
import { burialRingsLabel, confirmationProgress } from './burialRingsLabel';

describe('burialRingsLabel', () => {
	it('0 confirmations reads as plain "unconfirmed"', () => {
		expect(burialRingsLabel(0)).toBe('unconfirmed');
	});

	it('negative/invalid confirmations also read as "unconfirmed"', () => {
		expect(burialRingsLabel(-1)).toBe('unconfirmed');
	});

	it('1 confirmation is singular', () => {
		expect(burialRingsLabel(1)).toBe('1 confirmation');
	});

	it('2-5 confirmations are plural, plain "N confirmations"', () => {
		expect(burialRingsLabel(2)).toBe('2 confirmations');
		expect(burialRingsLabel(5)).toBe('5 confirmations');
	});

	it('6+ confirmations caps at the plain "6+ confirmations" label', () => {
		expect(burialRingsLabel(6)).toBe('6+ confirmations');
		expect(burialRingsLabel(97)).toBe('6+ confirmations');
	});

	it('never contains burial-ring jargon', () => {
		for (const n of [0, 1, 2, 5, 6, 50]) {
			const label = burialRingsLabel(n);
			expect(label.toLowerCase()).not.toContain('ring');
			expect(label.toLowerCase()).not.toContain('buried');
			expect(label.toLowerCase()).not.toContain('sealed');
		}
	});
});

// Explicit "N of 6" progress text (cairn-cqch): the burial-ring label alone
// ("2 confirmations") doesn't say how far along a still-confirming tx is
// toward Cairn's 6-confirmation "buried" threshold. This is the literal
// tally shown alongside it on the explorer tx-detail page.
describe('confirmationProgress', () => {
	it('0 confirmations reads as "0 of 6 confirmations"', () => {
		expect(confirmationProgress(0)).toBe('0 of 6 confirmations');
	});

	it('negative/invalid confirmations clamp to 0, like the label', () => {
		expect(confirmationProgress(-1)).toBe('0 of 6 confirmations');
	});

	it('1-5 confirmations report the literal count out of 6', () => {
		expect(confirmationProgress(1)).toBe('1 of 6 confirmations');
		expect(confirmationProgress(5)).toBe('5 of 6 confirmations');
	});

	it('6+ confirmations has nothing further to add — null, not "6 of 6" or "97 of 6"', () => {
		expect(confirmationProgress(6)).toBeNull();
		expect(confirmationProgress(97)).toBeNull();
	});
});
