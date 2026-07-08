// Regression test for the admin-invites action auth-bypass fix. SvelteKit
// form `actions` do NOT run a parent route's load() — a POST straight to
// /admin/invites?/create (or ?/revoke) skipped the layout's isAdmin gate and,
// before the fix, reached createInvites/revokeInvite for an anonymous or
// non-admin caller. Both actions now call requireAdmin(event) first, which
// THROWS (401 with no user, 403 for a non-admin) rather than returning a
// fail(). This pins that down for anon + non-admin, confirms the mutation
// never runs in either denied case, and confirms a real admin still reaches
// it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSetting } from '$lib/server/settings';

vi.mock('$lib/server/admin', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/admin')>();
	return {
		...mod,
		createInvites: vi.fn(() => [{ code: 'TESTCODE1' }]),
		revokeInvite: vi.fn()
	};
});

import { createInvites, revokeInvite } from '$lib/server/admin';
import { actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

/** Minimal RequestEvent for invoking an invites action. `locals.user` is
 *  `undefined` for the anon case — same as hooks.server.ts leaves it when
 *  getSessionUser() finds no cookie. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, fields: Record<string, string> = {}): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals: { user },
		request: new Request('http://localhost/admin/invites', { method: 'POST', body })
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Team mode is only relevant to the admin-reaches-mutation cases: the anon
	// and non-admin denials throw at requireAdmin() before assertTeamMode()
	// is ever reached, so this is harmless for those tests too.
	setSetting('instance_mode', 'team');
});

describe('admin/invites actions — anon is denied with a 401 throw, mutation never runs', () => {
	it('create', async () => {
		await expect(
			actions.create(makeEvent(undefined, { count: '1', maxUses: '1' }))
		).rejects.toMatchObject({ status: 401 });
		expect(createInvites).not.toHaveBeenCalled();
	});

	it('revoke', async () => {
		await expect(actions.revoke(makeEvent(undefined, { id: '3' }))).rejects.toMatchObject({
			status: 401
		});
		expect(revokeInvite).not.toHaveBeenCalled();
	});
});

describe('admin/invites actions — non-admin is denied with a 403 throw, mutation never runs', () => {
	it('create', async () => {
		await expect(
			actions.create(makeEvent(NON_ADMIN, { count: '1', maxUses: '1' }))
		).rejects.toMatchObject({ status: 403 });
		expect(createInvites).not.toHaveBeenCalled();
	});

	it('revoke', async () => {
		await expect(actions.revoke(makeEvent(NON_ADMIN, { id: '3' }))).rejects.toMatchObject({
			status: 403
		});
		expect(revokeInvite).not.toHaveBeenCalled();
	});
});

describe('admin/invites actions — a real admin still reaches the mutation', () => {
	it('create calls createInvites', async () => {
		const res = await actions.create(makeEvent(ADMIN, { count: '1', maxUses: '1' }));
		expect(res).toEqual({ created: ['TESTCODE1'] });
		expect(createInvites).toHaveBeenCalledTimes(1);
		expect(createInvites).toHaveBeenCalledWith(
			expect.objectContaining({ createdBy: ADMIN.id, count: 1, maxUses: 1 })
		);
	});

	it('revoke calls revokeInvite(id)', async () => {
		const res = await actions.revoke(makeEvent(ADMIN, { id: '3' }));
		expect(res).toEqual({});
		expect(revokeInvite).toHaveBeenCalledWith(3);
	});
});
