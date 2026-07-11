// Difficulty-epoch strip data for the Heartwood ChainStrip (cairn-koy4.7).
//
// The strip draws one vertical line per difficulty epoch, x-positioned by the
// epoch's REAL wall-clock duration — which needs the block timestamp at every
// epoch boundary height (0, 2016, 4032, …). Boundary heights are deterministic;
// the timestamps are not, so they're fetched once and cached hard:
//
//   1. Preferred source: mempool.space's all-time /v1/mining/difficulty-adjustments
//      — ONE request returns [time, height, difficulty, changePercent] for every
//      retarget, giving both boundary timestamps and the real difficulty-change
//      magnitude the spec's alpha formula wants.
//   2. Plain-esplora fallback: fetch the block at each boundary height directly
//      (2 requests per epoch, limited concurrency). Slow the first time, then
//      persisted forever; difficulty-change magnitude is approximated from each
//      epoch's duration deviation (an epoch far off 2016×10min implies a big
//      retarget — documented approximation, see alpha() below).
//
// Caching: boundary timestamps are immutable chain history. They live in a
// module-level singleton AND in the settings table (key `chainEpochs.v1`), so a
// restart never refetches. A new boundary is only crossed every ~2 weeks; until
// then each call is pure in-memory math plus one TTL-cached tip-height lookup.

import { getChain } from './chain';
import { getSetting, setSetting } from './settings';
import { childLogger } from './logger';
import type { ChainEpoch } from '$lib/components/heartwood/ChainStrip.svelte';

const log = childLogger('chainEpochs');

const EPOCH = 2016;
const HALVING_INTERVAL = 210_000;
const TARGET_EPOCH_SECONDS = EPOCH * 600; // 1,209,600s = two weeks
/** Mainnet genesis block timestamp — epoch 0's start anchor. */
const GENESIS_TIME = 1_231_006_505;
const SETTING_KEY = 'chainEpochs.v1';
/** Last N epochs are the sapwood zone (spec: soft warm tint). */
const SAPWOOD_EPOCHS = 8;
/** |change%| that maps to n(i)=1 — historical retargets rarely exceed this. */
const MAG_FULL_SCALE = 28;
/** Boundary-block fallback fetch parallelism. */
const FETCH_CONCURRENCY = 6;

export interface EpochStripData {
	/** Ready-to-draw epochs for ChainStrip (xStart/xEnd are 0..1 fractions). */
	epochs: ChainEpoch[];
	/** Total epochs including the currently-forming one. */
	epochCount: number;
	tipHeight: number;
	/** Which pipeline produced the boundary timestamps. */
	source: 'retarget-history' | 'boundary-blocks';
}

interface EpochCacheState {
	/** boundaryTimes[i] = timestamp of the block at height i*2016 (epoch i's start). */
	boundaryTimes: number[];
	/** changes[i] = retarget %% applied AT boundary i (entering epoch i); null unknown. */
	changes: (number | null)[];
	source: 'retarget-history' | 'boundary-blocks';
}

let mem: EpochCacheState | null = null;
let inFlight: Promise<EpochCacheState | null> | null = null;

// ---------------------------------------------------------- fetch progress
// Live progress of the one-time boundary-timestamp build, read by the
// first-sync screen (cairn-koy4.11). The boundary walk IS Cairn's closest real
// analogue to "verifying the chain's history": one fetched epoch boundary per
// growth ring, from genesis to the tip. Pure observation — nothing here
// changes how the fetch behaves.

export interface EpochFetchProgress {
	/** True while a boundary-timestamp build is in flight. */
	active: boolean;
	/** Epochs the current build needs in total (0 = no build attempted yet). */
	totalEpochs: number;
	/** Boundary timestamps known so far (cache prefix + fetched this run). */
	knownEpochs: number;
	/** Timestamp of the newest known boundary — drives the "Verifying 2017" note. */
	lastKnownTime: number | null;
}

