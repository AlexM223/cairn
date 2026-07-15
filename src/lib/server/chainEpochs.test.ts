import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEpochStrip, epochIndexForHeight, resetEpochStripCache } from './chainEpochs';

// chainEpochs resolves the chain via getChain() and persists through the settings
// module; stub both so no db/network code loads. With Esplora fully removed
// (cairn-zoz8.16) the module reaches the chain purely through the backend-agnostic
// ChainService seams — getTip() and getBlockTimeAtHeight(), both Electrum-backed —
// so the block at each difficulty-epoch boundary height supplies the timestamps.
const chainGetTip = vi.fn<() => Promise<{ height: number; hash: string }>>();
const chainGetBlockTimeAtHeight = vi.fn<(h: number) => Promise<number>>();

vi.mock('$lib/server/chain', () => ({
	getChain: () => ({
		getTip: chainGetTip,
		getBlockTimeAtHeight: chainGetBlockTimeAtHeight
	})
}));

const settingsStore = new Map<string, string>();
vi.mock('$lib/server/settings', () => ({
	getSetting: (key: string) => settingsStore.get(key) ?? null,
	setSetting: (key: string, value: string) => {
		settingsStore.set(key, value);
	}
}));

const logInfo = vi.fn();
const logWarn = vi.fn();
vi.mock('$lib/server/logger', () => ({
	childLogger: () => ({
		debug: () => {},
		info: (...args: unknown[]) => logInfo(...args),
		warn: (...args: unknown[]) => logWarn(...args),
		error: () => {}
	})
}));

const EPOCH = 2016;
const TWO_WEEKS = EPOCH * 600;
const GENESIS_TIME = 1_231_006_505;

/** Boundary timestamp for epoch i, at the ideal two-week pace. Any per-epoch
 *  duration deviation is injected via `overrides` (epoch index → seconds), which
 *  is what the alpha-from-duration path reads now that no retarget-history source
 *  supplies real change magnitudes. */
function boundaryTimes(tipEpoch: number, overrides: Record<number, number> = {}): number[] {
	const times: number[] = [GENESIS_TIME];
	for (let i = 1; i <= tipEpoch; i++) {
		const prevEpochDuration = overrides[i - 1] ?? TWO_WEEKS;
		times.push(times[i - 1] + prevEpochDuration);
	}
	return times;
}

