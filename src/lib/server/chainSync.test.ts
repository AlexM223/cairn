import { describe, it, expect, beforeEach, vi } from 'vitest';

// chainSync.refreshChainSnapshot() is the server-side "revalidate" half of the
// SWR chain pages. These tests pin its two guards — single-flight dedup and the
// freshness throttle (plus force-bypass) — and its persist / stale-on-failure
// behavior, against a fully stubbed ChainService (no Electrum, no network).

// Hoisted so the vi.mock factory below can reference the stub while chainSync is
// imported (its `import { getChain }` runs before the const declarations here).
const h = vi.hoisted(() => {
	const state: { recent: () => Promise<unknown[]> } = {
		recent: async () => []
	};
	const chain = {
		getRecentBlocks: vi.fn(() => state.recent()),
		getMempoolSummary: vi.fn(async () => ({ txCount: 3, vsize: 1200, totalFees: 900 })),
		getFeeEstimates: vi.fn(async () => ({
			fastest: 20,
			halfHour: 15,
			hour: 10,
			economy: 3,
			minimum: 1
		})),
		getHashrate: vi.fn(async () => 5e20),
		getTip: vi.fn(async () => ({ height: 800_000, hash: 'a'.repeat(64) })),
		getDifficultyInfo: vi.fn(async () => ({ currentDifficulty: 1, tipHeight: 800_000 })),
		getDifficultyHistory: vi.fn(async () => null),
		getMempoolBlocks: vi.fn(async () => null),
		getFeeHistogram: vi.fn(async () => null),
		getMempoolTrend: vi.fn(async () => null)
	};
	return { state, chain };
});

vi.mock('./chain', () => ({ getChain: () => h.chain }));

import { db } from './db';
import { refreshChainSnapshot, __resetChainSyncForTests } from './chainSync';
import { readChainSnapshot } from './chainSnapshot';

const BLOCKS = [
	{
		height: 800_000,
		hash: 'b'.repeat(64),
		time: 1_700_000_000,
		txCount: 2,
		size: 1000,
		weight: 4000,
		medianFee: null,
		feeRange: null
	}
];

beforeEach(() => {
	db.exec('DELETE FROM chain_snapshot');
	__resetChainSyncForTests();
	vi.clearAllMocks();
	h.state.recent = async () => BLOCKS;
});

describe('refreshChainSnapshot — single-flight', () => {
	it('serves concurrent callers from ONE in-flight fetch', async () => {
		// Hold the core fetch open so a second call overlaps the first.
		let release!: (v: unknown[]) => void;
		h.state.recent = () => new Promise<unknown[]>((res) => (release = res));

		const p1 = refreshChainSnapshot();
		const p2 = refreshChainSnapshot();
		// Both callers share the exact same promise — no second fetch was started.
		expect(p1).toBe(p2);

		release(BLOCKS);
		await Promise.all([p1, p2]);

		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(1);
	});

	it('starts a fresh fetch again once the previous one settled', async () => {
		await refreshChainSnapshot();
		// Second call is past the in-flight window but still inside the throttle,
		// so it must NOT refetch — proven separately below. Force it to prove the
		// in-flight lock actually released.
		await refreshChainSnapshot({ force: true });
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(2);
	});
});

describe('refreshChainSnapshot — throttle', () => {
	it('returns the cached snapshot without refetching when fresh', async () => {
		const first = await refreshChainSnapshot();
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(1);

		const second = await refreshChainSnapshot();
		// Inside the 20s window → no new fetch, same persisted data returned.
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(1);
		expect(second.lastSyncedAt).toBe(first.lastSyncedAt);
		expect(second.data.tipHeight).toBe(800_000);
	});

	it('force:true bypasses the throttle and refetches', async () => {
		await refreshChainSnapshot();
		await refreshChainSnapshot({ force: true });
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(2);
	});

	it('refetches when the persisted snapshot is older than the throttle window', async () => {
		await refreshChainSnapshot();
		// Backdate the row well past the 20s throttle.
		db.prepare('UPDATE chain_snapshot SET last_synced_at = ? WHERE id = 1').run(
			Date.now() - 60_000
		);
		await refreshChainSnapshot();
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(2);
	});
});

describe('refreshChainSnapshot — persistence & failure', () => {
	it('persists the fetched snapshot and reads it back', async () => {
		await refreshChainSnapshot();
		const row = readChainSnapshot();
		expect(row).not.toBeNull();
		expect(row!.data.blocks).toHaveLength(1);
		expect(row!.data.tipHeight).toBe(800_000);
		expect(row!.data.mempoolSummary?.txCount).toBe(3);
		expect(row!.data.fees?.fastest).toBe(20);
	});

	it('keeps the last good snapshot when a later refresh fails', async () => {
		await refreshChainSnapshot();
		h.state.recent = async () => {
			throw new Error('backend down');
		};
		const res = await refreshChainSnapshot({ force: true });
		// Stale data is served rather than an error being surfaced.
		expect(res.data.tipHeight).toBe(800_000);
		expect(readChainSnapshot()!.data.tipHeight).toBe(800_000);
	});

	it('throws when the fetch fails and there is no prior snapshot', async () => {
		h.state.recent = async () => {
			throw new Error('backend down');
		};
		await expect(refreshChainSnapshot({ force: true })).rejects.toThrow('backend down');
		expect(readChainSnapshot()).toBeNull();
	});
});
