// cairn-s6x3 / cairn-90k8 / cairn-ldhm — backup/restore round-trip coverage
// beyond backup.test.ts's existing suite (which owns: basic encrypt/decrypt,
// credential/secret exclusion, version-too-new rejection, the additive
// restore/skip-existing/admin-downgrade/settings-allowlist behavior, and the
// per-row-skip logging contract). This file adds:
//
//   4. A full byte-for-byte round-trip across ALL EIGHT captured tables at
//      once (not just users, one at a time) plus confirmation that
//      multisig_shares — collaborative-custody sharing — is never captured
//      by buildBackup and so can never survive a restore.
//   5. Older/malformed backup shapes: a version-0 backup with a wallet row
//      missing the `type` column, a wallet row with a renamed `xpub` column,
//      and decryptBackup's asymmetric version check (rejects newer-than-
//      VERSION, silently accepts older-than-VERSION).
//
// Every KNOWN GAP below pins CURRENT behavior for visibility; it does not
// assert the behavior is correct, per the sendBoundaryMatrix.test.ts
// convention (see src/lib/server/bitcoin/sendBoundaryMatrix.test.ts:559-603).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, getUserByEmail } from './auth';
import { setSetting } from './settings';
import { buildBackup, encryptBackup, decryptBackup, restoreBackup, BackupError } from './backup';

function wipeAll(): void {
	db.exec(`
		DELETE FROM multisig_transaction_signers; DELETE FROM multisig_transactions;
		DELETE FROM multisig_shares; DELETE FROM ledger_multisig_registrations;
		DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM tx_labels;
		DELETE FROM saved_addresses; DELETE FROM transactions; DELETE FROM wallets;
		DELETE FROM sessions; DELETE FROM invites; DELETE FROM users;
		DELETE FROM settings; DELETE FROM instance_secrets;
	`);
}

beforeEach(() => {
	wipeAll();
	// open mode so extra users can be created without invites
	db.prepare("INSERT INTO settings (key, value) VALUES ('registration_mode', 'open')").run();
});

function tableCount(table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function makeWallet(userId: number, xpub: string): void {
	db.prepare(
		"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', ?, 'p2wpkh')"
	).run(userId, xpub);
}

const PP = 'a-strong-passphrase';

// ═══════════════════════════════════════════════════ GROUP 4 — full round-trip

describe('full 8-table encrypt/decrypt round-trip (cairn-s6x3)', () => {
	it('round-trips every captured table byte-for-byte, and never carries multisig_shares', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = await registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		makeWallet(bob.id, 'xpubBOB');
		const msId = Number(
			db
				.prepare(
					"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'MS', 2, 'p2wsh')"
				)
				.run(bob.id).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, 0, 'K', 'hardware', 'xpub-k', '00000000', ?)"
		).run(msId, "m/48'/0'/0'/2'");
		db.prepare(
			"INSERT INTO ledger_multisig_registrations (multisig_id, master_fp, policy_name, policy_hmac) VALUES (?, '00000000', 'policy', ?)"
		).run(msId, '0'.repeat(64));
		db.prepare("INSERT INTO saved_addresses (user_id, label, address) VALUES (?, 'Label', 'bc1qaddr')").run(
			bob.id
		);
		const walletId = (
			db.prepare('SELECT id FROM wallets WHERE user_id = ?').get(bob.id) as { id: number }
		).id;
		db.prepare("INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, 'L')").run(
			walletId,
			'a'.repeat(64)
		);
		setSetting('electrum_host', 'my.node');
		// A collaborative-custody share, to confirm it is NOT part of the backup.
		db.prepare(
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'viewer')"
		).run(msId, bob.id, admin.id);

		const data = buildBackup('2026-07-12T00:00:00.000Z');
		// Sanity: every one of the 8 captured tables actually has a row (a bug
		// that silently emptied one of these would otherwise pass a bare
		// round-trip check vacuously).
		expect(data.users.length).toBeGreaterThanOrEqual(2);
		expect(data.wallets.length).toBeGreaterThanOrEqual(1);
		expect(data.multisigs.length).toBeGreaterThanOrEqual(1);
		expect(data.multisig_keys.length).toBeGreaterThanOrEqual(1);
		expect(data.ledger_multisig_registrations.length).toBeGreaterThanOrEqual(1);
		expect(data.saved_addresses.length).toBeGreaterThanOrEqual(1);
		expect(data.tx_labels.length).toBeGreaterThanOrEqual(1);
		expect(data.settings.some((s) => s.key === 'electrum_host')).toBe(true);

		const env = await encryptBackup(data, PP);
		const back = await decryptBackup(env, PP);
		expect(back).toEqual(data);

		await expect(decryptBackup(env, 'definitely-the-wrong-passphrase')).rejects.toThrowError(
			BackupError
		);

		// KNOWN GAP (cairn-s6x3): multisig_shares is never selected by
		// buildBackup — a restored instance loses every collaborative-custody
		// sharing relationship, silently.
		expect(data).not.toHaveProperty('multisig_shares'); // pinned current behavior, not endorsed
	});
});

