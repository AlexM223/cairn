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