const fetchProgress: EpochFetchProgress = {
	active: false,
	totalEpochs: 0,
	knownEpochs: 0,
	lastKnownTime: null
};

export function getEpochFetchProgress(): EpochFetchProgress {
	return { ...fetchProgress };
}

/**
 * Has the epoch-history cache ever been fully built on this install?
 * Cheap (memory, then one settings-key existence check) — this is the
 * first-sync gate's condition, so it runs on app-layout requests until true.
 */
export function hasEpochHistory(): boolean {
	if (mem) return true;
	try {
		return getSetting(SETTING_KEY) !== null;
	} catch {
		return false;
	}
}

export function epochIndexForHeight(height: number): number {
	return Math.floor(Math.max(0, height) / EPOCH);
}

/** Does epoch i's height span [i*2016, (i+1)*2016) contain a halving height? */
function containsHalving(i: number): boolean {
	const lo = i * EPOCH;
	const hi = lo + EPOCH; // exclusive
	const k = Math.floor((hi - 1) / HALVING_INTERVAL);
	return k > 0 && k * HALVING_INTERVAL >= lo;
}

/**
 * Fill null gaps in a boundary-time series: linear interpolation between the
 * nearest known neighbors (monotonic by construction), constant-pace
 * extrapolation past the last known point. times[0] must be set by the caller.
 */
function interpolateGaps(times: (number | null)[]): number[] {
	const out = times.slice();
	let prevKnown = 0; // index 0 is always set (genesis anchor)
	for (let i = 1; i < out.length; i++) {
		if (out[i] === null) continue;
		const gap = i - prevKnown;
		if (gap > 1) {
			const t0 = out[prevKnown] as number;
			const t1 = out[i] as number;
			for (let j = prevKnown + 1; j < i; j++) {
				out[j] = t0 + ((t1 - t0) * (j - prevKnown)) / gap;
			}
		}
		prevKnown = i;
	}
	// Trailing unknowns: extend at the ideal two-week pace.
	for (let i = prevKnown + 1; i < out.length; i++) {
		out[i] = (out[i - 1] as number) + TARGET_EPOCH_SECONDS;
	}
	return out as number[];
}

function loadPersisted(): EpochCacheState | null {
	try {
		const raw = getSetting(SETTING_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as EpochCacheState;
		if (
			!Array.isArray(parsed.boundaryTimes) ||
			!Array.isArray(parsed.changes) ||
			parsed.boundaryTimes.length !== parsed.changes.length ||
			parsed.boundaryTimes.some((t) => typeof t !== 'number') ||
			(parsed.source !== 'retarget-history' && parsed.source !== 'boundary-blocks')
		) {
			return null;
		}
		return parsed;
	} catch (e) {
		log.debug({ err: e }, 'persisted epoch cache unreadable; recomputing');
		return null;
	}
}

function persist(state: EpochCacheState): void {
	try {
		setSetting(SETTING_KEY, JSON.stringify(state));
	} catch (e) {
		// Persistence is an optimization — in-memory cache still works.
		log.warn({ err: e }, 'failed to persist epoch boundary cache');
	}
}

/**
 * Source 1: one all-time retarget-history request (mempool.space-compatible
 * backends only). Returns null when the backend lacks the endpoint or the
 * response is unusably sparse.
 */
async function fromRetargetHistory(tipEpoch: number): Promise<EpochCacheState | null> {
	const chain = getChain();
	// Empty interval = the all-time series. Available only from an explicitly
	// configured Esplora backend (mempool.space-compatible); null otherwise, which
	// sends us to the Electrum-backed boundary-block source below (works anywhere).
	const raw = chain.esplora
		? await chain.esplora.getDifficultyHistory('').catch(() => null)
		: null;
	if (!raw || raw.length === 0) return null;

	const times: (number | null)[] = new Array(tipEpoch + 1).fill(null);
	const changes: (number | null)[] = new Array(tipEpoch + 1).fill(null);
	times[0] = GENESIS_TIME;
	changes[0] = 0;
	let known = 1;
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length < 4) continue;
		const [time, height, , change] = entry;
		if (typeof time !== 'number' || typeof height !== 'number') continue;
		if (height <= 0 || height % EPOCH !== 0) continue;
		const idx = height / EPOCH;
		if (idx > tipEpoch) continue;
		if (times[idx] === null) known++;
		times[idx] = time;
		changes[idx] = typeof change === 'number' ? change : null;
	}
	// A couple of stray points can't shape 475 epochs — fall back to real blocks.
	if (known < Math.max(3, Math.floor((tipEpoch + 1) * 0.2))) {
		log.debug({ known, tipEpoch }, 'retarget history too sparse; using boundary blocks');
		return null;
	}
	return {
		boundaryTimes: interpolateGaps(times),
		changes,
		source: 'retarget-history'
	};
}

