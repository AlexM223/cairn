import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	getInstanceKey,
	encryptSecret,
	decryptSecret,
	instanceKeyPath,
	SecretKeyError
} from './secretKey';
import { DB_PATH } from './db';

// The instance key file is generated lazily on first use, colocated with the DB.
// Tests point the DB at a temp file (src/tests/setup.ts), so the key file lands
// in os.tmpdir() too. getInstanceKey() caches in-process after the first call, so
// we do NOT delete the file between tests (that would not force regeneration and
// only creates ordering hazards) — we just clean it up once at the end.
afterAll(() => {
	try {
		fs.rmSync(instanceKeyPath(), { force: true });
	} catch {
		/* best effort */
	}
});

describe('instanceKeyPath', () => {
	it('derives the key file path from the DB directory, not process.cwd()', () => {
		expect(instanceKeyPath()).toBe(path.join(path.dirname(DB_PATH), 'instance.key'));
		// The temp DB dir is not the project working directory.
		expect(path.dirname(instanceKeyPath())).not.toBe(process.cwd());
	});
});

describe('getInstanceKey', () => {
	it('generates a 32-byte key file on first use and reuses the same key', () => {
		const keyPath = instanceKeyPath();
		const k1 = getInstanceKey();
		expect(k1).toHaveLength(32);
		expect(fs.existsSync(keyPath)).toBe(true);
		expect(fs.readFileSync(keyPath)).toHaveLength(32);

		// Reuse: same key returned, and the on-disk bytes are unchanged (not
		// regenerated) — matches the file content.
		const onDisk = fs.readFileSync(keyPath);
		const k2 = getInstanceKey();
		expect(Buffer.compare(k1, k2)).toBe(0);
		expect(Buffer.compare(k1, onDisk)).toBe(0);
	});

	it('writes the key file with restrictive permissions on POSIX', () => {
		getInstanceKey();
		if (process.platform === 'win32') return; // POSIX perm bits are meaningless on Windows
		const mode = fs.statSync(instanceKeyPath()).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe('encryptSecret / decryptSecret round-trip', () => {
	it('round-trips a secret back to the original plaintext', () => {
		const secret = 'hunter2-correct-horse-battery';
		const envelope = encryptSecret(secret);
		expect(envelope).not.toContain(secret); // ciphertext, not plaintext
		expect(decryptSecret(envelope)).toBe(secret);
	});

	it('round-trips unicode and empty strings', () => {
		for (const s of ['', 'p@ss wörd 🔐', 'a'.repeat(500)]) {
			expect(decryptSecret(encryptSecret(s))).toBe(s);
		}
	});

	it('produces a versioned envelope with base64 iv/tag/data', () => {
		const env = JSON.parse(encryptSecret('topsecret'));
		expect(env.v).toBe(1);
		expect(typeof env.iv).toBe('string');
		expect(typeof env.tag).toBe('string');
		expect(typeof env.data).toBe('string');
	});
});

describe('per-domain label refactor (qfez8.21) back-compat', () => {
	it('a legacy envelope (no `l` field) still decrypts under the default label', () => {
		// Simulates an envelope written by the pre-refactor code, which never
		// serialized an `l` field at all.
		const secret = 'legacy-smtp-app-password';
		const envelope = JSON.parse(encryptSecret(secret)) as Record<string, unknown>;
		expect(envelope.l).toBeUndefined();
		expect(decryptSecret(JSON.stringify(envelope))).toBe(secret);
	});

	it('encryptSecret(value) with no label argument omits `l` entirely (byte-identical to pre-refactor envelopes)', () => {
		const envelope = JSON.parse(encryptSecret('unlabeled')) as Record<string, unknown>;
		expect('l' in envelope).toBe(false);
		expect(Object.keys(envelope).sort()).toEqual(['data', 'iv', 'tag', 'v']);
	});

	it('a labelled envelope round-trips under its own domain', () => {
		const secret = 'sv2-authority-secret-hex';
		const envelope = encryptSecret(secret, 'cairn:sv2-authority');
		const parsed = JSON.parse(envelope) as Record<string, unknown>;
		expect(parsed.l).toBe('cairn:sv2-authority');
		expect(decryptSecret(envelope)).toBe(secret);
	});

	it('a labelled envelope decrypted under the wrong label fails (auth-tag mismatch)', () => {
		const envelope = JSON.parse(encryptSecret('secret', 'cairn:sv2-authority')) as Record<string, unknown>;
		envelope.l = 'cairn:some-other-domain';
		expect(() => decryptSecret(JSON.stringify(envelope))).toThrow(SecretKeyError);
	});

	it('two different labels produce non-interchangeable ciphertext for the same plaintext', () => {
		const a = encryptSecret('same plaintext', 'domain-a');
		const b = encryptSecret('same plaintext', 'domain-b');
		expect(() => decryptSecret(JSON.stringify({ ...JSON.parse(a), l: 'domain-b' }))).toThrow(SecretKeyError);
		expect(decryptSecret(a)).toBe('same plaintext');
		expect(decryptSecret(b)).toBe('same plaintext');
	});

	it('rejects a non-string label', () => {
		const envelope = JSON.parse(encryptSecret('secret')) as Record<string, unknown>;
		envelope.l = 12345;
		expect(() => decryptSecret(JSON.stringify(envelope))).toThrow(SecretKeyError);
	});
});

describe('decryptSecret tamper detection', () => {
	it('fails when the ciphertext (data) is tampered with', () => {
		const env = JSON.parse(encryptSecret('secret'));
		const bad = Buffer.from(env.data, 'base64');
		bad[0] ^= 0xff;
		env.data = bad.toString('base64');
		expect(() => decryptSecret(JSON.stringify(env))).toThrow(SecretKeyError);
	});

	it('fails when the auth tag is tampered with', () => {
		const env = JSON.parse(encryptSecret('secret'));
		const bad = Buffer.from(env.tag, 'base64');
		bad[0] ^= 0xff;
		env.tag = bad.toString('base64');
		expect(() => decryptSecret(JSON.stringify(env))).toThrow(SecretKeyError);
	});

	it('fails when the iv is tampered with', () => {
		const env = JSON.parse(encryptSecret('secret'));
		const bad = Buffer.from(env.iv, 'base64');
		bad[0] ^= 0xff;
		env.iv = bad.toString('base64');
		expect(() => decryptSecret(JSON.stringify(env))).toThrow(SecretKeyError);
	});

	it('rejects malformed JSON and wrong-version envelopes', () => {
		expect(() => decryptSecret('not json')).toThrow(SecretKeyError);
		expect(() => decryptSecret(JSON.stringify({ v: 99, iv: 'a', tag: 'b', data: 'c' }))).toThrow(
			SecretKeyError
		);
		expect(() => decryptSecret(JSON.stringify({ v: 1 }))).toThrow(SecretKeyError);
	});
});
