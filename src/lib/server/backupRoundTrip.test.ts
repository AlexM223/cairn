// cairn-s6x3 / cairn-90k8 / cairn-ldhm — backup/restore round-trip coverage
// beyond backup.test.ts's existing suite (which owns: basic encrypt/decrypt,
// credential/secret exclusion, version-too-new rejection, the additive
// restore/skip-existing/admin-downgrade/settings-allowlist behavior, and the
// per-row-skip logging contract). This file adds:
//
//   4. A full byte-for-byte round-trip across ALL NINE captured tables at
//      once (not just users, one at a time) plus confirmation that
//      multisig_shares — collaborative-custody sharing — IS now captured by
//      buildBackup and survives a restore, including the per-key
//      collaborator assignment on multisig_keys.assigned_user_id (cairn-s6x3,
//      fixed).
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

// Real BIP84 test-vector account zpub (mnemonic "abandon abandon ... about",
// same vector backup.test.ts / bitcoin/xpub.test.ts use) -> p2wpkh. Any test
// below that actually calls restoreBackup on a wallet row needs a
// cryptographically real xpub: cairn-gmiw's restore-boundary check parses it
// and cross-checks the derived script type against the row's script_type, so
// a placeholder string like the old 'xpubBOB' is now correctly rejected.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

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

describe('full 9-table encrypt/decrypt round-trip (cairn-s6x3)', () => {
	it('round-trips every captured table byte-for-byte, including multisig_shares', async () => {
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
		expect(data.multisig_shares.length).toBeGreaterThanOrEqual(1);
		expect(data.saved_addresses.length).toBeGreaterThanOrEqual(1);
		expect(data.tx_labels.length).toBeGreaterThanOrEqual(1);
		expect(data.settings.some((s) => s.key === 'electrum_host')).toBe(true);

		const env = await encryptBackup(data, PP);
		const back = await decryptBackup(env, PP);
		expect(back).toEqual(data);

		await expect(decryptBackup(env, 'definitely-the-wrong-passphrase')).rejects.toThrowError(
			BackupError
		);

		// cairn-s6x3 (FIXED): multisig_shares IS now selected by buildBackup, so
		// the collaborative-custody sharing relationship survives the round-trip.
		expect(data).toHaveProperty('multisig_shares');
		expect(back.multisig_shares).toEqual(data.multisig_shares);
	});
});

// ═══════════════════════════════════════════════════ GROUP 4 — restore round-trip

describe('restore round-trip (cairn-s6x3)', () => {
	it('restores users/wallets/multisigs/addresses/labels/allowlisted-settings, downgrades the admin flag, mints reclaim codes, and recreates multisig_shares + key assignments (cairn-s6x3)', async () => {
		const admin = await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const bob = await registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		expect(admin.isAdmin).toBe(true); // first registration after wipe auto-admins
		makeWallet(bob.id, ZPUB);
		const msId = Number(
			db
				.prepare(
					"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'MS', 2, 'p2wsh')"
				)
				.run(bob.id).lastInsertRowid
		);
		// The key is assigned to admin (the cosigner) so the round-trip also proves
		// multisig_keys.assigned_user_id is captured and remapped, not just the
		// share row (cairn-s6x3).
		db.prepare(
			"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path, assigned_user_id) VALUES (?, 0, 'K', 'hardware', 'xpub-k', '00000000', ?, ?)"
		).run(msId, "m/48'/0'/0'/2'", admin.id);
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
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'cosigner')"
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
		expect(summary.shares).toBe(1);
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
		expect(wallets.map((w) => w.xpub)).toEqual([ZPUB]);

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

		// cairn-s6x3 (FIXED): multisig_shares is captured and the collaborative-
		// sharing relationship between bob and admin comes back, with both
		// endpoints and the multisig id remapped, and is surfaced on the summary.
		expect(tableCount('multisig_shares')).toBe(1);
		const share = db
			.prepare(
				'SELECT multisig_id, owner_id, shared_with_id, role FROM multisig_shares'
			)
			.get() as { multisig_id: number; owner_id: number; shared_with_id: number; role: string };
		const restoredMsId = (
			db.prepare('SELECT id FROM multisigs WHERE user_id = ?').get(restoredBob.id) as {
				id: number;
			}
		).id;
		expect(share).toEqual({
			multisig_id: restoredMsId,
			owner_id: restoredBob.id,
			shared_with_id: restoredAdmin.id,
			role: 'cosigner'
		});
		// The per-key collaborator assignment is remapped to the restored admin too.
		const assignedKey = db
			.prepare('SELECT assigned_user_id FROM multisig_keys WHERE multisig_id = ?')
			.get(restoredMsId) as { assigned_user_id: number | null };
		expect(assignedKey.assigned_user_id).toBe(restoredAdmin.id);

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
			// The xpub itself must be real (cairn-gmiw's restore-boundary check
			// parses it and cross-checks it against script_type below) — this test
			// isolates the `type`-defaulting gap, not xpub validity.
			xpub: ZPUB,
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

	it('a wallet row with a renamed xpub column (xpubkey instead of xpub) is now rejected instead of restoring with a blank xpub (cairn-gmiw)', async () => {
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
		// Previously (pre-cairn-gmiw) this row silently landed with xpub === ''
		// (str(undefined)) — no error, a wallet nothing could ever derive real
		// addresses from. cairn-gmiw's restore-boundary validation parses the
		// xpub before insert, so an empty/unparseable xpub is now caught by the
		// same guard that rejects a script_type/xpub mismatch, and the row is
		// skipped rather than silently inserted broken.
		expect(summary.wallets).toBe(0);

		const renamed = getUserByEmail('renamed@example.com')!;
		const wallet = db.prepare('SELECT xpub FROM wallets WHERE user_id = ?').get(renamed.id) as
			| { xpub: string }
			| undefined;
		expect(wallet).toBeUndefined();
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
