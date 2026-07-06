// Encrypted instance backup + restore, for self-hosted maintenance and admin
// recovery. The backup preserves durable CONFIG — user accounts (minus any
// credentials), wallet/multisig configs, settings, labels, address book — and
// deliberately contains NO secrets: no passkey credentials, no session tokens,
// no private keys (Cairn never holds keys, only xpubs).
//
// It is encrypted with a passphrase the admin chooses (AES-256-GCM, scrypt KDF),
// so a downloaded backup file is safe at rest. Restore is ADDITIVE and keyed on
// email: an account whose email already exists is skipped (never clobbered), and
// imported accounts arrive credential-less — their owner reclaims them by adding
// a passkey through the normal signup screen.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { childLogger } from './logger';

const log = childLogger('backup');

const FORMAT = 'cairn-backup';
const VERSION = 1;
const KDF = { N: 16384, r: 8, p: 1, keyLen: 32 };

// Tables captured in a backup, each read verbatim. Order matters for restore
// (parents before children).
type Row = Record<string, unknown>;
export interface BackupData {
	format: typeof FORMAT;
	version: number;
	exportedAt: string;
	users: Row[];
	wallets: Row[];
	multisigs: Row[];
	multisig_keys: Row[];
	ledger_multisig_registrations: Row[];
	saved_addresses: Row[];
	tx_labels: Row[];
	settings: Row[];
}

function all(sql: string): Row[] {
	return db.prepare(sql).all() as Row[];
}

// Setting keys that hold a secret (e.g. the Bitcoin Core RPC password) are
// excluded from backups — the operator re-enters them after a restore.
// Credential material itself lives in the separate instance_secrets table
// (cairn-e9mz.4), which buildBackup never selects from AT ALL — exclusion by
// construction; this regex is defense-in-depth for any secret-ish key that
// still lands in the plain settings table.
const SENSITIVE_SETTING = /pass|secret|token|pin|key/i;

/** Snapshot the instance's durable config (no credentials/tokens/keys). */
export function buildBackup(exportedAt: string): BackupData {
	return {
		format: FORMAT,
		version: VERSION,
		exportedAt,
		// Explicit column lists: never export credential/session material.
		users: all(
			'SELECT id, email, display_name, is_admin, disabled, created_at, last_login FROM users'
		),
		wallets: all('SELECT * FROM wallets'),
		multisigs: all('SELECT * FROM multisigs'),
		multisig_keys: all('SELECT * FROM multisig_keys'),
		ledger_multisig_registrations: all('SELECT * FROM ledger_multisig_registrations'),
		saved_addresses: all('SELECT * FROM saved_addresses'),
		tx_labels: all('SELECT * FROM tx_labels'),
		settings: all('SELECT key, value FROM settings').filter(
			(r) => !SENSITIVE_SETTING.test(String(r.key))
		)
	};
}

// -------------------------------------------------------------- encryption

function deriveKey(passphrase: string, salt: Buffer, params = KDF): Buffer {
	return scryptSync(passphrase, salt, params.keyLen, { N: params.N, r: params.r, p: params.p });
}

/** Encrypt a backup into a self-describing JSON envelope (safe to download). */
export function encryptBackup(data: BackupData, passphrase: string): string {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = deriveKey(passphrase, salt);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
		cipher.final()
	]);
	const envelope = {
		format: FORMAT,
		version: VERSION,
		cipher: 'aes-256-gcm',
		kdf: { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen, salt: salt.toString('base64') },
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: ciphertext.toString('base64')
	};
	return JSON.stringify(envelope, null, 2);
}

export class BackupError extends Error {}

