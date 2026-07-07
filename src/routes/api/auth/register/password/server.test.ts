// Regression tests for the password-registration route's invite handling:
//
// - cairn-zf3r (cairn-gy79): an invalid invite code must surface a typed,
//   visible error — never silently succeed or fail without signal.
// - cairn-nnfj (cairn-keo): invite dead-ends (invite_required / bad_invite)
//   append the "ask whoever runs this instance" guidance at error time. This
//   hint was added in 6373511, silently dropped by the passkey refactor
//   (119d5e4), and restored with these tests pinning it down.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createInvites } from '$lib/server/admin';
import { POST } from './+server';

const HINT = 'Invites come from whoever runs this Heartwood instance';

function wipe(): void {
	db.exec('DELETE FROM invites; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

let adminId: number;
// Distinct IP per request so the invite rate limiter never couples tests.
let ipSeq = 0;

beforeEach(() => {
	wipe();
	// First user registers freely and becomes admin; everyone after needs an invite.
	adminId = registerUser({
		email: 'admin@example.com',
		password: 'correct horse battery',
		displayName: 'Admin'
	}).id;
	setSetting('registration_mode', 'invite');
});

function event(body: Record<string, unknown>): Parameters<typeof POST>[0] {
	const ip = `10.0.0.${++ipSeq}`;
	const cookies = { set: () => {} };
	return {
		request: new Request('http://localhost/api/auth/register/password', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/register/password'),
		getClientAddress: () => ip,
		cookies,
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
}

function signup(overrides: Record<string, unknown> = {}) {
	return {
		email: `new${ipSeq}@example.com`,
		displayName: 'Newcomer',
		password: 'correct horse battery',
		...overrides
	};
}

async function post(body: Record<string, unknown>) {
	const res = await POST(event(body));
	return { status: res.status, body: (await res.json()) as { error?: string; code?: string; user?: unknown } };
}

describe('POST /api/auth/register/password — invite handling', () => {
	it('an invalid invite code returns a typed, visible 400 (cairn-zf3r)', async () => {
		const { status, body } = await post(signup({ inviteCode: 'CAIRN-NOPE-NOPE' }));
		expect(status).toBe(400);
		expect(body.code).toBe('bad_invite');
		expect(body.error).toContain('not valid');
		// No account was silently created.
		expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
	});

	it('bad_invite and invite_required errors carry the ask-your-admin hint (cairn-nnfj)', async () => {
		const bad = await post(signup({ inviteCode: 'CAIRN-NOPE-NOPE' }));
		expect(bad.body.error).toContain(HINT);

		const missing = await post(signup());
		expect(missing.status).toBe(400);
		expect(missing.body.code).toBe('invite_required');
		expect(missing.body.error).toContain(HINT);
	});

	it('non-invite errors do NOT get the invite hint', async () => {
		const weak = await post(signup({ password: 'short' }));
		expect(weak.status).toBe(400);
		expect(weak.body.error).not.toContain(HINT);

		const dupe = await post(
			signup({ email: 'admin@example.com', inviteCode: validCode() })
		);
		expect(dupe.status).toBe(400);
		expect(dupe.body.error).not.toContain(HINT);
	});

	it('a valid invite still registers cleanly', async () => {
		const { status, body } = await post(signup({ inviteCode: validCode() }));
		expect(status).toBe(201);
		expect(body.user).toBeTruthy();
	});
});

function validCode(): string {
	const [invite] = createInvites({ createdBy: adminId, count: 1 });
	return invite.code;
}