/** Stub getBlockTimeAtHeight to serve from a precomputed boundary-times array. */
function serveBoundaries(times: number[]): void {
	chainGetBlockTimeAtHeight.mockImplementation(async (h) => {
		const idx = h / EPOCH;
		const t = times[idx];
		if (typeof t !== 'number') throw new Error(`no boundary time for height ${h} (epoch ${idx})`);
		return t;
	});
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

describe('getEpochStrip — boundary-blocks (Electrum) source', () => {
	const TIP_EPOCH = 105; // spans the first halving (block 210,000 in epoch 104)
	const TIP = TIP_EPOCH * EPOCH + 100;

	beforeEach(() => {
		chainGetTip.mockResolvedValue({ height: TIP, hash: 'tip' });
		serveBoundaries(boundaryTimes(TIP_EPOCH));
	});

	it('produces one epoch per difficulty period, in ChainStrip prop shape', async () => {
		const strip = await getEpochStrip();
		expect(strip).not.toBeNull();
		expect(strip!.source).toBe('boundary-blocks');
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

	it('reads the block-header timestamp once per boundary, then serves later calls from cache', async () => {
		const strip = await getEpochStrip();
		expect(strip).not.toBeNull();
		// One fetch per boundary height (0..tipEpoch).
		expect(chainGetBlockTimeAtHeight).toHaveBeenCalledTimes(TIP_EPOCH + 1);
		expect(settingsStore.has('chainEpochs.v1')).toBe(true);

		// Same process: served from the module cache — no refetch.
		await getEpochStrip();
		expect(chainGetBlockTimeAtHeight).toHaveBeenCalledTimes(TIP_EPOCH + 1);

		// "Restart" (memory cache dropped): served from the persisted copy.
		resetEpochStripCache();
		const again = await getEpochStrip();
		expect(chainGetBlockTimeAtHeight).toHaveBeenCalledTimes(TIP_EPOCH + 1);
		expect(again!.epochCount).toBe(TIP_EPOCH + 1);
	});
});

describe('getEpochStrip — alpha from epoch-duration deviation', () => {
	// With no retarget-history source, the difficulty-change magnitude that drives
	// each epoch's line brightness is approximated from how far its real duration
	// deviates from the ideal two weeks (a much-too-fast epoch implies a big upward
	// retarget). This pins that approximation path.
	const TIP_EPOCH = 30;
	const TIP = TIP_EPOCH * EPOCH + 200;

	beforeEach(() => {
		chainGetTip.mockResolvedValue({ height: TIP, hash: 'tip' });
		// Epoch 9 ran 4× too fast (a big implied retarget); every other epoch was
		// on-pace. Its verdict lands on epoch 9's line.
		serveBoundaries(boundaryTimes(TIP_EPOCH, { 9: TWO_WEEKS / 4 }));
	});

	it('gives the off-pace epoch a brighter line than an on-pace one, and the forming epoch the floor', async () => {
		const strip = await getEpochStrip();
		const big = strip!.epochs[9].alpha; // the 4×-fast epoch
		const mild = strip!.epochs[20].alpha; // on-pace
		expect(big).toBeGreaterThan(mild);
		// Forming epoch has no verdict yet: exactly the 0.07 floor, no pop.
		expect(strip!.epochs.at(-1)!.alpha).toBeCloseTo(0.07, 10);
	});
});

describe('getEpochStrip — unreachable chain', () => {
	it('returns null (callers hide the strip) when the tip is unavailable', async () => {
		chainGetTip.mockRejectedValue(new Error('electrum down'));
		expect(await getEpochStrip()).toBeNull();
	});
});

describe('getEpochStrip — boundary-failure logging backoff (cairn-p7n6)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('sub-epoch chain (no complete difficulty epoch) logs info once, never warn, even on repeat', async () => {
		// tipEpoch 0 (e.g. regtest at 668 blocks): only one possible boundary
		// (genesis), so the knownCount threshold (>=2) can never be met. This is
		// expected and structural, not a fetch failure.
		chainGetTip.mockResolvedValue({ height: 668, hash: 'tip' });
		chainGetBlockTimeAtHeight.mockRejectedValue(new Error('no boundary yet'));

		expect(await getEpochStrip()).toBeNull();
		expect(await getEpochStrip()).toBeNull();
		expect(await getEpochStrip()).toBeNull();

		expect(logInfo).toHaveBeenCalledTimes(1);
		expect(logWarn).not.toHaveBeenCalled();
	});

	it('genuine repeated boundary-fetch failures: first occurrence warns, immediate repeat is suppressed', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		// tipEpoch 3 (a complete epoch exists), but every boundary beyond genesis
		// fails to fetch — genuinely too few known boundaries.
		const TIP_EPOCH = 3;
		chainGetTip.mockResolvedValue({ height: TIP_EPOCH * EPOCH + 5, hash: 'tip' });
		chainGetBlockTimeAtHeight.mockRejectedValue(new Error('electrum timeout'));

		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1);

		// Immediately again: still within the backoff window, no new WARN.
		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it('logs again once the backoff window elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const TIP_EPOCH = 3;
		chainGetTip.mockResolvedValue({ height: TIP_EPOCH * EPOCH + 5, hash: 'tip' });
		chainGetBlockTimeAtHeight.mockRejectedValue(new Error('electrum timeout'));

		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1);

		// Just under the window: still suppressed.
		vi.setSystemTime(10 * 60 * 1000 - 1);
		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1);

		// Window elapsed: warns again.
		vi.setSystemTime(10 * 60 * 1000);
		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(2);
	});

	it('a later success resets the backoff so the next failure warns immediately', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const TIP_EPOCH = 3;
		chainGetTip.mockResolvedValue({ height: TIP_EPOCH * EPOCH + 5, hash: 'tip' });
		chainGetBlockTimeAtHeight.mockRejectedValue(new Error('electrum timeout'));

		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1);

		// Chain recovers: all boundaries now fetch successfully.
		resetEpochStripCache();
		serveBoundaries(boundaryTimes(TIP_EPOCH));
		const strip = await getEpochStrip();
		expect(strip).not.toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(1); // unchanged — success, not a failure

		// Drop both the in-memory and persisted cache (simulating a fresh outage
		// with nothing usable cached) and fail again right away, with no time
		// advance: should warn immediately since the success reset the backoff,
		// rather than staying suppressed under the old window.
		resetEpochStripCache();
		settingsStore.clear();
		chainGetBlockTimeAtHeight.mockRejectedValue(new Error('electrum timeout again'));
		expect(await getEpochStrip()).toBeNull();
		expect(logWarn).toHaveBeenCalledTimes(2);
	});
});
