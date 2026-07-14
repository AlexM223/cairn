// cairn-x7vk: webauthn.ts (WebAuthn/passkey ceremony helpers) was ~5% tested
// — only the throw path was exercised indirectly, via a malformed response fed
// to the real @simplewebauthn/server library (security-logging.test.ts). No
// test anywhere drives webauthn.ts's own logic: which arguments it hands the
// library, origin/RPID binding, or the challenge-cookie lifecycle. Every
// existing route test (e.g. login/verify/server.test.ts) mocks
// `$lib/server/webauthn` WHOLESALE, so webauthn.ts's own code never runs.
//
// This file mocks `@simplewebauthn/server` (the layer BELOW webauthn.ts)
// instead, so webauthn.ts's real code executes and we can assert on:
//   1. Origin/RPID binding (getRp / verifyRegistration / verifyAuthentication)
//      — CAIRN_ORIGIN/CAIRN_RP_ID env override vs. request-derived defaults,
//      and that a library-side origin mismatch (phishing) propagates cleanly.
//   2. Counter-replay plumbing — the STORED counter (from getCredentialForAuth)
//      is the exact `credential.counter` handed to verifyAuthenticationResponse,
//      and a library-thrown replay/counter-regression rejection rethrows
//      unmodified rather than being swallowed.
//   3. Challenge-cookie lifecycle — set/read round-trips, a cleared challenge
//      reads back null (the single-use mechanism the calling routes rely on),
//      and a malformed cookie value fails closed to null rather than throwing.
//   4. notifyNewPasskey — the "was this you?" alert, including the viaRecovery
//      severity bump.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const swa = vi.hoisted(() => ({
	verifyRegistrationResponse: vi.fn(),
	verifyAuthenticationResponse: vi.fn(),
	generateRegistrationOptions: vi.fn(async (opts: unknown) => opts),
	generateAuthenticationOptions: vi.fn(async (opts: unknown) => opts)
}));

vi.mock('@simplewebauthn/server', () => swa);

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock('./notifications', () => ({ notify: notifyMock }));

import {
	getRp,
	verifyRegistration,
	verifyAuthentication,
	setRegChallenge,
	readRegChallenge,
	clearRegChallenge,
	setAuthChallenge,
	readAuthChallenge,
	clearAuthChallenge,
	notifyNewPasskey
} from './webauthn';

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.CAIRN_ORIGIN;
	delete process.env.CAIRN_RP_ID;
	// src/tests/setup.ts sets a default CAIRN_ORIGIN for the whole suite —
	// clear it here so getRp's request-derived fallback is actually exercised
	// by tests in this file that need it, and restore it isn't needed since
	// other files re-set what they need in their own beforeEach.
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(url = 'https://cairn.example.org/some/page'): any {
	return { url: new URL(url) };
}

describe('getRp — origin/RPID binding (cairn-x7vk)', () => {
	it('derives rpID and origin from the request URL when no env override is set', () => {
		const rp = getRp(makeEvent('https://wallet.example.org:8443/settings'));
		expect(rp.rpID).toBe('wallet.example.org');
		expect(rp.origin).toBe('https://wallet.example.org:8443');
	});

	it('CAIRN_ORIGIN/CAIRN_RP_ID env vars override the request-derived values (reverse-proxy deployments)', () => {
		process.env.CAIRN_ORIGIN = 'https://public.example.com';
		process.env.CAIRN_RP_ID = 'public.example.com';
		const rp = getRp(makeEvent('http://127.0.0.1:3000/settings'));
		expect(rp.rpID).toBe('public.example.com');
		expect(rp.origin).toBe('https://public.example.com');
	});
});

