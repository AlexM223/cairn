// Regression tests for the three server-side user-deletion defects fixed via the
// shared userDeletion.ts primitives:
//
//   cairn-piow (P1) — admin deleteUser threw a raw "FOREIGN KEY constraint
//     failed" for a target who had created invites or touched feature flags,
//     because it did a bare DELETE FROM users with no pre-cleanup of the three
//     non-cascade user FKs (invites.created_by, feature_flags.updated_by,
//     user_feature_flags.updated_by). Now routed through purgeUserRow().
//
//   cairn-sclk (P2) — the last-admin guard only counted ACTIVE admins, so a
//     DISABLED sole admin could be deleted, leaving zero admin rows.
//     deletionOrphansAdmins() now also refuses to drop the last admin ROW.
//
//   cairn-8r0l (P1) — deleting a user who owns multisigs shared with other
//     participants silently destroyed those wallets (and in-flight PSBTs) for the
//     cosigners with no signal. admin deleteUser now BLOCKS (owns_shared_multisigs)
//     unless forced; deleteOwnAccount proceeds (the danger-zone copy already warns)
//     — and BOTH now fire a `multisig_removed` notification to each cosigner.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, AuthError } from './auth';
import { setSetting } from './settings';
import { deleteUser } from './admin';
import { deleteOwnAccount } from './accountDeletion';
import { deletionOrphansAdmins, ownedSharedMultisigs } from './userDeletion';

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM events; DELETE FROM notification_queue;
		 DELETE FROM notification_preferences; DELETE FROM user_feature_flags; DELETE FROM feature_flags;
		 DELETE FROM invites; DELETE FROM multisig_transaction_signers; DELETE FROM multisig_transactions;
		 DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs;
		 DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeUser(email: string, opts: { admin?: boolean; disabled?: boolean } = {}): Promise<number> {
	const id = (
		await registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] })
	).id;
	if (opts.admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
	if (opts.disabled) db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
	return id;
}

function count(table: string, where: string, ...params: (string | number)[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }
	).n;
}

function makeSharedMultisig(ownerId: number, sharedWithId: number, name = 'Vault'): number {
	const msId = Number(
		db.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, ?, 2)").run(ownerId, name)
			.lastInsertRowid
	);
	db.prepare(
		'INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)'
	).run(msId, ownerId, sharedWithId, 'cosigner');
	return msId;
}

// ---------------------------------------------------------------- cairn-piow
describe('cairn-piow: FK-laden deletes clean up non-cascade FKs instead of throwing', () => {
	it('admin deleteUser removes a target who created invites and touched feature flags', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		const victim = await makeUser('victim@example.com');

		db.prepare("INSERT INTO invites (code, created_by) VALUES ('CODE1234', ?)").run(victim);
		db.prepare("INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('flag_a', 1, ?)").run(victim);
		db.prepare(
			"INSERT INTO user_feature_flags (user_id, key, enabled, updated_by) VALUES (?, 'flag_a', 1, ?)"
		).run(admin, victim);

		expect(() => deleteUser(victim)).not.toThrow();

		expect(count('users', 'id = ?', victim)).toBe(0);
		expect(count('invites', 'created_by = ?', victim)).toBe(0);
		expect(count('feature_flags', 'updated_by = ?', victim)).toBe(0);
		expect(count('user_feature_flags', 'updated_by = ?', victim)).toBe(0);
		// The flag rows themselves survive with a NULL author, not deleted.
		expect(count('feature_flags', "key = 'flag_a'", )).toBe(1);
		expect(count('user_feature_flags', 'user_id = ?', admin)).toBe(1);
	});

	it('deleteOwnAccount removes a self-deleting user who created invites/flag rows', async () => {
		await makeUser('admin@example.com', { admin: true }); // keep an admin
		const victim = await makeUser('victim@example.com');
		db.prepare("INSERT INTO invites (code, created_by) VALUES ('CODE5678', ?)").run(victim);
		db.prepare("INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('flag_b', 0, ?)").run(victim);

		expect(() => deleteOwnAccount(victim)).not.toThrow();
		expect(count('users', 'id = ?', victim)).toBe(0);
		expect(count('invites', 'created_by = ?', victim)).toBe(0);
		expect(count('feature_flags', 'updated_by = ?', victim)).toBe(0);
	});
});

