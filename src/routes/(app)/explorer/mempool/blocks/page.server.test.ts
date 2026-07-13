import { describe, it, expect, beforeEach, vi } from 'vitest';

// mempool/blocks load() (cairn-6efi.5): was the ONE remaining live-fetch
// explorer page (four Electrum round-trips per navigation, then a 10s client
// poll repeating them forever). Converted to the same snapshot-backed SWR
// pattern as every other explorer page. getChain is mocked to throw so any
// accidental live call fails the test loudly instead of silently succeeding.

vi.mock('$lib/server/chain', () => ({
	getChain: () => {
		throw new Error('mempool/blocks load() must never call the live chain service');
	}
}));

import { db } from '$lib/server/db';
import { writeChainSnapshot, type PersistedChainData } from '$lib/server/chainSnapshot';
import { load, type MempoolBlocksPageData } from './+page.server';

function emptySnapshot(over: Partial<PersistedChainData> = {}): PersistedChainData {
	return {
		blocks: [],
		tipHeight: 800_000,
		tipTime: 1_700_000_000,
		hashrate: null,
		mempoolSummary: null,
		fees: null,
		difficultyInfo: null,
		difficultyHistory: null,
		mempoolBlocks: null,
		feeHistogram: null,
		mempoolTrend: null,
		...over
	};
}

function loadEvent() {
	return { depends: vi.fn() } as unknown as Parameters<typeof load>[0];
}

/** load() is typed against SvelteKit's generated ./$types (unavailable to a
 *  plain test file), so its inferred return widens to `void`; cast to the
 *  shape the route actually returns, same as the explorer tx test does. */
async function run() {
	return (await load(loadEvent())) as {
		mempool: MempoolBlocksPageData | null;
		lastSyncedAt: number | null;
	};
}

beforeEach(() => {
	db.exec('DELETE FROM chain_snapshot;');
});

describe('mempool/blocks load() — snapshot-backed SWR', () => {
	it('renders null (loading shell) with no persisted snapshot, zero chain calls', async () => {
		const data = await run();
		expect(data.mempool).toBeNull();
		expect(data.lastSyncedAt).toBeNull();
	});

	it('shapes projected/histogram/fees/tipHeight from the persisted snapshot, zero chain calls', async () => {
		writeChainSnapshot(
			emptySnapshot({
				tipHeight: 800_123,
				fees: { fastest: 30, halfHour: 20, hour: 10, economy: 3 },
				feeHistogram: [
					[2, 50_000],
					[25, 300_000]
				],
				mempoolBlocks: [
					{ nTx: 12, vsize: 950_000, totalFees: 6000, medianFee: 22, feeRange: [15, 35] }
				]
			}),
			Date.now()
		);

		const data = await run();
		expect(data.mempool?.tipHeight).toBe(800_123);
		expect(data.mempool?.fees?.fastest).toBe(30);
		expect(data.mempool?.histogram).toHaveLength(2);
		expect(data.mempool?.projected).toHaveLength(1);
		expect(data.lastSyncedAt).toEqual(expect.any(Number));
	});

	it('degradation: a null histogram/projection (no fee-rate feed) still returns the tip/fees the snapshot has', async () => {
		writeChainSnapshot(
			emptySnapshot({
				tipHeight: 800_500,
				feeHistogram: null,
				mempoolBlocks: null
			}),
			Date.now()
		);

		const data = await run();
		expect(data.mempool).not.toBeNull();
		expect(data.mempool?.tipHeight).toBe(800_500);
		expect(data.mempool?.histogram).toBeNull();
		expect(data.mempool?.projected).toBeNull();
	});
});