describe('verifyRegistration / verifyAuthentication — the exact origin/RPID reach the library (anti-phishing)', () => {
	it('verifyRegistration passes expectedOrigin/expectedRPID from getRp(), not the raw event URL, when CAIRN_ORIGIN overrides', async () => {
		process.env.CAIRN_ORIGIN = 'https://trusted.example.org';
		process.env.CAIRN_RP_ID = 'trusted.example.org';
		swa.verifyRegistrationResponse.mockResolvedValue({ verified: true });

		await verifyRegistration(
			makeEvent('https://attacker.example.net/phish'),
			{ id: 'cred-1' } as never,
			'chal-1'
		);

		expect(swa.verifyRegistrationResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedOrigin: 'https://trusted.example.org',
				expectedRPID: 'trusted.example.org',
				expectedChallenge: 'chal-1'
			})
		);
	});

	it('verifyAuthentication rethrows (does not swallow) a library-side origin-mismatch rejection — the actual anti-phishing enforcement lives in the library, and webauthn.ts must not hide its failure', async () => {
		const originMismatch = new Error('Unexpected authentication response origin');
		swa.verifyAuthenticationResponse.mockRejectedValue(originMismatch);

		await expect(
			verifyAuthentication(
				makeEvent(),
				{ id: 'cred-1' } as never,
				'chal-1',
				{ id: 'cred-1', publicKey: new Uint8Array([1]), counter: 3 } as never
			)
		).rejects.toThrow('Unexpected authentication response origin');
	});
});

describe('counter-replay plumbing — the STORED counter is what reaches the library (cairn-x7vk)', () => {
	it('verifyAuthentication forwards the credential object (including its counter) UNCHANGED to verifyAuthenticationResponse', async () => {
		swa.verifyAuthenticationResponse.mockResolvedValue({
			verified: true,
			authenticationInfo: { newCounter: 42 }
		});
		const storedCredential = {
			id: 'cred-9',
			publicKey: new Uint8Array([9, 9, 9]),
			counter: 41 // this is what getCredentialForAuth would have read from the DB
		};

		await verifyAuthentication(makeEvent(), { id: 'cred-9' } as never, 'chal-9', storedCredential as never);

		expect(swa.verifyAuthenticationResponse).toHaveBeenCalledWith(
			expect.objectContaining({ credential: storedCredential })
		);
		// The stored counter specifically — a caller that accidentally passed a
		// fresh/zeroed counter instead of the persisted one would defeat replay
		// protection entirely (the library trusts the counter it's handed).
		const call = swa.verifyAuthenticationResponse.mock.calls[0][0] as { credential: { counter: number } };
		expect(call.credential.counter).toBe(41);
	});

	it('a library-thrown counter-regression (replay) rejection propagates cleanly out of verifyAuthentication, not swallowed into a false-positive verified result', async () => {
		const replayError = new Error('Response counter was not greater than credential counter');
		swa.verifyAuthenticationResponse.mockRejectedValue(replayError);

		await expect(
			verifyAuthentication(
				makeEvent(),
				{ id: 'cred-9' } as never,
				'chal-9',
				{ id: 'cred-9', publicKey: new Uint8Array([9]), counter: 41 } as never
			)
		).rejects.toBe(replayError);
	});

	it('verifyAuthenticationResponse resolving with verified:false (e.g. a signature the library itself rejects) is returned as-is, never coerced to true', async () => {
		swa.verifyAuthenticationResponse.mockResolvedValue({
			verified: false,
			authenticationInfo: { newCounter: 41 }
		});
		const result = await verifyAuthentication(
			makeEvent(),
			{ id: 'cred-9' } as never,
			'chal-9',
			{ id: 'cred-9', publicKey: new Uint8Array([9]), counter: 41 } as never
		);
		expect(result.verified).toBe(false);
	});
});

