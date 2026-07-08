// cairn-j1q9: the public "reclaim by email" branch of registration is gone.
// A POST against a credential-less (restored-shape) account's email must now
// hit the exact same path a normal duplicate-email signup attempt would —
// the registration-mode/email-taken gate in assertCanRegister — instead of
// silently starting a passkey ceremony that would take the account over.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { POST } from './+server';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM invites;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeCookies() {
	const jar: Record<string, string> = {};
	return {
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			delete jar[name];
		}
	};
}

function event(body: Record<string, unknown>): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/auth/register/options', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/register/options'),
		getClientAddress: () => '10.0.0.1',
		cookies: makeCookies(),
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
}

async function post(body: Record<string, unknown>) {
	const res = await POST(event(body));
	return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string; code?: string } | null };
}

describe('POST /api/auth/register/options — public reclaim path removed', () => {
	it('a credential-less (restored-shape) account is NOT reclaimable — email_taken, no options returned', async () => {
		// First user becomes admin so the target account below isn't the admin
		// slot; it is left credential-less and passwordless, exactly the shape a
		// backup restore produces (and exactly what the old reclaim path targeted).
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const restored = await registerUser({ email: 'restored@example.com', displayName: 'Restored' });

		const { status, body } = await post({
			email: 'restored@example.com',
			displayName: 'Attacker-supplied name'
		});

		// Hits the normal duplicate-email gate, same as any other already-used
		// email — no passkey-registration options are handed out for this account.
		expect(status).toBe(400);
		expect(body?.code).toBe('email_taken');
		expect(body).not.toHaveProperty('challenge');

		// Sanity: the account is untouched — still credential-less, still owned by
		// its original id, still not reachable via this route.
		const row = db.prepare('SELECT id FROM users WHERE email = ?').get('restored@example.com') as
			| { id: number }
			| undefined;
		expect(row?.id).toBe(restored.id);
	});

	it('a normal new email still gets registration options (the route is not broken)', async () => {
		await registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		const { status, body } = await post({ email: 'fresh@example.com', displayName: 'Fresh' });
		expect(status).toBe(200);
		expect(body).toHaveProperty('challenge');
	});
});
