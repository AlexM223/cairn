// TTL caches for the two hottest previously-uncached chain lookups: the chain
// tip and the fee estimates (ChainService.getTip / getFeeEstimates in ./index).
// Each was a fresh chain round-trip on every call, so on ARM/Umbrel —
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

import type { BlockPool, FeeEstimates, FeeHistogram, MempoolSummary } from '$lib/types';
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
/** Relay-fee floor (ChainService.getRelayFeeFloor, cairn-eacw.3): Core's
 *  mempoolminfee is DYNAMIC (rises when the mempool fills), so this needs the
 *  same short-TTL honest model as fees/mempool summary above rather than a
 *  one-shot cached verdict like packageRelay.ts's support probe. */
const RELAY_FEE_FLOOR_TTL_MS = 30_000;

interface Entry<T> {
	value: T;
	at: number;
}

type Tip = { height: number; hash: string };

let tipCache: Entry<Tip> | null = null;
let feeCache: Entry<FeeEstimates> | null = null;
let mempoolSummaryCache: Entry<MempoolSummary> | null = null;
let feeHistogramCache: Entry<FeeHistogram | null> | null = null;
let relayFeeFloorCache: Entry<number> | null = null;

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
 * As {@link cachedFeeEstimates} but for the node relay-fee floor (30s flat TTL) —
 * Core's mempoolminfee is dynamic (rises above minrelaytxfee when the mempool
 * fills), so a fixed short TTL rather than a one-shot cached verdict.
 */
