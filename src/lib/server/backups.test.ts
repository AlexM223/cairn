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

/** Insert a bare multisig row (bypasses crypto validation — we only test the
 *  backup-tracking layer, which reads the multisigs table directly). */
function makeMultisig(userId: number, name: string): number {
	const info = db
		.prepare('INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, ?)')
		.run(userId, name, 'p2wsh');
	return Number(info.lastInsertRowid);
}

describe('wallet-config backup tracking', () => {
	it('a fresh wallet is not backed up and shows in the unbacked list', () => {
		const user = makeUser('a@example.com');
		const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });

		expect(isBackedUp('wallet', wallet.id)).toBe(false);
		const unbacked = listUnbackedWallets(user.id);
		expect(unbacked).toHaveLength(1);
		expect(unbacked[0]).toMatchObject({ kind: 'wallet', id: wallet.id, name: 'Savings' });
	});

	it('markBackedUp records the backup and drops it from the unbacked list', () => {
		const user = makeUser('a@example.com');
		const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });

		markBackedUp(user.id, 'wallet', wallet.id);

		expect(isBackedUp('wallet', wallet.id)).toBe(true);
		expect(listUnbackedWallets(user.id)).toHaveLength(0);
	});

	it('markBackedUp is idempotent but refreshes downloaded_at on re-download', () => {
		const user = makeUser('a@example.com');
		const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });

		markBackedUp(user.id, 'wallet', wallet.id);
		// Force the stored timestamp into the past, then re-download.
		db.prepare(
			"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_kind = 'wallet' AND wallet_id = ?"
		).run(wallet.id);
		markBackedUp(user.id, 'wallet', wallet.id);

		const rows = db
			.prepare("SELECT downloaded_at FROM wallet_backups WHERE wallet_kind = 'wallet' AND wallet_id = ?")
			.all(wallet.id) as { downloaded_at: string }[];
		expect(rows).toHaveLength(1); // still one row (idempotent)
		expect(rows[0].downloaded_at).not.toBe('2000-01-01T00:00:00.000Z'); // refreshed
	});

	it('listUnbackedWallets covers both single-sig and multisig, scoped per user', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const w = createWallet(alice.id, { name: 'Alice SS', xpub: XPUB });
		const ms = makeMultisig(alice.id, 'Alice MS');
		makeMultisig(bob.id, "Bob's own");

		const aliceUnbacked = listUnbackedWallets(alice.id);
		expect(aliceUnbacked.map((u) => u.kind).sort()).toEqual(['multisig', 'wallet']);

		markBackedUp(alice.id, 'multisig', ms);
		expect(listUnbackedWallets(alice.id).map((u) => u.id)).toEqual([w.id]); // only the single-sig left
		// Bob's list is independent of Alice's backups.
		expect(listUnbackedWallets(bob.id)).toHaveLength(1);
	});

	describe('90-day reminder', () => {
		it('stays quiet when the user has no backups at all (unbacked banner owns that)', () => {
			const user = makeUser('a@example.com');
			createWallet(user.id, { name: 'Savings', xpub: XPUB });
			expect(shouldShowBackupReminder(user.id)).toBe(false);
		});

		it('stays quiet when the most recent backup is recent', () => {
			const user = makeUser('a@example.com');
			const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });
			markBackedUp(user.id, 'wallet', wallet.id); // downloaded_at defaults to now
			expect(shouldShowBackupReminder(user.id)).toBe(false);
		});

		it('fires when the newest backup is older than the window and undismissed', () => {
			const user = makeUser('a@example.com');
			const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });
			markBackedUp(user.id, 'wallet', wallet.id);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(wallet.id);

			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});

		it('is silenced by a recent dismissal, then returns once the dismissal is old', () => {
			const user = makeUser('a@example.com');
			const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });
			markBackedUp(user.id, 'wallet', wallet.id);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(wallet.id);

			dismissBackupReminder(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(false);

			// Age the dismissal past the window — the nudge should come back.
			db.prepare(
				"UPDATE backup_reminders SET dismissed_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?"
			).run(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});
	});
});