/**
 * Source 2: read the block at each boundary height (works on any esplora
 * backend). Reuses any previously cached prefix so an epoch rollover only
 * fetches the one new boundary.
 */
async function fromBoundaryBlocks(
	tipEpoch: number,
	prefix: EpochCacheState | null
): Promise<EpochCacheState | null> {
	const chain = getChain();
	const times: (number | null)[] = new Array(tipEpoch + 1).fill(null);
	times[0] = null; // even genesis is fetched here — regtest/testnet have their own genesis time
	if (prefix) {
		for (let i = 0; i < Math.min(prefix.boundaryTimes.length, times.length); i++) {
			times[i] = prefix.boundaryTimes[i];
		}
	}

	const missing: number[] = [];
	for (let i = 0; i <= tipEpoch; i++) if (times[i] === null) missing.push(i);

	// Seed live progress from the already-known prefix; workers advance it.
	fetchProgress.knownEpochs = tipEpoch + 1 - missing.length;
	for (let i = tipEpoch; i >= 0; i--) {
		if (times[i] !== null) {
			fetchProgress.lastKnownTime = times[i];
			break;
		}
	}

	let failures = 0;
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < missing.length) {
			const idx = missing[cursor++];
			try {
				// Boundary-block timestamp from the operator's own Electrum server
				// (block.header → decode), not a third-party esplora HTTP API — works on
				// an Umbrel-style local-only deploy (cairn-zoz8).
				const timestamp = await chain.getBlockTimeAtHeight(idx * EPOCH);
				times[idx] = timestamp;
				// missing[] ascends, so max() keeps the frontier moving 2009 → now
				// even with a few concurrent workers racing.
				fetchProgress.knownEpochs++;
				fetchProgress.lastKnownTime = Math.max(fetchProgress.lastKnownTime ?? 0, timestamp);
			} catch (e) {
				failures++;
				if (failures <= 3) log.debug({ err: e, epoch: idx }, 'boundary block fetch failed');
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(FETCH_CONCURRENCY, missing.length || 1) }, () => worker())
	);

	if (times[0] === null) times[0] = GENESIS_TIME;
	const knownCount = times.filter((t) => t !== null).length;
	if (knownCount < Math.max(2, Math.floor((tipEpoch + 1) * 0.5))) {
		log.warn({ knownCount, tipEpoch }, 'too many boundary fetch failures; no strip data');
		return null;
	}
	return {
		boundaryTimes: interpolateGaps(times),
		changes: new Array(tipEpoch + 1).fill(null),
		source: 'boundary-blocks'
	};
}

