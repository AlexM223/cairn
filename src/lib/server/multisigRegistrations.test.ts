import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	getLedgerRegistration,
	listLedgerRegistrations,
	saveLedgerRegistration,
	MultisigRegistrationError,
	POLICY_NAME_MAX
} from './multisigRegistrations';

// Registration fixtures: a fingerprint is 8 hex chars, HMAC/policy id 64.
const FP_A = 'f5acc2fd';
const FP_B = 'DEADBEEF'; // uppercase on purpose — must normalize to lowercase
const HMAC_A = 'aa'.repeat(32);
const HMAC_B = 'bb'.repeat(32);
const POLICY_ID = 'cc'.repeat(32);

function wipe(): void {
	db.exec(
		'DELETE FROM ledger_multisig_registrations; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Multisigs are created with direct SQL: this module (and its tests) deliberately
 *  never go through multisigs.ts — only the multisigs table row matters here. */
function makeMultisig(userId: number, name = 'Family savings'): number {
	db.prepare('INSERT INTO multisigs (user_id, name, threshold) VALUES (?, ?, 2)').run(userId, name);
	const row = db.prepare('SELECT id FROM multisigs WHERE user_id = ? ORDER BY id DESC').get(userId) as {
		id: number;
	};
	return row.id;
}

describe('ledger multisig registrations', () => {
	it('listLedgerRegistrations returns [] for an owned multisig with none, null for a missing multisig', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		expect(listLedgerRegistrations(user.id, multisigId)).toEqual([]);
		expect(listLedgerRegistrations(user.id, multisigId + 99)).toBeNull();
		expect(listLedgerRegistrations(user.id, 0)).toBeNull();
		expect(listLedgerRegistrations(user.id, -1)).toBeNull();
	});

	it('saveLedgerRegistration stores a registration and get/list read it back', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		const saved = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A,
			policyId: POLICY_ID
		});

		expect(saved.multisigId).toBe(multisigId);
		expect(saved.masterFp).toBe(FP_A);
		expect(saved.policyName).toBe('Family savings');
		expect(saved.policyHmac).toBe(HMAC_A);
		expect(saved.policyId).toBe(POLICY_ID);
		expect(saved.createdAt).toBeTruthy();

		expect(getLedgerRegistration(user.id, multisigId, FP_A)).toEqual(saved);
		expect(listLedgerRegistrations(user.id, multisigId)).toEqual([saved]);
	});

	it('normalizes fingerprint, HMAC, and policy id to lowercase; policyId is optional', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		const saved = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_B,
			policyName: 'Family savings',
			policyHmac: HMAC_A.toUpperCase()
		});

		expect(saved.masterFp).toBe(FP_B.toLowerCase());
		expect(saved.policyHmac).toBe(HMAC_A);
		expect(saved.policyId).toBeNull();

		// Lookups accept either case.
		expect(getLedgerRegistration(user.id, multisigId, FP_B)).toEqual(saved);
		expect(getLedgerRegistration(user.id, multisigId, FP_B.toLowerCase())).toEqual(saved);
	});

	it('re-registering the same device upserts instead of duplicating', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		const first = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A,
			policyId: POLICY_ID
		});

		// The device was re-seeded / the multisig renamed: fresh name + HMAC.
		const second = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A.toUpperCase(),
			policyName: 'Family savings v2',
			policyHmac: HMAC_B
		});

		expect(second.id).toBe(first.id);
		expect(second.policyName).toBe('Family savings v2');
		expect(second.policyHmac).toBe(HMAC_B);
		expect(second.policyId).toBeNull(); // replaced, not carried over
		expect(listLedgerRegistrations(user.id, multisigId)).toEqual([second]);

		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM ledger_multisig_registrations WHERE multisig_id = ?')
			.get(multisigId) as { n: number };
		expect(n).toBe(1);
	});

	it('keeps one registration per device: two Ledgers on the same multisig coexist', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		const a = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A
		});
		const b = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_B,
			policyName: 'Family savings',
			policyHmac: HMAC_B
		});

		expect(listLedgerRegistrations(user.id, multisigId)).toEqual([a, b]);
		expect(getLedgerRegistration(user.id, multisigId, FP_A)?.policyHmac).toBe(HMAC_A);
		expect(getLedgerRegistration(user.id, multisigId, FP_B)?.policyHmac).toBe(HMAC_B);
	});

	it('rejects malformed input with invalid_registration', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);

		const bad: { masterFp?: unknown; policyName?: unknown; policyHmac?: unknown; policyId?: unknown }[] = [
			{ masterFp: 'xyz', policyName: 'ok', policyHmac: HMAC_A }, // bad fp
			{ masterFp: 'f5acc2f', policyName: 'ok', policyHmac: HMAC_A }, // 7 chars
			{ masterFp: '00000000', policyName: 'ok', policyHmac: HMAC_A }, // placeholder fp
			{ masterFp: FP_A, policyName: '', policyHmac: HMAC_A }, // empty name
			{ masterFp: FP_A, policyName: '   ', policyHmac: HMAC_A }, // whitespace name
			{ masterFp: FP_A, policyName: 'x'.repeat(POLICY_NAME_MAX + 1), policyHmac: HMAC_A },
			{ masterFp: FP_A, policyName: 'ok', policyHmac: 'not hex' }, // bad hmac
			{ masterFp: FP_A, policyName: 'ok', policyHmac: HMAC_A.slice(0, -2) }, // short hmac
			{ masterFp: FP_A, policyName: 'ok', policyHmac: HMAC_A, policyId: 'short' } // bad id
		];
		for (const input of bad) {
			try {
				saveLedgerRegistration(user.id, multisigId, input);
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(MultisigRegistrationError);
				expect((e as MultisigRegistrationError).code).toBe('invalid_registration');
			}
		}
		expect(listLedgerRegistrations(user.id, multisigId)).toEqual([]);

		// Exactly at the name cap is fine.
		const saved = saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A,
			policyName: 'x'.repeat(POLICY_NAME_MAX),
			policyHmac: HMAC_A
		});
		expect(saved.policyName).toHaveLength(POLICY_NAME_MAX);
	});

	it('saving against a missing multisig throws multisig_not_found', () => {
		const user = makeUser('owner@example.com');
		try {
			saveLedgerRegistration(user.id, 12345, {
				masterFp: FP_A,
				policyName: 'ok',
				policyHmac: HMAC_A
			});
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigRegistrationError);
			expect((e as MultisigRegistrationError).code).toBe('multisig_not_found');
		}
	});

	it('isolates registrations per user: no read or write across owners', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const aliceMultisig = makeMultisig(alice.id, 'Alice multisig');

		const saved = saveLedgerRegistration(alice.id, aliceMultisig, {
			masterFp: FP_A,
			policyName: 'Alice multisig',
			policyHmac: HMAC_A
		});

		// Bob sees Alice's multisig as not-found in every shape.
		expect(listLedgerRegistrations(bob.id, aliceMultisig)).toBeNull();
		expect(getLedgerRegistration(bob.id, aliceMultisig, FP_A)).toBeNull();
		try {
			saveLedgerRegistration(bob.id, aliceMultisig, {
				masterFp: FP_B,
				policyName: 'sneaky',
				policyHmac: HMAC_B
			});
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigRegistrationError);
			expect((e as MultisigRegistrationError).code).toBe('multisig_not_found');
		}

		// Alice's row is untouched.
		expect(listLedgerRegistrations(alice.id, aliceMultisig)).toEqual([saved]);
	});

	it('the (multisig_id, master_fp) uniqueness constraint holds at the database level', () => {
		const user = makeUser('owner@example.com');
		const multisigId = makeMultisig(user.id);
		saveLedgerRegistration(user.id, multisigId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A
		});
		expect(() =>
			db
				.prepare(
					'INSERT INTO ledger_multisig_registrations (multisig_id, master_fp, policy_name, policy_hmac) VALUES (?, ?, ?, ?)'
				)
				.run(multisigId, FP_A, 'dupe', HMAC_B)
		).toThrow(/UNIQUE/i);
	});
});
