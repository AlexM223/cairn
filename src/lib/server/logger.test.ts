// cairn-5tp3 — pins the pino redaction config (logger.ts REDACT_KEYS →
// redact.paths + censor). /admin/logs serves data/logs/cairn.log over HTTP, so
// a secret-bearing field accidentally passed to logger.*() must be censored at
// the top level AND one nesting down. Tests build a capturing pino instance
// with the module's own exported REDACT_OPTIONS (the exact object the real
// logger is constructed with).

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_OPTIONS } from './logger';

/** A pino logger configured exactly like the real one, writing to a capture buffer. */
function captureLogger() {
	let out = '';
	const stream = new Writable({
		write(chunk, _enc, cb) {
			out += chunk.toString('utf8');
			cb();
		}
	});
	const log = pino({ level: 'info', base: undefined, redact: REDACT_OPTIONS }, stream);
	return {
		log,
		raw: () => out,
		lines: () =>
			out
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>)
	};
}

describe('REDACT_OPTIONS shape', () => {
	it('covers every secret key at the top level AND one nesting down, censoring with [redacted]', () => {
		expect(REDACT_OPTIONS.censor).toBe('[redacted]');
		// Representative keys across the credential families the config promises to
		// cover: passwords, SMTP creds, tokens, private key material, PSBTs.
		for (const key of ['password', 'pass', 'smtpPass', 'token', 'sessionToken', 'apiKey', 'xprv', 'mnemonic', 'seed', 'psbt', 'challenge']) {
			expect(REDACT_OPTIONS.paths).toContain(key);
			expect(REDACT_OPTIONS.paths).toContain(`*.${key}`);
		}
	});
});

describe('redaction through a real pino instance', () => {
	it('censors top-level secret fields — the raw output never contains the values', () => {
		const { log, raw, lines } = captureLogger();
		log.info(
			{ password: 'hunter2-topsecret', token: 'tok-abc123', xprv: 'xprv9s21-material' },
			'login attempt'
		);

		const [line] = lines();
		expect(line.password).toBe('[redacted]');
		expect(line.token).toBe('[redacted]');
		expect(line.xprv).toBe('[redacted]');
		expect(raw()).not.toContain('hunter2-topsecret');
		expect(raw()).not.toContain('tok-abc123');
		expect(raw()).not.toContain('xprv9s21-material');
	});

	it('censors secrets one level down (e.g. { config: { pass } }, { smtp: { accessToken } })', () => {
		const { log, raw, lines } = captureLogger();
		log.warn(
			{
				config: { pass: 'nested-smtp-pass', host: 'mail.example' },
				smtp: { accessToken: 'nested-oauth-token' },
				wallet: { xprv: 'nested-xprv-material' }
			},
			'smtp test failed'
		);

		const [line] = lines();
		expect((line.config as Record<string, unknown>).pass).toBe('[redacted]');
		expect((line.smtp as Record<string, unknown>).accessToken).toBe('[redacted]');
		expect((line.wallet as Record<string, unknown>).xprv).toBe('[redacted]');
		expect(raw()).not.toContain('nested-smtp-pass');
		expect(raw()).not.toContain('nested-oauth-token');
		expect(raw()).not.toContain('nested-xprv-material');
	});

	it('leaves non-secret triage context intact (userId, nested host)', () => {
		const { log, lines } = captureLogger();
		log.info(
			{ userId: 42, config: { host: 'mail.example', pass: 'x' } },
			'context survives'
		);

		const [line] = lines();
		expect(line.userId).toBe(42);
		expect((line.config as Record<string, unknown>).host).toBe('mail.example');
		expect(line.msg).toBe('context survives');
	});

	it('censors email and ip — PII from routine auth/invite traffic (cairn-o1dp.7)', () => {
		expect(REDACT_OPTIONS.paths).toContain('email');
		expect(REDACT_OPTIONS.paths).toContain('ip');

		const { log, raw, lines } = captureLogger();
		// The four real call-site shapes: failed login, disabled-account login,
		// break-glass recovery, invite rate-limit.
		log.warn({ event: 'password_login_failed', email: 'victim@example.com' }, 'login failed');
		log.warn({ event: 'password_login_denied', email: 'victim@example.com', userId: 7 }, 'denied');
		log.warn({ userId: 7, email: 'victim@example.com' }, 'Admin recovery login via environment variable');
		log.warn({ scope: 'invite', ip: '203.0.113.9' }, 'invalid invite code submitted');

		const out = lines();
		expect(out[0].email).toBe('[redacted]');
		expect(out[1].email).toBe('[redacted]');
		expect(out[1].userId).toBe(7); // still traceable to the account
		expect(out[2].email).toBe('[redacted]');
		expect(out[3].ip).toBe('[redacted]');
		expect(raw()).not.toContain('victim@example.com');
		expect(raw()).not.toContain('203.0.113.9');
	});
});
