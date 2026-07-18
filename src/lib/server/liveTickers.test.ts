// liveTickers.ts (docs/LIVE-UPDATES-DESIGN.md §3.4): the single shared mempool
// sampler. These tests drive runMempoolTick() directly (deterministic — no real
// timer) and assert the three promises: it's DORMANT while no connection wants
// the topic (no chain read, no frame), it emits exactly ONE frame on a change,
// and it stays silent when nothing changed since the last emitted frame. The
// chain accessors and liveHub are faked so this is pure logic, no sockets.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.fn();
let subscriberCount = 0;

vi.mock('./liveHub', () => ({
	publish: (...a: unknown[]) => publishMock(...a),
	mempoolSubscriberCount: () => subscriberCount
}));

const getMempoolSummary = vi.fn();
const getFeeHistogram = vi.fn();
const getMempoolBlocks = vi.fn();
const fakeChain = { getMempoolSummary, getFeeHistogram, getMempoolBlocks };
vi.mock('./chain', () => ({ getChain: () => fakeChain }));

import { runMempoolTick, resetLiveTickersForTest } from './liveTickers';

/** The mempool-topic publish calls captured by the spy. */
function mempoolFrames(): { scope: unknown; data: Record<string, unknown> }[] {
	return publishMock.mock.calls
		.filter((c) => c[0] === 'mempool')
		.map((c) => ({ scope: c[1], data: c[2] as Record<string, unknown> }));
}

beforeEach(() => {
	vi.clearAllMocks();
	resetLiveTickersForTest();
	subscriberCount = 0;
	getMempoolSummary.mockResolvedValue({ txCount: 10, vsize: 5_000, totalFees: 100 });
	getFeeHistogram.mockResolvedValue([[5, 1_000]]);
	getMempoolBlocks.mockResolvedValue([{ medianFee: 5, feeRange: [1, 10], nTx: 3, totalFees: 0.001 }]);
});

describe('dormant with no mempool subscribers', () => {
	it('reads nothing and publishes nothing while nobody wants the topic', async () => {
		subscriberCount = 0;
		const published = await runMempoolTick();
		expect(published).toBe(false);
		expect(getMempoolSummary).not.toHaveBeenCalled();
		expect(getFeeHistogram).not.toHaveBeenCalled();
		expect(publishMock).not.toHaveBeenCalled();
	});
});

describe('emit on change only', () => {
	it('publishes exactly one broadcast mempool frame on the first sample', async () => {
		subscriberCount = 1;
		const published = await runMempoolTick();
		expect(published).toBe(true);
		const frames = mempoolFrames();
		expect(frames.length).toBe(1);
		expect(frames[0].scope).toEqual({ broadcast: true });
		expect(frames[0].data).toMatchObject({ count: 10, vsizeVb: 5_000 });
		expect(frames[0].data.feeHistogram).toEqual([[5, 1_000]]);
		expect(frames[0].data.mempoolBlocks).toEqual([
			{ medianFee: 5, feeRange: [1, 10], nTx: 3, totalFees: 0.001 }
		]);
		expect(typeof frames[0].data.updatedAt).toBe('number');
	});

	it('does NOT re-publish when nothing changed since the last frame', async () => {
		subscriberCount = 1;
		await runMempoolTick(); // first emit
		publishMock.mockClear();
		const published = await runMempoolTick(); // identical values
		expect(published).toBe(false);
		expect(publishMock).not.toHaveBeenCalled();
	});

	it('publishes again once the mempool changes', async () => {
		subscriberCount = 1;
		await runMempoolTick();
		publishMock.mockClear();
		getMempoolSummary.mockResolvedValue({ txCount: 20, vsize: 9_000, totalFees: 200 });
		const published = await runMempoolTick();
		expect(published).toBe(true);
		expect(mempoolFrames()[0].data).toMatchObject({ count: 20, vsizeVb: 9_000 });
	});
});

describe('single-backend tolerance', () => {
	it('frames the histogram even when the Core-only summary is unavailable', async () => {
		subscriberCount = 1;
		getMempoolSummary.mockRejectedValue(new Error('requires a Bitcoin Core RPC connection'));
		const published = await runMempoolTick();
		expect(published).toBe(true);
		const f = mempoolFrames()[0].data;
		expect(f.count).toBeNull();
		expect(f.vsizeVb).toBeNull();
		expect(f.feeHistogram).toEqual([[5, 1_000]]);
	});

	it('emits nothing when no backend answers this tick', async () => {
		subscriberCount = 1;
		getMempoolSummary.mockRejectedValue(new Error('no core'));
		getFeeHistogram.mockResolvedValue(null);
		const published = await runMempoolTick();
		expect(published).toBe(false);
		expect(publishMock).not.toHaveBeenCalled();
	});
});