/** Decrypt an envelope produced by {@link encryptBackup}. Throws on bad input. */
export function decryptBackup(envelopeText: string, passphrase: string): BackupData {
	let env: Record<string, unknown>;
	try {
		env = JSON.parse(envelopeText);
	} catch {
		throw new BackupError('That is not a valid Cairn backup file.');
	}
	if (env.format !== FORMAT || env.cipher !== 'aes-256-gcm' || typeof env.data !== 'string') {
		throw new BackupError('That is not a Cairn backup file.');
	}
	const kdf = env.kdf as { N: number; r: number; p: number; keyLen: number; salt: string };
	const key = deriveKey(passphrase, Buffer.from(kdf.salt, 'base64'), {
		N: kdf.N,
		r: kdf.r,
		p: kdf.p,
		keyLen: kdf.keyLen
	});
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(env.iv), 'base64'));
	decipher.setAuthTag(Buffer.from(String(env.tag), 'base64'));
	let plaintext: Buffer;
	try {
		plaintext = Buffer.concat([
			decipher.update(Buffer.from(env.data, 'base64')),
			decipher.final()
		]);
	} catch {
		throw new BackupError('Wrong passphrase, or the backup file is corrupt.');
	}
	let data: BackupData;
	try {
		data = JSON.parse(plaintext.toString('utf8'));
	} catch {
		throw new BackupError('The backup contents are unreadable.');
	}
	if (data.format !== FORMAT || !Array.isArray(data.users)) {
		throw new BackupError('The backup contents are not in the expected shape.');
	}
	return data;
}

// ----------------------------------------------------------------- restore

