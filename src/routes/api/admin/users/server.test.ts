// cairn-rpif — POST /api/admin/users self-mutation guard. The UI hides the
// disable/demote controls on your own row, but the endpoint was scriptable
// directly: pre-fix, an admin with a second admin present could send
// { id: self, disabled: true } (locking themselves out mid-session) or
// { id: self, isAdmin: false } (stripping their own rights) — the last_admin
// guard in admin.ts only protects the ONLY admin. The route must refuse
// self-targeting mutations outright while still allowing them against others.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser, addCredential, setUserPassword } from '$lib/server/auth';
import { setUserAdmin, setUserDisabled } from '$lib/server/admin';
import { setSetting } from '$lib/server/settings';
import { consumeRecoveryCode } from '$lib/server/recovery';
import { POST } from './+server';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

const PASSWORD = 'correct horse battery';
let admin: { id: number; email: string; displayName: string; isAdmin: boolean };
let secondAdmin: { id: number };
let member: { id: number };

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	const a = registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'admin' });
	admin = { id: a.id, email: a.email, displayName: a.displayName, isAdmin: true };
	// A second admin exists, so the last_admin guard is NOT what protects the
	// caller below — only the route-level self-guard is.
	secondAdmin = registerUser({ email: 'admin2@example.com', password: PASSWORD, displayName: 'admin2' });
	setUserAdmin(secondAdmin.id, true);
	member = registerUser({ email: 'member@example.com', password: PASSWORD, displayName: 'member' });
});

function postEvent(body: unknown): Parameters<typeof POST>[0] {
	return {
		locals: { user: admin },
		params: {},
		request: new Request('http://localhost/api/admin/users', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0];
}

async function post(body: unknown) {
	const res = await POST(postEvent(body));
	return { status: res.status, body: await res.json() };
}

function userRow(id: number): { is_admin: number; disabled: number } {
	return db.prepare('SELECT is_admin, disabled FROM users WHERE id = ?').get(id) as {
		is_admin: number;
		disabled: number;
	};
}

describe('POST /api/admin/users self-mutation guard (cairn-rpif)', () => {
	it('refuses disabled:true against the caller’s own id and leaves the row unchanged', async () => {
		const { status, body } = await post({ id: admin.id, disabled: true });
		expect(status).toBe(400);
		expect(body.error).toMatch(/your own account/i);
		expect(userRow(admin.id)).toEqual({ is_admin: 1, disabled: 0 });
	});

	it('refuses isAdmin:false against the caller’s own id and leaves the row unchanged', async () => {
		const { status, body } = await post({ id: admin.id, isAdmin: false });
		expect(status).toBe(400);
		expect(body.error).toMatch(/your own admin access/i);
		expect(userRow(admin.id)).toEqual({ is_admin: 1, disabled: 0 });
	});

	it('the guard is not over-broad: disabling ANOTHER user still works', async () => {
		const { status } = await post({ id: member.id, disabled: true });
		expect(status).toBe(200);
		expect(userRow(member.id).disabled).toBe(1);
	});

	it('the guard is not over-broad: demoting ANOTHER admin still works', async () => {
		const { status } = await post({ id: secondAdmin.id, isAdmin: false });
		expect(status).toBe(200);
		expect(userRow(secondAdmin.id).is_admin).toBe(0);
	});

	it('self-targeting with the SAFE direction (isAdmin:true / disabled:false) is not blocked', async () => {
		// Re-affirming your own flags is a no-op, not a lockout — must not 400.
		const { status } = await post({ id: admin.id, isAdmin: true, disabled: false });
		expect(status).toBe(200);
		expect(userRow(admin.id)).toEqual({ is_admin: 1, disabled: 0 });
	});
});

// cairn-j1q9 — POST /api/admin/users { id, mintRecoveryCode: true }: the
// out-of-band replacement for the removed public "reclaim by email" signup
// path. Only a credential-less, passwordless, non-admin, non-disabled account
// (the exact shape a backup restore produces) may be minted a code.
describe('POST /api/admin/users mintRecoveryCode (cairn-j1q9)', () => {
	it('mints a code for an eligible (restored-shape) account and it actually redeems', async () => {
		const restored = registerUser({ email: 'restored@example.com', displayName: 'Restored' });

		const { status, body } = await post({ id: restored.id, mintRecoveryCode: true });
		expect(status).toBe(200);
		expect(typeof body.code).toBe('string');
		expect(consumeRecoveryCode(restored.id, body.code)).toBe(true);
	});

	it('refuses an unknown user id', async () => {
		const { status, body } = await post({ id: 999999, mintRecoveryCode: true });
		expect(status).toBe(404);
		expect(body.error).toBeTruthy();
	});

	it('refuses an admin target', async () => {
		const { status, body } = await post({ id: secondAdmin.id, mintRecoveryCode: true });
		expect(status).toBe(400);
		expect(body.error).toMatch(/admin/i);
	});

	it('refuses a disabled target', async () => {
		setUserDisabled(member.id, true);
		const { status, body } = await post({ id: member.id, mintRecoveryCode: true });
		expect(status).toBe(400);
		expect(body.error).toMatch(/enable/i);
	});

	it('refuses a target that already has a passkey', async () => {
		const restored = registerUser({ email: 'has-passkey@example.com', displayName: 'HasPasskey' });
		addCredential(restored.id, {
			credentialId: 'cred-x',
			publicKey: new Uint8Array([1, 2, 3]),
			counter: 0,
			name: 'Phone'
		});
		const { status, body } = await post({ id: restored.id, mintRecoveryCode: true });
		expect(status).toBe(400);
		expect(body.error).toMatch(/passkey|password/i);
	});

	it('refuses a target that already has a password', async () => {
		const restored = registerUser({ email: 'has-password@example.com', displayName: 'HasPassword' });
		setUserPassword(restored.id, 'some existing password');
		const { status, body } = await post({ id: restored.id, mintRecoveryCode: true });
		expect(status).toBe(400);
		expect(body.error).toMatch(/passkey|password/i);
	});

	it('does not touch disabled/isAdmin flags when mintRecoveryCode is set', async () => {
		const restored = registerUser({ email: 'both-fields@example.com', displayName: 'Both' });
		// Even if disabled/isAdmin are also present, the mint branch short-circuits
		// and neither flag update runs.
		await post({ id: restored.id, mintRecoveryCode: true, disabled: true, isAdmin: true });
		expect(userRow(restored.id)).toEqual({ is_admin: 0, disabled: 0 });
	});
});
