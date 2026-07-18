// GET /api/activity — the signed-in user's SIMPLIFIED activity feed: their own
// relevant events only (see listUserFeed), no server internals or other users'
// events. Used by the /activity page's auto-refresh. The full operational log
// lives at /api/admin/activity (admin-only).
// Note: the /api/live multiplexed SSE stream carries new-block/notification
// frames — unrelated to this feed endpoint.

import { json, requireUser } from '$lib/server/api';
import { listUserFeed } from '$lib/server/activity';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const limit = Number(event.url.searchParams.get('limit')) || 100;
	return json({ events: listUserFeed(user.id, limit) });
};
