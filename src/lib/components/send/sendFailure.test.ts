// cairn-gt05.7 — retry-safety copy invariants for every send/broadcast failure
// surface. These are copy CONTRACT tests: the exact words may be tuned, but
// every failure must state the fund state, stay non-accusatory, and give one
// concrete next step.

import { describe, it, expect } from 'vitest';
import {
	sendFailureCopy,
	sendFailureText,
	FUNDS_SAFE,
	type SendFailureKind
} from './sendFailure';

const ALL_KINDS: SendFailureKind[] = [
	'broadcast-rejected',
	'broadcast-unreachable',
	'broadcast-error',
	'attach-unreachable',
	'attach-rejected'
];

describe('sendFailureCopy (gt05.7)', () => {
	it('every failure kind states the fund state in plain words', () => {
		for (const kind of ALL_KINDS) {
			const c = sendFailureCopy(kind);
			expect(c.fundState, kind).toBe(FUNDS_SAFE);
			expect(c.fundState).toMatch(/was not sent/i);
			expect(c.fundState).toMatch(/nothing left your wallet/i);
			expect(c.fundState).toMatch(/safely try again/i);
			// The draft is preserved — the copy says so, matching the page behavior.
			expect(c.fundState).toMatch(/draft is saved/i);
		}
	});

	it('every failure kind carries a concrete next step and a headline', () => {
		for (const kind of ALL_KINDS) {
			const c = sendFailureCopy(kind);
			expect(c.headline.length, kind).toBeGreaterThan(0);
			expect(c.nextStep.length, kind).toBeGreaterThan(0);
		}
	});

	it('connection failures name the layer non-accusatorily (node, not the user)', () => {
		for (const kind of ['broadcast-unreachable', 'attach-unreachable'] as const) {
			const c = sendFailureCopy(kind);
			expect(c.layer, kind).toMatch(/connection to your node/i);
			expect(c.layer, kind).toMatch(/not something you did/i);
			expect(c.transient, kind).toBe(true);
		}
	});

	it('a network rejection is framed needs-a-change, not transient, and not user blame', () => {
		const c = sendFailureCopy('broadcast-rejected');
		expect(c.transient).toBe(false);
		expect(c.layer).toMatch(/not something you did/i);
		expect(c.nextStep).toMatch(/rebuild|re-sign/i);
	});

	it('passes a server message through as the headline when present', () => {
		const c = sendFailureCopy('broadcast-rejected', 'txn-mempool-conflict');
		expect(c.headline).toBe('txn-mempool-conflict');
		// Blank server messages fall back to the stock headline.
		const blank = sendFailureCopy('broadcast-rejected', '   ');
		expect(blank.headline).toMatch(/network refused/i);
	});

	it('never uses accusatory or bare-failure language', () => {
		for (const kind of ALL_KINDS) {
			const text = sendFailureText(kind);
			expect(text).not.toMatch(/you (made|caused|entered) (a|an) (mistake|error)/i);
			expect(text).not.toMatch(/^failed\.?$/i);
			// Fund state is present in the one-string form too.
			expect(text).toContain(FUNDS_SAFE);
		}
	});
});
