// cairn-5u2i.2 — self-service account deletion. Deleting your own account must
// remove everything you own (wallets, multisigs, sessions, credentials, config,
// labels, the no-FK ledger rows) while multisigs you merely PARTICIPATED in
// survive intact for their owner, minus your share row. The only-admin guard
// keeps an instance from deleting its last administrator.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, AuthError } from './auth';
import { setSetting } from './settings';
import { deleteOwnAccount } from './accountDeletion';

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM address_labels; DELETE FROM wallet_backups;
		 DELETE FROM backup_missing_notified; DELETE FROM invites; DELETE FROM multisig_shares;
		 DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM wallets;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string, opts: { admin?: boolean } = {}): number {
	const id = registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	}).id;
	if (opts.admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
	return id;
}

function count(table: string, where: string, ...params: (string | number)[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }
	).n;
}

describe('deleteOwnAccount', () => {
	it('removes the user and everything they own, including the no-FK ledger rows', () => {
		makeUser('admin@example.com', { admin: true }); // instance keeps an admin
		const uid = makeUser('leaver@example.com');

		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-w', 'p2wpkh')")
				.run(uid).lastInsertRowid
		);
		const msId = Number(
			db.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'MS', 2)").run(uid)
				.lastInsertRowid
		);
		// The no-FK tables that need hand cleanup.
		db.prepare("INSERT INTO notified_txids (user_id, wallet_kind, wallet_id, txid) VALUES (?, 'wallet', ?, 'aa')").run(uid, walletId);
		db.prepare("INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES ('wallet', ?, 'bcrt1q1', 'x')").run(walletId);
		db.prepare("INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES ('multisig', ?, 'bcrt1q2', 'y')").run(msId);
		db.prepare("INSERT INTO wallet_backups (user_id, wallet_kind, wallet_id) VALUES (?, 'wallet', ?)").run(uid, walletId);
		db.prepare("INSERT INTO backup_missing_notified (wallet_kind, wallet_id) VALUES ('multisig', ?)").run(msId);
		// An invite they created (FK with no cascade — would block a naive delete).
		db.prepare("INSERT INTO invites (code, created_by) VALUES ('CODE1234', ?)").run(uid);

		deleteOwnAccount(uid);

		expect(count('users', 'id = ?', uid)).toBe(0);
		expect(count('wallets', 'user_id = ?', uid)).toBe(0);
		expect(count('multisigs', 'user_id = ?', uid)).toBe(0);
		expect(count('notified_txids', 'user_id = ?', uid)).toBe(0);
		expect(count('address_labels', 'wallet_id IN (?, ?)', walletId, msId)).toBe(0);
		expect(count('wallet_backups', 'wallet_id = ?', walletId)).toBe(0);
		expect(count('backup_missing_notified', 'wallet_id = ?', msId)).toBe(0);
		expect(count('invites', 'created_by = ?', uid)).toBe(0);
	});

	it('removes only the share row for a multisig the user participated in — the wallet survives', () => {
		makeUser('admin@example.com', { admin: true });
		const owner = makeUser('owner@example.com');
		const leaver = makeUser('leaver@example.com');
		const other = makeUser('other@example.com');

		const msId = Number(
			db.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'Shared', 2)").run(owner)
				.lastInsertRowid
		);
		const share = db.prepare(
			'INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)'
		);
		share.run(msId, owner, leaver, 'cosigner');
		share.run(msId, owner, other, 'viewer');

		deleteOwnAccount(leaver);

		// The multisig and the OTHER participant's share are untouched.
		expect(count('multisigs', 'id = ?', msId)).toBe(1);
		expect(count('multisig_shares', 'multisig_id = ? AND shared_with_id = ?', msId, other)).toBe(1);
		// The leaver's share is gone.
		expect(count('multisig_shares', 'shared_with_id = ?', leaver)).toBe(0);
	});

	it('refuses to delete the only active administrator', () => {
		const soleAdmin = makeUser('admin@example.com', { admin: true });
		makeUser('user@example.com');

		expect(() => deleteOwnAccount(soleAdmin)).toThrow(AuthError);
		expect(count('users', 'id = ?', soleAdmin)).toBe(1); // nothing deleted

		// With a second admin present, self-deletion works.
		makeUser('admin2@example.com', { admin: true });
		deleteOwnAccount(soleAdmin);
		expect(count('users', 'id = ?', soleAdmin)).toBe(0);
	});

	it('throws not_found for a nonexistent user', () => {
		expect(() => deleteOwnAccount(999_999)).toThrow(AuthError);
	});
});
