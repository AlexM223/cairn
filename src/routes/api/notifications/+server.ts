// GET   /api/notifications        → recent notifications + unread count
// PATCH /api/notifications         → mark { ids: number[] } or { all: true } read
//
// Unit 2 (§2.1 of docs/NOTIFICATION-PLAN.md). An in-app notification IS an
// `events` row (activity.ts); this route is the bell's data source and its
// "mark read" write path. Read state is INSTANCE-WIDE, not per-user: we set the
// single `events.read_at` column. That means an instance-wide event marked read
// by one user reads as read for everyone — the simpler model §2.1 recommends,
// consistent with how the existing /activity page already treats instance-wide
// events as stateless rows (no per-user receipts table). A user can only mark
// their OWN rows or instance-wide rows, never another user's.

import { json, requireUser, readJson } from '$lib/server/api';
import { db } from '$lib/server/db';
import { listActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('notify:inapp');

/** Unread = the caller's own rows OR instance-wide rows, not yet read. */
function unreadCount(userId: number): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
			   FROM events
			  WHERE (user_id = ? OR user_id IS NULL)
			    AND read_at IS NULL`
		)
		.get(userId) as { n: number };
	return row.n;
}

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const url = event.url;
	const limitRaw = Number(url.searchParams.get('limit') ?? '30');
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 30;

	const notifications = listActivity(user.id, limit);
	return json({ notifications, unread: unreadCount(user.id) });
};

export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ ids?: number[]; all?: boolean }>(event);

	try {
		if (body.all === true) {
			// Every unread row this user can see (their own + instance-wide).
			db.prepare(
				`UPDATE events
				    SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				  WHERE (user_id = ? OR user_id IS NULL)
				    AND read_at IS NULL`
			).run(user.id);
		} else if (Array.isArray(body.ids) && body.ids.length > 0) {
			// Sanitize to a bounded list of integers, then mark just those — still
			// scoped so a user can only touch their own or instance-wide rows.
			const ids = body.ids
				.map((n) => Number(n))
				.filter((n) => Number.isInteger(n))
				.slice(0, 500);
			if (ids.length > 0) {
				const placeholders = ids.map(() => '?').join(', ');
				db.prepare(
					`UPDATE events
					    SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					  WHERE id IN (${placeholders})
					    AND (user_id = ? OR user_id IS NULL)
					    AND read_at IS NULL`
				).run(...ids, user.id);
			}
		}
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'mark-read failed');
		return json({ error: 'Could not update notifications.' }, { status: 500 });
	}

	return json({ unread: unreadCount(user.id) });
};
