// Gate the entire /explorer section (index + address/block/tx/mempool/difficulty
// sub-routes) behind the `explorer` feature flag. A layout load runs for every
// child page, so this one guard covers direct navigation to any explorer URL —
// the enforcement boundary the per-page nav-hiding in §4 is only a courtesy for.
import { requireFeature } from '$lib/server/api';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	requireFeature(event, 'explorer');
	return {};
};
