// GET /api/mining/pool — pool-wide stats every signed-in pool user may see
// (cairn-et38g): pool hashrate + 24h series, miners online, best share, the
// best-share leaderboard (cairn-192dr) and the blocks-found trophy wall.
// Feature-gated on `mining` like /api/mining/me; NOT admin-gated — that gap
// (all the exciting numbers admin-only) was the bug. Genuinely sensitive
// admin material stays on /api/admin/mining behind requireAdmin. Refetched by
// the pool page on `mining:pool` live nudges.

import { json, requireFeature } from '$lib/server/api';
import { getPublicPoolView } from '$lib/server/mining/readModels';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = requireFeature(event, 'mining');
	return json(await getPublicPoolView(user.id));
};
