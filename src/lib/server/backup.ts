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
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import {
	getSetting,
	setSetting,
	setSecretSetting,
	readSecretSetting,
	hasSecretSetting
} from './settings';
import { notify } from './notifications';
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

// ------------------------------------------------------- scheduled backups
//
// Opt-in automation of the manual download above (cairn-ivae.3): on a daily or
// weekly cadence, write the same encrypted envelope to an operator-configured
// LOCAL path (a mounted volume, NAS mount, synced folder — cloud storage
// integrations are explicitly out of scope). The passphrase is stored via
// setSecretSetting (encrypted at rest in instance_secrets, excluded from
// backups by construction) so unattended runs can encrypt exactly like a
// manual download. A successful run updates the SAME last_instance_backup_at
// key the manual path writes, so backupHealth.ts's staleness reminder sees
// scheduled runs and never double-reports.

const K_SCHED_ENABLED = 'scheduled_backup_enabled';
const K_SCHED_INTERVAL = 'scheduled_backup_interval'; // 'daily' | 'weekly'
const K_SCHED_PATH = 'scheduled_backup_path';
const K_SCHED_PASS = 'scheduled_backup_pass'; // instance_secrets (encrypted at rest)
const K_SCHED_LAST_RUN = 'scheduled_backup_last_run_at';
const K_SCHED_LAST_ERROR = 'scheduled_backup_last_error';
const K_SCHED_ERROR_NOTIFIED = 'scheduled_backup_error_notified_at';

export type ScheduledBackupInterval = 'daily' | 'weekly';

const INTERVAL_MS: Record<ScheduledBackupInterval, number> = {
	daily: 24 * 3_600_000,
	weekly: 7 * 24 * 3_600_000
};

/** How often the watcher checks whether a run is due. A failed run stays due
 *  and is retried on this cadence (silently — the admin notification below is
 *  throttled separately). */
const TICK_MS = 15 * 60_000;
/** At most one "scheduled backup failed" admin notification per day, however
 *  many retry ticks fail in between. */
const ERROR_RENOTIFY_MS = 24 * 3_600_000;
/** Scheduled files kept in the destination before the oldest are pruned. */
const KEEP_FILES = 30;

export interface ScheduledBackupConfig {
	enabled: boolean;
	interval: ScheduledBackupInterval;
	/** Destination directory ('' = unset). */
	path: string;
	/** Whether an encryption passphrase is stored (never the value itself). */
	hasPassphrase: boolean;
	lastRunAt: string | null;
	lastError: string | null;
}

export function getScheduledBackupConfig(): ScheduledBackupConfig {
	const interval = getSetting(K_SCHED_INTERVAL);
	return {
		enabled: getSetting(K_SCHED_ENABLED) === 'true',
		interval: interval === 'weekly' ? 'weekly' : 'daily',
		path: getSetting(K_SCHED_PATH) ?? '',
		hasPassphrase: hasSecretSetting(K_SCHED_PASS),
		lastRunAt: getSetting(K_SCHED_LAST_RUN),
		lastError: getSetting(K_SCHED_LAST_ERROR) || null
	};
}

/**
 * Save the schedule. `passphrase` undefined/'' = keep the stored one (it is
 * never echoed to the form, so an untouched field must not clear it — same
 * convention as the Core RPC password). Throws BackupError with a
 * user-facing message on any invalid combination; the destination directory
 * is created (and write-tested) here so a typo'd path fails at save time in
 * front of the admin, not silently at 3am.
 */
export function saveScheduledBackupConfig(input: {
	enabled: boolean;
	interval: string;
	path: string;
	passphrase?: string;
}): void {
	if (input.interval !== 'daily' && input.interval !== 'weekly') {
		throw new BackupError('Choose a daily or weekly schedule.');
	}
	const dest = input.path.trim();
	const pass = input.passphrase ?? '';
	if (pass && pass.length < 8) {
		throw new BackupError('Choose a passphrase of at least 8 characters.');
	}

	if (input.enabled) {
		if (!dest) throw new BackupError('Enter a destination folder for scheduled backups.');
		if (!path.isAbsolute(dest)) {
			throw new BackupError('The destination must be an absolute path on the server.');
		}
		if (!pass && !hasSecretSetting(K_SCHED_PASS)) {
			throw new BackupError('Choose an encryption passphrase for scheduled backups.');
		}
		try {
			fs.mkdirSync(dest, { recursive: true });
			fs.accessSync(dest, fs.constants.W_OK);
		} catch {
			throw new BackupError('That folder cannot be created or written to by the server.');
		}
	}

	setSetting(K_SCHED_ENABLED, input.enabled ? 'true' : 'false');
	setSetting(K_SCHED_INTERVAL, input.interval);
	setSetting(K_SCHED_PATH, dest);
	if (pass) setSecretSetting(K_SCHED_PASS, pass);
	log.info(
		{ enabled: input.enabled, interval: input.interval },
		'scheduled backup settings saved'
	);
}

