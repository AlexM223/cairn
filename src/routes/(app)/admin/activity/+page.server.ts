// Admin activity log: the full operational firehose — every event across all
// users and the instance-wide bucket, filterable. Admin gate is enforced by
// (app)/admin/+layout.server.ts. This is the detailed counterpart to the
// simplified per-user /activity feed.

import { listAllActivity, distinctActivityTypes } from '$lib/server/activity';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const { events, total } = listAllActivity({ limit: 200 });
	// A small user list to label/scope the filter — instances are single-operator
	// or small teams, so this stays cheap.
	const users = db
		.prepare('SELECT id, email, display_name FROM users ORDER BY display_name COLLATE NOCASE')
		.all() as { id: number; email: string; display_name: string }[];
	return {
		events,
		total,
		types: distinctActivityTypes(),
		users: users.map((u) => ({ id: u.id, email: u.email, name: u.display_name }))
	};
};