/** Boundary timestamps covering epochs 0..tipEpoch, from cache or the chain. */
async function ensureState(tipEpoch: number): Promise<EpochCacheState | null> {
	if (mem && mem.boundaryTimes.length >= tipEpoch + 1) return mem;
	if (!mem) {
		const persisted = loadPersisted();
		if (persisted) {
			mem = persisted;
			if (mem.boundaryTimes.length >= tipEpoch + 1) return mem;
		}
	}
	// Single-flight: concurrent page loads share one computation.
	if (!inFlight) {
		fetchProgress.active = true;
		fetchProgress.totalEpochs = tipEpoch + 1;
		fetchProgress.knownEpochs = mem ? Math.min(mem.boundaryTimes.length, tipEpoch + 1) : 0;
		inFlight = (async () => {
			try {
				const state =
					(await fromRetargetHistory(tipEpoch)) ?? (await fromBoundaryBlocks(tipEpoch, mem));
				if (state) {
					mem = state;
					persist(state);
					fetchProgress.knownEpochs = tipEpoch + 1;
					fetchProgress.lastKnownTime = state.boundaryTimes[tipEpoch] ?? null;
				}
				return state;
			} finally {
				fetchProgress.active = false;
				inFlight = null;
			}
		})();
	}
	return inFlight;
}

/** p-th quantile (0..1) of a numeric array; 0 when empty. */
function quantile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
	return sorted[idx];
}

/**
 * The strip dataset for the current chain tip. Cheap after first computation
 * (one TTL-cached tip lookup + in-memory math). Returns null when chain data
 * is unreachable — callers hide the strip rather than erroring the page.
 */
export async function getEpochStrip(): Promise<EpochStripData | null> {
	let tipHeight: number;
	try {
		// Tip via the Electrum-backed, TTL-cached getTip (cairn-zoz8) — no esplora.
		tipHeight = (await getChain().getTip()).height;
	} catch (e) {
		log.debug({ err: e }, 'tip height unavailable; no strip data');
		return null;
	}
	if (!Number.isFinite(tipHeight) || tipHeight < 0) return null;

	const tipEpoch = epochIndexForHeight(tipHeight);
	const state = await ensureState(tipEpoch);
	if (!state) return null;

	const count = tipEpoch + 1;
	const now = Math.floor(Date.now() / 1000);

	// Real epoch durations; the forming epoch runs boundary → "now".
	const durations: number[] = [];
	for (let i = 0; i < count; i++) {
		const start = state.boundaryTimes[i];
		const end = i < tipEpoch ? state.boundaryTimes[i + 1] : Math.max(now, start + 1);
		durations.push(Math.max(1, end - start));
	}
	const total = durations.reduce((a, b) => a + b, 0);

	// Per-epoch difficulty-change magnitude for the alpha formula. The retarget
	// APPLIED at boundary i+1 is the verdict on epoch i's pace, so that's the
	// real value where the history source provided it; otherwise approximate
	// from the epoch's duration deviation (same percent scale as a retarget:
	// target/actual − 1). The forming epoch has no verdict yet — magnitude 0.
	const mags = durations.map((d, i) => {
		if (i === tipEpoch) return 0;
		const applied = state.changes[i + 1];
		if (typeof applied === 'number') return Math.abs(applied);
		return Math.abs((TARGET_EPOCH_SECONDS / d - 1) * 100);
	});
	// "Pop rings" (~13% of epochs get +0.26): everything at or above the 87th
	// percentile of magnitude, guarded so a flat-difficulty era can't pop zeros.
	const popThreshold = Math.max(quantile(mags, 0.87), 1);

	let acc = 0;
	const epochs: ChainEpoch[] = durations.map((d, i) => {
		const xStart = acc / total;
		acc += d;
		const xEnd = acc / total;
		const n = Math.min(mags[i] / MAG_FULL_SCALE, 1);
		const pop = mags[i] >= popThreshold ? 0.26 : 0;
		return {
			index: i,
			xStart,
			xEnd,
			alpha: Math.min(0.07 + 0.14 * n + pop, 1),
			isHalving: containsHalving(i),
			isSapwood: i >= count - SAPWOOD_EPOCHS
		};
	});

	return { epochs, epochCount: count, tipHeight, source: state.source };
}

/** Test/reconfigure hook: drop the in-memory cache (persisted copy remains). */
export function resetEpochStripCache(): void {
	mem = null;
	inFlight = null;
}