// ═══════════════════════════════════════════════════ GROUP 4 — restore round-trip

describe('restore round-trip (cairn-s6x3)', () => {
	it('restores users/wallets/multisigs/addresses/labels/allowlisted-settings, downgrades the admin flag, mints reclaim codes, and drops multisig_shares', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = await registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		expect(admin.isAdmin).toBe(true); // first registration after wipe auto-admins
		makeWallet(bob.id, 'xpubBOB');
		const msId = Number(
			db
				.prepare(
					"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'MS', 2, 'p2wsh')"
				)
				.run(bob.id).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, 0, 'K', 'hardware', 'xpub-k', '00000000', ?)"
		).run(msId, "m/48'/0'/0'/2'");
		db.prepare("INSERT INTO saved_addresses (user_id, label, address) VALUES (?, 'Label', 'bc1qaddr')").run(
			bob.id
		);
		const walletId = (
			db.prepare('SELECT id FROM wallets WHERE user_id = ?').get(bob.id) as { id: number }
		).id;
		db.prepare("INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, 'L')").run(
			walletId,
			'a'.repeat(64)
		);
		setSetting('electrum_host', 'my.node');
		// registration_mode is deliberately set to something OTHER than the
		// beforeEach default, so its post-restore absence proves it was withheld
		// rather than just never having been backed up.
		setSetting('registration_mode', 'invite');
		db.prepare(
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'viewer')"
		).run(msId, bob.id, admin.id);

		const data = buildBackup('t');
		expect(data.users).toHaveLength(2);

		wipeAll();

		const summary = await restoreBackup(data);

		expect(summary.usersAdded).toBe(2);
		expect(summary.usersSkipped).toBe(0);
		expect(summary.adminDowngraded).toBe(1); // only the admin account was flagged is_admin
		expect(summary.wallets).toBe(1);
		expect(summary.multisigs).toBe(1);
		expect(summary.addresses).toBe(1);
		expect(summary.labels).toBe(1);
		expect(summary.settingsSkipped).toContain('registration_mode');
		expect(summary.reclaimCodes).toHaveLength(2); // both restored accounts were enabled

		const restoredAdmin = getUserByEmail('admin@example.com')!;
		expect(restoredAdmin.isAdmin).toBe(false); // forced non-admin on restore (cairn-cpb5)
		const restoredBob = getUserByEmail('bob@example.com')!;
		expect(restoredBob.id).not.toBe(bob.id); // id remapped

		const value = (key: string) =>
			(
				db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
					| { value: string }
					| undefined
			)?.value;
		expect(value('electrum_host')).toBe('my.node');
		expect(value('registration_mode')).toBeUndefined(); // withheld by the allowlist

		const wallets = db
			.prepare('SELECT xpub FROM wallets WHERE user_id = ?')
			.all(restoredBob.id) as { xpub: string }[];
		expect(wallets.map((w) => w.xpub)).toEqual(['xpubBOB']);

		const ms = db
			.prepare('SELECT name, threshold FROM multisigs WHERE user_id = ?')
			.get(restoredBob.id) as { name: string; threshold: number };
		expect(ms).toEqual({ name: 'MS', threshold: 2 });

		const addrs = db
			.prepare('SELECT label, address FROM saved_addresses WHERE user_id = ?')
			.all(restoredBob.id) as { label: string; address: string }[];
		expect(addrs).toEqual([{ label: 'Label', address: 'bc1qaddr' }]);

		const restoredWalletId = (
			db.prepare('SELECT id FROM wallets WHERE user_id = ?').get(restoredBob.id) as {
				id: number;
			}
		).id;
		const labels = db
			.prepare('SELECT txid, label FROM tx_labels WHERE wallet_id = ?')
			.all(restoredWalletId) as { txid: string; label: string }[];
		expect(labels).toEqual([{ txid: 'a'.repeat(64), label: 'L' }]);

		// KNOWN GAP (cairn-s6x3): multisig_shares was never captured, so the
		// collaborative-sharing relationship between bob and admin cannot come
		// back — silently, with no indication in the restore summary at all.
		expect(tableCount('multisig_shares')).toBe(0); // pinned current behavior, not endorsed
		expect(summary).not.toHaveProperty('shares'); // RestoreSummary has no shares field

		// KNOWN GAP (cairn-ldhm, secondary): notification prefs/channel config,
		// contacts, address_labels, device_keys, and per-user feature-flag
		// overrides are equally absent from BackupData, so none of them can be
		// restored either — every one of these tables is empty post-restore.
		for (const t of [
			'notification_preferences',
			'notification_channel_config',
			'contacts',
			'address_labels',
			'device_keys',
			'user_feature_flags'
		]) {
			expect(tableCount(t), t).toBe(0); // pinned current behavior, not endorsed
		}
	});
});