// ---------------------------------------------------------------- cairn-sclk
describe('cairn-sclk: last-admin guard covers a disabled sole admin', () => {
	it('deleteOwnAccount refuses a DISABLED sole admin (would leave zero admin rows)', async () => {
		const soleAdmin = await makeUser('admin@example.com', { admin: true, disabled: true });
		await makeUser('user@example.com');

		expect(() => deleteOwnAccount(soleAdmin)).toThrow(AuthError);
		expect(count('users', 'id = ? AND is_admin = 1', soleAdmin)).toBe(1);
	});

	it('admin deleteUser refuses a DISABLED sole admin', async () => {
		const soleAdmin = await makeUser('admin@example.com', { admin: true, disabled: true });
		expect(() => deleteUser(soleAdmin)).toThrow(AuthError);
		expect(count('users', 'id = ?', soleAdmin)).toBe(1);
	});

	it('deletionOrphansAdmins predicate matrix', async () => {
		const active = await makeUser('a1@example.com', { admin: true });
		const disabled = await makeUser('a2@example.com', { admin: true, disabled: true });
		const plain = await makeUser('u@example.com');
		const row = (id: number) =>
			db.prepare('SELECT id, is_admin, disabled FROM users WHERE id = ?').get(id) as {
				id: number;
				is_admin: number;
				disabled: number;
			};

		// Deleting the only usable admin (a disabled admin also exists) — blocked.
		expect(deletionOrphansAdmins(row(active))).toBe(true);
		// Deleting the disabled admin while a usable one remains — allowed.
		expect(deletionOrphansAdmins(row(disabled))).toBe(false);
		// Non-admins never orphan the admin set.
		expect(deletionOrphansAdmins(row(plain))).toBe(false);

		// With two usable admins, either may go.
		const active2 = await makeUser('a3@example.com', { admin: true });
		expect(deletionOrphansAdmins(row(active))).toBe(false);
		expect(deletionOrphansAdmins(row(active2))).toBe(false);
	});
});

// ---------------------------------------------------------------- cairn-8r0l
describe('cairn-8r0l: owner deletion guards + notifies cosigners of shared multisigs', () => {
	it('admin deleteUser BLOCKS an owner of a shared multisig unless forced', async () => {
		await makeUser('admin@example.com', { admin: true });
		const owner = await makeUser('owner@example.com');
		const cosigner = await makeUser('cosigner@example.com');
		makeSharedMultisig(owner, cosigner, 'Family Vault');

		try {
			deleteUser(owner);
			throw new Error('expected deleteUser to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(AuthError);
			expect((e as AuthError).code).toBe('owns_shared_multisigs');
			expect((e as AuthError).message).toContain('Family Vault');
		}
		// Nothing was deleted on the blocked attempt.
		expect(count('users', 'id = ?', owner)).toBe(1);
		expect(count('multisigs', 'user_id = ?', owner)).toBe(1);
	});

	it('forced admin deleteUser proceeds and notifies the cosigner (incl. pending PSBT)', async () => {
		await makeUser('admin@example.com', { admin: true });
		const owner = await makeUser('owner@example.com');
		const cosigner = await makeUser('cosigner@example.com');
		const msId = makeSharedMultisig(owner, cosigner, 'Family Vault');
		// An in-flight PSBT awaiting signature.
		db.prepare(
			`INSERT INTO multisig_transactions
			   (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
			 VALUES (?, 'awaiting_signature', 'cHNidP8B', 'bcrt1qrecipient', 100000, 200, 1.0)`
		).run(msId);

		// Sanity: the enumeration sees the wallet + its pending tx before deletion.
		const shared = ownedSharedMultisigs(owner);
		expect(shared).toHaveLength(1);
		expect(shared[0].pendingTxCount).toBe(1);
		expect(shared[0].participantIds).toContain(cosigner);

		deleteUser(owner, { force: true });

		expect(count('users', 'id = ?', owner)).toBe(0);
		expect(count('multisigs', 'id = ?', msId)).toBe(0);
		// The cosigner got an in-app multisig_removed notification.
		const notices = db
			.prepare("SELECT message FROM events WHERE user_id = ? AND type = 'multisig_removed'")
			.all(cosigner) as { message: string }[];
		expect(notices).toHaveLength(1);
		expect(notices[0].message).toContain('Family Vault');
		expect(notices[0].message).toContain('awaiting signature');
	});

	it('deleteOwnAccount is NOT blocked but still notifies cosigners', async () => {
		await makeUser('admin@example.com', { admin: true }); // keep an admin
		const owner = await makeUser('owner@example.com');
		const cosigner = await makeUser('cosigner@example.com');
		const msId = makeSharedMultisig(owner, cosigner, 'Shared Stack');

		expect(() => deleteOwnAccount(owner)).not.toThrow();
		expect(count('users', 'id = ?', owner)).toBe(0);
		expect(count('multisigs', 'id = ?', msId)).toBe(0);
		expect(count('events', "user_id = ? AND type = 'multisig_removed'", cosigner)).toBe(1);
	});

	it('a private (unshared) multisig owner deletes with no guard and no notice', async () => {
		await makeUser('admin@example.com', { admin: true });
		const owner = await makeUser('owner@example.com');
		db.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'Solo MS', 2)").run(owner);

		expect(ownedSharedMultisigs(owner)).toHaveLength(0);
		expect(() => deleteUser(owner)).not.toThrow();
		expect(count('users', 'id = ?', owner)).toBe(0);
		expect(count('events', "type = 'multisig_removed'", )).toBe(0);
	});
});
