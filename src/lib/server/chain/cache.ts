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

import type { FeeEstimates } from '$lib/types';

/** Safety ceiling only — the tip is normally invalidated on the 'header' event
 *  the instant a block lands, long before this elapses. */
const TIP_TTL_MS = 10 * 60_000;
/** Fee estimates drift continuously; a flat short TTL is the honest model. */
const FEE_TTL_MS = 30_000;

interface Entry<T> {
	value: T;
	at: number;
}

type Tip = { height: number; hash: string };

let tipCache: Entry<Tip> | null = null;
let feeCache: Entry<FeeEstimates> | null = null;

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
}