export async function cachedRelayFeeFloor(load: () => Promise<number>): Promise<number> {
	const now = Date.now();
	if (relayFeeFloorCache && now - relayFeeFloorCache.at < RELAY_FEE_FLOOR_TTL_MS) {
		return relayFeeFloorCache.value;
	}
	const value = await load();
	relayFeeFloorCache = { value, at: now };
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
	relayFeeFloorCache = null;
	// The header cache is keyed by HEIGHT (not a globally-unique hash), so a switch
	// to a different chain must drop it or height 800000 on the new chain could serve
	// the old chain's header. The merkle-pos cache is keyed by txid (globally unique)
	// but is cleared too for a clean slate on reconfigure.
	headerCache.clear();
	merklePosCache.clear();
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

// ---------------------------------------------------- pool-tag LRU (cairn-6efi.4, T-C)
//
// A block's mining pool is derived from its coinbase (chain/pools.ts). Like
// blockStatsCache above, the coinbase of a buried block NEVER changes (a reorg
// mints a NEW hash), so keying by block hash makes stale data structurally
// impossible — the same "cache forever, bounded by count" model, NOT the tip/fee
// TTL model. A NULL result (coinbase matched no known pool) is cached too: it's an
// equally immutable, equally expensive-to-recompute fact, so re-deriving it every
// refresh would waste the getblock + getrawtransaction round-trips. This keeps the
// steady-state SWR refresh to a single new-tip pool lookup; the other ~14 blocks
// are cache hits.

const POOL_CACHE_MAX = 300;
const poolCache = new Map<string, BlockPool | null>();

/** Cached pool for a block hash. Returns `{ pool }` on a hit (pool may be null —
 *  a cached "no known pool"), or undefined on a miss. Refreshes LRU recency. */
export function getCachedPool(hash: string): { pool: BlockPool | null } | undefined {
	if (!poolCache.has(hash)) return undefined;
	const pool = poolCache.get(hash) ?? null;
	// Re-insert to mark as recently used (Map iterates in insertion order).
	poolCache.delete(hash);
	poolCache.set(hash, pool);
	return { pool };
}

/** Cache a block's pool (or null for "no known pool") under its hash, evicting the
 *  least-recently-used entry past the cap. */
export function cachePool(hash: string, pool: BlockPool | null): void {
	poolCache.delete(hash);
	poolCache.set(hash, pool);
	while (poolCache.size > POOL_CACHE_MAX) {
		const oldest = poolCache.keys().next().value;
		if (oldest === undefined) break;
		poolCache.delete(oldest);
	}
}

export function poolCacheSize(): number {
	return poolCache.size;
}

/** Test hook: drop every cached pool entry. */
export function clearPoolCache(): void {
	poolCache.clear();
}

// ---------------------------------------------------- block-header + merkle-pos caches
//   (tx block context — docs/TX-BLOCK-CONTEXT-DESIGN.md §3 "Caching")
//
// The tx-detail block-context section needs two small buried-immutable lookups per
// cold view: each neighbour block's (hash, time) header and the tx's position
// (merkle `pos`) within its block. Both follow the "immutable once buried" model —
// with one wrinkle the block-stats/pool caches don't have: a header is keyed by
// HEIGHT, not hash, and a height within the reorg window (~6 of tip) can be
// re-pointed at a new block. So headers get a SHORT TTL near the tip and are cached
// (near-)forever once buried; the merkle pos is keyed by (txid, height) — a reorg
// changes the tx's height, so the new key misses and refetches, making stale data
// structurally impossible without any explicit invalidation.

/** A header stays "near the tip" (reorg-eligible) within this many blocks; a cached
 *  entry for such a height is only trusted for HEADER_TIP_TTL_MS. Beyond it a
 *  block is treated as buried and its header is cached until evicted by size. */
const HEADER_REORG_WINDOW = 6;
/** Short TTL for a still-reorg-eligible (near-tip) cached header. */
const HEADER_TIP_TTL_MS = 60_000;
const HEADER_CACHE_MAX = 300;

interface HeaderEntry {
	value: { hash: string; time: number };
	at: number;
}
const headerCache = new Map<number, HeaderEntry>();

/**
 * Cached (hash, time) for a block height, honouring the reorg window: a near-tip
 * entry expires after {@link HEADER_TIP_TTL_MS}; a buried entry never expires (only
 * LRU-evicted). `distanceFromTip` is `tipHeight − height` at read time — pass it so
 * a block that has since buried is trusted even if it was cached while near-tip.
 * Returns undefined on a miss or an expired near-tip entry.
 */
export function getCachedHeader(
	height: number,
	distanceFromTip: number
): { hash: string; time: number } | undefined {
	const hit = headerCache.get(height);
	if (!hit) return undefined;
	const nowBuried = distanceFromTip >= HEADER_REORG_WINDOW;
	// A near-tip height (still reorg-eligible now) is only trusted within the TTL.
	if (!nowBuried && Date.now() - hit.at >= HEADER_TIP_TTL_MS) {
		headerCache.delete(height);
		return undefined;
	}
	// Refresh LRU recency.
	headerCache.delete(height);
	headerCache.set(height, hit);
	return hit.value;
}

/** Cache a block's (hash, time) under its height. Whether the entry is trusted past
 *  the near-tip TTL is decided at READ time (see {@link getCachedHeader}) from the
 *  then-current distance from tip, so no burial flag is stored here. */
export function cacheHeader(height: number, value: { hash: string; time: number }): void {
	headerCache.delete(height);
	headerCache.set(height, { value, at: Date.now() });
	while (headerCache.size > HEADER_CACHE_MAX) {
		const oldest = headerCache.keys().next().value;
		if (oldest === undefined) break;
		headerCache.delete(oldest);
	}
}

export function headerCacheSize(): number {
	return headerCache.size;
}

/** Test hook: drop every cached header entry. */
export function clearHeaderCache(): void {
	headerCache.clear();
}

// Merkle position, keyed by `${txid}:${height}` — immutable for that pair (a reorg
// mints a new height ⇒ new key ⇒ refetch). `{ pos, merkleDepth }` so the basic-tier
// denominator estimate (2 ** depth) survives the round-trip without re-deriving.
const MERKLE_POS_CACHE_MAX = 300;
const merklePosCache = new Map<string, { pos: number; merkleDepth: number }>();

/** Cached merkle position for (txid, height), or undefined. Refreshes LRU recency. */
export function getCachedMerklePos(
	txid: string,
	height: number
): { pos: number; merkleDepth: number } | undefined {
	const key = `${txid}:${height}`;
	const hit = merklePosCache.get(key);
	if (hit !== undefined) {
		merklePosCache.delete(key);
		merklePosCache.set(key, hit);
	}
	return hit;
}

/** Cache the merkle position for (txid, height), evicting the LRU entry past the cap. */
export function cacheMerklePos(
	txid: string,
	height: number,
	value: { pos: number; merkleDepth: number }
): void {
	const key = `${txid}:${height}`;
	merklePosCache.delete(key);
	merklePosCache.set(key, value);
	while (merklePosCache.size > MERKLE_POS_CACHE_MAX) {
		const oldest = merklePosCache.keys().next().value;
		if (oldest === undefined) break;
		merklePosCache.delete(oldest);
	}
}

export function merklePosCacheSize(): number {
	return merklePosCache.size;
}

/** Test hook: drop every cached merkle position. */
export function clearMerklePosCache(): void {
	merklePosCache.clear();
}