export interface RestoreSummary {
	usersAdded: number;
	usersSkipped: number;
	/** Imported rows that were flagged is_admin in the backup and were forcibly
	 *  demoted to a normal account on restore (see restoreBackup for why). */
	adminDowngraded: number;
	wallets: number;
	multisigs: number;
	addresses: number;
	labels: number;
	settings: number;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const numOr = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
// For nullable TEXT columns: keep null, otherwise coerce to a string.
const orNull = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Restore a decrypted backup ADDITIVELY. Accounts whose email already exists are
 * skipped; new accounts are inserted credential-less (their owner reclaims them
 * by adding a passkey at signup). Ids are remapped, so this is safe to run on an
 * instance that already has the restoring admin. Runs in one transaction.
 *
 * SECURITY (cairn-cpb5): every imported account is forced to is_admin = 0,
 * regardless of what the backup file claims. A backup file is untrusted input
 * (an admin can be social-engineered into restoring an attacker-crafted one);
 * combined with the credential-less-account reclaim path, honouring an imported
 * is_admin flag would let an attacker register a passkey for that email and walk
 * straight into admin — bypassing the instance's registration lockdown entirely.
 * Legitimately restored admins are simply re-promoted by an existing admin from
 * the users screen. The count of demoted rows is surfaced so the restore is
 * visible, not silent.
 */
export function restoreBackup(data: BackupData): RestoreSummary {
	const summary: RestoreSummary = {
		usersAdded: 0,
		usersSkipped: 0,
		adminDowngraded: 0,
		wallets: 0,
		multisigs: 0,
		addresses: 0,
		labels: 0,
		settings: 0
	};

	db.exec('BEGIN');
	try {
		const userIdMap = new Map<number, number>();
		const emailExists = db.prepare('SELECT id FROM users WHERE email = ?');
		const insertUser = db.prepare(
			'INSERT INTO users (email, display_name, is_admin, disabled, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)'
		);
		for (const u of data.users) {
			const email = str(u.email).trim().toLowerCase();
			if (!email) continue;
			if (emailExists.get(email)) {
				summary.usersSkipped++;
				continue;
			}
			// NEVER trust an imported is_admin flag — force every restored account to
			// a normal (non-admin) role. See the function doc comment (cairn-cpb5).
			if (u.is_admin) summary.adminDowngraded++;
			const res = insertUser.run(
				email,
				str(u.display_name) || email,
				0, // is_admin — always non-admin on restore
				u.disabled ? 1 : 0,
				str(u.created_at) || new Date().toISOString(),
				orNull(u.last_login)
			);
			userIdMap.set(Number(u.id), Number(res.lastInsertRowid));
			summary.usersAdded++;
		}

		const walletIdMap = new Map<number, number>();
		const insertWallet = db.prepare(
			`INSERT INTO wallets (user_id, name, type, xpub, script_type, receive_cursor, created_at, master_fingerprint, derivation_path, device_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const w of data.wallets) {
			const uid = userIdMap.get(Number(w.user_id));
			if (!uid) continue;
			try {
				const res = insertWallet.run(
					uid,
					str(w.name),
					str(w.type) || 'xpub',
					str(w.xpub),
					str(w.script_type),
					numOr(w.receive_cursor, 0),
					str(w.created_at) || new Date().toISOString(),
					orNull(w.master_fingerprint),
					orNull(w.derivation_path),
					orNull(w.device_type)
				);
				walletIdMap.set(Number(w.id), Number(res.lastInsertRowid));
				summary.wallets++;
			} catch (e) {
				// Duplicate (user_id, xpub) or malformed row — skip it, keep going.
				log.warn({ err: e, table: 'wallets', srcId: w.id }, 'restore: skipped a wallet row');
			}
		}

		const multisigIdMap = new Map<number, number>();
		const insertMs = db.prepare(
			'INSERT INTO multisigs (user_id, name, threshold, script_type, receive_cursor, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		);
		for (const m of data.multisigs) {
			const uid = userIdMap.get(Number(m.user_id));
			if (!uid) continue;
			const res = insertMs.run(
				uid,
				str(m.name),
				numOr(m.threshold, 1),
				str(m.script_type) || 'p2wsh',
				numOr(m.receive_cursor, 0),
				str(m.created_at) || new Date().toISOString()
			);
			multisigIdMap.set(Number(m.id), Number(res.lastInsertRowid));
			summary.multisigs++;
		}

		const insertKey = db.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, device_type, xpub, fingerprint, path, last_verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const k of data.multisig_keys) {
			const msId = multisigIdMap.get(Number(k.multisig_id));
			if (!msId) continue;
			try {
				insertKey.run(
					msId,
					numOr(k.position, 0),
					str(k.name),
					str(k.category),
					orNull(k.device_type),
					str(k.xpub),
					str(k.fingerprint),
					str(k.path),
					orNull(k.last_verified_at)
				);
			} catch (eKey) {
				log.warn(
					{ err: eKey, table: 'multisig_keys', srcMultisigId: k.multisig_id },
					'restore: skipped a multisig key row'
				);
			}
		}

		const insertReg = db.prepare(
			`INSERT INTO ledger_multisig_registrations (multisig_id, master_fp, policy_name, policy_hmac, policy_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		for (const r of data.ledger_multisig_registrations ?? []) {
			const msId = multisigIdMap.get(Number(r.multisig_id));
			if (!msId) continue;
			try {
				insertReg.run(
					msId,
					str(r.master_fp),
					str(r.policy_name),
					str(r.policy_hmac),
					orNull(r.policy_id),
					str(r.created_at) || new Date().toISOString()
				);
			} catch (e) {
				log.warn(
					{ err: e, table: 'ledger_multisig_registrations', srcMultisigId: r.multisig_id },
					'restore: skipped a Ledger registration row'
				);
			}
		}

		const insertAddr = db.prepare(
			'INSERT INTO saved_addresses (user_id, label, address, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)'
		);
		for (const a of data.saved_addresses ?? []) {
			const uid = userIdMap.get(Number(a.user_id));
			if (!uid) continue;
			try {
				insertAddr.run(
					uid,
					str(a.label),
					str(a.address),
					str(a.created_at) || new Date().toISOString(),
					orNull(a.last_used_at)
				);
				summary.addresses++;
			} catch (e) {
				log.warn(
					{ err: e, table: 'saved_addresses', srcUserId: a.user_id },
					'restore: skipped a saved-address row'
				);
			}
		}

		const insertLabel = db.prepare(
			'INSERT OR REPLACE INTO tx_labels (wallet_id, txid, label, created_at) VALUES (?, ?, ?, ?)'
		);
		for (const l of data.tx_labels ?? []) {
			const wid = walletIdMap.get(Number(l.wallet_id));
			if (!wid) continue;
			insertLabel.run(wid, str(l.txid), str(l.label), str(l.created_at) || new Date().toISOString());
			summary.labels++;
		}

		const upsertSetting = db.prepare(
			'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
		);
		for (const s of data.settings ?? []) {
			if (!s.key) continue;
			upsertSetting.run(str(s.key), str(s.value));
			summary.settings++;
		}

		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		log.error({ err: e }, 'restore failed');
		throw e instanceof BackupError ? e : new BackupError('Restore failed; no changes were made.');
	}

	return summary;
}

/** Constant-time-ish check that two passphrases match (for the confirm field). */
export function passphrasesMatch(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}
