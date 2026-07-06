import { listUserFeed } from '$lib/server/activity';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// The user's SIMPLIFIED feed: newest 200 of their OWN relevant events only —
	// no server internals, no other users' events (see listUserFeed). The full
	// operational log is admin-only at /admin/activity. First paint is
	// server-rendered; the page live-refreshes from /api/activity.
	return { events: listUserFeed(locals.user!.id, 200) };
};
