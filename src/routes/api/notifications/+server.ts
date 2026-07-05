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
import { listUserFeed, unreadUserFeedCount, markUserFeedRead } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('notify:inapp');

// The bell shows the user's SIMPLIFIED feed — their own relevant events only, no
// server internals or other users' events (see listUserFeed). Read state is the
// events.read_at column, scoped to the user's own rows.

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const url = event.url;
	const limitRaw = Number(url.searchParams.get('limit') ?? '30');
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 30;

	const notifications = listUserFeed(user.id, limit);
	return json({ notifications, unread: unreadUserFeedCount(user.id) });
};

export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ ids?: number[]; all?: boolean }>(event);

	try {
		if (body.all === true) {
			markUserFeedRead(user.id);
		} else if (Array.isArray(body.ids) && body.ids.length > 0) {
			markUserFeedRead(user.id, body.ids);
		}
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'mark-read failed');
		return json({ error: 'Could not update notifications.' }, { status: 500 });
	}

	return json({ unread: unreadUserFeedCount(user.id) });
};
