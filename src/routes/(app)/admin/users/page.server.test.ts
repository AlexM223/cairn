// Regression test for the admin-users action auth-bypass fix. SvelteKit form
// `actions` do NOT run a parent route's load() — a POST straight to
// /admin/users?/disable (etc.) skipped the layout's isAdmin gate and, before
// the fix, reached setUserDisabled/setUserAdmin for an anonymous or
// non-admin caller. userAction()/setDisabledAction() now call
// requireAdmin(event) first, which THROWS (401 with no user, 403 for a
// non-admin) rather than returning a fail(). This pins that down for anon +
// non-admin, confirms the mutation never runs in either denied case, and
// confirms a real admin still reaches it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSetting } from '$lib/server/settings';

vi.mock('$lib/server/admin', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/admin')>();
	return { ...mod, setUserAdmin: vi.fn(), setUserDisabled: vi.fn() };
});

import { setUserAdmin, setUserDisabled } from '$lib/server/admin';
import { actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

/** Minimal RequestEvent for invoking a users action. `locals.user` is
 *  `undefined` for the anon case — same as hooks.server.ts leaves it when
 *  getSessionUser() finds no cookie. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, id = 5): any {
	const body = new FormData();
	body.set('id', String(id));
	return {
		locals: { user },
		request: new Request('http://localhost/admin/users', { method: 'POST', body })
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Team mode is only relevant to the admin-reaches-mutation cases: the anon
	// and non-admin denials throw at requireAdmin() before assertTeamMode()
	// is ever reached, so this is harmless for those tests too.
	setSetting('instance_mode', 'team');
});

describe('admin/users actions — anon is denied with a 401 throw, mutation never runs', () => {
	it('disable / enable / promote / demote', async () => {
		for (const action of [actions.disable, actions.enable, actions.promote, actions.demote]) {
			await expect(action(makeEvent(undefined))).rejects.toMatchObject({ status: 401 });
		}
		expect(setUserDisabled).not.toHaveBeenCalled();
		expect(setUserAdmin).not.toHaveBeenCalled();
	});
});

describe('admin/users actions — non-admin is denied with a 403 throw, mutation never runs', () => {
	it('disable / enable / promote / demote', async () => {
		for (const action of [actions.disable, actions.enable, actions.promote, actions.demote]) {
			await expect(action(makeEvent(NON_ADMIN))).rejects.toMatchObject({ status: 403 });
		}
		expect(setUserDisabled).not.toHaveBeenCalled();
		expect(setUserAdmin).not.toHaveBeenCalled();
	});
});

describe('admin/users actions — a real admin still reaches the mutation', () => {
	it('disable calls setUserDisabled(id, true)', async () => {
		const res = await actions.disable(makeEvent(ADMIN, 7));
		expect(res).toEqual({ ok: true });
		expect(setUserDisabled).toHaveBeenCalledWith(7, true);
	});

	it('enable calls setUserDisabled(id, false)', async () => {
		const res = await actions.enable(makeEvent(ADMIN, 7));
		expect(res).toEqual({ ok: true });
		expect(setUserDisabled).toHaveBeenCalledWith(7, false);
	});

	it('promote calls setUserAdmin(id, true)', async () => {
		const res = await actions.promote(makeEvent(ADMIN, 7));
		expect(res).toEqual({ ok: true });
		expect(setUserAdmin).toHaveBeenCalledWith(7, true);
	});

	it('demote calls setUserAdmin(id, false)', async () => {
		const res = await actions.demote(makeEvent(ADMIN, 7));
		expect(res).toEqual({ ok: true });
		expect(setUserAdmin).toHaveBeenCalledWith(7, false);
	});
});
