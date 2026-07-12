import { describe, it, expect, beforeEach, vi } from 'vitest';

// cairn-yjs5 (fix cairn-sd3n): restoreBackup skips malformed/duplicate rows —
// those skips must each log a warning with table + source-id context. backup.ts
// captures `const log = childLogger('backup')` at import time, so the logger is
// mocked here at the top; vi.mock is hoisted above the imports below, which is
// what makes spying possible despite this file importing backup.ts directly.
const logMock = vi.hoisted(() => {
	const log: Record<string, unknown> = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn()
	};
	log.child = () => log;
	return log as {
		warn: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
		fatal: ReturnType<typeof vi.fn>;
		child: () => unknown;
	};
});
vi.mock('./logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log'
}));

import { db } from './db';
import { registerUser, addCredential, getUserByEmail, hasNoCredentials, hasPassword, listCredentials } from './auth';
import { buildBackup, encryptBackup, decryptBackup, restoreBackup, BackupError } from './backup';
import { consumeRecoveryCode } from './recovery';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM tx_labels; DELETE FROM saved_addresses; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;'
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
	it('round-trips a backup with the right passphrase', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('2026-07-05T00:00:00.000Z');
		const blob = await encryptBackup(data, PP);
		const back = await decryptBackup(blob, PP);
		expect(back.users).toHaveLength(1);
		expect(back.users[0]).toMatchObject({ email: 'admin@example.com' });
	});

	it('rejects a wrong passphrase', async () => {
		const blob = await encryptBackup(buildBackup('t'), PP);
		await expect(decryptBackup(blob, 'wrong-passphrase')).rejects.toThrowError(BackupError);
	});

	it('rejects non-backup / corrupt input', async () => {
		await expect(decryptBackup('not json', PP)).rejects.toThrowError(BackupError);
		await expect(decryptBackup('{"format":"other"}', PP)).rejects.toThrowError(BackupError);
	});

	it('never includes credentials or password material', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		addCredential(admin.id, {
			credentialId: 'c1',
			publicKey: new Uint8Array([9, 9, 9]),
			counter: 0,
			name: 'Phone'
		});
		const blob = await encryptBackup(buildBackup('t'), PP);
		// The plaintext (decrypted) must not carry credential fields.
		const text = JSON.stringify(await decryptBackup(blob, PP));
		expect(text).not.toContain('credential');
		expect(text).not.toContain('public_key');
		expect(text).not.toContain('password');
		expect(text).not.toContain('token');
	});

	it('excludes secret settings like the Bitcoin Core RPC password', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		db.prepare("INSERT INTO settings (key, value) VALUES ('core_rpc_pass', 'supersecret')").run();
		const data = buildBackup('t');
		expect(data.settings.some((s) => s.key === 'core_rpc_pass')).toBe(false);
		expect(JSON.stringify(data)).not.toContain('supersecret');
	});

	it('excludes instance_secrets by construction — even an innocently-named key (cairn-e9mz.4)', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		// A key the SENSITIVE_SETTING regex would NOT catch: exclusion must come
		// from the table never being exported, not from name-based filtering.
		db.prepare(
			"INSERT INTO instance_secrets (key, value_enc) VALUES ('harmless_looking', 'bogus-envelope-material')"
		).run();
		const data = buildBackup('t');
		expect(JSON.stringify(data)).not.toContain('bogus-envelope-material');
		expect(JSON.stringify(data)).not.toContain('instance_secrets');
	});

	it('rejects a backup envelope from a newer format version (cairn-lka5)', async () => {
		const blob = await encryptBackup(buildBackup('t'), PP);
		const envelope = JSON.parse(blob);
		envelope.version = 999;
		await expect(decryptBackup(JSON.stringify(envelope), PP)).rejects.toThrowError(BackupError);
	});

	it('rejects inner backup data flagged with a newer version number (cairn-lka5)', async () => {
		const data = buildBackup('t');
		(data as unknown as { version: number }).version = 999;
		const blob = await encryptBackup(data, PP);
		await expect(decryptBackup(blob, PP)).rejects.toThrowError(BackupError);
	});
});

