// Scheduled instance backups (cairn-ivae.3) — the automation layer over
// backup.ts's manual encrypted export.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting, getSetting, setSecretSetting } from './settings';
import {
	getScheduledBackupConfig,
	saveScheduledBackupConfig,
	runScheduledBackupIfDue,
	decryptBackup,
	BackupError
} from './backup';

const destDir = path.join(os.tmpdir(), `cairn-schedbk-${randomBytes(6).toString('hex')}`);

function wipe(): void {
	db.exec(
		`DELETE FROM notification_queue; DELETE FROM events; DELETE FROM instance_secrets;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
	fs.rmSync(destDir, { recursive: true, force: true });
}

function enableSchedule(interval: 'daily' | 'weekly' = 'daily'): void {
	saveScheduledBackupConfig({
		enabled: true,
		interval,
		path: destDir,
		passphrase: 'backup passphrase'
	});
}

function backupFiles(): string[] {
	return fs.existsSync(destDir)
		? fs.readdirSync(destDir).filter((f) => f.endsWith('.json'))
		: [];
}

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	await registerUser({
		email: 'admin@example.com',
		password: 'correct horse battery',
		displayName: 'Admin'
	});
});

afterAll(() => {
	fs.rmSync(destDir, { recursive: true, force: true });
});

describe('saveScheduledBackupConfig', () => {
	it('round-trips the config and stores the passphrase as a presence flag only', () => {
		enableSchedule('weekly');
		const cfg = getScheduledBackupConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.interval).toBe('weekly');
		expect(cfg.path).toBe(destDir);
		expect(cfg.hasPassphrase).toBe(true);
		// Never retrievable from the plain settings table.
		expect(getSetting('scheduled_backup_pass')).toBeNull();
	});

	it('rejects enabling without a destination or passphrase', () => {
		expect(() =>
			saveScheduledBackupConfig({ enabled: true, interval: 'daily', path: '', passphrase: 'x'.repeat(8) })
		).toThrow(BackupError);
		expect(() =>
			saveScheduledBackupConfig({ enabled: true, interval: 'daily', path: destDir, passphrase: '' })
		).toThrow(BackupError);
	});

	it('rejects a relative destination and a short passphrase', () => {
		expect(() =>
			saveScheduledBackupConfig({
				enabled: true,
				interval: 'daily',
				path: 'relative/dir',
				passphrase: 'long enough'
			})
		).toThrow(BackupError);
		expect(() =>
			saveScheduledBackupConfig({ enabled: true, interval: 'daily', path: destDir, passphrase: 'short' })
		).toThrow(BackupError);
	});

	it('keeps the stored passphrase when saving with a blank one', () => {
		enableSchedule();
		saveScheduledBackupConfig({ enabled: true, interval: 'daily', path: destDir, passphrase: '' });
		expect(getScheduledBackupConfig().hasPassphrase).toBe(true);
	});
});

describe('runScheduledBackupIfDue', () => {
	it('does nothing when disabled', async () => {
		expect(await runScheduledBackupIfDue()).toBe(false);
		expect(backupFiles()).toHaveLength(0);
	});

	it('writes a decryptable backup, stamps both timestamps, and clears errors', async () => {
		enableSchedule();
		expect(await runScheduledBackupIfDue()).toBe(true);

		const files = backupFiles();
		expect(files).toHaveLength(1);
		const data = await decryptBackup(
			fs.readFileSync(path.join(destDir, files[0]), 'utf8'),
			'backup passphrase'
		);
		expect(data.users.map((u) => u.email)).toContain('admin@example.com');

		// Updates the SAME staleness key as a manual download (no double-report).
		expect(getSetting('last_instance_backup_at')).not.toBeNull();
		expect(getSetting('scheduled_backup_last_run_at')).toBe(getSetting('last_instance_backup_at'));
		expect(getScheduledBackupConfig().lastError).toBeNull();
	});

	it('is not due again immediately after a successful run', async () => {
		enableSchedule();
		expect(await runScheduledBackupIfDue()).toBe(true);
		expect(await runScheduledBackupIfDue()).toBe(false);
	});

	it('is due again once the interval has elapsed', async () => {
		enableSchedule();
		expect(await runScheduledBackupIfDue()).toBe(true);
		const later = Date.now() + 25 * 3_600_000;
		expect(await runScheduledBackupIfDue(later)).toBe(true);
	});

	it('weekly schedule does not re-run after only a day', async () => {
		enableSchedule('weekly');
		expect(await runScheduledBackupIfDue()).toBe(true);
		expect(await runScheduledBackupIfDue(Date.now() + 25 * 3_600_000)).toBe(false);
	});

	it('surfaces a write failure as an admin notification, throttled', async () => {
		enableSchedule();
		// Break the destination AFTER save-time validation passed: point the
		// stored path at a location that cannot be a directory (a file).
		fs.mkdirSync(destDir, { recursive: true });
		const blocker = path.join(destDir, 'not-a-dir');
		fs.writeFileSync(blocker, 'x');
		setSetting('scheduled_backup_path', path.join(blocker, 'sub'));

		expect(await runScheduledBackupIfDue()).toBe(false);
		expect(getScheduledBackupConfig().lastError).not.toBeNull();

		const events = db
			.prepare("SELECT user_id, level FROM events WHERE type = 'admin_server_health'")
			.all() as { user_id: number | null; level: string }[];
		expect(events).toHaveLength(1);
		expect(events[0].user_id).toBeNull(); // admin fan-out
		expect(events[0].level).toBe('error');

		// A second failing tick shortly after must NOT notify again (throttle),
		// though it still retries and records the error.
		expect(await runScheduledBackupIfDue(Date.now() + 60_000)).toBe(false);
		const after = db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'admin_server_health'")
			.get() as { n: number };
		expect(after.n).toBe(1);
	});

	it('fails (notified, not thrown) when the stored passphrase is missing', async () => {
		enableSchedule();
		setSecretSetting('scheduled_backup_pass', '');
		expect(await runScheduledBackupIfDue()).toBe(false);
		expect(getScheduledBackupConfig().lastError).toContain('passphrase');
	});

	it('prunes old scheduled files beyond the retention count', async () => {
		enableSchedule();
		fs.mkdirSync(destDir, { recursive: true });
		// Seed 32 old files in the exact scheduled-name format, plus one
		// operator file that must survive.
		for (let i = 1; i <= 32; i++) {
			const day = String(i).padStart(2, '0');
			fs.writeFileSync(path.join(destDir, `cairn-backup-2020-01-${day}.json`), '{}');
		}
		fs.writeFileSync(path.join(destDir, 'my-own-notes.json'), '{}');

		expect(await runScheduledBackupIfDue()).toBe(true);
		const files = backupFiles();
		// 30 kept in total (today's + the 29 newest seeds), plus the foreign file.
		expect(files.filter((f) => /^cairn-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))).toHaveLength(30);
		expect(files).toContain('my-own-notes.json');
		expect(files).not.toContain('cairn-backup-2020-01-01.json');
	});
});
