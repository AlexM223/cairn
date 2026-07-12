// cairn-1cl9 — pins the security-event logging added for cairn-wbmu (commit
// d56e77f, auth.ts / rateLimit.ts / webauthn.ts): failed password logins,
// rate-limit trips, and failed passkey verifications must emit 'security'-tagged
// log lines with triage context — and must NEVER log the password.
//
// Wave 2 / log-ops.md fix (logging-recovered.md finding): this test used to mock
// REDACT_OPTIONS to `{ paths: [] }`, which DISABLED redaction, so it asserted
// raw `email`/`ip` values came through — the exact opposite of what the real
// logger does (logger.ts:214-215 redacts both `email` and `ip` because
// /admin/logs is readable by every admin). That gave false confidence: the
// test would keep passing even if redaction broke, or even if it were removed
// entirely, and it never proved the real logger.ts config actually redacts
// these fields on a security-tagged line.
//
// Fix: build a REAL pino instance here, configured with the actual
// REDACT_OPTIONS imported from logger.ts (not a stand-in), writing to an
// in-memory sink instead of stdout/file. childLogger/logger are mocked to
// return children of that real instance, so every log call from auth.ts /
// rateLimit.ts / webauthn.ts goes through the SAME redaction pino would apply
// in production. Assertions now check the serialized output: email/ip come
// through as the literal '[redacted]' censor string, and the raw values never
// appear anywhere in the emitted text — the only way to actually prove
// redaction is active rather than merely configured. This does not change the
// redaction policy itself (that's a parked product decision — see
// PLAN.md §4 item 3); it only makes the test exercise it honestly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { RequestEvent } from '@sveltejs/kit';
import type { WebAuthnCredential } from '@simplewebauthn/server';

// The modules under test bind `const log = childLogger('security')` at import
// time, so the logger mock must be registered before they load — vi.mock is
// hoisted above the imports below, and the shared capture array is vi.hoisted.
const captured = vi.hoisted(() => {
	const lines: string[] = [];
	return { lines };
});

vi.mock('./logger', async () => {
	// The REAL redact config — same object logger.ts hands to pino in
	// production. Importing the actual module is safe in test mode: LOG_FILE
	// writing is gated off (`FILE_ENABLED = !isTest && …`), so this doesn't
	// touch disk.
	const actual = await vi.importActual<typeof import('./logger')>('./logger');

	// A minimal synchronous sink so every pino write lands in `captured.lines`
	// in order, with no async timing to race against in the tests below.
	const sink = new Writable({
		write(chunk, _enc, cb) {
			captured.lines.push(chunk.toString());
			cb();
		}
	});

	const testLogger = pino(
		{
			level: 'debug',
			serializers: { err: pino.stdSerializers.err },
			base: undefined,
			redact: actual.REDACT_OPTIONS
		},
		sink
	);

	return {
		logger: testLogger,
		childLogger: (tag: string) => testLogger.child({ tag }),
		LOG_FILE: 'unused-in-tests.log',
		REDACT_OPTIONS: actual.REDACT_OPTIONS
	};
});

import { db } from './db';
import { setSetting } from './settings';
import { registerUser, loginWithPassword } from './auth';
import { loginRetryAfter, noteLoginFailure } from './rateLimit';
import { verifyAuthentication } from './webauthn';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	captured.lines.length = 0;
});

/** Every line pino has written so far, parsed from NDJSON into records. */
function records(): Record<string, unknown>[] {
	return captured.lines
		.join('')
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

function securityCalls(level?: string): Record<string, unknown>[] {
	return records().filter(
		(r) => r.tag === 'security' && (!level || pino.levels.labels[r.level as number] === level)
	);
}

function eventsNamed(name: string): Record<string, unknown>[] {
	return securityCalls().filter((r) => r.event === name);
}

/** Every character pino has emitted so far — the ONLY place a real leak (or a
 *  redaction failure) could show up, since redaction happens at serialization. */
function allLoggedText(): string {
	return captured.lines.join('');
}

describe('failed password login (auth.ts)', () => {
	const RIGHT_PW = 'correct horse battery';
	const WRONG_PW = 'Tr0ub4dor&3-wrong';

	it('emits a security warn, but redacts the email — and never logs the password', async () => {
		await registerUser({ email: 'victim@example.com', displayName: 'Victim', password: RIGHT_PW });
		captured.lines.length = 0; // drop the user_registered info line

		await expect(loginWithPassword('victim@example.com', WRONG_PW)).rejects.toThrowError(
			expect.objectContaining({ code: 'bad_credentials' })
		);

		const failed = eventsNamed('password_login_failed');
		expect(failed).toHaveLength(1);
		expect(pino.levels.labels[failed[0].level as number]).toBe('warn');
		// The real logger.ts config redacts `email` (cairn-o1dp.7) — this is the
		// behavior the old mock disabled and thereby failed to pin.
		expect(failed[0]).toMatchObject({
			event: 'password_login_failed',
			email: '[redacted]'
		});

		// The regression this pins: neither the guessed/real password NOR the
		// raw email may appear ANYWHERE in the actual emitted log text.
		const text = allLoggedText();
		expect(text).not.toContain(WRONG_PW);
		expect(text).not.toContain(RIGHT_PW);
		expect(text).not.toContain('victim@example.com');
	});

	it('an unknown email still logs the failure (same event), email still redacted', async () => {
		await expect(loginWithPassword('ghost@example.com', WRONG_PW)).rejects.toThrowError();
		const failed = eventsNamed('password_login_failed');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ email: '[redacted]' });
		const text = allLoggedText();
		expect(text).not.toContain(WRONG_PW);
		expect(text).not.toContain('ghost@example.com');
	});

	it('a disabled account with the right password logs a denial (not silence)', async () => {
		const u = await registerUser({ email: 'off@example.com', displayName: 'Off', password: RIGHT_PW });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
		captured.lines.length = 0;

		await expect(loginWithPassword('off@example.com', RIGHT_PW)).rejects.toThrowError(
			expect.objectContaining({ code: 'disabled' })
		);
		const denied = eventsNamed('password_login_denied');
		expect(denied).toHaveLength(1);
		expect(pino.levels.labels[denied[0].level as number]).toBe('warn');
		// userId is NOT in REDACT_KEYS — stays plain, it's the non-PII triage
		// handle the redaction policy is explicitly meant to preserve.
		expect(denied[0]).toMatchObject({ email: '[redacted]', userId: u.id });
		const text = allLoggedText();
		expect(text).not.toContain(RIGHT_PW);
		expect(text).not.toContain('off@example.com');
	});
});

