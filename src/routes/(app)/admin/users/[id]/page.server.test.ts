// Regression test for cairn-7xlf: the admin/users/[id] detail route was missing
// the assertTeamMode() gate the list page already has, so in solo mode
// /admin/users 404'd while /admin/users/2 kept rendering. Pins: solo mode 404s
// load() before touching anything; team mode is unaffected.
//
// The per-user feature-flag override grid + its setOverride action were removed
// in the UX-simplification pass (cairn-6c91u.2) — the flag ENGINE is untouched,
// so there is no longer a route action to test here; only the load gate remains.

import { describe, it, expect, beforeEach } from 'vitest';
import { setSetting } from '$lib/server/settings';
import { db } from '$lib/server/db';
import { load } from './+page.server';

beforeEach(() => {
	db.prepare('DELETE FROM users').run();
	db.prepare(
		"INSERT INTO users (id, email, display_name, is_admin) VALUES (1, 'admin@example.com', 'Admin', 1)"
	).run();
	db.prepare(
		"INSERT INTO users (id, email, display_name, is_admin) VALUES (2, 'user@example.com', 'User', 0)"
	).run();
});

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
