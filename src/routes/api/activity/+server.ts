// GET /api/activity — the signed-in user's activity feed (their events plus
// instance-wide ones), newest first. Used by the /activity page's auto-refresh.
// Note: /api/events is a separate SSE stream of new blocks — unrelated to this.

import { json, requireUser } from '$lib/server/api';
import { listActivity } from '$lib/server/activity';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const limit = Number(event.url.searchParams.get('limit')) || 100;
	return json({ events: listActivity(user.id, limit) });
};
