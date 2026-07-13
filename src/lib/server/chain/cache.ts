// TTL caches for the two hottest previously-uncached chain lookups: the chain
// tip and the fee estimates (ChainService.getTip / getFeeEstimates in ./index).
// Each was a fresh esplora HTTP round-trip on every call, so on ARM/Umbrel —
// where every network hop is meaningfully slow — a single navigation, or a few
// tabs open at once (dashboard + wallet + send), paid for the same slow lookup
// several times over (cairn-vknb.5).
//
// The two values have different honest models, mirroring the reasoning already
// written for the tip/peers caches in ../syncStatus.ts:
//
//   tip  — changes only when a new block arrives. The Electrum 'header' event
//          (../chainEvents.ts) is the real signal, so the cache is invalidated
//          the instant a block lands. The 10-minute TTL is only a safety ceiling
//          for the case where the header pipeline itself stalls; in practice the
//          cache is never actually that stale. Same reasoning as TIP_TTL_MS in
//          ../syncStatus.ts.
//   fees — drift continuously as the mempool churns; there is no discrete
//          "changed" event to hook. A flat short TTL is the honest model — same
//          reasoning as PEERS_TTL_MS in ../syncStatus.ts.

import type { FeeEstimates, FeeHistogram, MempoolSummary } from '$lib/types';
import type { BlockStats } from './index';

/** Safety ceiling only — the tip is normally invalidated on the 'header' event
 *  the instant a block lands, long before this elapses. */
const TIP_TTL_MS = 10 * 60_000;
/** Fee estimates drift continuously; a flat short TTL is the honest model. */
const FEE_TTL_MS = 30_000;
/** Mempool summary + fee histogram churn continuously like fees; same short-TTL
 *  honest model. Short enough that a new-block forced refresh reflects the drained
 *  mempool promptly, long enough to dedupe repeated reads within one refresh cycle
 *  and across the mempool sub-pages (cairn-6efi.1, U3). */
const MEMPOOL_TTL_MS = 30_000;

interface Entry<T> {
	value: T;
	at: number;
}

type Tip = { height: number; hash: string };

let tipCache: Entry<Tip> | null = null;
let feeCache: Entry<FeeEstimates> | null = null;
let mempoolSummaryCache: Entry<MempoolSummary> | null = null;
let feeHistogramCache: Entry<FeeHistogram | null> | null = null;

/**
 * Return the cached tip if still fresh, else fetch via `load`, cache, return.
 * A concurrent 'header' event may invalidate mid-flight; that only means the
 * next caller refetches — never a correctness problem for a value that is just
 * "the current tip". Errors from `load` propagate and are not cached, so a
 * transient backend failure never poisons the cache (matches the pre-cache
 * contract where every call could throw).
 */
export async function cachedTip(load: () => Promise<Tip>): Promise<Tip> {
	const now = Date.now();
	if (tipCache && now - tipCache.at < TIP_TTL_MS) return tipCache.value;
	const value = await load();
	tipCache = { value, at: now };
	return value;
}

/** As {@link cachedTip} but for fee estimates (30s flat TTL, no invalidation). */
export async function cachedFeeEstimates(
	load: () => Promise<FeeEstimates>
): Promise<FeeEstimates> {
	const now = Date.now();
	if (feeCache && now - feeCache.at < FEE_TTL_MS) return feeCache.value;
	const value = await load();
	feeCache = { value, at: now };
	return value;
}

/** As {@link cachedFeeEstimates} but for the mempool summary (30s flat TTL). */
export async function cachedMempoolSummary(
	load: () => Promise<MempoolSummary>
): Promise<MempoolSummary> {
	const now = Date.now();
	if (mempoolSummaryCache && now - mempoolSummaryCache.at < MEMPOOL_TTL_MS) {
		return mempoolSummaryCache.value;
	}
	const value = await load();
	mempoolSummaryCache = { value, at: now };
	return value;
}

/** As {@link cachedFeeEstimates} but for the mempool fee histogram (30s flat TTL).
 *  A null result (empty mempool) is a valid cached value, not a miss. */
export async function cachedFeeHistogram(
	load: () => Promise<FeeHistogram | null>
): Promise<FeeHistogram | null> {
	const now = Date.now();
	if (feeHistogramCache && now - feeHistogramCache.at < MEMPOOL_TTL_MS) {
		return feeHistogramCache.value;
	}
	const value = await load();
	feeHistogramCache = { value, at: now };
	return value;
}

