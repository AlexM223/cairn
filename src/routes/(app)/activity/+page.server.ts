import { listActivity } from '$lib/server/activity';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Newest 200 of the user's own events + instance-wide ones. The page can
	// live-refresh from /api/activity, but the first paint is server-rendered.
	return { events: listActivity(locals.user!.id, 200) };
};
