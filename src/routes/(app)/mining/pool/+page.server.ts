// /mining/pool — the pool-wide stats page every signed-in pool user may see
// (cairn-et38g): pool hashrate + 24h chart, miners online, best-share
// leaderboard (cairn-192dr) and the blocks-found trophy wall. Same `mining`
// feature gate as /mining; NOT admin-gated — that gap was the bug. Live
// refresh: the page subscribes to the (now broadcast) `mining:pool` nudge and
// refetches /api/mining/pool.

import { requireFeature } from '$lib/server/api';
import { getPublicPoolView, type PublicPoolView } from '$lib/server/mining/readModels';
import { childLogger } from '$lib/server/logger';
import type { PageServerLoad } from './$types';

const log = childLogger('mining-ui');

const DEGRADED_VIEW: PublicPoolView = {
	engine: { status: 'stopped' },
	pool: { connectedWorkers: 0, connectedUsers: 0, hashrateNow: 0, hashrate24h: 0 },
	hashrateSeries: [],
	networkDifficulty: null,
	bestShare: null,
	leaderboard: [],
	blocks: [],
	totalBlocksFound: 0
};

export const load: PageServerLoad = async (event) => {
	const user = requireFeature(event, 'mining');
	try {
		const view = await getPublicPoolView(user.id);
		return { view, loadError: null as string | null };
	} catch (e) {
		// Same degrade-not-blank contract as /mining's load.
		log.warn(
			{ userId: user.id, err: e instanceof Error ? e.message : String(e) },
			'getPublicPoolView failed'
		);
		return {
			view: DEGRADED_VIEW,
			loadError: 'Pool data is temporarily unavailable. Try refreshing the page.'
		};
	}
};