describe('restore', () => {
	it('additively restores missing accounts and their wallets, credential-less', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = await registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		makeWallet(bob.id, 'xpubBOB');

		const data = buildBackup('t');

		// Simulate a fresh instance where only the admin exists (bob is gone).
		db.prepare('DELETE FROM users WHERE id = ?').run(bob.id); // wallets cascade

		const summary = await restoreBackup(data);
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

	it('mints a redeemable recovery code for each newly-restored account (cairn-j1q9)', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = await registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		const data = buildBackup('t');
		db.prepare('DELETE FROM users WHERE id = ?').run(bob.id);

		const summary = await restoreBackup(data);
		// Only bob was newly inserted (admin already existed → skipped, no code).
		expect(summary.reclaimCodes).toHaveLength(1);
		expect(summary.reclaimCodes[0].email).toBe('bob@example.com');

		const restoredBob = getUserByEmail('bob@example.com')!;
		expect(hasNoCredentials(restoredBob.id)).toBe(true);
		expect(hasPassword(restoredBob.id)).toBe(false);
		// The minted code actually redeems for the right (remapped) account.
		expect(await consumeRecoveryCode(restoredBob.id, summary.reclaimCodes[0].code)).toBe(true);
		// Sanity: it does NOT redeem for an unrelated account.
		expect(await consumeRecoveryCode(admin.id, summary.reclaimCodes[0].code)).toBe(false);
	});

	it('does not mint a code for a disabled restored account', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('t');
		data.users.push({
			id: 8888,
			email: 'disabled@example.com',
			display_name: 'Disabled',
			is_admin: 0,
			disabled: 1,
			created_at: 't',
			last_login: null
		});

		const summary = await restoreBackup(data);
		expect(summary.usersAdded).toBe(1);
		expect(summary.reclaimCodes).toHaveLength(0);
	});

	it('does not clobber an existing account with the same email', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		addCredential(admin.id, {
			credentialId: 'c1',
			publicKey: new Uint8Array([1]),
			counter: 0,
			name: 'Phone'
		});
		const data = buildBackup('t');

		const summary = await restoreBackup(data);
		expect(summary.usersSkipped).toBe(1);
		expect(summary.usersAdded).toBe(0);
		// The admin's passkey is untouched.
		expect(hasNoCredentials(admin.id)).toBe(false);
	});

	it('forces imported accounts to non-admin, never trusting the backup is_admin flag (cairn-cpb5)', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
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

		const summary = await restoreBackup(data);
		expect(summary.usersAdded).toBe(1);
		expect(summary.adminDowngraded).toBe(1);

		const imported = getUserByEmail('attacker@example.com');
		expect(imported).not.toBeNull();
		expect(imported!.isAdmin).toBe(false); // demoted despite is_admin: 1 in the file
	});

	it('logs one warning per skipped row with table context, and counts only successful inserts (cairn-yjs5 / cairn-sd3n)', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('t');

		// A new user whose child rows include deliberate constraint violations —
		// the "malformed/duplicate row" shapes restoreBackup skips row-by-row.
		data.users.push({
			id: 500,
			email: 'carol@example.com',
			display_name: 'Carol',
			is_admin: 0,
			disabled: 0,
			created_at: 't',
			last_login: null
		});
		const wallet = (id: number, xpub: string) => ({
			id,
			user_id: 500,
			name: `W${id}`,
			type: 'xpub',
			xpub,
			script_type: 'p2wpkh',
			receive_cursor: 0,
			created_at: 't',
			master_fingerprint: null,
			derivation_path: null,
			device_type: null
		});
		// Second wallet duplicates (user_id, xpub) → UNIQUE violation, skipped.
		data.wallets.push(wallet(1, 'xpubDUP'), wallet(2, 'xpubDUP'), wallet(3, 'xpubOK'));

		data.multisigs.push({
			id: 10,
			user_id: 500,
			name: 'Vault',
			threshold: 2,
			script_type: 'p2wsh',
			receive_cursor: 0,
			created_at: 't'
		});
		const key = (name: string, xpub: string) => ({
			multisig_id: 10,
			position: 0, // both keys claim position 0 → second violates UNIQUE(multisig_id, position)
			name,
			category: 'hardware',
			device_type: null,
			xpub,
			fingerprint: '00000000',
			path: "m/48'/0'/0'/2'",
			last_verified_at: null
		});
		data.multisig_keys.push(key('K1', 'xpubK1'), key('K2', 'xpubK2'));

		const addr = (label: string) => ({
			id: null,
			user_id: 500,
			label,
			address: 'bc1qsameaddress',
			created_at: 't',
			last_used_at: null
		});
		// Duplicate (user_id, address) → UNIQUE violation, skipped.
		data.saved_addresses.push(addr('Exchange'), addr('Exchange again'));

		logMock.warn.mockClear();
		const summary = await restoreBackup(data);

		// The summary counts only rows that actually landed.
		expect(summary.usersAdded).toBe(1);
		expect(summary.wallets).toBe(2); // xpubDUP once + xpubOK
		expect(summary.multisigs).toBe(1);
		expect(summary.addresses).toBe(1);

		// One warning per skipped row — three skips across three tables.
		expect(logMock.warn).toHaveBeenCalledTimes(3);
		const calls = logMock.warn.mock.calls as [Record<string, unknown>, string][];
		for (const [, msg] of calls) expect(msg).toMatch(/skipped/i);

		const walletWarn = calls.find(([ctx]) => ctx.table === 'wallets');
		expect(walletWarn).toBeDefined();
		expect(walletWarn![0]).toMatchObject({ table: 'wallets', srcId: 2 });
		expect(walletWarn![0].err).toBeTruthy();

		const keyWarn = calls.find(([ctx]) => ctx.table === 'multisig_keys');
		expect(keyWarn).toBeDefined();
		expect(keyWarn![0]).toMatchObject({ table: 'multisig_keys', srcMultisigId: 10 });

		const addrWarn = calls.find(([ctx]) => ctx.table === 'saved_addresses');
		expect(addrWarn).toBeDefined();
		expect(addrWarn![0]).toMatchObject({ table: 'saved_addresses', srcUserId: 500 });

		// Only the surviving rows are in the DB.
		const carol = getUserByEmail('carol@example.com');
		expect(carol).not.toBeNull();
		const xpubs = (
			db.prepare('SELECT xpub FROM wallets WHERE user_id = ?').all(carol!.id) as {
				xpub: string;
			}[]
		)
			.map((w) => w.xpub)
			.sort();
		expect(xpubs).toEqual(['xpubDUP', 'xpubOK']);

		const vault = db.prepare("SELECT id FROM multisigs WHERE name = 'Vault'").get() as {
			id: number;
		};
		const keys = db
			.prepare('SELECT name FROM multisig_keys WHERE multisig_id = ?')
			.all(vault.id) as { name: string }[];
		expect(keys.map((k) => k.name)).toEqual(['K1']);

		const addrs = db
			.prepare('SELECT label FROM saved_addresses WHERE user_id = ?')
			.all(carol!.id) as { label: string }[];
		expect(addrs.map((a) => a.label)).toEqual(['Exchange']);
	});

	it('restores settings', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		db.prepare("INSERT INTO settings (key, value) VALUES ('electrum_host', 'my.node')").run();
		const data = buildBackup('t');

		db.prepare("DELETE FROM settings WHERE key = 'electrum_host'").run();
		await restoreBackup(data);
		const row = db.prepare("SELECT value FROM settings WHERE key = 'electrum_host'").get() as {
			value: string;
		};
		expect(row.value).toBe('my.node');
	});

	it('still restores ordinary connectivity settings the allowlist covers', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		db.prepare("INSERT INTO settings (key, value) VALUES ('esplora_url', 'https://esplora.example')").run();
		db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_host', 'smtp.example.org')").run();
		const data = buildBackup('t');

		db.prepare("DELETE FROM settings WHERE key IN ('esplora_url', 'smtp_host')").run();
		const summary = await restoreBackup(data);

		const value = (key: string) =>
			(
				db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
					| { value: string }
					| undefined
			)?.value;
		expect(value('esplora_url')).toBe('https://esplora.example');
		expect(value('smtp_host')).toBe('smtp.example.org');
		expect(summary.settingsSkipped).not.toContain('esplora_url');
		expect(summary.settingsSkipped).not.toContain('smtp_host');
	});

	it('withholds security-posture settings from a hostile backup instead of silently adopting them (cairn-0dg4)', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		// The instance is deliberately locked down: invite-only registration, SSRF
		// guard on, solo instance mode, password auth, cert validation required.
		db.prepare("UPDATE settings SET value = 'invite' WHERE key = 'registration_mode'").run();
		db.prepare(
			"INSERT INTO settings (key, value) VALUES ('webhook_allow_private_targets', 'false')"
		).run();
		db.prepare("INSERT INTO settings (key, value) VALUES ('instance_mode', 'solo')").run();
		db.prepare("INSERT INTO settings (key, value) VALUES ('auth_mode', 'password')").run();
		db.prepare(
			"INSERT INTO settings (key, value) VALUES ('electrum_tls_insecure', 'false')"
		).run();

		const data = buildBackup('t');
		// Craft a hostile backup: flip every posture key to its unlocked/insecure
		// value — the exact shape an attacker would social-engineer an admin into
		// restoring (open registration + SSRF guard off + team mode + passkey-only
		// + no cert validation).
		data.settings = data.settings.map((s) => {
			if (s.key === 'registration_mode') return { key: s.key, value: 'open' };
			if (s.key === 'webhook_allow_private_targets') return { key: s.key, value: 'true' };
			if (s.key === 'instance_mode') return { key: s.key, value: 'team' };
			if (s.key === 'auth_mode') return { key: s.key, value: 'passkey' };
			if (s.key === 'electrum_tls_insecure') return { key: s.key, value: 'true' };
			return s;
		});

		const summary = await restoreBackup(data);

		const value = (key: string) =>
			(
				db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
					| { value: string }
					| undefined
			)?.value;
		// Posture is UNCHANGED — none of the hostile values were adopted.
		expect(value('registration_mode')).toBe('invite');
		expect(value('webhook_allow_private_targets')).toBe('false');
		expect(value('instance_mode')).toBe('solo');
		expect(value('auth_mode')).toBe('password');
		expect(value('electrum_tls_insecure')).toBe('false');

		// The restore result names exactly what was withheld.
		expect(summary.settingsSkipped).toEqual(
			expect.arrayContaining([
				'registration_mode',
				'webhook_allow_private_targets',
				'instance_mode',
				'auth_mode',
				'electrum_tls_insecure'
			])
		);
	});

	it('skips an unrecognized settings key by default — allowlist, not a denylist', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('t');
		data.settings.push({ key: 'some_future_setting_nobody_has_reviewed_yet', value: 'x' });

		const summary = await restoreBackup(data);
		expect(
			db
				.prepare('SELECT 1 FROM settings WHERE key = ?')
				.get('some_future_setting_nobody_has_reviewed_yet')
		).toBeUndefined();
		expect(summary.settingsSkipped).toContain('some_future_setting_nobody_has_reviewed_yet');
	});
});
