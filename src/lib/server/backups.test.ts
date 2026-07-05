import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import {
	markBackedUp,
	isBackedUp,
	listUnbackedWallets,
	shouldShowBackupReminder,
	dismissBackupReminder
} from './backups';

// A known-valid mainnet xpub (same fixture family the xpub tests use).
const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM wallet_backups; DELETE FROM backup_reminders; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Insert a bare multisig row with a given source ('created' | 'imported'). */
function makeMultisig(userId: number, name: string, source: 'created' | 'imported' = 'created'): number {
	const info = db
		.prepare(
			'INSERT INTO multisigs (user_id, name, threshold, script_type, source) VALUES (?, ?, 2, ?, ?)'
		)
		.run(userId, name, 'p2wsh', source);
	return Number(info.lastInsertRowid);
}

describe('wallet-config backup tracking', () => {
	it('only multisigs CREATED from scratch need a backup — single-sig never nags', () => {
		const user = makeUser('a@example.com');
		createWallet(user.id, { name: 'Savings', xpub: XPUB }); // single-sig
		const ms = makeMultisig(user.id, 'Family vault', 'created');

		const unbacked = listUnbackedWallets(user.id);
		expect(unbacked).toHaveLength(1);
		expect(unbacked[0]).toMatchObject({ kind: 'multisig', id: ms, name: 'Family vault' });
	});

	it('an IMPORTED multisig never appears in the unbacked list', () => {
		const user = makeUser('a@example.com');
		makeMultisig(user.id, 'Imported vault', 'imported');
		expect(listUnbackedWallets(user.id)).toHaveLength(0);
	});

	it('markBackedUp drops a created multisig from the unbacked list', () => {
		const user = makeUser('a@example.com');
		const ms = makeMultisig(user.id, 'Family vault', 'created');
		expect(listUnbackedWallets(user.id)).toHaveLength(1);

		markBackedUp(user.id, 'multisig', ms);

		expect(isBackedUp('multisig', ms)).toBe(true);
		expect(listUnbackedWallets(user.id)).toHaveLength(0);
	});

	it('markBackedUp is idempotent but refreshes downloaded_at (single-sig, table mechanics)', () => {
		const user = makeUser('a@example.com');
		const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });

		markBackedUp(user.id, 'wallet', wallet.id);
		db.prepare(
			"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_kind = 'wallet' AND wallet_id = ?"
		).run(wallet.id);
		markBackedUp(user.id, 'wallet', wallet.id);

		const rows = db
			.prepare("SELECT downloaded_at FROM wallet_backups WHERE wallet_kind = 'wallet' AND wallet_id = ?")
			.all(wallet.id) as { downloaded_at: string }[];
		expect(rows).toHaveLength(1); // idempotent — one row
		expect(rows[0].downloaded_at).not.toBe('2000-01-01T00:00:00.000Z'); // refreshed
	});

	it('unbacked list is scoped per user', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		makeMultisig(alice.id, 'Alice vault', 'created');
		makeMultisig(bob.id, "Bob's vault", 'created');

		expect(listUnbackedWallets(alice.id)).toHaveLength(1);
		expect(listUnbackedWallets(bob.id)).toHaveLength(1);
		expect(listUnbackedWallets(alice.id)[0].name).toBe('Alice vault');
	});

	describe('90-day reminder (created multisig only)', () => {
		it('stays quiet when the user has no created-multisig backups', () => {
			const user = makeUser('a@example.com');
			// Single-sig + imported multisig backups do NOT drive the reminder.
			const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });
			markBackedUp(user.id, 'wallet', wallet.id);
			const imp = makeMultisig(user.id, 'Imported', 'imported');
			markBackedUp(user.id, 'multisig', imp);
			db.prepare("UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z'").run();

			expect(shouldShowBackupReminder(user.id)).toBe(false);
		});

		it('fires when a created multisig backup is older than the window and undismissed', () => {
			const user = makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			markBackedUp(user.id, 'multisig', ms);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);

			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});

		it('is silenced by a recent dismissal, then returns once the dismissal ages out', () => {
			const user = makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			markBackedUp(user.id, 'multisig', ms);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);

			dismissBackupReminder(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(false);

			db.prepare(
				"UPDATE backup_reminders SET dismissed_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?"
			).run(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});
	});
});
