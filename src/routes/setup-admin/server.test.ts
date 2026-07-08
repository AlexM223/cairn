// cairn-49xi.2 — the forced first-login credential reset for bootstrap-created
// admins. Covers the route's own gating (signed-out → /login, no-flag → /),
// the happy path (flag cleared, email+password replaced, sessions rotated,
// redirect home), and the failure paths staying ON the page as 400 fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '$lib/server/db';
import {
	bootstrapAdminFromEnv,
	mustResetPassword,
	getUserByEmail,
	loginWithPassword,
	createSession,
	getSessionUser,
	BOOTSTRAP_PLACEHOLDER_EMAIL
} from '$lib/server/auth';
import type { SessionUser } from '$lib/types';
import { actions, load } from './+page.server';

const ENV_KEYS = ['CAIRN_ADMIN_PASSWORD', 'CAIRN_ADMIN_EMAIL', 'APP_PASSWORD'] as const;
let saved: Record<string, string | undefined>;

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function bootstrapAdmin(): Promise<SessionUser> {
	process.env.CAIRN_ADMIN_PASSWORD = 'generated-install-pw';
	await bootstrapAdminFromEnv();
	return getUserByEmail(BOOTSTRAP_PLACEHOLDER_EMAIL)!;
}

/** Minimal RequestEvent for invoking load/actions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: SessionUser | null, fields: Record<string, string> = {}): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const setCookies: { name: string; value: string }[] = [];
	return {
		locals: { user },
		request: new Request('http://localhost/setup-admin?/complete', {
			method: 'POST',
			body,
			headers: { 'user-agent': 'vitest' }
		}),
		cookies: {
			set: (name: string, value: string) => setCookies.push({ name, value })
		},
		getClientAddress: () => '203.0.113.7',
		params: {},
		url: new URL('http://localhost/setup-admin'),
		setCookies
	};
}

async function expectThrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

describe('/setup-admin load', () => {
	it('redirects a signed-out request to /login', async () => {
		const thrown = await expectThrown(() => load(makeEvent(null)));
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
	});

	it('redirects home when no reset is pending (normal accounts, or already done)', async () => {
		const admin = await bootstrapAdmin();
		db.prepare('UPDATE users SET must_reset_password = 0 WHERE id = ?').run(admin.id);
		const thrown = await expectThrown(() => load(makeEvent(admin)));
		expect(thrown).toMatchObject({ status: 302, location: '/' });
	});

	it('serves the page while the reset is pending, without prefilling the placeholder email', async () => {
		const admin = await bootstrapAdmin();
		const data = (await load(makeEvent(admin))) as { currentEmail: string };
		expect(data.currentEmail).toBe('');
	});

	it('prefills a real bootstrap email (CAIRN_ADMIN_EMAIL was set)', async () => {
		process.env.CAIRN_ADMIN_PASSWORD = 'generated-install-pw';
		process.env.CAIRN_ADMIN_EMAIL = 'operator@example.com';
		await bootstrapAdminFromEnv();
		const admin = getUserByEmail('operator@example.com')!;
		const data = (await load(makeEvent(admin))) as { currentEmail: string };
		expect(data.currentEmail).toBe('operator@example.com');
	});
});

describe('/setup-admin ?/complete', () => {
	it('clears the flag, replaces email + password, rotates sessions, and redirects home', async () => {
		const admin = await bootstrapAdmin();
		// A pre-existing session — e.g. someone else who read the install card.
		const { token: oldToken } = createSession(admin.id);
		expect(getSessionUser(oldToken)?.id).toBe(admin.id);

		const event = makeEvent(admin, {
			email: 'Real@Example.com',
			password: 'chosen-by-human',
			confirm: 'chosen-by-human'
		});
		const thrown = await expectThrown(() => actions.complete(event));
		expect(thrown).toMatchObject({ status: 303, location: '/' });

		expect(mustResetPassword(admin.id)).toBe(false);
		expect((await loginWithPassword('real@example.com', 'chosen-by-human')).id).toBe(admin.id);
		// Every session opened with the generated password is dead…
		expect(getSessionUser(oldToken)).toBeNull();
		// …and a fresh one was set for THIS browser so the user lands signed in.
		expect(event.setCookies.some((c: { name: string }) => c.name === 'cairn_session')).toBe(true);
	});

	it('fails 400 when the passwords do not match, leaving the flag up', async () => {
		const admin = await bootstrapAdmin();
		const res = await actions.complete(
			makeEvent(admin, { email: 'real@example.com', password: 'chosen-by-human', confirm: 'different' })
		);
		expect(res).toMatchObject({ status: 400 });
		expect(mustResetPassword(admin.id)).toBe(true);
	});

	it('fails 400 on a validation error from completeForcedCredentialReset (placeholder email)', async () => {
		const admin = await bootstrapAdmin();
		const res = await actions.complete(
			makeEvent(admin, {
				email: BOOTSTRAP_PLACEHOLDER_EMAIL,
				password: 'chosen-by-human',
				confirm: 'chosen-by-human'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(mustResetPassword(admin.id)).toBe(true);
	});

	it('fails 400 when trying to keep the generated install password', async () => {
		const admin = await bootstrapAdmin();
		const res = await actions.complete(
			makeEvent(admin, {
				email: 'real@example.com',
				password: 'generated-install-pw',
				confirm: 'generated-install-pw'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(mustResetPassword(admin.id)).toBe(true);
	});

	it('redirects a signed-out request to /login', async () => {
		const thrown = await expectThrown(() => actions.complete(makeEvent(null)));
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
	});
});
