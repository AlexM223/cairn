// Background refresh of the persisted chain snapshot (chainSnapshot.ts) — the
// server-side "revalidate" half of the SWR page loads.
//
// The retrofitted dashboard/explorer load()s NEVER call the chain here; they
// only read the persisted snapshot. The client fires POST /api/chain/refresh on
// mount and on every new block, which calls refreshChainSnapshot() below, which
// does the real Electrum/esplora work once and persists the result. Two guards
// keep that cheap and safe:
//
//   • single-flight — this is GLOBAL data (not per-wallet), so concurrent
//     callers (several tabs, a nav + a block event) await ONE shared in-flight
//     fetch instead of each hitting the backend.
//   • throttle — a non-forced call whose snapshot is younger than THROTTLE_MS
//     skips the fetch entirely and returns what's persisted. A new-block-driven
//     call passes { force: true } to bypass it (the block IS the "data changed"
//     signal). Note ChainService already TTL-caches getTip/getFeeEstimates
//     (chain/cache.ts, cairn-vknb.5); this layer adds only single-flight +
//     persistence on top, not a second copy of those caches.
//
// A refresh that can't reach the backend NEVER overwrites a good snapshot with
// an error — it logs and keeps serving the last (stale) one. Only when there is
// no prior snapshot at all does it propagate, so the endpoint can report the
// outage and the client can show its "can't reach chain data" state.

import { getChain } from './chain';
import { readChainSnapshot, writeChainSnapshot } from './chainSnapshot';
import type { ChainSnapshotRow, PersistedChainData } from './chainSnapshot';
import { recordMempoolSample } from './mempoolSamples';
import { childLogger } from './logger';

const log = childLogger('chain-sync');

/** Skip re-fetching if the snapshot is younger than this (unless forced). */
const THROTTLE_MS = 20_000;
/** Newest-first blocks to cache — covers the dashboard's 10 and explorer's 15. */
const SNAPSHOT_BLOCKS = 15;
/** Difficulty retargets to cache for the difficulty page's history chart. */
const DIFFICULTY_HISTORY = 10;

/** The single shared in-flight refresh, or null when idle. */
let inFlight: Promise<ChainSnapshotRow> | null = null;

/**
 * Refresh the persisted chain snapshot, honoring single-flight + throttle.
 * Resolves to the fresh (or throttled-cached, or stale-on-failure) snapshot.
 * Throws only when the fetch fails AND there is no prior snapshot to fall back
 * on.
 */
export function refreshChainSnapshot(opts: { force?: boolean } = {}): Promise<ChainSnapshotRow> {
	// Single-flight: an in-flight refresh serves every concurrent caller,
	// regardless of `force` (it's already fetching fresh data).
	if (inFlight) return inFlight;

	// Throttle: fresh-enough snapshot short-circuits the whole fetch.
	const current = readChainSnapshot();
	if (!opts.force && current && Date.now() - current.lastSyncedAt < THROTTLE_MS) {
		return Promise.resolve(current);
	}

	inFlight = doRefresh(current).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function doRefresh(current: ChainSnapshotRow | null): Promise<ChainSnapshotRow> {
	const chain = getChain();
	try {
		// Volatile-every-pass fetches + the core tip-bearing ones. `getRecentBlocks`
		// is the required core fetch (its failure means the backend is unreachable and
		// sends us to the catch); every other sub-fetch carries its own catch so a
		// backend that lacks one (plain esplora) or a single flaky lookup degrades
		// that field to null instead of failing the whole refresh. Mempool summary,
		// fee estimates, projected blocks, the fee histogram and the backlog trend are
		// genuinely volatile — they can change within a single block — so they refetch
		// on every pass.
		// Fetch the fee histogram exactly ONCE per refresh, then feed the SAME value
		// into both the mempool-block projection and the snapshot's histogram field.
		// Previously getMempoolBlocks() re-fetched it internally, so every refresh
		// paid for two identical histogram round-trips (cairn-6efi.1, U3).
		const histPromise = chain.getFeeHistogram().catch(() => null);
		const [blocks, mempoolSummary, fees, tip, mempoolBlocks, feeHistogram, mempoolTrend] =
			await Promise.all([
				// Core-enriched when Core RPC is configured (getblockstats per block).
				// Those aggregates are immutable-cached by hash (chain/cache.ts), so
				// steady-state refreshes only fetch stats for the newly-arrived tip
				// block — the other ~14 rows are cache hits. The enriched rows persist
				// verbatim in the snapshot's JSON blob below; the widened number|null
				// fields need no DB schema change (cairn-6efi.1, U4).
				chain.getRecentBlocks(SNAPSHOT_BLOCKS),
				chain.getMempoolSummary().catch(() => null),
				chain.getFeeEstimates().catch(() => null),
				chain.getTip().catch(() => null),
				histPromise.then((h) => chain.getMempoolBlocks(h)).catch(() => null),
				histPromise,
				chain.getMempoolTrend().catch(() => null)
			]);

		const tipHeight = tip?.height ?? blocks[0]?.height ?? null;

		// Drop a mempool sample into the local rolling time-series (cairn-zoz8.15) so
		// the 2h backlog-trend chart builds up organically — this refresh cycle IS the
		// sampler. Skipped when the summary is unavailable (backend can't serve it).
		if (mempoolSummary) recordMempoolSample(mempoolSummary);

		// Epoch-scale data — network hashrate, current difficulty, and the retarget
		// history chart — only meaningfully changes on a NEW BLOCK / retarget (the
		// difficulty itself only every ~2 weeks). Refetching it every 20s refresh
		// cycle wastes 3 Electrum round-trips + CPU for values that are identical
		// within the same block. So fetch it only when the tip actually advanced since
		// the last successful refresh; otherwise carry the persisted values forward.
		// (cairn — Explorer over-fetch.) The first refresh has no `current`, so it
		// always fetches; a plain-esplora backend that returns null stays null until
		// the tip moves, exactly as before.
		let hashrate = current?.data.hashrate ?? null;
		let difficultyInfo = current?.data.difficultyInfo ?? null;
		let difficultyHistory = current?.data.difficultyHistory ?? null;
		const tipUnchanged =
			current !== null && tipHeight !== null && current.data.tipHeight === tipHeight;
		if (!tipUnchanged) {
			[hashrate, difficultyInfo, difficultyHistory] = await Promise.all([
				chain.getHashrate().catch(() => null),
				chain.getDifficultyInfo().catch(() => null),
				chain.getDifficultyHistory(DIFFICULTY_HISTORY).catch(() => null)
			]);
		}

		const data: PersistedChainData = {
			blocks,
			tipHeight,
			tipTime: blocks[0]?.time ?? null,
			hashrate,
			mempoolSummary,
			fees,
			difficultyInfo,
			difficultyHistory,
			mempoolBlocks,
			feeHistogram,
			mempoolTrend
		};
		const at = Date.now();
		writeChainSnapshot(data, at);
		return { data, lastSyncedAt: at };
	} catch (e) {
		// Backend unreachable. Keep serving the last good snapshot (stale) rather
		// than blanking the pages; only propagate when there's nothing cached.
		log.warn({ err: e }, 'chain snapshot refresh failed; keeping last snapshot');
		if (current) return current;
		throw e;
	}
}

/** Test hook: clear the in-flight promise between cases. */
export function __resetChainSyncForTests(): void {
	inFlight = null;
}
