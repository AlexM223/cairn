// GET /api/admin/mining — the operator's mining dashboard view (engine health,
// connected miners, per-user breakdown, blocks, the hashrate series, and the
// current settings). Admin-only (requireAdmin → 403 for non-admins); this is a
// pool-wide view spanning every user, so it must never be reachable by a plain
// signed-in user. Polled by the /admin/mining page.

import { json, requireAdmin } from '$lib/server/api';
import { getAdminMiningView } from '$lib/server/mining/readModels';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json(await getAdminMiningView());
};
