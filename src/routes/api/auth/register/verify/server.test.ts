// cairn-wukz: POST /api/auth/register/verify — passkey-signup completion.
//
// Two properties this route must hold, tested here:
//
//   1. Reclaim rejection (cairn-j1q9): this route only completes a SIGNUP
//      ceremony (a pending challenge with an email and NO userId). A challenge
//      that carries a userId is an ADD-passkey / reclaim context and must be
//      turned away here — completing it would attach an attacker's passkey to an
//      existing account. Same for an absent challenge or a missing response.
//
//   2. Atomic account creation (cairn-jlrb): the user row and its first passkey
//      are created inside one BEGIN/COMMIT. If the credential insert fails after
//      the user insert, the whole thing must ROLL BACK — never a user with no
//      way to sign in, nor a half-created account. An AuthError (e.g. a taken
//      email) surfaces as a typed 400 and creates nothing.
//
// The WebAuthn ceremony itself needs a real authenticator, so webauthn.ts is
// mocked: we drive the verified/failed/thrown outcomes directly and assert the
// route's account-creation behavior around them.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const wa = vi.hoisted(() => ({
	// The pending registration challenge readRegChallenge() returns.
	pending: null as
		| null
		| { challenge: string; email?: string; displayName?: string; userId?: number; inviteCode?: string },
	// What verifyRegistration() resolves to, or an error it throws.
	verifyResult: null as unknown,
	verifyThrows: null as unknown
}));

vi.mock('$lib/server/webauthn', () => ({
	readRegChallenge: () => wa.pending,
	clearRegChallenge: () => {},
	verifyRegistration: async () => {
		if (wa.verifyThrows) throw wa.verifyThrows;
		return wa.verifyResult;
	}
}));

import { db } from '$lib/server/db';
import { registerUser, addCredential, getSessionUser, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { POST } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM user_credentials; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM invites;'
	);
}

/** A verified-registration result carrying a given credential id. */
function verified(credentialId: string) {
	return {
		verified: true,
		registrationInfo: {
			credential: {
				id: credentialId,
				publicKey: new Uint8Array([1, 2, 3, 4]),
				counter: 0,
				transports: ['internal']
			},
			credentialDeviceType: 'singleDevice',
			credentialBackedUp: true
		}
	};
}

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	// First user becomes admin so the ceremonies below create ordinary members.
	await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
	wa.pending = { challenge: 'chal', email: 'new@example.com', displayName: 'New' };
	wa.verifyResult = verified('cred-new');
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
		request: new Request('http://localhost/api/auth/register/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/register/verify'),
		getClientAddress: () => '10.0.0.1',
		cookies,
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
	return { ev, jar: cookies.jar };
}

async function post(body: Record<string, unknown> = { response: { id: 'cred-new' }, name: 'My Key' }) {
	const { ev, jar } = event(body);
	const res = await POST(ev);
	return {
		status: res.status,
		body: (await res.json().catch(() => null)) as {
			error?: string;
			code?: string;
			user?: { id: number; email: string };
			next?: string;
		} | null,
		jar
	};
}

function userCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

describe('POST /api/auth/register/verify — reclaim rejection guard', () => {
	it('rejects a challenge that carries a userId (add-passkey/reclaim context) with a 400', async () => {
		wa.pending = { challenge: 'chal', email: 'victim@example.com', userId: 999 };
		const { status, body } = await post();
		expect(status).toBe(400);
		expect(body?.error).toMatch(/session expired/i);
		// Nothing was created for the targeted account.
		expect(userCount()).toBe(1); // just the admin
	});

	it('rejects an absent challenge with a 400 and creates nothing', async () => {
		wa.pending = null;
		const { status } = await post();
		expect(status).toBe(400);
		expect(userCount()).toBe(1);
	});

	it('rejects a challenge with no email (not a signup ceremony) with a 400', async () => {
		wa.pending = { challenge: 'chal' };
		const { status } = await post();
		expect(status).toBe(400);
		expect(userCount()).toBe(1);
	});

	it('rejects a request with no passkey response with a 400', async () => {
		const { status } = await post({ name: 'no response field' });
		expect(status).toBe(400);
		expect(userCount()).toBe(1);
	});
});

describe('POST /api/auth/register/verify — verification outcomes', () => {
	it('a thrown verification surfaces as a 400 and creates nothing', async () => {
		wa.verifyThrows = new Error('bad attestation');
		const { status, body } = await post();
		expect(status).toBe(400);
		expect(body?.error).toContain('bad attestation');
		expect(userCount()).toBe(1);
	});

	it('an unverified result is a 400 and creates nothing', async () => {
		wa.verifyResult = { verified: false, registrationInfo: null };
		const { status, body } = await post();
		expect(status).toBe(400);
		expect(body?.error).toMatch(/could not be verified/i);
		expect(userCount()).toBe(1);
	});
});

describe('POST /api/auth/register/verify — atomic account creation', () => {
	it('creates the account + first passkey and opens a session on success', async () => {
		const { status, body, jar } = await post();
		expect(status).toBe(201);
		expect(body?.user?.email).toBe('new@example.com');
		// Fresh signup is routed into the mandatory account-recovery setup.
		expect(body?.next).toBe('/recovery-setup');

		const newId = body!.user!.id;
		// The user AND its first credential both exist.
		expect(userCount()).toBe(2);
		const cred = db
			.prepare('SELECT user_id FROM user_credentials WHERE credential_id = ?')
			.get('cred-new') as { user_id: number } | undefined;
		expect(cred?.user_id).toBe(newId);

		// A real session cookie was set and resolves to the new user.
		const token = jar[SESSION_COOKIE];
		expect(token).toBeTruthy();
		expect(getSessionUser(token)?.id).toBe(newId);
	});

	it('rolls back completely when the credential insert fails — no orphaned user row', async () => {
		// Pre-seed a DIFFERENT account whose credential id collides with the one the
		// ceremony will try to insert. The user row inserts first, then addCredential
		// hits the UNIQUE(credential_id) constraint and throws AFTER the user insert —
		// the transaction must undo the user row.
		const other = await registerUser({ email: 'other@example.com', displayName: 'Other' });
		addCredential(other.id, { credentialId: 'dup-cred', publicKey: new Uint8Array([9]), counter: 0 });
		const before = userCount();

		wa.pending = { challenge: 'chal', email: 'fresh@example.com', displayName: 'Fresh' };
		wa.verifyResult = verified('dup-cred');

		const { status } = await post({ response: { id: 'dup-cred' } });
		expect(status).toBe(500);

		// The half-created 'fresh' user must NOT survive the rollback.
		expect(userCount()).toBe(before);
		expect(db.prepare('SELECT id FROM users WHERE email = ?').get('fresh@example.com')).toBeUndefined();
	});

	it('maps an AuthError (taken email) to a typed 400 and creates no second account', async () => {
		await registerUser({ email: 'taken@example.com', displayName: 'Taken' });
		const before = userCount();

		wa.pending = { challenge: 'chal', email: 'taken@example.com', displayName: 'Dupe' };
		wa.verifyResult = verified('cred-dupe-email');

		const { status, body } = await post({ response: { id: 'cred-dupe-email' } });
		expect(status).toBe(400);
		expect(body?.code).toBe('email_taken');
		expect(userCount()).toBe(before);
		// No stray credential either.
		expect(
			db.prepare('SELECT id FROM user_credentials WHERE credential_id = ?').get('cred-dupe-email')
		).toBeUndefined();
	});
});
