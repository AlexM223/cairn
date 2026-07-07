import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { DifficultyInfo, DifficultyAdjustment } from '$lib/types';

interface DifficultyData {
	info: DifficultyInfo | null;
	history: DifficultyAdjustment[] | null;
	error: string | null;
}

/** getDifficultyInfo/getDifficultyHistory are Electrum/esplora round-trips
 *  (cairn-2zxt.3) — streamed so the page chrome paints instantly instead of
 *  blocking SSR until the backend answers. Never rejects. */
async function loadDifficulty(): Promise<DifficultyData> {
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
}

export const load: PageServerLoad = async () => {
	return { difficulty: loadDifficulty() };
};
