import { describe, it, expect } from 'vitest';
import {
	STAKE_FLAT_THRESHOLD_SATS,
	STAKE_BALANCE_FRACTION,
	isHighStakeAmount,
	isFirstSendToAddress,
	shouldVerifyRecipient,
	addressTail,
	matchesAddressTail
} from './recipientVerify';

// R2 trigger logic must be RARE by construction (F4: warnings habituate within two
// exposures) — these lock the exact intersection (first-send AND high-stake AND
// single-recipient) so nobody loosens it into a routine checkbox later.

describe('isHighStakeAmount', () => {
	it('trips on the flat floor regardless of balance', () => {
		expect(isHighStakeAmount(STAKE_FLAT_THRESHOLD_SATS, null)).toBe(true);
		expect(isHighStakeAmount(STAKE_FLAT_THRESHOLD_SATS, 1_000_000_000)).toBe(true);
	});

	it('stays below the flat floor for a small send with no balance context', () => {
		expect(isHighStakeAmount(STAKE_FLAT_THRESHOLD_SATS - 1, null)).toBe(false);
	});

	it('trips on the balance-relative floor even under the flat floor', () => {
		// 9,000 sats from a 50,000-sat wallet = 18% > 10% fraction, but well under
		// the 100k flat floor.
		expect(isHighStakeAmount(9_000, 50_000)).toBe(true);
		expect(STAKE_BALANCE_FRACTION).toBe(0.1);
	});

	it('does not trip when under both floors', () => {
		expect(isHighStakeAmount(1_000, 50_000)).toBe(false);
	});

	it('ignores a zero/negative balance for the relative floor (falls back to flat only)', () => {
		expect(isHighStakeAmount(5_000, 0)).toBe(false);
		expect(isHighStakeAmount(5_000, -100)).toBe(false);
	});

	it('never trips on a zero or negative amount', () => {
		expect(isHighStakeAmount(0, 1)).toBe(false);
		expect(isHighStakeAmount(-500, null)).toBe(false);
	});
});

describe('isFirstSendToAddress', () => {
	const known = new Set(['bc1qknownaddressxyz']);

	it('is true for an address outside the known set', () => {
		expect(isFirstSendToAddress('bc1qneveraddresses', known)).toBe(true);
	});

	it('is false for an address inside the known set', () => {
		expect(isFirstSendToAddress('bc1qknownaddressxyz', known)).toBe(false);
	});

	it('accepts a plain array as well as a Set', () => {
		expect(isFirstSendToAddress('bc1qknownaddressxyz', ['bc1qknownaddressxyz'])).toBe(false);
		expect(isFirstSendToAddress('bc1qother', ['bc1qknownaddressxyz'])).toBe(true);
	});
});

describe('shouldVerifyRecipient', () => {
	const base = {
		address: 'bc1qbrandnewaddress9f4d',
		amountSats: 200_000,
		balanceSats: 1_000_000,
		knownAddresses: [] as string[],
		isBatch: false
	};

	it('fires on first-send + high-stake + single-recipient', () => {
		expect(shouldVerifyRecipient(base)).toBe(true);
	});

	it('never fires for a batch send, even if every other condition holds', () => {
		expect(shouldVerifyRecipient({ ...base, isBatch: true })).toBe(false);
	});

	it('never fires for a known address (saved contact or prior send)', () => {
		expect(
			shouldVerifyRecipient({ ...base, knownAddresses: [base.address] })
		).toBe(false);
	});

	it('never fires for a low-stake amount', () => {
		expect(shouldVerifyRecipient({ ...base, amountSats: 500, balanceSats: 1_000_000 })).toBe(
			false
		);
	});

	it('stays rare: a routine repeat send to a known address at high stakes is silent', () => {
		expect(
			shouldVerifyRecipient({
				...base,
				amountSats: 5_000_000,
				knownAddresses: [base.address]
			})
		).toBe(false);
	});
});

describe('addressTail / matchesAddressTail', () => {
	it('reads the last 4 characters, case-folded', () => {
		expect(addressTail('bc1qsomeaddress9F4D')).toBe('9f4d');
	});

	it('matches regardless of the user input case or surrounding whitespace', () => {
		expect(matchesAddressTail(' 9F4d ', 'bc1qsomeaddress9f4d')).toBe(true);
		expect(matchesAddressTail('9f4d', 'bc1qsomeaddress9F4D')).toBe(true);
	});

	it('rejects a mismatched tail', () => {
		expect(matchesAddressTail('0000', 'bc1qsomeaddress9f4d')).toBe(false);
	});

	it('rejects a partial/short input rather than fuzzy-matching', () => {
		expect(matchesAddressTail('f4d', 'bc1qsomeaddress9f4d')).toBe(false);
	});
});
