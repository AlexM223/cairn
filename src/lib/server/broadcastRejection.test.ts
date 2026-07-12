import { describe, it, expect } from 'vitest';
import { friendlyBroadcastRejection } from './broadcastRejection';

describe('friendlyBroadcastRejection', () => {
	it('keeps the raw node reason verbatim and always says nothing was sent', () => {
		expect(friendlyBroadcastRejection('some unrecognized node reason')).toBe(
			'The Bitcoin network rejected this transaction: some unrecognized node reason. Nothing was sent.'
		);
	});

	it('adds a dust-specific hint', () => {
		expect(friendlyBroadcastRejection('dust')).toBe(
			'The Bitcoin network rejected this transaction: dust. Nothing was sent. The amount is below the dust limit — send a little more.'
		);
	});

	it('adds a low-fee hint', () => {
		expect(friendlyBroadcastRejection('min relay fee not met')).toContain(
			'try again with a higher fee'
		);
	});

	it('adds an already-in-mempool hint', () => {
		expect(friendlyBroadcastRejection('txn-already-in-mempool')).toContain(
			"there's no need to resend it"
		);
	});

	it('adds a spent-coin hint', () => {
		expect(friendlyBroadcastRejection('bad-txns-inputs-missingorspent')).toContain(
			'already spent elsewhere'
		);
	});

	it('is case-insensitive when matching known reasons', () => {
		expect(friendlyBroadcastRejection('DUST')).toContain('below the dust limit');
	});
});
