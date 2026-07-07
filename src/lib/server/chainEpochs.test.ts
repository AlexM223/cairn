import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEpochStrip, epochIndexForHeight, resetEpochStripCache } from './chainEpochs';

// chainEpochs resolves the chain via getChain() and persists through the
// settings module; stub both so no db/network code loads.
const esplora = {
	getTipHeight: vi.fn<() => Promise<number>>(),
	getDifficultyHistory: vi.fn<(interval: string) => Promise<unknown[]>>(),
	getBlockHashAtHeight: vi.fn<(h: number) => Promise<string>>(),
	getBlockByHash: vi.fn<(hash: string) => Promise<{ timestamp: number }>>()
};

vi.mock('$lib/server/chain', () => ({
	getChain: () => ({ esplora })
}));

const settingsStore = new Map<string, string>();
vi.mock('$lib/server/settings', () => ({
	getSetting: (key: string) => settingsStore.get(key) ?? null,
	setSetting: (key: string, value: string) => {
		settingsStore.set(key, value);
	}
}));

vi.mock('$lib/server/logger', () => ({
	childLogger: () => ({
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	})
}));

const EPOCH = 2016;
const TWO_WEEKS = EPOCH * 600;
const GENESIS_TIME = 1_231_006_505;

/** All-time retarget history: [time, height, difficulty, changePercent]. */
function makeHistory(tipEpoch: number): [number, number, number, number][] {
	const out: [number, number, number, number][] = [];
	for (let i = 1; i <= tipEpoch; i++) {
		// Mild varied changes, plus one big +30% retarget entering epoch 10.
		const change = i === 10 ? 30 : (i % 7) + 1;
		out.push([GENESIS_TIME + i * TWO_WEEKS, i * EPOCH, 1000 + i, change]);
	}
	return out;
}

beforeEach(() => {
	vi.resetAllMocks();
	settingsStore.clear();
	resetEpochStripCache();
});

describe('epochIndexForHeight', () => {
	it('maps heights to 2016-block epochs', () => {
		expect(epochIndexForHeight(0)).toBe(0);
		expect(epochIndexForHeight(2015)).toBe(0);
		expect(epochIndexForHeight(2016)).toBe(1);
		expect(epochIndexForHeight(956_237)).toBe(474);
		expect(epochIndexForHeight(-5)).toBe(0);
	});
});

describe('getEpochStrip — retarget-history source', () => {
	const TIP_EPOCH = 105; // spans the first halving (block 210,000 in epoch 104)
	const TIP = TIP_EPOCH * EPOCH + 100;

	beforeEach(() => {
		esplora.getTipHeight.mockResolvedValue(TIP);
		esplora.getDifficultyHistory.mockResolvedValue(makeHistory(TIP_EPOCH));
	});

	it('produces one epoch per difficulty period, in ChainStrip prop shape', async () => {
		const strip = await getEpochStrip();
		expect(strip).not.toBeNull();
		expect(strip!.source).toBe('retarget-history');
		expect(strip!.tipHeight).toBe(TIP);
		expect(strip!.epochCount).toBe(TIP_EPOCH + 1);
		expect(strip!.epochs).toHaveLength(TIP_EPOCH + 1);

		// x fractions: monotonic, 0-anchored, closing at 1 (the forming epoch's
		// edge is "now").
		expect(strip!.epochs[0].xStart).toBe(0);
		expect(strip!.epochs.at(-1)!.xEnd).toBeCloseTo(1, 10);
		for (let i = 0; i < strip!.epochs.length; i++) {
			const e = strip!.epochs[i];
			expect(e.index).toBe(i);
			expect(e.xEnd).toBeGreaterThan(e.xStart);
			if (i > 0) expect(e.xStart).toBeCloseTo(strip!.epochs[i - 1].xEnd, 10);
			// Spec alpha formula bounds: 0.07 + 0.14·n (+0.26 pop), capped at 1.
			expect(e.alpha).toBeGreaterThanOrEqual(0.07);
			expect(e.alpha).toBeLessThanOrEqual(1);
		}
	});

	it('marks halving and sapwood epochs', async () => {
		const strip = await getEpochStrip();
		// Block 210,000 lies in [104·2016, 105·2016) = [209,664, 211,680).
		expect(strip!.epochs[104].isHalving).toBe(true);
		expect(strip!.epochs[103].isHalving).toBe(false);
		expect(strip!.epochs[0].isHalving).toBe(false);

		const sapwood = strip!.epochs.filter((e) => e.isSapwood).map((e) => e.index);
		expect(sapwood).toHaveLength(8);
		expect(sapwood).toEqual([98, 99, 100, 101, 102, 103, 104, 105]);
	});

	it('gives a big retarget a brighter line than a mild one, and the forming epoch the floor', async () => {
		const strip = await getEpochStrip();
		// The +30% retarget was applied at boundary 10 — the verdict on epoch 9.
		const big = strip!.epochs[9].alpha;
		const mild = strip!.epochs[20].alpha;
		expect(big).toBeGreaterThan(mild);
		// Forming epoch has no verdict yet: exactly the 0.07 floor, no pop.
		expect(strip!.epochs.at(-1)!.alpha).toBeCloseTo(0.07, 10);
	});

	it('persists boundaries and never refetches history on later calls', async () => {
		await getEpochStrip();
		expect(esplora.getDifficultyHistory).toHaveBeenCalledTimes(1);
		expect(settingsStore.has('chainEpochs.v1')).toBe(true);

		// Same process: served from the module cache.
		await getEpochStrip();
		expect(esplora.getDifficultyHistory).toHaveBeenCalledTimes(1);

		// "Restart" (memory cache dropped): served from the persisted copy.
		resetEpochStripCache();
		const strip = await getEpochStrip();
		expect(esplora.getDifficultyHistory).toHaveBeenCalledTimes(1);
		expect(strip!.epochCount).toBe(TIP_EPOCH + 1);
	});
});

describe('getEpochStrip — boundary-blocks fallback', () => {
	const TIP_EPOCH = 5;
	const TIP = TIP_EPOCH * EPOCH + 653;

	beforeEach(() => {
		esplora.getTipHeight.mockResolvedValue(TIP);
		// Plain esplora: no retarget-history endpoint.
		esplora.getDifficultyHistory.mockRejectedValue(new Error('404'));
		esplora.getBlockHashAtHeight.mockImplementation(async (h) => `hash-${h}`);
		esplora.getBlockByHash.mockImplementation(async (hash) => {
			const height = Number(hash.slice(5));
			return { timestamp: GENESIS_TIME + (height / EPOCH) * TWO_WEEKS };
		});
	});

	it('reads the block at each boundary height instead', async () => {
		const strip = await getEpochStrip();
		expect(strip).not.toBeNull();
		expect(strip!.source).toBe('boundary-blocks');
		expect(strip!.epochs).toHaveLength(TIP_EPOCH + 1);
		expect(strip!.epochs.at(-1)!.xEnd).toBeCloseTo(1, 10);
		// One fetch per boundary (0..tipEpoch), then cached.
		expect(esplora.getBlockHashAtHeight).toHaveBeenCalledTimes(TIP_EPOCH + 1);
		await getEpochStrip();
		expect(esplora.getBlockHashAtHeight).toHaveBeenCalledTimes(TIP_EPOCH + 1);
	});
});

describe('getEpochStrip — unreachable chain', () => {
	it('returns null (callers hide the strip) when the tip is unavailable', async () => {
		esplora.getTipHeight.mockRejectedValue(new Error('electrum down'));
		expect(await getEpochStrip()).toBeNull();
	});
});
