// cairn-rpif — POST /api/admin/users self-mutation guard. The UI hides the
// disable/demote controls on your own row, but the endpoint was scriptable
// directly: pre-fix, an admin with a second admin present could send
// { id: self, disabled: true } (locking themselves out mid-session) or
// { id: self, isAdmin: false } (stripping their own rights) — the last_admin
// guard in admin.ts only protects the ONLY admin. The route must refuse
// self-targeting mutations outright while still allowing them against others.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setUserAdmin } from '$lib/server/admin';
import { setSetting } from '$lib/server/settings';
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
