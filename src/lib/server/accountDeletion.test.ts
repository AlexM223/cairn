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

async function makeUser(email: string, opts: { admin?: boolean } = {}): Promise<number> {
	const id = (
		await registerUser({
			email,
			password: 'correct horse battery',
			displayName: email.split('@')[0]
		})
	).id;
	if (opts.admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
	return id;
}

function count(table: string, where: string, ...params: (string | number)[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }
	).n;
}

describe('deleteOwnAccount', () => {
	it('removes the user and everything they own, including the no-FK ledger rows', async () => {
		await makeUser('admin@example.com', { admin: true }); // instance keeps an admin
		const uid = await makeUser('leaver@example.com');

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

	it('removes only the share row for a multisig the user participated in — the wallet survives', async () => {
		await makeUser('admin@example.com', { admin: true });
		const owner = await makeUser('owner@example.com');
		const leaver = await makeUser('leaver@example.com');
		const other = await makeUser('other@example.com');

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

	it('refuses to delete the only active administrator', async () => {
		const soleAdmin = await makeUser('admin@example.com', { admin: true });
		await makeUser('user@example.com');

		expect(() => deleteOwnAccount(soleAdmin)).toThrow(AuthError);
		expect(count('users', 'id = ?', soleAdmin)).toBe(1); // nothing deleted

		// With a second admin present, self-deletion works.
		await makeUser('admin2@example.com', { admin: true });
		deleteOwnAccount(soleAdmin);
		expect(count('users', 'id = ?', soleAdmin)).toBe(0);
	});

	it('throws not_found for a nonexistent user', () => {
		expect(() => deleteOwnAccount(999_999)).toThrow(AuthError);
	});
});

// ---- cairn-vop2: whole-account deletion refuses on a live broadcast claim ----
//
// deleteOwnAccount cascades every owned wallet/multisig via the users FK
// (purgeUserRow's plain DELETE FROM users), which bypasses deleteWallet()'s /
// deleteMultisig()'s own per-object broadcast guard entirely. This mirrors
// that same guard at the account level via hasLiveBroadcastClaimForUser.
describe('deleteOwnAccount broadcast-claim guard (cairn-vop2)', () => {
	it('refuses while an owned wallet has a transaction with a live broadcast claim', async () => {
		await makeUser('admin@example.com', { admin: true });
		const uid = await makeUser('leaver@example.com');
		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-w', 'p2wpkh')")
				.run(uid).lastInsertRowid
		);
		db.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, broadcast_started_at)
			 VALUES (?, 'awaiting_signature', 'cHNidA==', 'bc1qtest', 10000, 100, 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
		).run(walletId);

		expect(() => deleteOwnAccount(uid)).toThrow(AuthError);
		try {
			deleteOwnAccount(uid);
			expect.unreachable();
		} catch (e) {
			expect((e as AuthError).code).toBe('broadcast_in_progress');
		}
		expect(count('users', 'id = ?', uid)).toBe(1); // nothing deleted
	});

	it('refuses while an owned multisig has a transaction with a live broadcast claim', async () => {
		await makeUser('admin@example.com', { admin: true });
		const uid = await makeUser('ms-leaver@example.com');
		const msId = Number(
			db.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'MS', 2)").run(uid)
				.lastInsertRowid
		);
		db.prepare(
			`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, broadcast_started_at)
			 VALUES (?, 'awaiting_signature', 'cHNidA==', 'bc1qtest', 10000, 100, 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
		).run(msId);

		expect(() => deleteOwnAccount(uid)).toThrow(AuthError);
		expect(count('users', 'id = ?', uid)).toBe(1);
	});

	it('allows deletion once the broadcast claim goes stale (>60s)', async () => {
		await makeUser('admin@example.com', { admin: true });
		const uid = await makeUser('stale-leaver@example.com');
		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-stale', 'p2wpkh')")
				.run(uid).lastInsertRowid
		);
		db.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, broadcast_started_at)
			 VALUES (?, 'awaiting_signature', 'cHNidA==', 'bc1qtest', 10000, 100, 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds'))`
		).run(walletId);

		deleteOwnAccount(uid);
		expect(count('users', 'id = ?', uid)).toBe(0);
	});
});