// ═══════════════════════════════════════════════════ GROUP 5 — older/malformed backups

describe('older-version / malformed backup shapes — KNOWN GAP (cairn-90k8)', () => {
	it('a wallet row missing the `type` column restores with a silent "xpub" default', async () => {
		const data = buildBackup('t');
		(data as unknown as { version: number }).version = 0; // simulates a pre-VERSION-tracking backup
		data.users.push({
			id: 9001,
			email: 'legacy@example.com',
			display_name: 'Legacy',
			is_admin: 0,
			disabled: 0,
			created_at: 't',
			last_login: null
		});
		data.wallets.push({
			id: 1,
			user_id: 9001,
			name: 'Old wallet',
			// `type` deliberately omitted — simulates a pre-`type`-column backup.
			xpub: 'xpub-old-format',
			script_type: 'p2wpkh',
			receive_cursor: 0,
			created_at: 't',
			master_fingerprint: null,
			derivation_path: null,
			device_type: null
		});

		const summary = await restoreBackup(data);
		expect(summary.wallets).toBe(1);

		const legacy = getUserByEmail('legacy@example.com')!;
		const wallet = db.prepare('SELECT type FROM wallets WHERE user_id = ?').get(legacy.id) as {
			type: string;
		};
		// pinned current behavior, not endorsed: silently defaults to 'xpub'
		// (backup.ts's `str(w.type) || 'xpub'`) instead of failing loudly on an
		// unrecognized/older row shape.
		expect(wallet.type).toBe('xpub');
	});

	it('a wallet row with a renamed xpub column (xpubkey instead of xpub) restores with an empty xpub, no error', async () => {
		const data = buildBackup('t');
		data.users.push({
			id: 9002,
			email: 'renamed@example.com',
			display_name: 'Renamed',
			is_admin: 0,
			disabled: 0,
			created_at: 't',
			last_login: null
		});
		data.wallets.push({
			id: 2,
			user_id: 9002,
			name: 'Renamed-col wallet',
			type: 'xpub',
			xpubkey: 'xpub-should-be-ignored', // wrong key name — restore code reads `xpub`
			script_type: 'p2wpkh',
			receive_cursor: 0,
			created_at: 't',
			master_fingerprint: null,
			derivation_path: null,
			device_type: null
		});

		const summary = await restoreBackup(data);
		expect(summary.wallets).toBe(1);

		const renamed = getUserByEmail('renamed@example.com')!;
		const wallet = db.prepare('SELECT xpub FROM wallets WHERE user_id = ?').get(renamed.id) as {
			xpub: string;
		};
		// pinned current behavior, not endorsed: silently lands as '' (str(undefined))
		// rather than erroring on the unrecognized column name.
		expect(wallet.xpub).toBe('');
	});

	it('decryptBackup does NOT reject a backup older than VERSION — only newer-than-VERSION is rejected', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const data = buildBackup('t');
		(data as unknown as { version: number }).version = 0;
		const blob = await encryptBackup(data, PP);
		const envelope = JSON.parse(blob) as { version: number };
		envelope.version = 0;

		// Contrast with backup.test.ts's "rejects a backup envelope from a newer
		// format version" test: an OLDER version sails through with no
		// BackupError at all. Pinned current behavior, not endorsed — there is
		// no lower-bound version check, only an upper bound.
		const back = await decryptBackup(JSON.stringify(envelope), PP);
		expect(back.version).toBe(0);
	});
});
