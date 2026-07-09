import { readChainSnapshot } from '$lib/server/chainSnapshot';
import type { PageServerLoad } from './$types';
import type { DifficultyInfo, DifficultyAdjustment } from '$lib/types';

export interface DifficultyData {
	info: DifficultyInfo | null;
	history: DifficultyAdjustment[] | null;
	error: string | null;
}

export const load: PageServerLoad = async ({ depends }) => {
	// Re-run after a background chain refresh (invalidate('cairn:chain')).
	depends('cairn:chain');

	// Stale-while-revalidate: difficulty info + history come straight from the
	// persisted chain snapshot (synchronous SQLite read, no live chain call). The
	// client refreshes it in the background on mount.
	const snap = readChainSnapshot();
	const difficulty: DifficultyData | null = snap
		? { info: snap.data.difficultyInfo, history: snap.data.difficultyHistory, error: null }
		: null;
	return { difficulty, lastSyncedAt: snap?.lastSyncedAt ?? null };
};
