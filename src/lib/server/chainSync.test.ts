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
		// Core-enriched widened shape (cairn-6efi.1): stats present, plus the new
		// total_out + fullness row-model fields.
		txCount: 2_500,
		size: 1_312_000,
		weight: 3_993_000,
		medianFee: 12,
		feeRange: [1, 220],
		total_out: 1_234_567_890,
		fullness: 3_993_000 / 4_000_000
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

describe('refreshChainSnapshot — tiered epoch-data refetch (Explorer over-fetch)', () => {
	it('does NOT refetch hashrate / difficulty when the tip is unchanged', async () => {
		await refreshChainSnapshot();
		expect(h.chain.getHashrate).toHaveBeenCalledTimes(1);
		expect(h.chain.getDifficultyInfo).toHaveBeenCalledTimes(1);
		expect(h.chain.getDifficultyHistory).toHaveBeenCalledTimes(1);

		// Force a second pass past the in-flight lock but with the SAME tip (800_000):
		// the epoch-scale fetches must be skipped and carried forward from the snapshot.
		await refreshChainSnapshot({ force: true });
		expect(h.chain.getRecentBlocks).toHaveBeenCalledTimes(2); // core + volatile still refetch
		expect(h.chain.getMempoolSummary).toHaveBeenCalledTimes(2);
		expect(h.chain.getHashrate).toHaveBeenCalledTimes(1); // NOT refetched
		expect(h.chain.getDifficultyInfo).toHaveBeenCalledTimes(1);
		expect(h.chain.getDifficultyHistory).toHaveBeenCalledTimes(1);

		// The carried-forward values are still present in the persisted snapshot.
		const row = readChainSnapshot()!;
		expect(row.data.hashrate).toBe(5e20);
		expect(row.data.difficultyInfo?.currentDifficulty).toBe(1);
	});

	it('refetches hashrate / difficulty once the tip advances', async () => {
		await refreshChainSnapshot();
		expect(h.chain.getHashrate).toHaveBeenCalledTimes(1);

		// New block: bump both the tip lookup and the recent-blocks height.
		h.chain.getTip.mockResolvedValueOnce({ height: 800_001, hash: 'a'.repeat(64) });
		h.state.recent = async () => [{ ...BLOCKS[0], height: 800_001 }];

		await refreshChainSnapshot({ force: true });
		expect(h.chain.getHashrate).toHaveBeenCalledTimes(2);
		expect(h.chain.getDifficultyInfo).toHaveBeenCalledTimes(2);
		expect(h.chain.getDifficultyHistory).toHaveBeenCalledTimes(2);
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

describe('refreshChainSnapshot — fee histogram fetched once (cairn-6efi.1, U3)', () => {
	it('fetches the histogram once per refresh and feeds it into getMempoolBlocks', async () => {
		const HIST: [number, number][] = [
			[50, 1000],
			[10, 5000]
		];
		h.chain.getFeeHistogram.mockResolvedValue(HIST);
		h.chain.getMempoolBlocks.mockResolvedValue(null);

		await refreshChainSnapshot();

		// Exactly one histogram fetch — previously getMempoolBlocks re-fetched it,
		// doubling the round-trip every refresh.
		expect(h.chain.getFeeHistogram).toHaveBeenCalledTimes(1);
		expect(h.chain.getMempoolBlocks).toHaveBeenCalledTimes(1);
		// The SAME fetched histogram is passed into the projection…
		expect(h.chain.getMempoolBlocks).toHaveBeenCalledWith(HIST);
		// …and persisted as the snapshot's own histogram field.
		expect(readChainSnapshot()!.data.feeHistogram).toEqual(HIST);
	});
});

describe('refreshChainSnapshot — enriched blocks persist verbatim (cairn-6efi.1, U4)', () => {
	it('round-trips Core-enriched block rows (incl. total_out + fullness) through the JSON blob', async () => {
		await refreshChainSnapshot();
		const row = readChainSnapshot()!;
		expect(row.data.blocks).toHaveLength(1);
		// The widened number|null fields survive the JSON blob with no schema change.
		expect(row.data.blocks[0]).toMatchObject({
			txCount: 2_500,
			size: 1_312_000,
			weight: 3_993_000,
			medianFee: 12,
			feeRange: [1, 220],
			total_out: 1_234_567_890,
			fullness: 3_993_000 / 4_000_000
		});
	});

	it('persists a null baseline (Electrum-only) without coercing to 0', async () => {
		h.state.recent = async () => [
			{
				height: 800_001,
				hash: 'c'.repeat(64),
				time: 1_700_000_100,
				txCount: null,
				size: null,
				weight: null,
				medianFee: null,
				feeRange: null,
				total_out: null,
				fullness: null
			}
		];
		await refreshChainSnapshot({ force: true });
		expect(readChainSnapshot()!.data.blocks[0]).toMatchObject({
			txCount: null,
			size: null,
			weight: null,
			total_out: null,
			fullness: null
		});
	});
});
