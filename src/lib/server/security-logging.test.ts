// cairn-1cl9 — pins the security-event logging added for cairn-wbmu (commit
// d56e77f, auth.ts / rateLimit.ts / webauthn.ts): failed password logins,
// rate-limit trips, and failed passkey verifications must emit 'security'-tagged
// log lines with triage context (email/ip) — and must NEVER log the password.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { WebAuthnCredential } from '@simplewebauthn/server';

// The modules under test bind `const log = childLogger('security')` at import
// time, so the logger mock must be registered before they load — vi.mock is
// hoisted above the imports below, and the shared capture array is vi.hoisted.
const captured = vi.hoisted(() => {
	const calls: { tag: string; level: string; args: unknown[] }[] = [];
	return { calls };
});

vi.mock('./logger', () => {
	function makeLogger(tag: string) {
		const emit =
			(level: string) =>
			(...args: unknown[]) => {
				captured.calls.push({ tag, level, args });
			};
		return {
			error: emit('error'),
			warn: emit('warn'),
			info: emit('info'),
			debug: emit('debug'),
			trace: emit('trace'),
			fatal: emit('fatal'),
			child: (bindings?: { tag?: string }) => makeLogger(bindings?.tag ?? tag),
			level: 'silent'
		};
	}
	return {
		logger: makeLogger('root'),
		childLogger: (tag: string) => makeLogger(tag),
		LOG_FILE: 'unused-in-tests.log',
		REDACT_OPTIONS: { paths: [], censor: '[redacted]' }
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
	captured.calls.length = 0;
});

function securityCalls(level?: string) {
	return captured.calls.filter((c) => c.tag === 'security' && (!level || c.level === level));
}

function eventsNamed(name: string) {
	return securityCalls().filter((c) => (c.args[0] as { event?: string })?.event === name);
}

/** Every argument ever passed to any log method, flattened to one string. */
function allLoggedText(): string {
	return JSON.stringify(captured.calls);
}

describe('failed password login (auth.ts)', () => {
	const RIGHT_PW = 'correct horse battery';
	const WRONG_PW = 'Tr0ub4dor&3-wrong';

	it('emits a security warn with the email — and never the password string', async () => {
		await registerUser({ email: 'victim@example.com', displayName: 'Victim', password: RIGHT_PW });
		captured.calls.length = 0; // drop the user_registered info line

		await expect(loginWithPassword('victim@example.com', WRONG_PW)).rejects.toThrowError(
			expect.objectContaining({ code: 'bad_credentials' })
		);

		const failed = eventsNamed('password_login_failed');
		expect(failed).toHaveLength(1);
		expect(failed[0].level).toBe('warn');
		expect(failed[0].args[0]).toMatchObject({
			event: 'password_login_failed',
			email: 'victim@example.com'
		});

		// The regression this pins: neither the guessed nor the real password may
		// appear ANYWHERE in the logged arguments.
		const text = allLoggedText();
		expect(text).not.toContain(WRONG_PW);
		expect(text).not.toContain(RIGHT_PW);
	});

	it('an unknown email still logs the failure (same event, no user leak beyond the email)', async () => {
		await expect(loginWithPassword('ghost@example.com', WRONG_PW)).rejects.toThrowError();
		const failed = eventsNamed('password_login_failed');
		expect(failed).toHaveLength(1);
		expect(failed[0].args[0]).toMatchObject({ email: 'ghost@example.com' });
		expect(allLoggedText()).not.toContain(WRONG_PW);
	});

	it('a disabled account with the right password logs a denial (not silence)', async () => {
		const u = await registerUser({ email: 'off@example.com', displayName: 'Off', password: RIGHT_PW });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
		captured.calls.length = 0;

		await expect(loginWithPassword('off@example.com', RIGHT_PW)).rejects.toThrowError(
			expect.objectContaining({ code: 'disabled' })
		);
		const denied = eventsNamed('password_login_denied');
		expect(denied).toHaveLength(1);
		expect(denied[0].level).toBe('warn');
		expect(denied[0].args[0]).toMatchObject({ email: 'off@example.com', userId: u.id });
		expect(allLoggedText()).not.toContain(RIGHT_PW);
	});
});

describe('rate-limit trips (rateLimit.ts)', () => {
	// The limiter is module-level in-memory state that survives across tests in
	// this file, so each test uses its own ip/email.

	it('every failure logs; crossing the per-email threshold escalates to error exactly once', () => {
		const ip = '203.0.113.9';
		const email = 'stuffed@example.com'; // no such account → notify() path is skipped

		for (let i = 0; i < 5; i++) noteLoginFailure(ip, email);

		const failures = eventsNamed('login_failed');
		expect(failures).toHaveLength(5);
		expect(failures[0].level).toBe('warn');
		expect(failures[0].args[0]).toMatchObject({ ip, email });

		const crossings = eventsNamed('login_threshold_crossed');
		expect(crossings).toHaveLength(1);
		expect(crossings[0].level).toBe('error');
		expect(crossings[0].args[0]).toMatchObject({ ip, email, attempts: 5 });

		// A 6th failure in the same window must not re-fire the crossing alert.
		noteLoginFailure(ip, email);
		expect(eventsNamed('login_threshold_crossed')).toHaveLength(1);
	});

	it('once tripped, the throttle decision itself logs (login_throttled with retryAfter)', () => {
		const ip = '203.0.113.10';
		const email = 'throttled@example.com';

		// Under the limit: no wait, no throttle line.
		expect(loginRetryAfter(ip, email)).toBeNull();
		expect(eventsNamed('login_throttled')).toHaveLength(0);

		for (let i = 0; i < 5; i++) noteLoginFailure(ip, email);
		captured.calls.length = 0;

		const wait = loginRetryAfter(ip, email);
		expect(wait).not.toBeNull();
		const throttled = eventsNamed('login_throttled');
		expect(throttled).toHaveLength(1);
		expect(throttled[0].level).toBe('warn');
		expect(throttled[0].args[0]).toMatchObject({ ip, email, retryAfter: wait });
	});
});

describe('failed WebAuthn verification (webauthn.ts)', () => {
	// A full passkey ceremony needs a real authenticator; a malformed assertion
	// (garbage clientDataJSON) is the reachable failure path — the library throws,
	// and verifyAuthentication must log passkey_login_error before rethrowing.
	it('a malformed passkey assertion logs a security warn with the credential id', async () => {
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
		expect(errors[0].level).toBe('warn');
		expect(errors[0].args[0]).toMatchObject({ credentialId: 'bogus-cred-id' });
		// The ceremony challenge is a secret-ish one-time value — it must not be logged.
		expect(allLoggedText()).not.toContain('expected-challenge');
	});
});
