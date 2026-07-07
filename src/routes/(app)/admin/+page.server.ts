import { instanceStats } from '$lib/server/admin';
import { getInstanceSettings } from '$lib/server/settings';
import { getChain } from '$lib/server/chain';
import { getUpdateNotice } from '$lib/server/updateCheck';
import type { PageServerLoad } from './$types';
import type { NodeInfo } from '$lib/types';

export const load: PageServerLoad = async () => {
	const stats = instanceStats();
	const settings = getInstanceSettings();

	let node: NodeInfo;
	try {
		node = await getChain().getNodeInfo();
	} catch (e) {
		node = {
			connected: false,
			mode: settings.connectionMode,
			server: `${settings.electrumHost}:${settings.electrumPort}`,
			tipHeight: null,
			tipHash: null,
			network: 'mainnet',
			error: e instanceof Error ? e.message : 'Connection failed'
		};
	}

	return {
		stats,
		node,
		registrationMode: settings.registrationMode,
		// Newer-release notice (cairn-ivae.2). Answers from an in-process cache and
		// never awaits the network — GitHub being down can't slow this page.
		updateNotice: getUpdateNotice()
	};
};
