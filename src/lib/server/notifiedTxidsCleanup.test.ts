// cairn-h8xo — notified_txids has no FK to wallets/multisigs (cairn-zari), so the
// watcher's notification-dedup rows do NOT cascade when a wallet is deleted.
// Pre-fix, deleteWallet()/deleteMultisig() left orphaned rows behind; because
// SQLite reuses AUTOINCREMENT-free rowids across kinds, stale dedup state could
// later suppress a brand-new wallet's tx_received notifications. These tests pin
// the explicit cleanup in both deletion paths (resetInstance's full-table clear
// is pinned in admin.test.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { deleteWallet } from './wallets';
import { deleteMultisig } from './wallets/multisig';

function wipe(): void {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM wallet_backups; DELETE FROM backup_missing_notified; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

let xpubSeq = 0;
function makeWallet(userId: number): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
		.run(userId, `xpub-test-${xpubSeq++}`);
	return Number(res.lastInsertRowid);
}

function makeMultisig(userId: number): number {
	const res = db
		.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'ms', 2, 'p2wsh')")
		.run(userId);
	return Number(res.lastInsertRowid);
}

function seedNotified(kind: 'wallet' | 'multisig', walletId: number, userId: number, txid: string): void {
	db.prepare(
		'INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid) VALUES (?, ?, ?, ?)'
	).run(kind, walletId, userId, txid);
}

function notifiedCount(kind: 'wallet' | 'multisig', walletId: number): number {
	return (
		db
			.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE wallet_kind = ? AND wallet_id = ?')
			.get(kind, walletId) as { n: number }
	).n;
}

describe('notified_txids cleanup on wallet deletion (cairn-h8xo)', () => {
	it('deleteWallet clears that wallet’s dedup rows — and only those', async () => {
		const user = await makeUser('owner@example.com');
		const gone = makeWallet(user.id);
		const kept = makeWallet(user.id);

		seedNotified('wallet', gone, user.id, 'a'.repeat(64));
		seedNotified('wallet', gone, user.id, 'b'.repeat(64));
		seedNotified('wallet', kept, user.id, 'c'.repeat(64));
		// A multisig dedup row with the SAME numeric id as the deleted wallet: the
		// cleanup must be kind-scoped, not a bare wallet_id match.
		seedNotified('multisig', gone, user.id, 'd'.repeat(64));

		expect(deleteWallet(user.id, gone)).toBe(true);

		expect(notifiedCount('wallet', gone)).toBe(0); // orphans removed
		expect(notifiedCount('wallet', kept)).toBe(1); // other wallet untouched
		expect(notifiedCount('multisig', gone)).toBe(1); // other kind untouched
	});

	it('a failed (non-owned) deleteWallet leaves the dedup rows alone', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const wallet = makeWallet(owner.id);
		seedNotified('wallet', wallet, owner.id, 'a'.repeat(64));

		expect(deleteWallet(other.id, wallet)).toBe(false);
		expect(notifiedCount('wallet', wallet)).toBe(1);
	});

	it('deleteMultisig clears that multisig’s dedup rows — and only those', async () => {
		const user = await makeUser('owner@example.com');
		const gone = makeMultisig(user.id);
		const kept = makeMultisig(user.id);

		seedNotified('multisig', gone, user.id, 'a'.repeat(64));
		seedNotified('multisig', gone, user.id, 'b'.repeat(64));
		seedNotified('multisig', kept, user.id, 'c'.repeat(64));
		// A single-sig dedup row with the deleted multisig's numeric id — must survive.
		seedNotified('wallet', gone, user.id, 'd'.repeat(64));

		expect(deleteMultisig(user.id, gone)).toBe(true);

		expect(notifiedCount('multisig', gone)).toBe(0);
		expect(notifiedCount('multisig', kept)).toBe(1);
		expect(notifiedCount('wallet', gone)).toBe(1);
	});

	it('a failed (non-owned) deleteMultisig leaves the dedup rows alone', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const ms = makeMultisig(owner.id);
		seedNotified('multisig', ms, owner.id, 'a'.repeat(64));

		expect(deleteMultisig(other.id, ms)).toBe(false);
		expect(notifiedCount('multisig', ms)).toBe(1);
	});
});

// wallet_backups / backup_missing_notified share notified_txids' no-FK
// (wallet_kind, wallet_id) shape and needed the same hand cleanup — a reused
// wallet id must not inherit the old wallet's backup status (cairn-zui7.6).
describe('backup-status ledger cleanup on wallet deletion (cairn-zui7.6)', () => {
	function seedBackupRows(kind: 'wallet' | 'multisig', walletId: number, userId: number): void {
		db.prepare(
			'INSERT INTO wallet_backups (user_id, wallet_kind, wallet_id) VALUES (?, ?, ?)'
		).run(userId, kind, walletId);
		db.prepare(
			'INSERT INTO backup_missing_notified (wallet_kind, wallet_id) VALUES (?, ?)'
		).run(kind, walletId);
	}

	function ledgerCount(table: string, kind: 'wallet' | 'multisig', walletId: number): number {
		return (
			db
				.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE wallet_kind = ? AND wallet_id = ?`)
				.get(kind, walletId) as { n: number }
		).n;
	}

	it('deleteWallet clears both ledgers for that wallet, kind-scoped', async () => {
		const user = await makeUser('owner@example.com');
		const gone = makeWallet(user.id);
		seedBackupRows('wallet', gone, user.id);
		// A multisig row with the same numeric id — must survive.
		seedBackupRows('multisig', gone, user.id);

		expect(deleteWallet(user.id, gone)).toBe(true);
		expect(ledgerCount('wallet_backups', 'wallet', gone)).toBe(0);
		expect(ledgerCount('backup_missing_notified', 'wallet', gone)).toBe(0);
		expect(ledgerCount('wallet_backups', 'multisig', gone)).toBe(1);
		expect(ledgerCount('backup_missing_notified', 'multisig', gone)).toBe(1);
	});

	it('deleteMultisig clears both ledgers for that multisig, kind-scoped', async () => {
		const user = await makeUser('owner@example.com');
		const gone = makeMultisig(user.id);
		seedBackupRows('multisig', gone, user.id);
		seedBackupRows('wallet', gone, user.id);

		expect(deleteMultisig(user.id, gone)).toBe(true);
		expect(ledgerCount('wallet_backups', 'multisig', gone)).toBe(0);
		expect(ledgerCount('backup_missing_notified', 'multisig', gone)).toBe(0);
		expect(ledgerCount('wallet_backups', 'wallet', gone)).toBe(1);
		expect(ledgerCount('backup_missing_notified', 'wallet', gone)).toBe(1);
	});
});
