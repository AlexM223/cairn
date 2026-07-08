// Tests for POST /api/auth/recover/password (cairn-nhfe): the second recovery
// completion path (set a new password) that exists so recovery never dead-ends
// when a passkey ceremony can't run (plain-HTTP Umbrel).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser, getSessionUser } from '$lib/server/auth';
import { createRecoveryGrant, peekRecoveryGrant, RECOVERY_GRANT_COOKIE } from '$lib/server/recovery';
import { POST } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM recovery_grants; DELETE FROM events;'
	);
}

beforeEach(wipe);

function registerAdmin() {
	return registerUser({ email: 'admin@example.com', displayName: 'Admin' });
}

/** A minimal in-memory cookie jar backing the same get/set/delete shape the
 *  route handler uses. */
function makeCookies(initial: Record<string, string> = {}) {
	const jar: Record<string, string> = { ...initial };
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

function event(body: Record<string, unknown>, grantToken?: string): Parameters<typeof POST>[0] {
	const cookies = makeCookies(grantToken ? { [RECOVERY_GRANT_COOKIE]: grantToken } : {});
	return {
		request: new Request('http://localhost/api/auth/recover/password', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/recover/password'),
		getClientAddress: () => '10.0.0.1',
		cookies,
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
}

async function post(body: Record<string, unknown>, grantToken?: string) {
	const ev = event(body, grantToken);
	const res = await POST(ev);
	return {
		status: res.status,
		body: (await res.json().catch(() => null)) as { error?: string; code?: string; user?: { id: number } } | null,
		cookies: (ev.cookies as unknown as { jar: Record<string, string> }).jar
	};
}

describe('POST /api/auth/recover/password', () => {
	it('a weak password 400s WITHOUT consuming the grant (order matters)', async () => {
		const admin = registerAdmin();
		const { token } = createRecoveryGrant(admin.id);

		const { status, body } = await post({ password: 'short' }, token);
		expect(status).toBe(400);
		expect(body?.code).toBe('weak_password');

		// The grant must still be alive — a weak-password attempt must not burn it.
		expect(peekRecoveryGrant(token)?.userId).toBe(admin.id);
	});

	it('sets the password, consumes the grant, and starts a real session', async () => {
		const admin = registerAdmin();
		const { token } = createRecoveryGrant(admin.id);

		const { status, body, cookies } = await post({ password: 'a whole new password' }, token);
		expect(status).toBe(200);
		expect(body?.user?.id).toBe(admin.id);

		// Grant is single-use: gone after success.
		expect(peekRecoveryGrant(token)).toBeNull();
		expect(cookies[RECOVERY_GRANT_COOKIE]).toBeUndefined();

		// A real session cookie was set and resolves to the user.
		const sessionToken = cookies['cairn_session'];
		expect(sessionToken).toBeTruthy();
		expect(getSessionUser(sessionToken)?.id).toBe(admin.id);

		// The password actually changed (a login with it would work) — checked
		// indirectly via the hash changing from null.
		const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id) as {
			password_hash: string | null;
		};
		expect(row.password_hash).toBeTruthy();
	});

	it('an absent/unknown/expired grant 400s with the same "session expired" message the passkey path uses', async () => {
		const noGrant = await post({ password: 'a whole new password' });
		expect(noGrant.status).toBe(400);
		expect(noGrant.body?.error).toMatch(/session expired/i);

		const bogus = await post({ password: 'a whole new password' }, 'not-a-real-token');
		expect(bogus.status).toBe(400);
		expect(bogus.body?.error).toMatch(/session expired/i);
	});

	it('a grant is single-use: a second completion attempt with the same token fails', async () => {
		const admin = registerAdmin();
		const { token } = createRecoveryGrant(admin.id);

		const first = await post({ password: 'first new password' }, token);
		expect(first.status).toBe(200);

		const second = await post({ password: 'second new password' }, token);
		expect(second.status).toBe(400);
		expect(second.body?.error).toMatch(/session expired/i);
	});

	it('racing the password path against the passkey path: whichever consumes the grant first wins', async () => {
		// Simulates the race the spec calls out: two completion paths sharing one
		// grant. consumeRecoveryGrant's DELETE...WHERE guard means only the first
		// caller can ever win, regardless of which path it is.
		const admin = registerAdmin();
		const { token } = createRecoveryGrant(admin.id);

		const winner = await post({ password: 'winner password' }, token);
		expect(winner.status).toBe(200);

		// The "passkey path" losing the race is modeled directly against the same
		// primitive the register/verify route uses.
		const { consumeRecoveryGrant } = await import('$lib/server/recovery');
		expect(consumeRecoveryGrant(token)).toBeNull();
	});
});
