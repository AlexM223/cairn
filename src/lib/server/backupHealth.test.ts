import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { markBackedUp } from './backups';
import { runBackupHealthScan } from './backupHealth';

function wipe(): void {
	db.exec(
		`DELETE FROM notification_queue; DELETE FROM notification_preferences;
		 DELETE FROM events; DELETE FROM backup_missing_notified; DELETE FROM wallet_backups;
		 DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

/** Insert a from-scratch multisig created `agoMs` ago. */
function makeMultisig(userId: number, name: string, agoMs: number): number {
	const createdAt = new Date(Date.now() - agoMs).toISOString();
	const info = db
		.prepare(
			`INSERT INTO multisigs (user_id, name, threshold, source, created_at)
			 VALUES (?, ?, 2, 'created', ?)`
		)
		.run(userId, name, createdAt);
	return Number(info.lastInsertRowid);
}

function eventsOfType(type: string): { user_id: number | null; message: string }[] {
	return db
		.prepare('SELECT user_id, message FROM events WHERE type = ? ORDER BY id')
		.all(type) as never;
}

let userId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({ email: 'owner@example.com', password: 'correct horse battery', displayName: 'owner' })
	).id;
});

describe('backup_missing detector (cairn-evp9)', () => {
	it('fires for a from-scratch wallet with no backup, past the grace window', () => {
		makeMultisig(userId, 'Cold Storage', 48 * 3_600_000); // 2 days old
		runBackupHealthScan();

		const evs = eventsOfType('backup_missing');
		expect(evs).toHaveLength(1);
		expect(evs[0].user_id).toBe(userId);
		expect(evs[0].message).toContain('Cold Storage');
	});

	it('does not fire within the creation grace window', () => {
		makeMultisig(userId, 'Fresh Wallet', 60_000); // 1 minute old
		runBackupHealthScan();
		expect(eventsOfType('backup_missing')).toHaveLength(0);
	});

	it('does not fire once the wallet has a backup', () => {
		const id = makeMultisig(userId, 'Backed Up', 48 * 3_600_000);
		markBackedUp(userId, 'multisig', id);
		runBackupHealthScan();
		expect(eventsOfType('backup_missing')).toHaveLength(0);
	});

	it('throttles: does not re-fire on a second scan within the renotify window', () => {
		makeMultisig(userId, 'Cold Storage', 48 * 3_600_000);
		runBackupHealthScan();
		runBackupHealthScan();
		expect(eventsOfType('backup_missing')).toHaveLength(1);
	});
});

describe('backup_stale detector (cairn-evp9)', () => {
	it('fires an admin broadcast when the instance backup is older than the interval', () => {
		// The bootstrap user is an admin; instance backup was long ago.
		setSetting('last_instance_backup_at', new Date(Date.now() - 45 * 86_400_000).toISOString());
		runBackupHealthScan();

		const evs = eventsOfType('backup_stale');
		expect(evs).toHaveLength(1);
		expect(evs[0].user_id).toBeNull(); // instance-wide
		expect(setting('backup_stale_notified_at')).not.toBeNull();
	});

	it('does not fire when no instance backup has ever been taken', () => {
		runBackupHealthScan();
		expect(eventsOfType('backup_stale')).toHaveLength(0);
	});

	it('does not fire when the instance backup is recent', () => {
		setSetting('last_instance_backup_at', new Date(Date.now() - 3 * 86_400_000).toISOString());
		runBackupHealthScan();
		expect(eventsOfType('backup_stale')).toHaveLength(0);
	});
});

function setting(key: string): string | null {
	const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}
