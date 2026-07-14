import { describe, it, expect, beforeEach } from 'vitest';

// The explorer mempool loader (src/routes/(app)/explorer/mempool/+page.server.ts)
// had zero coverage. Unlike block/tx detail, this loader makes NO live chain
// calls at all — it's a synchronous snapshot read (stale-while-revalidate,
// same pattern as mempool/blocks/+page.server.ts, whose own test file is the
// house style this mirrors). What genuinely needs pinning: the `mempool: null`
// vs populated-from-snapshot branch the .svelte derives its loading state
// from, and that `coreRpcConfigured` threads through independently (it drives
// the CoreRpcRequiredNotice inside the "snapshot exists but no summary yet"
// sub-branch — see +page.svelte L182-188).

import { db } from '$lib/server/db';
import { setSetting } from '$lib/server/settings';
import { writeChainSnapshot, type PersistedChainData } from '$lib/server/chainSnapshot';
import { load, type MempoolPageData } from './+page.server';

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

function loadEvent(userId?: number) {
	return {
		depends: () => {},
		locals: { user: userId ? { id: userId } : undefined }
	} as unknown as Parameters<typeof load>[0];
}

async function run(userId?: number) {
	return (await load(loadEvent(userId))) as {
		mempool: MempoolPageData | null;
		lastSyncedAt: number | null;
		pending: unknown[];
		coreRpcConfigured: boolean;
		isAdmin: boolean;
	};
}

beforeEach(() => {
	db.exec('DELETE FROM chain_snapshot; DELETE FROM settings; DELETE FROM instance_secrets;');
});

describe('explorer mempool load() — no persisted snapshot (fresh boot / never synced)', () => {
	it('renders mempool:null (loading shell), zero chain calls, regardless of coreRpcConfigured', async () => {
		const data = await run();
		expect(data.mempool).toBeNull();
		expect(data.lastSyncedAt).toBeNull();
		expect(data.coreRpcConfigured).toBe(false);
	});
});

describe('explorer mempool load() — coreRpcConfigured threading', () => {
	it('reports coreRpcConfigured:false with no core_rpc_url set', async () => {
		const data = await run();
		expect(data.coreRpcConfigured).toBe(false);
	});

	it('reports coreRpcConfigured:true once core_rpc_url is set — independent of snapshot state', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		const data = await run();
		expect(data.coreRpcConfigured).toBe(true);
		// Still null — coreRpcConfigured and the snapshot are orthogonal.
		expect(data.mempool).toBeNull();
	});
});

describe('explorer mempool load() — snapshot present, but no mempool summary yet (honest degrade)', () => {
	it('shapes a non-null mempool object with summary:null — the .svelte renders CoreRpcRequiredNotice off coreRpcConfigured, not off a fabricated summary', async () => {
		writeChainSnapshot(emptySnapshot(), Date.now());

		const data = await run();
		expect(data.mempool).not.toBeNull();
		expect(data.mempool?.summary).toBeNull();
		expect(data.coreRpcConfigured).toBe(false);
	});
});

describe('explorer mempool load() — populated snapshot', () => {
	it('shapes summary/fees/histogram/projected/trend straight from the persisted snapshot', async () => {
		writeChainSnapshot(
			emptySnapshot({
				mempoolSummary: { count: 4200, vsize: 12_000_000, totalFee: 900_000 } as never,
				fees: { fastest: 30, halfHour: 20, hour: 10, economy: 3 },
				feeHistogram: [
					[2, 50_000],
					[25, 300_000]
				],
				mempoolBlocks: [
					{ nTx: 12, vsize: 950_000, totalFees: 6000, medianFee: 22, feeRange: [15, 35] }
				],
				mempoolTrend: [{ time: 1_700_000_000, count: 4000 } as never]
			}),
			Date.now()
		);

		const data = await run();
		expect(data.mempool?.summary).toMatchObject({ count: 4200 });
		expect(data.mempool?.fees?.fastest).toBe(30);
		expect(data.mempool?.histogram).toHaveLength(2);
		expect(data.mempool?.projected).toHaveLength(1);
		expect(data.mempool?.trend).toHaveLength(1);
		expect(data.mempool?.error).toBeNull();
		expect(data.lastSyncedAt).toEqual(expect.any(Number));
	});
});

describe('explorer mempool load() — never rejects / never hangs', () => {
	it('resolves synchronously-fast even with garbage settings state (no chain call to time out on)', async () => {
		setSetting('core_rpc_url', '   '); // whitespace-only: coreRpcConfigured() treats as unset
		const start = Date.now();
		const data = await run();
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(data.coreRpcConfigured).toBe(false);
	});

	it('pending defaults to [] for an anonymous (logged-out) viewer', async () => {
		const data = await run(undefined);
		expect(data.pending).toEqual([]);
	});
});
