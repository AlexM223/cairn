import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, addCredential, getUserByEmail, hasNoCredentials, listCredentials } from './auth';
import { buildBackup, encryptBackup, decryptBackup, restoreBackup, BackupError } from './backup';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM tx_labels; DELETE FROM saved_addresses; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	// open mode so we can create extra users without invites
	db.prepare("INSERT INTO settings (key, value) VALUES ('registration_mode', 'open')").run();
});

function makeWallet(userId: number, xpub: string) {
	db.prepare(
		"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', ?, 'p2wpkh')"
	).run(userId, xpub);
}

const PP = 'a-strong-passphrase';

describe('encrypt / decrypt', () => {
	it('round-trips a backup with the right passphrase', () => {
		registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('2026-07-05T00:00:00.000Z');
		const blob = encryptBackup(data, PP);
		const back = decryptBackup(blob, PP);
		expect(back.users).toHaveLength(1);
		expect(back.users[0]).toMatchObject({ email: 'admin@example.com' });
	});

	it('rejects a wrong passphrase', () => {
		const blob = encryptBackup(buildBackup('t'), PP);
		expect(() => decryptBackup(blob, 'wrong-passphrase')).toThrowError(BackupError);
	});

	it('rejects non-backup / corrupt input', () => {
		expect(() => decryptBackup('not json', PP)).toThrowError(BackupError);
		expect(() => decryptBackup('{"format":"other"}', PP)).toThrowError(BackupError);
	});

	it('never includes credentials or password material', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		addCredential(admin.id, {
			credentialId: 'c1',
			publicKey: new Uint8Array([9, 9, 9]),
			counter: 0,
			name: 'Phone'
		});
		const blob = encryptBackup(buildBackup('t'), PP);
		// The plaintext (decrypted) must not carry credential fields.
		const text = JSON.stringify(decryptBackup(blob, PP));
		expect(text).not.toContain('credential');
		expect(text).not.toContain('public_key');
		expect(text).not.toContain('password');
		expect(text).not.toContain('token');
	});

	it('excludes secret settings like the Bitcoin Core RPC password', () => {
		registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		db.prepare("INSERT INTO settings (key, value) VALUES ('core_rpc_pass', 'supersecret')").run();
		const data = buildBackup('t');
		expect(data.settings.some((s) => s.key === 'core_rpc_pass')).toBe(false);
		expect(JSON.stringify(data)).not.toContain('supersecret');
	});
});

describe('restore', () => {
	it('additively restores missing accounts and their wallets, credential-less', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		makeWallet(bob.id, 'xpubBOB');

		const data = buildBackup('t');

		// Simulate a fresh instance where only the admin exists (bob is gone).
		db.prepare('DELETE FROM users WHERE id = ?').run(bob.id); // wallets cascade

		const summary = restoreBackup(data);
		expect(summary.usersAdded).toBe(1); // bob
		expect(summary.usersSkipped).toBe(1); // admin already exists
		expect(summary.wallets).toBe(1);

		const restoredBob = getUserByEmail('bob@example.com');
		expect(restoredBob).not.toBeNull();
		expect(restoredBob!.id).not.toBe(bob.id); // remapped id
		expect(hasNoCredentials(restoredBob!.id)).toBe(true);
		expect(listCredentials(admin.id)).toBeDefined();

		const wallets = db
			.prepare('SELECT xpub FROM wallets WHERE user_id = ?')
			.all(restoredBob!.id) as { xpub: string }[];
		expect(wallets.map((w) => w.xpub)).toContain('xpubBOB');
	});

	it('does not clobber an existing account with the same email', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		addCredential(admin.id, {
			credentialId: 'c1',
			publicKey: new Uint8Array([1]),
			counter: 0,
			name: 'Phone'
		});
		const data = buildBackup('t');

		const summary = restoreBackup(data);
		expect(summary.usersSkipped).toBe(1);
		expect(summary.usersAdded).toBe(0);
		// The admin's passkey is untouched.
		expect(hasNoCredentials(admin.id)).toBe(false);
	});

	it('forces imported accounts to non-admin, never trusting the backup is_admin flag (cairn-cpb5)', () => {
		registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('t');
		// Craft a hostile backup: an extra credential-less row claiming admin — the
		// exact shape an attacker would social-engineer an admin into restoring.
		data.users.push({
			id: 9999,
			email: 'attacker@example.com',
			display_name: 'Attacker',
			is_admin: 1,
			disabled: 0,
			created_at: 't',
			last_login: null
		});

		const summary = restoreBackup(data);
		expect(summary.usersAdded).toBe(1);
		expect(summary.adminDowngraded).toBe(1);

		const imported = getUserByEmail('attacker@example.com');
		expect(imported).not.toBeNull();
		expect(imported!.isAdmin).toBe(false); // demoted despite is_admin: 1 in the file
	});

	it('restores settings', () => {
		registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		db.prepare("INSERT INTO settings (key, value) VALUES ('electrum_host', 'my.node')").run();
		const data = buildBackup('t');

		db.prepare("DELETE FROM settings WHERE key = 'electrum_host'").run();
		restoreBackup(data);
		const row = db.prepare("SELECT value FROM settings WHERE key = 'electrum_host'").get() as {
			value: string;
		};
		expect(row.value).toBe('my.node');
	});
});
