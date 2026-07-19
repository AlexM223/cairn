// Coinbase (mining reward) output maturity. Bitcoin consensus requires a coinbase
// output to reach 100 confirmations before it can be spent — this protects against
// loss if the mining block is later reorganized out of the chain. Pure and shared
// between server (PSBT construction guard) and client (coin control / detail UI).

/** Confirmations a coinbase output needs before it can be spent (consensus rule). */
export const COINBASE_MATURITY = 100;

/** Rough minutes per block, for the "time until spendable" estimate. */
const BLOCK_MINUTES = 10;

export interface CoinbaseMaturity {
	/** Confirmations so far: tip - height + 1, clamped to 0 (0 = unconfirmed). */
	confirmations: number;
	/** Confirmations required to spend (COINBASE_MATURITY). */
	required: number;
	/** True once the output can be spent. */
	mature: boolean;
	/** Blocks still needed before it matures (0 when mature). */
	blocksRemaining: number;
	/** Rough hours until mature, rounded up (0 when mature). */
	etaHours: number;
}

/**
 * Maturity of a coinbase output confirmed at block `height`, given the current
 * chain `tipHeight`. An unconfirmed output (height <= 0) reports 0 confirmations.
 */
export function coinbaseMaturity(height: number, tipHeight: number): CoinbaseMaturity {
	const confirmations = height > 0 && tipHeight >= height ? tipHeight - height + 1 : 0;
	const blocksRemaining = Math.max(0, COINBASE_MATURITY - confirmations);
	return {
		confirmations,
		required: COINBASE_MATURITY,
		mature: confirmations >= COINBASE_MATURITY,
		blocksRemaining,
		etaHours: Math.ceil((blocksRemaining * BLOCK_MINUTES) / 60)
	};
}

/** True when a coinbase output at `height` is NOT yet spendable at `tipHeight`. */
export function isImmatureCoinbase(height: number, tipHeight: number): boolean {
	return !coinbaseMaturity(height, tipHeight).mature;
}

/**
 * Display-side maturity classification of one CONFIRMED coin — the single
 * shared answer to "may this coin be presented as spendable?" (cairn-8lwa6 /
 * 25ges / e176o / i0d0q root cause: maturity was never modeled as a
 * first-class state, so every surface re-derived it differently and the
 * display path failed OPEN where the send path failed closed).
 *
 *   - 'spendable'  — a regular coin, or a coinbase output past COINBASE_MATURITY.
 *   - 'maturing'   — a DEFINITE coinbase output not yet mature (or tip unknown:
 *                    over-reporting "maturing" is safe; under-reporting isn't).
 *   - 'unverified' — coinbase-ness could not be established ('unknown', e.g.
 *                    the funding tx was unfetchable) AND the coin is young
 *                    enough that IF it were coinbase it would be immature (or
 *                    the tip is unknown). Mirrors the send path's guard
 *                    (`selectSpendCandidates`, psbt.ts): fail CLOSED on
 *                    presentation — an unverifiable young coin must never
 *                    silently render as plain spendable money.
 *
 * Caller contract: only pass CONFIRMED coins (height > 0). Unconfirmed coins
 * live in the separate `unconfirmed` bucket and are never part of a confirmed
 * balance, so classifying them here would double-count.
 */
export type MaturityClass = 'spendable' | 'maturing' | 'unverified';

export function classifyCoinMaturity(
	coinbase: boolean | 'unknown' | undefined,
	height: number,
	tipHeight: number
): MaturityClass {
	if (coinbase === true) return isImmatureCoinbase(height, tipHeight) ? 'maturing' : 'spendable';
	if (coinbase === false) return 'spendable';
	// 'unknown' (or never annotated): old enough that even a coinbase would have
	// matured → provably spendable regardless; otherwise unverifiable.
	if (tipHeight > 0 && !isImmatureCoinbase(height, tipHeight)) return 'spendable';
	return 'unverified';
}

/**
 * Human ETA for `blocksRemaining` blocks at ~10 min/block (cairn-oae1.4), e.g.
 * "~9.7 hours" for 58 blocks, "~10 minutes" for 1 block. 1-decimal hours once
 * the wait crosses an hour; whole minutes below that — a bare rounded-up hour
 * ("~1h", `etaHours` above) reads wrong for a coin that matures in 6 minutes.
 */
export function formatMaturityEta(blocksRemaining: number): string {
	const minutes = blocksRemaining * BLOCK_MINUTES;
	if (minutes < 60) return `~${Math.round(minutes)} minutes`;
	return `~${(minutes / 60).toFixed(1)} hours`;
}
