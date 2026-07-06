// Instance secret key + at-rest encryption for small server-side secrets
// (currently: per-user SMTP passwords — docs/PER-USER-SMTP-PLAN.md §2).
//
// The instance key is 32 random bytes generated on first use and persisted to a
// file COLOCATED WITH THE DATABASE, deliberately OUTSIDE the DB file itself:
//
//   path.join(path.dirname(DB_PATH), 'instance.key')   // mode 0600
//
// Why next to the DB and not in the `settings` table: a leaked/exported
// `cairn.db` (a backup, a support screenshare, a replicated copy) must NOT carry
// the key needed to decrypt the SMTP passwords stored inside it — otherwise the
// encryption is theatre against exactly that threat. Under Docker/Umbrel the DB
// lives on the mounted /data volume (ENV CAIRN_DB=/data/cairn.db, VOLUME /data),
// so the key file lands on that SAME persistent volume — a container restart on
// ephemeral storage would otherwise silently orphan every saved password.
//
// Encryption is AES-256-GCM. The actual cipher key is derived from the instance
// key via HKDF-SHA256 with a fixed `info` label, so this use is domain-separated
// from any future use of the same instance key for something else. The instance
// key is already high-entropy, so (unlike backup.ts's passphrase-derived key)
// there is no scrypt/KDF-cost step here. The envelope is a small versioned JSON
// object with base64 fields, mirroring backup.ts's envelope style.

import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './db';
import { childLogger } from './logger';

const log = childLogger('secret-key');

const KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
// Domain-separation label for the HKDF expansion — bump/change only alongside a
// key-rotation migration, never casually (existing envelopes decrypt with it).
const HKDF_INFO = 'cairn:notification-smtp-pass';

export class SecretKeyError extends Error {}

/** Absolute path of the instance key file, derived from the DB's directory (NOT
 *  process.cwd()) so it shares the DB's persistent volume under Docker/Umbrel. */
export function instanceKeyPath(): string {
	return path.join(path.dirname(DB_PATH), 'instance.key');
}

// Cached after first read so we hit the filesystem once per process.
let cachedKey: Buffer | null = null;

/**
 * The instance's 32-byte secret key. Generated and written (mode 0600) on the
 * first call if the file doesn't exist yet — idempotent lazy init, same style as
 * the rest of the app's first-run code. Cached in memory afterwards.
 */
export function getInstanceKey(): Buffer {
	if (cachedKey) return cachedKey;

	const keyPath = instanceKeyPath();
	if (fs.existsSync(keyPath)) {
		const buf = fs.readFileSync(keyPath);
		if (buf.length !== KEY_BYTES) {
			throw new SecretKeyError(
				`Instance key at ${keyPath} is ${buf.length} bytes, expected ${KEY_BYTES}. ` +
					`Refusing to use a malformed key (it would silently break decryption).`
			);
		}
		cachedKey = buf;
		return cachedKey;
	}

	// First run: generate and persist. Write to a temp file + rename so a crash
	// mid-write can't leave a truncated key, and set restrictive perms up front.
	const key = randomBytes(KEY_BYTES);
	fs.mkdirSync(path.dirname(keyPath), { recursive: true });
	const tmp = `${keyPath}.tmp-${randomBytes(6).toString('hex')}`;
	fs.writeFileSync(tmp, key, { mode: 0o600 });
	fs.renameSync(tmp, keyPath);
	// Re-assert perms after rename (umask can slacken the create mode on POSIX).
	try {
		fs.chmodSync(keyPath, 0o600);
	} catch {
		// chmod is a no-op / unsupported on some filesystems (e.g. Windows) — the
		// key file's confidentiality there rests on OS/volume permissions instead.
	}
	log.info({ keyPath }, 'generated new instance secret key');
	cachedKey = key;
	return cachedKey;
}

/** The AES-256 cipher key for this domain, derived from the instance key. */
function cipherKey(): Buffer {
	return Buffer.from(
		hkdfSync('sha256', getInstanceKey(), Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf8'), 32)
	);
}

interface Envelope {
	v: number;
	iv: string;
	tag: string;
	data: string;
}

/** Encrypt a secret into a versioned base64 JSON envelope (safe to store at rest). */
export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
	const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
	const envelope: Envelope = {
		v: ENVELOPE_VERSION,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64')
	};
	return JSON.stringify(envelope);
}

/** Inverse of {@link encryptSecret}. Throws SecretKeyError on a malformed/wrong-
 *  version envelope or a failed auth-tag check (tampered ciphertext) — never
 *  silently returns garbage. */
export function decryptSecret(envelopeText: string): string {
	let env: Partial<Envelope>;
	try {
		env = JSON.parse(envelopeText);
	} catch {
		throw new SecretKeyError('Malformed secret envelope (not valid JSON).');
	}
	if (env.v !== ENVELOPE_VERSION) {
		throw new SecretKeyError(`Unsupported secret envelope version: ${String(env.v)}.`);
	}
	if (typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.data !== 'string') {
		throw new SecretKeyError('Malformed secret envelope (missing iv/tag/data).');
	}
	const decipher = createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(env.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
	try {
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(env.data, 'base64')),
			decipher.final()
		]);
		return plaintext.toString('utf8');
	} catch {
		throw new SecretKeyError('Could not decrypt secret (wrong key or tampered data).');
	}
}