/**
 * Drop the cached tip. Called from the 'header' handler in ../chainEvents.ts the
 * instant a new block arrives, so the next getTip() reflects the new tip without
 * waiting out the TTL ceiling.
 */
export function invalidateTipCache(): void {
	tipCache = null;
}

/**
 * Reset both caches. Called from reconfigureChain() so a server switch never
 * serves a value that was fetched from the old backend.
 */
export function resetChainCaches(): void {
	tipCache = null;
	feeCache = null;
	mempoolSummaryCache = null;
	feeHistogramCache = null;
}

// -------------------------------------------------------- raw prev-tx LRU
//
// Cross-BUILD cache for raw transaction hex, keyed by txid (cairn perf:
// send-flow prev-tx fetch — see psbt.ts's constructPsbt). A confirmed
// transaction's serialized bytes never change once broadcast, so — unlike
// tip/fees above — there is no TTL here, just a size bound: this is the
// difference between "cache forever, bounded by count" and "cache briefly,
// bounded by time". psbt.ts's own prevTxCache only dedupes fetches WITHIN one
// build; without this, a user adjusting the amount/fee and rebuilding the
// draft re-fetches the same selected inputs' previous transactions from
// Electrum on every rebuild. Shared by every raw-tx consumer through
// ChainService.getTxHex (PSBT construction, fee-bump parent lookups, …), not
// just the send flow.

const RAW_TX_CACHE_MAX = 200;
const rawTxCache = new Map<string, string>();

/** Cached raw tx hex for a txid, or undefined. Refreshes LRU recency. */
export function getCachedRawTx(txid: string): string | undefined {
	const hit = rawTxCache.get(txid);
	if (hit !== undefined) {
		// Map iterates in insertion order — re-insert to mark as recently used.
		rawTxCache.delete(txid);
		rawTxCache.set(txid, hit);
	}
	return hit;
}

/** Cache a fetched raw tx under its txid, evicting the least-recently-used entry past the cap. */
export function cacheRawTx(txid: string, hex: string): void {
	rawTxCache.delete(txid);
	rawTxCache.set(txid, hex);
	while (rawTxCache.size > RAW_TX_CACHE_MAX) {
		const oldest = rawTxCache.keys().next().value;
		if (oldest === undefined) break;
		rawTxCache.delete(oldest);
	}
}

export function rawTxCacheSize(): number {
	return rawTxCache.size;
}

/** Test hook: drop every cached raw tx. */
export function clearRawTxCache(): void {
	rawTxCache.clear();
}

// ---------------------------------------------------- block-stats LRU (cairn-6efi.1, U2)
//
// getblockstats aggregates for a confirmed block (tx count / size / weight /
// total out / fee percentiles) NEVER change once the block is buried — a reorg
// mints a NEW hash, so keying by block hash makes stale data structurally
// impossible. Exactly the "cache forever, bounded by count" model as rawTxCache
// above (NOT the tip/fee TTL model). This lets the SWR refresh (chainSync.ts)
// re-fetch stats only for the newly-arrived tip block on each pass; the other
// ~14 blocks in the list are cache hits (U4).

const BLOCK_STATS_CACHE_MAX = 300;
const blockStatsCache = new Map<string, BlockStats>();

/** Cached block stats for a block hash, or undefined. Refreshes LRU recency. */
export function getCachedBlockStats(hash: string): BlockStats | undefined {
	const hit = blockStatsCache.get(hash);
	if (hit !== undefined) {
		// Re-insert to mark as recently used (Map iterates in insertion order).
		blockStatsCache.delete(hash);
		blockStatsCache.set(hash, hit);
	}
	return hit;
}

/** Cache a block's stats under its hash, evicting the least-recently-used past the cap. */
export function cacheBlockStats(hash: string, stats: BlockStats): void {
	blockStatsCache.delete(hash);
	blockStatsCache.set(hash, stats);
	while (blockStatsCache.size > BLOCK_STATS_CACHE_MAX) {
		const oldest = blockStatsCache.keys().next().value;
		if (oldest === undefined) break;
		blockStatsCache.delete(oldest);
	}
}

export function blockStatsCacheSize(): number {
	return blockStatsCache.size;
}

/** Test hook: drop every cached block stats entry. */
export function clearBlockStatsCache(): void {
	blockStatsCache.clear();
}
