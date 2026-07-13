// Pure, client-safe helpers for the block-detail "depth" surfaces (Wave 3,
// cairn-6efi.7): the value-flow bar and the "largest passages" list. Kept in a
// standalone module (no server / Svelte imports) so the logic is unit-testable
// in isolation and the +page.svelte just renders the result.
//
// Cardinal rule (Explorer-redesign): absence reads as absence. Every function
// here returns null / [] rather than fabricating a zero when the underlying
// getblockstats aggregate is unavailable (Electrum-only baseline).

import type { TxDetail } from '$lib/types';

// ----------------------------------------------------------------- value flow

/** One segment of the block's value-flow bar. Segments never overlap and sum to
 *  {@link ValueFlow.total}. */
export interface ValueFlowSegment {
	key: 'transferred' | 'subsidy' | 'fees';
	sats: number;
	/** Fraction of the bar this segment occupies, 0..1. */
	fraction: number;
}

export interface ValueFlow {
	segments: ValueFlowSegment[];
	/** transferred + subsidy + fees, in sats. */
	total: number;
	transferred: number;
	subsidy: number;
	fees: number;
}

/**
 * The block's economic throughput split into three NON-overlapping quantities,
 * all sourced from `getblockstats` aggregates (no per-tx fan-out):
 *
 *   - `transferred`  value moved between parties = `total_out` (Core's
 *                    `total_out` already EXCLUDES the coinbase, so it is exactly
 *                    the non-coinbase output value — no double counting).
 *   - `subsidy`      newly minted bitcoin (deterministic from height).
 *   - `fees`         paid to the miner = `totalfee`.
 *
 * Returns null when either aggregate that must come from Core is unknown
 * (`totalOut` or `fees` null → Electrum-only), so the caller degrades the whole
 * bar to nothing rather than drawing a misleading partial bar. `subsidy` is
 * always known, but a subsidy-only bar carries no value-flow meaning.
 */
export function computeValueFlow(
	totalOut: number | null,
	fees: number | null,
	subsidy: number
): ValueFlow | null {
	if (totalOut === null || fees === null) return null;
	const transferred = Math.max(0, totalOut);
	const feeSats = Math.max(0, fees);
	const subsidySats = Math.max(0, subsidy);
	const total = transferred + subsidySats + feeSats;
	if (total <= 0) return null;

	const raw: Array<Omit<ValueFlowSegment, 'fraction'>> = [
		{ key: 'transferred', sats: transferred },
		{ key: 'subsidy', sats: subsidySats },
		{ key: 'fees', sats: feeSats }
	];
	const segments: ValueFlowSegment[] = raw.map((s) => ({ ...s, fraction: s.sats / total }));
	return { segments, total, transferred, subsidy: subsidySats, fees: feeSats };
}

// ------------------------------------------------------------ largest passages

export type PassageTag = 'coinbase' | 'consolidation' | 'batch' | 'whale' | 'payment';

export interface Passage {
	txid: string;
	/** Sum of the transaction's output values, in sats. */
	value: number;
	vinCount: number;
	voutCount: number;
	tag: PassageTag;
}

/** A single output ≥ this (100 BTC) marks a transaction a "whale" passage. */
export const WHALE_SATS = 100 * 100_000_000;
/** ≥ this many inputs collapsing into ≤2 outputs reads as a consolidation. */
export const CONSOLIDATION_MIN_VIN = 10;
/** ≥ this many outputs from ≤3 inputs reads as a batch payout. */
export const BATCH_MIN_VOUT = 10;

/** Total output value of a transaction, in sats. */
export function passageValue(tx: TxDetail): number {
	return tx.vout.reduce((sum, v) => sum + v.value, 0);
}

/**
 * Describe a transaction's shape for the "largest passages" tag. Structural
 * shapes (consolidation / batch) win over the value-based "whale" tag because a
 * large consolidation is still, first, a consolidation. Coinbase is always
 * flagged first — it is the block's reward, not a user payment.
 */
export function classifyPassage(tx: TxDetail): PassageTag {
	if (tx.vin.some((v) => v.coinbase)) return 'coinbase';
	const vin = tx.vin.length;
	const vout = tx.vout.length;
	if (vin >= CONSOLIDATION_MIN_VIN && vout <= 2) return 'consolidation';
	if (vout >= BATCH_MIN_VOUT && vin <= 3) return 'batch';
	if (passageValue(tx) >= WHALE_SATS) return 'whale';
	return 'payment';
}

/**
 * The largest transactions, by total output value, WITHIN the supplied page of
 * transactions — never a whole-block fan-out (Cardinal rule 4). Callers pass the
 * already-fetched ≤25-tx page and label the result as "largest of those shown".
 * Ties break by more inputs+outputs first (the busier tx), then txid for a
 * stable order.
 */
export function largestPassages(txs: TxDetail[], limit = 5): Passage[] {
	const passages: Passage[] = txs.map((tx) => ({
		txid: tx.txid,
		value: passageValue(tx),
		vinCount: tx.vin.length,
		voutCount: tx.vout.length,
		tag: classifyPassage(tx)
	}));
	passages.sort((a, b) => {
		if (b.value !== a.value) return b.value - a.value;
		const aBusy = a.vinCount + a.voutCount;
		const bBusy = b.vinCount + b.voutCount;
		if (bBusy !== aBusy) return bBusy - aBusy;
		return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
	});
	return passages.slice(0, Math.max(0, limit));
}
