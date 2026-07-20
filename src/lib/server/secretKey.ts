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

/**
 * The AES-256 cipher key for a domain, derived from the instance key via
 * HKDF-SHA256 with that domain's label as the `info` field. Defaults to the
 * legacy notification-SMTP label so every pre-existing call site (and every
 * envelope already on disk with no `l` field) keeps computing byte-identical
 * keys — see the `Envelope.l` doc comment below for the back-compat contract.
 */
function cipherKey(label: string = HKDF_INFO): Buffer {
	return Buffer.from(hkdfSync('sha256', getInstanceKey(), Buffer.alloc(0), Buffer.from(label, 'utf8'), 32));
}

interface Envelope {
	v: number;
	iv: string;
	tag: string;
	data: string;
	/**
	 * Domain-separation label this envelope was encrypted under (qfez8.21:
	 * generalizing the previously-hardcoded single `HKDF_INFO` label to
	 * per-caller domains — e.g. `'cairn:sv2-authority'` for the SV2 authority
	 * secret). OMITTED (not merely equal to the legacy label — actually absent
	 * from the JSON) whenever `label === HKDF_INFO`, so every envelope written
	 * before this field existed, and every envelope written afterwards under
	 * the legacy label, serialize to byte-identical JSON. `decryptSecret`
	 * defaults a missing `l` to `HKDF_INFO`, so old ciphertexts for
	 * `core_rpc_pass` / per-user SMTP passwords keep decrypting unchanged.
	 * `ENVELOPE_VERSION` is NOT bumped for this change — it's purely additive.
	 */
	l?: string;
}

/**
 * Encrypt a secret into a versioned base64 JSON envelope (safe to store at
 * rest). `label` domain-separates the derived cipher key from other secrets
 * sharing the same instance key (e.g. SV2's authority secret vs. SMTP
 * passwords) — it defaults to the legacy label so existing call sites
 * (`encryptSecret(value)`) are unaffected.
 */
export function encryptSecret(plaintext: string, label: string = HKDF_INFO): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', cipherKey(label), iv);
	const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
	const envelope: Envelope = {
		v: ENVELOPE_VERSION,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64'),
		...(label !== HKDF_INFO ? { l: label } : {})
	};
	return JSON.stringify(envelope);
}

/**
 * Whether a stored value LOOKS like an {@link encryptSecret} envelope (versioned
 * JSON with iv/tag/data). Used by startup migrations and legacy-tolerant readers
 * to tell an already-encrypted value from pre-encryption plaintext — it does NOT
 * verify the ciphertext decrypts.
 */
export function isSecretEnvelope(text: string): boolean {
	if (!text.startsWith('{')) return false;
	try {
		const env = JSON.parse(text) as Partial<Envelope>;
		return (
			!!env &&
			typeof env === 'object' &&
			typeof env.v === 'number' &&
			typeof env.iv === 'string' &&
			typeof env.tag === 'string' &&
			typeof env.data === 'string'
		);
	} catch {
		return false;
	}
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
	if (env.l !== undefined && typeof env.l !== 'string') {
		throw new SecretKeyError('Malformed secret envelope (non-string label).');
	}
	// Self-describing: a legacy envelope (no `l`) decrypts under the same
	// default label encryptSecret() used before this field existed.
	const label = env.l ?? HKDF_INFO;
	const decipher = createDecipheriv('aes-256-gcm', cipherKey(label), Buffer.from(env.iv, 'base64'));
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
