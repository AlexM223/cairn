// cairn-wgr8 — self-signed HTTPS for Umbrel's insecure-context problem.
// Exercises the standalone cert module (scripts/tls-cert.mjs) that server.mjs
// uses: generation produces a usable X.509 pair with the expected SANs,
// ensureCert persists once and then reuses, and expiring certs regenerate.
import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { certUsable, ensureCert, generateCert } from '../../scripts/tls-cert.mjs';

describe('generateCert', () => {
	it('produces a parsable self-signed cert with the Umbrel SANs and ~10y validity', async () => {
		const { key, cert } = await generateCert();
		expect(key).toContain('PRIVATE KEY');
		const parsed = new X509Certificate(cert);
		expect(parsed.subjectAltName).toContain('umbrel.local');
		expect(parsed.subjectAltName).toContain('localhost');
		expect(parsed.subjectAltName).toContain('127.0.0.1');
		const remainingDays =
			(new Date(parsed.validTo).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
		expect(remainingDays).toBeGreaterThan(3600);
		expect(certUsable(cert)).toBe(true);
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
});
