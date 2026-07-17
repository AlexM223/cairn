// GET /api/mining/me — the signed-in user's live mining view (connection creds,
// workers, hashrate, earnings, solo odds). Feature-gated on `mining`; strictly
// scoped to the caller (readModels.getUserMiningView never reads another user's
// data). Polled by the /mining page.

import { json, requireFeature } from '$lib/server/api';
import { getUserMiningView } from '$lib/server/mining/readModels';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = requireFeature(event, 'mining');
	return json(await getUserMiningView(user.id));
};
