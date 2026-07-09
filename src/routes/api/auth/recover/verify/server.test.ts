// cairn-wukz: POST /api/auth/recover/verify — account-recovery verification.
//
// The property under test is ANTI-ENUMERATION: the response for an unknown
// email, a wrong phrase, and a wrong code must be indistinguishable in SHAPE —
// same HTTP status, same generic JSON body, no grant cookie — so an attacker
// can't use this route as an oracle for "does this account exist / use recovery".
// (We assert the response contract, not wall-clock timing; the constant-time
// scrypt/dummyVerify work that backs the timing guarantee is unit-tested in the
// recovery module.)
//
// A correct phrase or code, by contrast, returns 200 with a recovery-grant
// cookie and only the display name — never anything the client didn't already
// send.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import {
	generateRecoveryCodes,
	generateRecoveryPhrase,
	RECOVERY_GRANT_COOKIE
} from '$lib/server/recovery';
import { POST } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM recovery_grants; DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; DELETE FROM events;'
	);
}

// Distinct ip per request so the 5/hour recovery limiter (module-level, per ip
// AND per email) never couples independent test cases.
let ipSeq = 0;

beforeEach(wipe);

function makeCookies() {
	const jar: Record<string, string> = {};
	return {
		jar,
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			delete jar[name];
		}
	};
}

function event(body: Record<string, unknown>): { ev: Parameters<typeof POST>[0]; jar: Record<string, string> } {
	const cookies = makeCookies();
	const ip = `10.0.1.${++ipSeq}`;
	const ev = {
		request: new Request('http://localhost/api/auth/recover/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/recover/verify'),
		getClientAddress: () => ip,
		cookies,
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
	return { ev, jar: cookies.jar };
}

async function post(body: Record<string, unknown>) {
	const { ev, jar } = event(body);
	const res = await POST(ev);
	return {
		status: res.status,
		body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
		jar
	};
}

/** Register an account WITH recovery secrets set up; returns the plaintext. */
async function accountWithRecovery(email: string) {
	const user = await registerUser({ email, displayName: 'Recoverable' });
	const phraseGen = generateRecoveryPhrase();
	await phraseGen.store(user.id);
	const codesGen = generateRecoveryCodes();
	await codesGen.store(user.id);
	return { user, phrase: phraseGen.phrase, codes: codesGen.codes };
}

describe('POST /api/auth/recover/verify — anti-enumeration response contract', () => {
	it('an unknown email and a wrong code on a REAL account return the identical 401 shape', async () => {
		await accountWithRecovery('real@example.com');

		const unknown = await post({ email: 'ghost@example.com', code: 'ZZZZZ-ZZZZZ' });
		const wrong = await post({ email: 'real@example.com', code: 'ZZZZZ-ZZZZZ' });

		// Same status.
		expect(unknown.status).toBe(401);
		expect(wrong.status).toBe(401);
		// Byte-identical body (the single generic failure message, nothing else).
		expect(unknown.body).toEqual(wrong.body);
		expect(Object.keys(unknown.body ?? {})).toEqual(['error']);
		// Neither path leaks a grant cookie.
		expect(unknown.jar[RECOVERY_GRANT_COOKIE]).toBeUndefined();
		expect(wrong.jar[RECOVERY_GRANT_COOKIE]).toBeUndefined();
	});

	it('a wrong phrase on a real account matches the unknown-email shape too', async () => {
		await accountWithRecovery('real2@example.com');
		const unknown = await post({ email: 'nobody@example.com', phrase: 'these words are all wrong indeed friend today' });
		const wrong = await post({ email: 'real2@example.com', phrase: 'these words are all wrong indeed friend today' });
		expect(unknown.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(unknown.body).toEqual(wrong.body);
	});

	it('supplying neither secret, or BOTH, is a generic 400 regardless of whether the account exists', async () => {
		await accountWithRecovery('real3@example.com');

		const neitherReal = await post({ email: 'real3@example.com' });
		const neitherGhost = await post({ email: 'ghost@example.com' });
		const bothReal = await post({ email: 'real3@example.com', phrase: 'x', code: 'y' });

		expect(neitherReal.status).toBe(400);
		expect(neitherGhost.status).toBe(400);
		expect(bothReal.status).toBe(400);
		// Same generic body across all of them — no signal about the account.
		expect(neitherReal.body).toEqual(neitherGhost.body);
		expect(bothReal.body).toEqual(neitherGhost.body);
	});
});

describe('POST /api/auth/recover/verify — successful recovery', () => {
	it('a correct one-time code returns 200, sets the grant cookie, and leaks only the display name', async () => {
		const { codes } = await accountWithRecovery('coded@example.com');
		const { status, body, jar } = await post({ email: 'coded@example.com', code: codes[0] });

		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, user: { email: 'coded@example.com', displayName: 'Recoverable' } });
		expect(body).toHaveProperty('grantExpiresAt');
		// A grant cookie was set (authorizes only a new-passkey ceremony).
		expect(jar[RECOVERY_GRANT_COOKIE]).toBeTruthy();
		// The user object is exactly {email, displayName} — no id, hash, or internals.
		expect(Object.keys((body as { user: object }).user)).toEqual(['email', 'displayName']);
	});

	it('a correct code is single-use: replaying it returns the generic failure', async () => {
		const { codes } = await accountWithRecovery('once@example.com');
		const first = await post({ email: 'once@example.com', code: codes[0] });
		expect(first.status).toBe(200);

		const replay = await post({ email: 'once@example.com', code: codes[0] });
		expect(replay.status).toBe(401);
		expect(replay.jar[RECOVERY_GRANT_COOKIE]).toBeUndefined();
	});

	it('a correct recovery phrase returns 200 and is reusable (not consumed)', async () => {
		const { phrase } = await accountWithRecovery('phrased@example.com');
		const first = await post({ email: 'phrased@example.com', phrase });
		expect(first.status).toBe(200);
		expect(first.jar[RECOVERY_GRANT_COOKIE]).toBeTruthy();

		// A phrase is not burned on use — a second correct submission still works.
		const second = await post({ email: 'phrased@example.com', phrase });
		expect(second.status).toBe(200);
	});
});

describe('POST /api/auth/recover/verify — rate limiting', () => {
	it('caps attempts on one ip/email pair and 429s past the limit', async () => {
		await accountWithRecovery('spammed@example.com');
		// Fix the ip so the limiter accumulates against one bucket.
		const fixedIp = '10.9.9.9';
		function fixedEvent(body: Record<string, unknown>) {
			const cookies = makeCookies();
			return {
				request: new Request('http://localhost/api/auth/recover/verify', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				}),
				url: new URL('http://localhost/api/auth/recover/verify'),
				getClientAddress: () => fixedIp,
				cookies,
				locals: {}
			} as unknown as Parameters<typeof POST>[0];
		}
		let last = 0;
		for (let i = 0; i < 6; i++) {
			const res = await POST(fixedEvent({ email: 'spammed@example.com', code: 'WRONG-WRONG' }));
			last = res.status;
		}
		expect(last).toBe(429);
	});
});
