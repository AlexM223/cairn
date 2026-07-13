// cairn-684u / cairn-rksw / cairn-8r0l / cairn-z93o — destructive-ops audit
// follow-up coverage (see the audit-destructive-2026-07-12 evidence bead).
//
// accountDeletion.test.ts already covers deleteOwnAccount's basic self-delete
// + the no-FK ledger rows (invites/notified_txids) + the "participated in a
// shared multisig as viewer/cosigner, only my share goes" case. admin.test.ts
// already covers deleteUser/resetInstance's basic guards and the
// feature_flags NO-ACTION fix (cairn-hl87). deleteCascade.test.ts already owns
// the polymorphic (wallet_kind, wallet_id) sweep (balance_snapshots,
// wallet_backups, address_labels, backup_missing_notified, notified_txids,
// wallet_snapshots) via its own discovery test — none of that is repeated
// here.
//
// This file adds:
//   1. Cascade completeness across EVERY remaining user-FK table (discovered,
//      not hardcoded, so a table added later without cascade wiring fails
//      loudly) — plus an empirical probe of whether admin.ts's deleteUser has
//      the same invites/feature_flags NO-ACTION gap deleteOwnAccount was
//      fixed for (cairn-hl87 only touched resetInstance).
//   2. Last-admin guard edge cases: a disabled second admin doesn't count
//      towards the quorum, and a disabled SOLE admin can slip past the guard
//      entirely (it only checks disabled=0 accounts).
//   3. Factory reset coverage of instance_secrets/feature_flags wipe (cairn-rksw)
//      that admin.test.ts's resetInstance suite doesn't touch.
//   4. Shared-multisig destruction: what happens to a collaborator's data
//      (and their notifications) when the OWNER leaves vs. when a mere
//      COSIGNER leaves.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, AuthError } from './auth';
import { setSetting, setSecretSetting, readSecretSetting } from './settings';
import { deleteOwnAccount } from './accountDeletion';
import { deleteUser, resetInstance } from './admin';
import { buildAccountExport } from './accountData';

function wipe(): void {
	db.exec(`
		DELETE FROM notified_txids; DELETE FROM address_labels; DELETE FROM wallet_backups;
		DELETE FROM backup_missing_notified; DELETE FROM balance_snapshots; DELETE FROM wallet_snapshots;
		DELETE FROM multisig_transaction_signers; DELETE FROM multisig_transactions;
		DELETE FROM multisig_shares; DELETE FROM ledger_multisig_registrations; DELETE FROM multisig_keys;
		DELETE FROM multisigs; DELETE FROM transactions; DELETE FROM tx_labels; DELETE FROM wallets;
		DELETE FROM saved_addresses; DELETE FROM sessions; DELETE FROM invites;
		DELETE FROM portfolio_snapshot; DELETE FROM admin_disclosure_acceptances;
		DELETE FROM user_agreement_acceptances; DELETE FROM events;
		DELETE FROM user_credentials; DELETE FROM account_recovery_phrases;
		DELETE FROM account_recovery_codes; DELETE FROM recovery_grants;
		DELETE FROM notification_preferences; DELETE FROM notification_channel_config;
		DELETE FROM user_pgp_keys; DELETE FROM notification_queue; DELETE FROM user_notification_settings;
		DELETE FROM known_devices; DELETE FROM backup_reminders; DELETE FROM contacts;
		DELETE FROM announcement_dismissals; DELETE FROM announcements; DELETE FROM device_keys;
		DELETE FROM user_feature_flags; DELETE FROM feature_flags;
		DELETE FROM wallet_scan_cache; DELETE FROM chain_snapshot; DELETE FROM mempool_samples;
		DELETE FROM tx_snapshots; DELETE FROM instance_secrets; DELETE FROM multisig_service_referrals;
		DELETE FROM users; DELETE FROM settings;
	`);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

const PASSWORD = 'correct horse battery';

async function makeUser(
	email: string,
	opts: { admin?: boolean; disabled?: boolean } = {}
): Promise<number> {
	const id = (
		await registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] })
	).id;
	if (opts.admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
	if (opts.disabled) db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
	return id;
}

function count(table: string, where: string, ...params: (string | number)[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as {
			n: number;
		}
	).n;
}

