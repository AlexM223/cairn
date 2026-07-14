// Regression test for cairn-7xlf: the admin/users/[id] detail route was
// missing the assertTeamMode() gate that the list page (../+page.server.ts)
// already has, so in solo mode /admin/users 404'd while /admin/users/2 kept
// rendering full feature-flag override UI — contradicting the admin layout's
// own doc comment that "the routes themselves 404 via assertTeamMode()
// regardless of this list". Pins: solo mode 404s both load() and the
// setOverride action, before ever touching the per-user override read/write
// path; team mode is unaffected.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSetting } from '$lib/server/settings';
import { db } from '$lib/server/db';

vi.mock('$lib/server/featureFlags/admin', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/featureFlags/admin')>();
	return { ...mod, setUserOverride: vi.fn(), clearUserOverride: vi.fn() };
});

import { setUserOverride } from '$lib/server/featureFlags/admin';
import { load, actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };

beforeEach(() => {
	vi.clearAllMocks();
	db.prepare('DELETE FROM users').run();
	db.prepare(
		"INSERT INTO users (id, email, display_name, is_admin) VALUES (1, 'admin@example.com', 'Admin', 1)"
	).run();
	db.prepare(
		"INSERT INTO users (id, email, display_name, is_admin) VALUES (2, 'user@example.com', 'User', 0)"
	).run();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, userId = 2, form?: FormData): any {
	return {
		locals: { user },
		params: { id: String(userId) },
		request: new Request(`http://localhost/admin/users/${userId}`, {
			method: 'POST',
			body: form ?? new FormData()
		})
	};
}

describe('admin/users/[id] load — gated on assertTeamMode like the list page', () => {
	it('404s in solo mode even for a real user id', async () => {
		setSetting('instance_mode', 'solo');
		await expect(load({ params: { id: '2' } } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads normally in team mode', async () => {
		setSetting('instance_mode', 'team');
		const result = (await load({ params: { id: '2' } } as never)) as { subject: { id: number } };
		expect(result.subject.id).toBe(2);
	});
});

describe('admin/users/[id] setOverride action — gated on assertTeamMode', () => {
	it('404s in solo mode for an admin caller, mutation never runs', async () => {
		setSetting('instance_mode', 'solo');
		const form = new FormData();
		form.set('key', 'address_book');
		form.set('state', 'off');
		await expect(actions.setOverride(makeEvent(ADMIN, 2, form))).rejects.toMatchObject({
			status: 404
		});
		expect(setUserOverride).not.toHaveBeenCalled();
	});

	it('runs normally in team mode for an admin caller', async () => {
		setSetting('instance_mode', 'team');
		const form = new FormData();
		form.set('key', 'address_book');
		form.set('state', 'off');
		const res = await actions.setOverride(makeEvent(ADMIN, 2, form));
		expect(res).toEqual({ ok: true });
		expect(setUserOverride).toHaveBeenCalledWith(2, 'address_book', false, 1);
	});
});
