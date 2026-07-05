import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	getLedgerRegistration,
	listLedgerRegistrations,
	saveLedgerRegistration,
	VaultRegistrationError,
	POLICY_NAME_MAX
} from './vaultRegistrations';

// Registration fixtures: a fingerprint is 8 hex chars, HMAC/policy id 64.
const FP_A = 'f5acc2fd';
const FP_B = 'DEADBEEF'; // uppercase on purpose — must normalize to lowercase
const HMAC_A = 'aa'.repeat(32);
const HMAC_B = 'bb'.repeat(32);
const POLICY_ID = 'cc'.repeat(32);

function wipe(): void {
	db.exec(
		'DELETE FROM ledger_vault_registrations; DELETE FROM vault_keys; DELETE FROM vaults; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Vaults are created with direct SQL: this module (and its tests) deliberately
 *  never go through vaults.ts — only the vaults table row matters here. */
function makeVault(userId: number, name = 'Family savings'): number {
	db.prepare('INSERT INTO vaults (user_id, name, threshold) VALUES (?, ?, 2)').run(userId, name);
	const row = db.prepare('SELECT id FROM vaults WHERE user_id = ? ORDER BY id DESC').get(userId) as {
		id: number;
	};
	return row.id;
}

describe('ledger vault registrations', () => {
	it('listLedgerRegistrations returns [] for an owned vault with none, null for a missing vault', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

		expect(listLedgerRegistrations(user.id, vaultId)).toEqual([]);
		expect(listLedgerRegistrations(user.id, vaultId + 99)).toBeNull();
		expect(listLedgerRegistrations(user.id, 0)).toBeNull();
		expect(listLedgerRegistrations(user.id, -1)).toBeNull();
	});

	it('saveLedgerRegistration stores a registration and get/list read it back', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

		const saved = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A,
			policyId: POLICY_ID
		});

		expect(saved.vaultId).toBe(vaultId);
		expect(saved.masterFp).toBe(FP_A);
		expect(saved.policyName).toBe('Family savings');
		expect(saved.policyHmac).toBe(HMAC_A);
		expect(saved.policyId).toBe(POLICY_ID);
		expect(saved.createdAt).toBeTruthy();

		expect(getLedgerRegistration(user.id, vaultId, FP_A)).toEqual(saved);
		expect(listLedgerRegistrations(user.id, vaultId)).toEqual([saved]);
	});

	it('normalizes fingerprint, HMAC, and policy id to lowercase; policyId is optional', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

		const saved = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_B,
			policyName: 'Family savings',
			policyHmac: HMAC_A.toUpperCase()
		});

		expect(saved.masterFp).toBe(FP_B.toLowerCase());
		expect(saved.policyHmac).toBe(HMAC_A);
		expect(saved.policyId).toBeNull();

		// Lookups accept either case.
		expect(getLedgerRegistration(user.id, vaultId, FP_B)).toEqual(saved);
		expect(getLedgerRegistration(user.id, vaultId, FP_B.toLowerCase())).toEqual(saved);
	});

	it('re-registering the same device upserts instead of duplicating', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

		const first = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A,
			policyId: POLICY_ID
		});

		// The device was re-seeded / the vault renamed: fresh name + HMAC.
		const second = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A.toUpperCase(),
			policyName: 'Family savings v2',
			policyHmac: HMAC_B
		});

		expect(second.id).toBe(first.id);
		expect(second.policyName).toBe('Family savings v2');
		expect(second.policyHmac).toBe(HMAC_B);
		expect(second.policyId).toBeNull(); // replaced, not carried over
		expect(listLedgerRegistrations(user.id, vaultId)).toEqual([second]);

		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM ledger_vault_registrations WHERE vault_id = ?')
			.get(vaultId) as { n: number };
		expect(n).toBe(1);
	});

	it('keeps one registration per device: two Ledgers on the same vault coexist', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

		const a = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A
		});
		const b = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_B,
			policyName: 'Family savings',
			policyHmac: HMAC_B
		});

		expect(listLedgerRegistrations(user.id, vaultId)).toEqual([a, b]);
		expect(getLedgerRegistration(user.id, vaultId, FP_A)?.policyHmac).toBe(HMAC_A);
		expect(getLedgerRegistration(user.id, vaultId, FP_B)?.policyHmac).toBe(HMAC_B);
	});

	it('rejects malformed input with invalid_registration', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);

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
				saveLedgerRegistration(user.id, vaultId, input);
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(VaultRegistrationError);
				expect((e as VaultRegistrationError).code).toBe('invalid_registration');
			}
		}
		expect(listLedgerRegistrations(user.id, vaultId)).toEqual([]);

		// Exactly at the name cap is fine.
		const saved = saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A,
			policyName: 'x'.repeat(POLICY_NAME_MAX),
			policyHmac: HMAC_A
		});
		expect(saved.policyName).toHaveLength(POLICY_NAME_MAX);
	});

	it('saving against a missing vault throws vault_not_found', () => {
		const user = makeUser('owner@example.com');
		try {
			saveLedgerRegistration(user.id, 12345, {
				masterFp: FP_A,
				policyName: 'ok',
				policyHmac: HMAC_A
			});
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(VaultRegistrationError);
			expect((e as VaultRegistrationError).code).toBe('vault_not_found');
		}
	});

	it('isolates registrations per user: no read or write across owners', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const aliceVault = makeVault(alice.id, 'Alice vault');

		const saved = saveLedgerRegistration(alice.id, aliceVault, {
			masterFp: FP_A,
			policyName: 'Alice vault',
			policyHmac: HMAC_A
		});

		// Bob sees Alice's vault as not-found in every shape.
		expect(listLedgerRegistrations(bob.id, aliceVault)).toBeNull();
		expect(getLedgerRegistration(bob.id, aliceVault, FP_A)).toBeNull();
		try {
			saveLedgerRegistration(bob.id, aliceVault, {
				masterFp: FP_B,
				policyName: 'sneaky',
				policyHmac: HMAC_B
			});
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(VaultRegistrationError);
			expect((e as VaultRegistrationError).code).toBe('vault_not_found');
		}

		// Alice's row is untouched.
		expect(listLedgerRegistrations(alice.id, aliceVault)).toEqual([saved]);
	});

	it('the (vault_id, master_fp) uniqueness constraint holds at the database level', () => {
		const user = makeUser('owner@example.com');
		const vaultId = makeVault(user.id);
		saveLedgerRegistration(user.id, vaultId, {
			masterFp: FP_A,
			policyName: 'Family savings',
			policyHmac: HMAC_A
		});
		expect(() =>
			db
				.prepare(
					'INSERT INTO ledger_vault_registrations (vault_id, master_fp, policy_name, policy_hmac) VALUES (?, ?, ?, ?)'
				)
				.run(vaultId, FP_A, 'dupe', HMAC_B)
		).toThrow(/UNIQUE/i);
	});
});