function tableCount(table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

interface UserFk {
	table: string;
	from: string;
	on_delete: string;
}

/** Every (table, column) pair whose column carries a real FK to users(id),
 *  discovered from sqlite_master + PRAGMA foreign_key_list rather than
 *  hardcoded — a table added later with a users FK is picked up automatically,
 *  same discovery idiom as deleteCascade.test.ts's polymorphic sweep. */
function tablesWithDirectUserFk(): UserFk[] {
	const tables = (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
	).map((t) => t.name);
	const fks: UserFk[] = [];
	for (const t of tables) {
		const rows = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as {
			table: string;
			from: string;
			on_delete: string;
		}[];
		for (const r of rows) {
			if (r.table === 'users') fks.push({ table: t, from: r.from, on_delete: r.on_delete });
		}
	}
	return fks;
}

const KNOWN_USER_FK_TABLES = [
	'sessions',
	'wallets',
	'multisigs',
	'saved_addresses',
	'balance_snapshots',
	'admin_disclosure_acceptances',
	'user_agreement_acceptances',
	'wallet_backups',
	'events',
	'user_credentials',
	'account_recovery_phrases',
	'account_recovery_codes',
	'recovery_grants',
	'notification_preferences',
	'notification_channel_config',
	'user_pgp_keys',
	'notification_queue',
	'user_notification_settings',
	'known_devices',
	'backup_reminders',
	'contacts',
	'multisig_shares',
	'multisig_transaction_signers',
	'announcement_dismissals',
	'device_keys',
	'user_feature_flags',
	'multisig_keys',
	'feature_flags',
	'invites',
	'portfolio_snapshot'
];

// ═══════════════════════════════════════════════════════ GROUP 1 — cascade completeness

describe('cascade completeness beyond accountDeletion.test.ts / deleteCascade.test.ts (cairn-684u)', () => {
	it('deleteOwnAccount clears every discovered user-FK table, the wallet/multisig-id children, and the account export', async () => {
		await makeUser('admin@example.com', { admin: true }); // keep-alive admin
		const uid = await makeUser('leaver@example.com');
		const other = await makeUser('other@example.com');

		// Owned parents.
		const w = Number(
			db
				.prepare(
					"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-w', 'p2wpkh')"
				)
				.run(uid).lastInsertRowid
		);
		const m = Number(
			db
				.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'MS', 2)")
				.run(uid).lastInsertRowid
		);
		const mtx = Number(
			db
				.prepare(
					`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
					 VALUES (?, 'awaiting_signature', 'cHNidA==', 'bc1qrecipient', 1000, 100, 1.0)`
				)
				.run(m).lastInsertRowid
		);

		db.prepare(
			"INSERT INTO transactions (wallet_id, psbt, recipient, amount, fee, fee_rate) VALUES (?, 'cHNidA==', 'bc1qrecipient', 1000, 100, 1.0)"
		).run(w);
		db.prepare("INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, 'label')").run(
			w,
			'a'.repeat(64)
		);
		db.prepare("INSERT INTO saved_addresses (user_id, label, address) VALUES (?, 'Label', 'bcrt1qaddr')").run(
			uid
		);
		db.prepare(
			"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, 0, 'Key', 'hardware', 'xpub-k', '00000000', ?)"
		).run(m, "m/48'/0'/0'/2'");
		db.prepare(
			"INSERT INTO ledger_multisig_registrations (multisig_id, master_fp, policy_name, policy_hmac) VALUES (?, '00000000', 'policy', ?)"
		).run(m, '0'.repeat(64));
		db.prepare(
			"INSERT INTO multisig_transaction_signers (transaction_id, user_id, assigned_key_ids) VALUES (?, ?, '[]')"
		).run(mtx, uid);
		db.prepare(
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'cosigner')"
		).run(m, uid, other);
		db.prepare(
			"INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, 'wallet', ?, '2026-01-01T00:00:00Z', 1000)"
		).run(uid, w);
		db.prepare("INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, '{}', 0)").run(
			uid
		);
		db.prepare('INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?)').run(uid);
		db.prepare('INSERT INTO user_agreement_acceptances (user_id, version) VALUES (?, 1)').run(uid);
		db.prepare("INSERT INTO wallet_backups (user_id, wallet_kind, wallet_id) VALUES (?, 'wallet', ?)").run(
			uid,
			w
		);
		db.prepare("INSERT INTO events (user_id, type, level, message) VALUES (?, 'test', 'info', 'msg')").run(
			uid
		);
		db.prepare(
			"INSERT INTO user_credentials (user_id, credential_id, public_key) VALUES (?, 'cred1', 'pubkey1')"
		).run(uid);
		db.prepare("INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, 'hash')").run(uid);
		db.prepare("INSERT INTO account_recovery_codes (user_id, code_hash) VALUES (?, 'hash')").run(uid);
		db.prepare(
			"INSERT INTO recovery_grants (token_hash, user_id, expires_at) VALUES ('tok1', ?, '2099-01-01T00:00:00Z')"
		).run(uid);
		db.prepare(
			"INSERT INTO notification_preferences (user_id, event_type, channel) VALUES (?, 'tx_received', 'email')"
		).run(uid);
		db.prepare(
			"INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', '{}')"
		).run(uid);
		db.prepare("INSERT INTO user_pgp_keys (user_id, public_key, fingerprint) VALUES (?, 'key', 'fp')").run(
			uid
		);
		db.prepare(
			"INSERT INTO notification_queue (user_id, channel, event_type, payload) VALUES (?, 'email', 'tx_received', '{}')"
		).run(uid);
		db.prepare('INSERT INTO user_notification_settings (user_id) VALUES (?)').run(uid);
		db.prepare("INSERT INTO known_devices (user_id, fingerprint) VALUES (?, 'fp1')").run(uid);
		db.prepare('INSERT INTO backup_reminders (user_id) VALUES (?)').run(uid);
		db.prepare("INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')").run(
			uid,
			other
		);
		const annId = Number(
			db.prepare("INSERT INTO announcements (title, body) VALUES ('Notice', 'Body')").run()
				.lastInsertRowid
		);
		db.prepare('INSERT INTO announcement_dismissals (user_id, announcement_id) VALUES (?, ?)').run(
			uid,
			annId
		);
		db.prepare(
			"INSERT INTO device_keys (user_id, fingerprint, purpose, xpub, path) VALUES (?, 'fp1', '84', 'xpub-dk', ?)"
		).run(uid, "m/84'/0'/0'");
		db.prepare(
			"INSERT INTO user_feature_flags (user_id, key, enabled, updated_by) VALUES (?, 'flag1', 1, ?)"
		).run(uid, uid);
		db.prepare("INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('flag1', 1, ?)").run(uid);
		db.prepare("INSERT INTO invites (code, created_by) VALUES ('CODE1', ?)").run(uid);
		db.prepare(
			"INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid) VALUES ('wallet', ?, ?, ?)"
		).run(w, uid, 'b'.repeat(64));

		// Anti-vacuous guard: the discovery query itself must find (at least) the
		// known set of tables with a real FK to users — a silently-empty/broken
		// discovery could make every assertion below pass vacuously.
		const userFks = tablesWithDirectUserFk();
		const discoveredTables = new Set(userFks.map((f) => f.table));
		expect([...discoveredTables]).toEqual(expect.arrayContaining(KNOWN_USER_FK_TABLES));
		expect(userFks.length).toBeGreaterThanOrEqual(30);

		deleteOwnAccount(uid);

		// Every discovered FK column pointing at uid is gone — CASCADE deletes the
		// row, SET NULL clears the column, and the two hand-cleaned NO-ACTION
		// columns (feature_flags/user_feature_flags.updated_by, invites.created_by)
		// are cleared by accountDeletion.ts's own pre-delete statements. One
		// uniform assertion covers all three mechanisms: none of them can leave
		// uid sitting in that column afterward.
		for (const fk of userFks) {
			expect(count(fk.table, `${fk.from} = ?`, uid), `${fk.table}.${fk.from}`).toBe(0);
		}

		// Rows that hang off the owned wallet/multisig via wallet_id/multisig_id
		// (no direct user FK) must also be gone, via the wallets/multisigs cascade.
		expect(count('transactions', 'wallet_id = ?', w)).toBe(0);
		expect(count('tx_labels', 'wallet_id = ?', w)).toBe(0);
		expect(count('multisig_keys', 'multisig_id = ?', m)).toBe(0);
		expect(count('ledger_multisig_registrations', 'multisig_id = ?', m)).toBe(0);
		expect(count('multisig_transactions', 'multisig_id = ?', m)).toBe(0);
		expect(count('multisig_transaction_signers', 'transaction_id = ?', mtx)).toBe(0);

		// feature_flags is instance-wide config, not a per-user row — only its
		// updated_by pointer is cleared, the row itself survives.
		expect(tableCount('feature_flags')).toBeGreaterThanOrEqual(1);
		// invites and notified_txids, by contrast, are per-user rows with no
		// ON DELETE action — accountDeletion.ts hand-deletes them outright.
		expect(count('invites', 'created_by = ?', uid)).toBe(0);
		expect(count('notified_txids', 'user_id = ?', uid)).toBe(0);

		// The self-service export reflects the now-empty account.
		const exp = buildAccountExport(uid) as Record<string, unknown[]>;
		expect(exp.wallets).toEqual([]);
		expect(exp.multisigs).toEqual([]);
		expect(exp.savedAddresses).toEqual([]);
		expect(exp.sessions).toEqual([]);

		// The other user (contact + multisig_shares partner) is untouched.
		expect(count('users', 'id = ?', other)).toBe(1);
	});

	// Empirical probe (candidate P1): deleteOwnAccount was patched to hand-clean
	// invites.created_by and feature_flags/user_feature_flags.updated_by before
	// its `DELETE FROM users` (see accountDeletion.ts's file-header comment).
	// admin.ts's deleteUser does a bare `DELETE FROM users WHERE id = ?` with NO
	// such pre-cleanup. Both columns are plain `REFERENCES users(id)` with no
	// ON DELETE clause (NO ACTION, the SQLite default) — this probe observes
	// what actually happens when an admin deletes a user who has created an
	// invite or touched a feature flag.
	it('PROBE: deleteUser(victim) when the victim created an invite and touched a feature flag', async () => {
		await makeUser('admin@example.com', { admin: true });
		const victim = await makeUser('victim@example.com');
		db.prepare("INSERT INTO invites (code, created_by) VALUES ('CODE9', ?)").run(victim);
		db.prepare("INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('flag9', 1, ?)").run(victim);
		db.prepare(
			"INSERT INTO user_feature_flags (user_id, key, enabled, updated_by) VALUES (?, 'flag9', 1, ?)"
		).run(victim, victim);

		// KNOWN GAP (candidate P1, cairn-684u extension): deleteUser has no
		// pre-cleanup for these NO-ACTION columns, so the bare DELETE FROM users
		// violates the FK and throws — the victim row (and everything that WOULD
		// have cascaded) survives untouched. Pinned current behavior, not
		// endorsed; see the final report for the exact error text observed.
		let caught: unknown;
		try {
			deleteUser(victim);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeDefined();
		expect(caught).not.toBeInstanceOf(AuthError); // not the last_admin/not_found guard — a raw FK failure
		expect((caught as Error).message).toMatch(/FOREIGN KEY constraint failed/i);

		// The victim row must still be there — the failed DELETE did not partially apply.
		expect(count('users', 'id = ?', victim)).toBe(1);
		expect(count('invites', 'created_by = ?', victim)).toBe(1);
		expect(count('feature_flags', 'updated_by = ?', victim)).toBe(1);

		// And the shared connection must not be left inside an open transaction —
		// node:sqlite's exec-based DELETE isn't wrapped in an explicit
		// BEGIN/COMMIT in deleteUser, so a subsequent BEGIN should still succeed
		// regardless; this guards against the cairn-hl87 failure mode recurring
		// here.
		expect(() => {
			db.prepare('BEGIN').run();
			db.prepare('COMMIT').run();
		}).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════ GROUP 2 — last-admin guard

describe('last-admin guard — edge cases beyond accountDeletion.test.ts / admin.test.ts', () => {
	it('deleteUser refuses when the target is the sole active admin, row survives', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		expect(() => deleteUser(admin)).toThrowError(expect.objectContaining({ code: 'last_admin' }));
		expect(count('users', 'id = ?', admin)).toBe(1);
	});

	it('deleteUser succeeds once a second active admin exists', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		const second = await makeUser('second@example.com', { admin: true });
		deleteUser(admin);
		expect(count('users', 'id = ?', admin)).toBe(0);
		expect(count('users', 'id = ?', second)).toBe(1);
	});

	it('a DISABLED second admin does not count toward the quorum — deleteUser AND deleteOwnAccount both still refuse', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		await makeUser('second@example.com', { admin: true, disabled: true });

		expect(() => deleteUser(admin)).toThrowError(expect.objectContaining({ code: 'last_admin' }));
		expect(() => deleteOwnAccount(admin)).toThrowError(expect.objectContaining({ code: 'last_admin' }));
		expect(count('users', 'id = ?', admin)).toBe(1);
	});

	it('KNOWN GAP (candidate bead: disabled-sole-admin self-delete leaves zero admins): a DISABLED sole admin can self-delete because the guard only fires for is_admin=1 AND disabled=0', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(admin);
		// Sanity: this admin was already the only is_admin=1 row, just disabled.
		expect(count('users', 'is_admin = 1')).toBe(1);

		expect(() => deleteOwnAccount(admin)).not.toThrow(); // pinned current behavior, not endorsed
		expect(count('users', 'id = ?', admin)).toBe(0);
		// The instance now has NO admin row at all — not just zero ACTIVE admins,
		// which was already true before this call (the guard's own adminCount()
		// query already excludes disabled rows), but zero admin rows, period.
		expect(count('users', 'is_admin = 1')).toBe(0); // pinned current behavior, not endorsed
	});
});

