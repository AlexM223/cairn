import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const chain = getChain();
	try {
		const [info, history] = await Promise.all([
			chain.getDifficultyInfo(),
			chain.getDifficultyHistory(10).catch(() => null)
		]);
		return { info, history, error: null };
	} catch (e) {
		return { info: null, history: null, error: chainErrorMessage(e) };
	}
};