describe('challenge-cookie lifecycle — set/read/clear round-trip and fail-closed parsing', () => {
	function makeCookieJar(initial: Record<string, string> = {}) {
		const store = new Map(Object.entries(initial));
		return {
			get: (name: string) => store.get(name),
			set: (name: string, value: string) => {
				store.set(name, value);
			},
			delete: (name: string) => {
				store.delete(name);
			}
		} as unknown as Cookies;
	}

	it('setAuthChallenge -> readAuthChallenge round-trips the exact data written', () => {
		const cookies = makeCookieJar();
		const event = { ...makeEvent(), cookies };
		setAuthChallenge(event, { challenge: 'c-1', userId: 7 });
		expect(readAuthChallenge(event)).toEqual({ challenge: 'c-1', userId: 7 });
	});

	it('clearAuthChallenge makes a subsequent read return null — this is the single-use mechanism every login route relies on', () => {
		const cookies = makeCookieJar();
		const event = { ...makeEvent(), cookies };
		setAuthChallenge(event, { challenge: 'c-1', userId: 7 });
		clearAuthChallenge(event);
		expect(readAuthChallenge(event)).toBeNull();
	});

	it('FIXED (cairn-ixnv): reading the challenge consumes it atomically — a second read before any explicit clearAuthChallenge() returns null, not the same challenge again', () => {
		// readAuthChallenge() used to have no consume-once guard of its own;
		// single-use was purely the calling route's discipline (every real call
		// site happened to call clearAuthChallenge() immediately after reading).
		// A future route that read the challenge without clearing it would have
		// silently reopened a replay window. readAuthChallenge() now clears the
		// cookie as part of the read itself, so that footgun is gone.
		const cookies = makeCookieJar();
		const event = { ...makeEvent(), cookies };
		setAuthChallenge(event, { challenge: 'c-replay', userId: 7 });
		const first = readAuthChallenge(event);
		const second = readAuthChallenge(event);
		expect(first).toEqual({ challenge: 'c-replay', userId: 7 });
		expect(second).toBeNull();
	});

	it('a malformed (non-JSON) cookie value fails closed to null rather than throwing', () => {
		const cookies = makeCookieJar({ cairn_wa_auth: '{not json' });
		const event = { ...makeEvent(), cookies };
		expect(() => readAuthChallenge(event)).not.toThrow();
		expect(readAuthChallenge(event)).toBeNull();
	});

	it('an absent cookie reads as null, not a throw', () => {
		const cookies = makeCookieJar();
		const event = { ...makeEvent(), cookies };
		expect(readAuthChallenge(event)).toBeNull();
		expect(readRegChallenge(event)).toBeNull();
	});

	it('registration challenges use a SEPARATE cookie from auth challenges — clearing one never touches the other', () => {
		const cookies = makeCookieJar();
		const event = { ...makeEvent(), cookies };
		setRegChallenge(event, { challenge: 'reg-1', email: 'a@example.com', displayName: 'A' });
		setAuthChallenge(event, { challenge: 'auth-1', userId: 3 });
		clearRegChallenge(event);
		expect(readRegChallenge(event)).toBeNull();
		expect(readAuthChallenge(event)).toEqual({ challenge: 'auth-1', userId: 3 });
	});
});

describe('notifyNewPasskey — "was this you?" takeover alert', () => {
	it('a routine add (viaRecovery unset) notifies at info level with the routine copy', () => {
		notifyNewPasskey(11, { name: 'My YubiKey' });
		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'security_new_passkey',
				userId: 11,
				level: 'info',
				title: 'New passkey added',
				body: expect.stringContaining('"My YubiKey" was added')
			})
		);
	});

	it('a recovery-flow add (viaRecovery: true) bumps to warn level with account-takeover copy — the higher-signal case', () => {
		notifyNewPasskey(11, { viaRecovery: true });
		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'warn',
				title: 'Account recovered with a new passkey',
				body: expect.stringContaining('registered to your account during account recovery'),
				detail: { viaRecovery: true }
			})
		);
	});

	it('an unnamed passkey falls back to generic "A new passkey" copy rather than an empty/undefined name', () => {
		notifyNewPasskey(11, {});
		const call = notifyMock.mock.calls[0][0] as { body: string };
		expect(call.body).toContain('A new passkey was added');
	});
});
