import { describe, it, expect } from 'vitest';
import { FEE_SPEEDS, arrivalWords, summarySentence } from './sendCopy';

// The summary sentence + arrival copy are the plain-language heart of the send
// review surface (cairn-krwp): a normal person reads one sentence, not sat/vB.
// These lock the amount/recipient/eta permutations, the fiat-hidden degrade
// (BTC-only amountText), and the batch/multisig variants.

describe('arrivalWords', () => {
	it('gives a concrete duration for each named speed', () => {
		expect(arrivalWords('priority')).toBe('about 10 minutes');
		expect(arrivalWords('standard')).toBe('about 30 minutes');
		expect(arrivalWords('economy')).toBe('an hour or more');
	});

	// A custom sat/vB has no honest tier→duration mapping, so it must read as a
	// mempool-dependent time rather than inventing a false estimate.
	it('falls back to a mempool-dependent phrasing for a custom fee', () => {
		expect(arrivalWords('custom')).toBe('a time that depends on the mempool');
	});
});

describe('FEE_SPEEDS', () => {
	it('carries the three named speeds mapped onto FeeEstimates tiers', () => {
		expect(FEE_SPEEDS.map((s) => s.key)).toEqual(['priority', 'standard', 'economy']);
		expect(FEE_SPEEDS.map((s) => s.tier)).toEqual(['fastest', 'halfHour', 'economy']);
	});

	// The picker's per-speed eta and the review card's arrivalWords must not drift
	// apart — both read the same duration for a given speed.
	it('keeps each speed eta in lock-step with arrivalWords', () => {
		for (const speed of FEE_SPEEDS) {
			expect(speed.eta).toBe(arrivalWords(speed.key));
		}
	});
});

describe('summarySentence: single recipient', () => {
	const base = {
		arrivalWords: 'about 30 minutes',
		isBatch: false,
		recipientCount: 1,
		multisig: null
	};

	it('reads amount + recipient name + arrival in one sentence', () => {
		expect(
			summarySentence({
				...base,
				amountText: '$64.70 (0.001 BTC)',
				recipientText: 'Alice'
			})
		).toBe("You're sending $64.70 (0.001 BTC) to Alice. It should arrive in about 30 minutes.");
	});

	// When no contact matches, the page passes the shortened address as
	// recipientText — the sentence renders it verbatim, no name.
	it('uses a shortened address when there is no saved-contact name', () => {
		expect(
			summarySentence({
				...base,
				amountText: '$64.70 (0.001 BTC)',
				recipientText: 'bc1qxy…k3n8'
			})
		).toBe("You're sending $64.70 (0.001 BTC) to bc1qxy…k3n8. It should arrive in about 30 minutes.");
	});

	// Fiat-hidden mode: with no price the amountText degrades to BTC-only, and the
	// sentence must carry that through without any empty/broken fiat fragment.
	it('degrades to BTC-only amount text when fiat is unavailable', () => {
		expect(
			summarySentence({
				...base,
				amountText: '0.001 BTC',
				recipientText: 'Alice'
			})
		).toBe("You're sending 0.001 BTC to Alice. It should arrive in about 30 minutes.");
	});

	it('threads the chosen arrival estimate through', () => {
		expect(
			summarySentence({
				...base,
				amountText: '0.001 BTC',
				recipientText: 'Alice',
				arrivalWords: 'a time that depends on the mempool'
			})
		).toBe(
			"You're sending 0.001 BTC to Alice. It should arrive in a time that depends on the mempool."
		);
	});
});

describe('summarySentence: batch', () => {
	it('summarises count instead of a single recipient', () => {
		expect(
			summarySentence({
				amountText: '$250.00 (0.00386 BTC)',
				recipientText: '',
				arrivalWords: 'about 10 minutes',
				isBatch: true,
				recipientCount: 3,
				multisig: null
			})
		).toBe(
			"You're sending $250.00 (0.00386 BTC) across 3 recipients. It should arrive in about 10 minutes."
		);
	});
});

describe('summarySentence: multisig', () => {
	// Multisig arrival is dominated by signature collection, so the tail becomes
	// the signing context rather than a network-time estimate.
	it('replaces the arrival tail with the signature-collection context', () => {
		expect(
			summarySentence({
				amountText: '$64.70 (0.001 BTC)',
				recipientText: 'Alice',
				arrivalWords: 'about 30 minutes',
				isBatch: false,
				recipientCount: 1,
				multisig: { threshold: 2, keysTotal: 3 }
			})
		).toBe(
			"You're sending $64.70 (0.001 BTC) to Alice. This payment needs 2 of 3 signatures before it's sent."
		);
	});

	it('keeps the batch lead but still swaps in the multisig tail', () => {
		expect(
			summarySentence({
				amountText: '$250.00 (0.00386 BTC)',
				recipientText: '',
				arrivalWords: 'about 10 minutes',
				isBatch: true,
				recipientCount: 4,
				multisig: { threshold: 3, keysTotal: 5 }
			})
		).toBe(
			"You're sending $250.00 (0.00386 BTC) across 4 recipients. This payment needs 3 of 5 signatures before it's sent."
		);
	});
});