describe('rate-limit trips (rateLimit.ts)', () => {
	// The limiter is module-level in-memory state that survives across tests in
	// this file, so each test uses its own ip/email.

	it('every failure logs; crossing the per-email threshold escalates to error exactly once — ip/email redacted', () => {
		const ip = '203.0.113.9';
		const email = 'stuffed@example.com'; // no such account → notify() path is skipped

		for (let i = 0; i < 5; i++) noteLoginFailure(ip, email);

		const failures = eventsNamed('login_failed');
		expect(failures).toHaveLength(5);
		expect(pino.levels.labels[failures[0].level as number]).toBe('warn');
		expect(failures[0]).toMatchObject({ ip: '[redacted]', email: '[redacted]' });

		const crossings = eventsNamed('login_threshold_crossed');
		expect(crossings).toHaveLength(1);
		expect(pino.levels.labels[crossings[0].level as number]).toBe('error');
		// attempts is NOT PII — stays plain.
		expect(crossings[0]).toMatchObject({ ip: '[redacted]', email: '[redacted]', attempts: 5 });

		// A 6th failure in the same window must not re-fire the crossing alert.
		noteLoginFailure(ip, email);
		expect(eventsNamed('login_threshold_crossed')).toHaveLength(1);

		const text = allLoggedText();
		expect(text).not.toContain(ip);
		expect(text).not.toContain(email);
	});

	it('once tripped, the throttle decision itself logs (login_throttled with retryAfter), ip/email redacted', () => {
		const ip = '203.0.113.10';
		const email = 'throttled@example.com';

		// Under the limit: no wait, no throttle line.
		expect(loginRetryAfter(ip, email)).toBeNull();
		expect(eventsNamed('login_throttled')).toHaveLength(0);

		for (let i = 0; i < 5; i++) noteLoginFailure(ip, email);
		captured.lines.length = 0;

		const wait = loginRetryAfter(ip, email);
		expect(wait).not.toBeNull();
		const throttled = eventsNamed('login_throttled');
		expect(throttled).toHaveLength(1);
		expect(pino.levels.labels[throttled[0].level as number]).toBe('warn');
		expect(throttled[0]).toMatchObject({ ip: '[redacted]', email: '[redacted]', retryAfter: wait });
		expect(allLoggedText()).not.toContain(ip);
	});
});

describe('failed WebAuthn verification (webauthn.ts)', () => {
	// A full passkey ceremony needs a real authenticator; a malformed assertion
	// (garbage clientDataJSON) is the reachable failure path — the library throws,
	// and verifyAuthentication must log passkey_login_error before rethrowing.
	it('a malformed passkey assertion logs a security warn with the (non-redacted) credential id', async () => {
		const event = {
			url: new URL('https://cairn.test/api/auth/passkey/verify')
		} as unknown as RequestEvent;

		const bogusResponse = {
			id: 'bogus-cred-id',
			rawId: 'bogus-cred-id',
			type: 'public-key',
			clientExtensionResults: {},
			response: {
				clientDataJSON: '%%%not-base64url%%%',
				authenticatorData: '',
				signature: ''
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;

		const credential: WebAuthnCredential = {
			id: 'bogus-cred-id',
			publicKey: new Uint8Array([1, 2, 3, 4]),
			counter: 0,
			transports: []
		};

		await expect(
			verifyAuthentication(event, bogusResponse, 'expected-challenge', credential)
		).rejects.toThrow();

		const errors = eventsNamed('passkey_login_error');
		expect(errors).toHaveLength(1);
		expect(pino.levels.labels[errors[0].level as number]).toBe('warn');
		// credentialId is NOT in REDACT_KEYS — it identifies a device, not a
		// person, and is needed for triage, so it stays plain.
		expect(errors[0]).toMatchObject({ credentialId: 'bogus-cred-id' });
		// The ceremony challenge is a secret-ish one-time value — it must not be logged.
		expect(allLoggedText()).not.toContain('expected-challenge');
	});
});