/** Prune old scheduled files, keeping the newest KEEP_FILES. Only files this
 *  feature wrote (strict name match) are ever touched — the destination is an
 *  operator folder that may hold anything else. Best-effort. */
function pruneScheduledFiles(dir: string): void {
	try {
		const mine = fs
			.readdirSync(dir)
			.filter((f) => /^cairn-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
			.sort(); // name order IS date order for this fixed format
		for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_FILES))) {
			fs.rmSync(path.join(dir, f), { force: true });
		}
	} catch (e) {
		log.warn({ err: e, dir }, 'scheduled backup prune failed');
	}
}

/** Surface a failed scheduled run to the admins — a silent skip would defeat
 *  the point of automating the backup. Throttled to once per day so hourly
 *  retry ticks against a broken destination don't flood the bell. */
function noteScheduledFailure(nowMs: number, message: string): void {
	setSetting(K_SCHED_LAST_ERROR, message);
	const lastNotified = getSetting(K_SCHED_ERROR_NOTIFIED);
	if (lastNotified) {
		const t = Date.parse(lastNotified);
		if (!Number.isNaN(t) && nowMs - t < ERROR_RENOTIFY_MS) return;
	}
	setSetting(K_SCHED_ERROR_NOTIFIED, new Date(nowMs).toISOString());
	notify({
		type: 'admin_server_health',
		userId: null, // admin fan-out
		level: 'error',
		title: 'Scheduled backup failed',
		body: `The automatic instance backup could not be written: ${message} Check the destination folder in Admin → Backup.`,
		detail: { error: message },
		link: '/admin/backup'
	});
}

/**
 * Run the scheduled backup if one is due. Exported for tests; the watcher
 * below calls it on a fixed tick. Never throws — failures are recorded on
 * scheduled_backup_last_error and (throttled) notified to admins.
 */
export function runScheduledBackupIfDue(nowMs = Date.now()): boolean {
	try {
		const cfg = getScheduledBackupConfig();
		if (!cfg.enabled) return false;

		const lastRun = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : NaN;
		if (!Number.isNaN(lastRun) && nowMs - lastRun < INTERVAL_MS[cfg.interval]) return false;

		if (!cfg.path) {
			noteScheduledFailure(nowMs, 'No destination folder is configured.');
			return false;
		}
		const passphrase = readSecretSetting(K_SCHED_PASS);
		if (!passphrase) {
			noteScheduledFailure(nowMs, 'No encryption passphrase is stored.');
			return false;
		}

		const exportedAt = new Date(nowMs).toISOString();
		const encrypted = encryptBackup(buildBackup(exportedAt), passphrase);
		const file = path.join(cfg.path, `cairn-backup-${exportedAt.slice(0, 10)}.json`);
		try {
			fs.mkdirSync(cfg.path, { recursive: true });
			// Write-then-rename so a crash mid-write can't leave a truncated file
			// that looks like a valid (but unrestorable) backup.
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, encrypted, 'utf8');
			fs.renameSync(tmp, file);
		} catch (e) {
			noteScheduledFailure(nowMs, e instanceof Error ? e.message : 'Write failed.');
			return false;
		}

		// Same key the manual download records, so backupHealth's staleness
		// reminder counts scheduled runs too (no double-reporting).
		setSetting('last_instance_backup_at', exportedAt);
		setSetting(K_SCHED_LAST_RUN, exportedAt);
		setSetting(K_SCHED_LAST_ERROR, '');
		pruneScheduledFiles(cfg.path);
		log.info({ file }, 'scheduled instance backup written');
		return true;
	} catch (e) {
		// Belt-and-suspenders: nothing above should throw, but a scheduler tick
		// must never take the process down.
		log.error({ err: e }, 'scheduled backup run failed unexpectedly');
		return false;
	}
}

let watcherStarted = false;

/**
 * Start the scheduled-backup ticker. Idempotent and unref'd, same shape as
 * startBackupHealthWatcher. Called from the authenticated layout load (the
 * earliest in-scope hook that runs on every deployment) rather than
 * hooks.server.ts — the first request after boot arms it for the life of the
 * process.
 */
export function startScheduledBackupWatcher(): void {
	if (watcherStarted) return;
	watcherStarted = true;
	const interval = setInterval(() => {
		runScheduledBackupIfDue();
	}, TICK_MS);
	interval.unref?.();
}