// ═══════════════════════════════════════════════════════ GROUP 3 — factory reset

describe('factory reset — additional coverage beyond admin.test.ts (cairn-rksw)', () => {
	it('wipes every discovered user-FK table too, plus instance_secrets and feature_flags (cairn-rksw fixed)', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });
		const w = Number(
			db
				.prepare(
					"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-w2', 'p2wpkh')"
				)
				.run(admin).lastInsertRowid
		);
		db.prepare("INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('flag-reset', 1, ?)").run(
			admin
		);
		db.prepare(
			"INSERT INTO user_feature_flags (user_id, key, enabled, updated_by) VALUES (?, 'flag-reset', 1, ?)"
		).run(admin, admin);
		setSecretSetting('smtp_pass', 's3cr3t');
		setSecretSetting('core_rpc_pass', 'rpcsecret');
		setSecretSetting('telegram_bot_token', 'tgtoken');
		db.prepare("INSERT INTO wallet_scan_cache (cache_key, kind, result) VALUES ('xpub-w2', 'wallet', '{}')").run();
		db.prepare(
			"INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, last_synced_at) VALUES ('wallet', ?, '{}', 0)"
		).run(w);
		db.prepare("INSERT INTO chain_snapshot (id, data, last_synced_at) VALUES (1, '{}', 0)").run();
		db.prepare('INSERT INTO mempool_samples (at, vsize, tx_count) VALUES (1000, 100, 5)').run();
		db.prepare("INSERT INTO tx_snapshots (txid, data, cached_at) VALUES (?, '{}', 0)").run('c'.repeat(64));
		db.prepare("INSERT INTO multisig_service_referrals (name, url) VALUES ('Casa', 'https://casa.io')").run();
		db.prepare("INSERT INTO announcements (title, body) VALUES ('N', 'B')").run();

		resetInstance();

		for (const table of [
			'users',
			'sessions',
			'wallets',
			'invites',
			'settings',
			'events',
			'notified_txids',
			'announcements',
			'multisig_service_referrals'
		]) {
			expect(tableCount(table), table).toBe(0);
		}
		// Every discovered user-FK table is empty too (cascade from `users`, or
		// hand-cleared like feature_flags/user_feature_flags.updated_by).
		for (const fk of tablesWithDirectUserFk()) {
			expect(count(fk.table, `${fk.from} = ?`, admin), `${fk.table}.${fk.from}`).toBe(0);
		}

		// FIXED (cairn-rksw): resetInstance now clears instance_secrets outright —
		// the stored SMTP/Core-RPC/Telegram/Nostr secrets no longer survive a
		// factory reset, closing the credential-reuse trap on device handover.
		expect(readSecretSetting('smtp_pass')).toBeNull();
		expect(readSecretSetting('core_rpc_pass')).toBeNull();
		expect(readSecretSetting('telegram_bot_token')).toBeNull();
		expect(tableCount('instance_secrets')).toBe(0);
		// feature_flags rows are now deleted outright (not just updated_by
		// nulled) — a reset instance no longer inherits the prior operator's
		// flag/override configuration.
		expect(tableCount('feature_flags')).toBe(0);

		// Logged, not pinned as correct or incorrect either way — the plan only
		// asks for visibility into whether these pure caches survive a reset.
		console.log('[cairn-rksw] post-reset cache table counts', {
			wallet_scan_cache: tableCount('wallet_scan_cache'),
			wallet_snapshots: tableCount('wallet_snapshots'),
			chain_snapshot: tableCount('chain_snapshot'),
			mempool_samples: tableCount('mempool_samples'),
			tx_snapshots: tableCount('tx_snapshots')
		});
	});

	// Table-driven so a FUTURE secret key/store added to the codebase without
	// wiring into resetInstance's cleanup fails this test loudly, instead of
	// silently repeating cairn-rksw. Two kinds of store are covered:
	//   1. instance-wide secrets in `instance_secrets` (settings.ts
	//      setSecretSetting/readSecretSetting) — no user_id, so resetInstance
	//      MUST delete them explicitly.
	//   2. the per-user personal-SMTP password embedded (secretKey.ts
	//      encryptSecret envelope) inside notification_channel_config.config —
	//      this one has a user_id FK with ON DELETE CASCADE, so it is expected
	//      to disappear as a side effect of `DELETE FROM users`, not an
	//      explicit resetInstance step. Both are asserted here so a regression
	//      in either mechanism is caught in one place.
	const INSTANCE_SECRET_KEYS = [
		'smtp_pass',
		'core_rpc_pass',
		'telegram_bot_token',
		'nostr_sender_privkey',
		'scheduled_backup_pass'
	];

	it('table-driven: every known secret store is empty after a factory reset (cairn-rksw)', async () => {
		const admin = await makeUser('admin@example.com', { admin: true });

		// 1. Instance-wide secrets (instance_secrets table).
		for (const key of INSTANCE_SECRET_KEYS) {
			setSecretSetting(key, `secret-value-for-${key}`);
		}
		for (const key of INSTANCE_SECRET_KEYS) {
			expect(readSecretSetting(key), `${key} before reset`).toBe(`secret-value-for-${key}`);
		}
		expect(tableCount('instance_secrets')).toBe(INSTANCE_SECRET_KEYS.length);

		// 2. Per-user personal SMTP password, encrypted via secretKey.ts and
		// embedded in notification_channel_config.config (email.ts's PersonalSmtp
		// shape) — a different storage mechanism from instance_secrets entirely.
		const { encryptSecret, decryptSecret } = await import('./secretKey');
		const personalSmtpEnvelope = encryptSecret('personal-smtp-secret');
		const config = JSON.stringify({
			address: 'admin@example.com',
			smtp: {
				host: 'smtp.personal.example',
				port: 587,
				user: 'admin',
				from: 'admin@example.com',
				tls: 'starttls',
				passEnc: personalSmtpEnvelope
			}
		});
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', ?)`
		).run(admin, config);
		// Sanity: the envelope really does decrypt before the reset.
		expect(decryptSecret(personalSmtpEnvelope)).toBe('personal-smtp-secret');
		expect(tableCount('notification_channel_config')).toBe(1);

		resetInstance();

		// Every instance_secrets key is gone — both via readSecretSetting (the
		// production read path) and via a direct row count.
		for (const key of INSTANCE_SECRET_KEYS) {
			expect(readSecretSetting(key), `${key} after reset`).toBeNull();
		}
		expect(tableCount('instance_secrets')).toBe(0);

		// The per-user encrypted SMTP secret is gone too (cascaded away with the
		// user row, not a resetInstance-specific step).
		expect(tableCount('notification_channel_config')).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════ GROUP 6 — shared-multisig destruction

describe('shared-multisig destruction (cairn-8r0l / cairn-z93o)', () => {
	it('KNOWN GAP (cairn-8r0l): the OWNER leaving destroys an in-flight collaborative multisig with no notice to the other participants', async () => {
		await makeUser('admin@example.com', { admin: true });
		const alice = await makeUser('alice@example.com');
		const bob = await makeUser('bob@example.com');
		const carol = await makeUser('carol@example.com');

		const m = Number(
			db
				.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'Shared', 2)")
				.run(alice).lastInsertRowid
		);
		const shareIns = db.prepare(
			'INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)'
		);
		shareIns.run(m, alice, bob, 'cosigner');
		shareIns.run(m, alice, carol, 'viewer');
		const mtx = Number(
			db
				.prepare(
					`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
					 VALUES (?, 'awaiting_signature', 'cHNidA==', 'bc1qrecipient', 5000, 200, 2.0)`
				)
				.run(m).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO multisig_transaction_signers (transaction_id, user_id, assigned_key_ids) VALUES (?, ?, '[]')"
		).run(mtx, bob);

		deleteOwnAccount(alice);

		// Pinned current behavior, not endorsed — see the final report (cairn-8r0l).
		expect(count('multisigs', 'id = ?', m)).toBe(0);
		expect(count('multisig_shares', 'multisig_id = ?', m)).toBe(0);
		expect(count('multisig_transactions', 'id = ?', mtx)).toBe(0);
		expect(count('multisig_transaction_signers', 'transaction_id = ?', mtx)).toBe(0);
		// Carol (viewer) and bob (cosigner) get no in-app or queued notification
		// that their shared multisig — including an in-flight, awaiting-signature
		// spend — just vanished.
		expect(count('events', 'user_id IN (?, ?)', bob, carol)).toBe(0); // pinned current behavior, not endorsed
		expect(count('notification_queue', 'user_id IN (?, ?)', bob, carol)).toBe(0); // pinned current behavior, not endorsed
	});

	it('GREEN: a COSIGNER leaving leaves the multisig, all its keys, and the in-flight tx intact for the owner', async () => {
		await makeUser('admin@example.com', { admin: true });
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');

		const m = Number(
			db
				.prepare(
					"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'Shared', 2, 'p2wsh')"
				)
				.run(owner).lastInsertRowid
		);
		const keyIns = db.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path, assigned_user_id)
			 VALUES (?, ?, ?, 'hardware', ?, '00000000', ?, ?)`
		);
		const k0 = Number(
			keyIns.run(m, 0, 'Key0', 'xpub-k0', "m/48'/0'/0'/2'", null).lastInsertRowid
		);
		const k1 = Number(
			keyIns.run(m, 1, 'Key1', 'xpub-k1', "m/48'/0'/0'/2'", bob).lastInsertRowid
		);
		const k2 = Number(
			keyIns.run(m, 2, 'Key2', 'xpub-k2', "m/48'/0'/0'/2'", null).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'cosigner')"
		).run(m, owner, bob);
		const mtx = Number(
			db
				.prepare(
					`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
					 VALUES (?, 'awaiting_signature', 'cHNidA-INFLIGHT', 'bc1qrecipient', 5000, 200, 2.0)`
				)
				.run(m).lastInsertRowid
		);
		db.prepare(
			'INSERT INTO multisig_transaction_signers (transaction_id, user_id, assigned_key_ids) VALUES (?, ?, ?)'
		).run(mtx, bob, JSON.stringify([k1]));

		deleteOwnAccount(bob);

		// GREEN — nothing about the owner's multisig is disturbed by a cosigner leaving.
		expect(count('multisigs', 'id = ?', m)).toBe(1);
		expect(count('multisig_keys', 'multisig_id = ?', m)).toBe(3);
		const tx = db.prepare('SELECT status, psbt FROM multisig_transactions WHERE id = ?').get(mtx) as {
			status: string;
			psbt: string;
		};
		expect(tx.status).toBe('awaiting_signature');
		expect(tx.psbt).toBe('cHNidA-INFLIGHT');

		// Bob's own rows are gone.
		expect(count('multisig_shares', 'shared_with_id = ?', bob)).toBe(0);
		expect(count('multisig_transaction_signers', 'user_id = ?', bob)).toBe(0);

		// SET NULL pin: bob's key row survives — it's the owner's multisig
		// config, not bob's — but its assignment pointer is cleared.
		const key1 = db.prepare('SELECT assigned_user_id FROM multisig_keys WHERE id = ?').get(k1) as {
			assigned_user_id: number | null;
		};
		expect(key1.assigned_user_id).toBeNull();
		expect(count('multisig_keys', 'id IN (?, ?)', k0, k2)).toBe(2);

		// KNOWN GAP (cairn-z93o): the owner gets no in-app or queued notification
		// that their cosigner just left.
		expect(count('events', 'user_id = ?', owner)).toBe(0); // pinned current behavior, not endorsed
		expect(count('notification_queue', 'user_id = ?', owner)).toBe(0); // pinned current behavior, not endorsed
	});
});
