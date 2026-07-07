// cairn-wgr8 — self-signed HTTPS for Umbrel's insecure-context problem.
// Exercises the standalone cert module (scripts/tls-cert.mjs) that server.mjs
// uses: generation produces a usable X.509 pair with the expected SANs and a
// SHA-256 signature (cairn-yurk: selfsigned defaults to SHA-1, which browsers
// and OS trust stores reject), ensureCert persists once and then reuses,
// regenerates expiring/weak certs, and never fails just because the pair
// can't be persisted (cairn-qv6h: a dead HTTPS port is the worst outcome).
import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { certUsable, ensureCert, generateCert } from '../../scripts/tls-cert.mjs';

const SHA1_RSA_OID = Buffer.from('06092a864886f70d010105', 'hex');
const SHA256_RSA_OID = Buffer.from('06092a864886f70d01010b', 'hex');

/** A pair signed the way Cairn ≤ 0.1.6 signed them (selfsigned's SHA-1 default). */
async function generateLegacySha1Cert(): Promise<{ key: string; cert: string }> {
	const selfsigned = (await import('selfsigned')).default;
	const pems = await selfsigned.generate([{ name: 'commonName', value: 'umbrel.local' }], {
		days: 3650,
		keySize: 2048,
		algorithm: 'sha1'
	});
	return { key: pems.private, cert: pems.cert };
}

describe('generateCert', () => {
	it('produces a parsable SHA-256 self-signed cert with the Umbrel SANs', async () => {
		const { key, cert } = await generateCert();
		expect(key).toContain('PRIVATE KEY');
		const parsed = new X509Certificate(cert);
		expect(parsed.subjectAltName).toContain('umbrel.local');
		expect(parsed.subjectAltName).toContain('localhost');
		expect(parsed.subjectAltName).toContain('127.0.0.1');
		expect(parsed.raw.includes(SHA256_RSA_OID)).toBe(true);
		expect(parsed.raw.includes(SHA1_RSA_OID)).toBe(false);
		expect(certUsable(cert)).toBe(true);
	}, 30_000);

	it('stays under Apple\'s 825-day trust-import ceiling but well past the regen floor', async () => {
		const { cert } = await generateCert();
		const parsed = new X509Certificate(cert);
		const remainingDays =
			(new Date(parsed.validTo).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
		expect(remainingDays).toBeGreaterThan(700);
		expect(remainingDays).toBeLessThanOrEqual(825);
	}, 30_000);

	it('carries the leaf-certificate extensions OS trust stores require', async () => {
		const { cert } = await generateCert();
		const parsed = new X509Certificate(cert);
		expect(parsed.ca).toBe(false); // basicConstraints present, cA=false
		expect(parsed.keyUsage).toBeDefined(); // extKeyUsage: serverAuth
		expect(parsed.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
	}, 30_000);
});

describe('certUsable', () => {
	it('rejects garbage and near-expiry certs', async () => {
		expect(certUsable('not a pem')).toBe(false);
		const { cert } = await generateCert();
		// A cert that "now" says is 20 days from expiry (< the 30-day floor).
		const expires = new Date(new X509Certificate(cert).validTo);
		const twentyDaysBefore = new Date(expires.getTime() - 20 * 24 * 60 * 60 * 1000);
		expect(certUsable(cert, twentyDaysBefore)).toBe(false);
	}, 30_000);

	it('rejects SHA-1-signed certs even with years of validity left', async () => {
		const { cert } = await generateLegacySha1Cert();
		expect(certUsable(cert)).toBe(false);
	}, 30_000);
});

describe('ensureCert', () => {
	it('generates + persists on first call, then reuses the same pair; regenerates when unusable', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'cairn-tls-'));
		try {
			const first = await ensureCert(dir);
			expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toBe(first.cert);

			const second = await ensureCert(dir);
			expect(second.cert).toBe(first.cert); // reused, not regenerated

			writeFileSync(path.join(dir, 'cert.pem'), 'corrupted');
			const third = await ensureCert(dir);
			expect(third.cert).not.toBe(first.cert);
			expect(certUsable(third.cert)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it('replaces a persisted SHA-1 cert from ≤ 0.1.6 with a SHA-256 one', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'cairn-tls-sha1-'));
		try {
			const legacy = await generateLegacySha1Cert();
			writeFileSync(path.join(dir, 'key.pem'), legacy.key);
			writeFileSync(path.join(dir, 'cert.pem'), legacy.cert);

			const { cert } = await ensureCert(dir);
			expect(cert).not.toBe(legacy.cert);
			expect(new X509Certificate(cert).raw.includes(SHA256_RSA_OID)).toBe(true);
			// and the replacement was persisted for the next boot
			expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toBe(cert);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it('still returns a working pair when the cert cannot be persisted', async () => {
		const parent = mkdtempSync(path.join(tmpdir(), 'cairn-tls-ro-'));
		try {
			// A regular FILE where the tls dir should go → mkdir/write both fail.
			const blocker = path.join(parent, 'tls');
			writeFileSync(blocker, 'i am a file, not a directory');

			const { key, cert } = await ensureCert(blocker);
			expect(key).toContain('PRIVATE KEY');
			expect(certUsable(cert)).toBe(true);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	}, 60_000);
});
