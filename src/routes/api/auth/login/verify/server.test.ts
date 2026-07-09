// cairn-wukz: POST /api/auth/login/verify — passkey assertion verification.
//
// The property under test is CROSS-USER / CROSS-SESSION isolation: a challenge
// issued for one user (pending.userId) can never be spent with another user's
// credential. The route pins the credential's owner to the ceremony's user
// BEFORE any signature check — record.userId !== pending.userId is an immediate
// 'Unrecognized passkey', so a stolen/replayed assertion for account B can't
// open a session as A (or vice-versa). Also covered: unknown credential,
// disabled account, and a failed/negative verification never open a session.
//
// The WebAuthn signature check needs a real authenticator, so webauthn.ts is
// mocked; the credential rows and ownership are real DB state.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const wa = vi.hoisted(() => ({
	pending: null as null | { challenge: string; userId: number },
	verifyResult: null as unknown,
	verifyThrows: null as unknown
}));

vi.mock('$lib/server/webauthn', () => ({
	readAuthChallenge: () => wa.pending,
	clearAuthChallenge: () => {},
	verifyAuthentication: async () => {
		if (wa.verifyThrows) throw wa.verifyThrows;
		return wa.verifyResult;
	}
}));

import { db } from '$lib/server/db';
import { registerUser, addCredential, getSessionUser, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { POST } from './+server';

function wipe(): void {
	db.exec('DELETE FROM user_credentials; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

/** A verified authentication result with a bumped replay counter. */
const VERIFIED = { verified: true, authenticationInfo: { newCounter: 5 } };

let userA: { id: number };
let userB: { id: number };

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userA = await registerUser({ email: 'a@example.com', displayName: 'A' });
	userB = await registerUser({ email: 'b@example.com', displayName: 'B' });
	addCredential(userA.id, { credentialId: 'cred-A', publicKey: new Uint8Array([1, 1, 1]), counter: 0 });
	addCredential(userB.id, { credentialId: 'cred-B', publicKey: new Uint8Array([2, 2, 2]), counter: 0 });
	wa.verifyResult = VERIFIED;
	wa.verifyThrows = null;
});

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
	const ev = {
		request: new Request('http://localhost/api/auth/login/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/login/verify'),
		getClientAddress: () => `10.0.3.${Math.floor(Math.random() * 250) + 1}`,
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
		body: (await res.json().catch(() => null)) as { error?: string; user?: { id: number } } | null,
		jar
	};
}

describe('POST /api/auth/login/verify — cross-user isolation', () => {
	it("rejects user B's credential against a challenge issued for user A (no session for either)", async () => {
		wa.pending = { challenge: 'chal', userId: userA.id };
		const { status, body, jar } = await post({ response: { id: 'cred-B' } });
		expect(status).toBe(400);
		expect(body?.error).toMatch(/unrecognized passkey/i);
		expect(jar[SESSION_COOKIE]).toBeUndefined();
	});

	it("the symmetric case is rejected too: user A's credential against user B's challenge", async () => {
		wa.pending = { challenge: 'chal', userId: userB.id };
		const { status, body } = await post({ response: { id: 'cred-A' } });
		expect(status).toBe(400);
		expect(body?.error).toMatch(/unrecognized passkey/i);
	});

	it('the matching owner+challenge pair verifies and opens a session for exactly that user', async () => {
		wa.pending = { challenge: 'chal', userId: userA.id };
		const { status, body, jar } = await post({ response: { id: 'cred-A' } });
		expect(status).toBe(200);
		expect(body?.user?.id).toBe(userA.id);
		expect(getSessionUser(jar[SESSION_COOKIE])?.id).toBe(userA.id);
		// The replay counter was advanced to the verified value.
		const row = db.prepare('SELECT counter FROM user_credentials WHERE credential_id = ?').get('cred-A') as { counter: number };
		expect(row.counter).toBe(5);
	});
});

describe('POST /api/auth/login/verify — other rejections never open a session', () => {
	it('an unknown credential id is an Unrecognized passkey 400', async () => {
		wa.pending = { challenge: 'chal', userId: userA.id };
		const { status, body, jar } = await post({ response: { id: 'cred-does-not-exist' } });
		expect(status).toBe(400);
		expect(body?.error).toMatch(/unrecognized passkey/i);
		expect(jar[SESSION_COOKIE]).toBeUndefined();
	});

	it('a disabled account is rejected 403 even with a matching credential + challenge', async () => {
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userA.id);
		wa.pending = { challenge: 'chal', userId: userA.id };
		const { status, body, jar } = await post({ response: { id: 'cred-A' } });
		expect(status).toBe(403);
		expect(body?.error).toMatch(/disabled/i);
		expect(jar[SESSION_COOKIE]).toBeUndefined();
	});

	it('a negative (unverified) assertion is a 400 with no session and no counter bump', async () => {
		wa.verifyResult = { verified: false, authenticationInfo: { newCounter: 99 } };
		wa.pending = { challenge: 'chal', userId: userA.id };
		const { status, jar } = await post({ response: { id: 'cred-A' } });
		expect(status).toBe(400);
		expect(jar[SESSION_COOKIE]).toBeUndefined();
		const row = db.prepare('SELECT counter FROM user_credentials WHERE credential_id = ?').get('cred-A') as { counter: number };
		expect(row.counter).toBe(0); // untouched
	});

	it('an absent challenge is rejected 400 before any credential lookup', async () => {
		wa.pending = null;
		const { status, body } = await post({ response: { id: 'cred-A' } });
		expect(status).toBe(400);
		expect(body?.error).toMatch(/session expired/i);
	});
});
