// Pure layout math for the tx-detail Sankey-lite value-flow diagram
// (cairn-6efi.8, Explorer redesign Wave 3). Given an already-decoded transaction
// (no new chain calls — the tx page already loaded it), it produces proportional
// bands for inputs → outputs + fee. Kept pure and side-effect-free so the
// geometry is unit-testable in isolation from the Svelte component that renders
// it.
//
// Cardinal rules honored (docs/EXPLORER-REDESIGN-2026-07-12.md):
//   • Absence reads as absence: when input values are unknown (backend didn't
//     resolve prevouts) we return null and the page falls back to its textual
//     input/output list — we NEVER invent a proportion.
//   • Coinbase has no inputs: its single left band represents the newly minted
//     coins (subsidy + collected fees), and there is no separate "→ the miner"
//     fee band (the miner IS the recipient).
//   • Many-in / many-out is capped to a handful of bands with an honest
//     "+N more" aggregate whose height still reflects the summed value.

import type { TxDetail } from '$lib/types';

/** Max proportional bands rendered per side before the tail collapses into a
 *  single honest "+N more" aggregate band. */
export const MAX_FLOW_BANDS = 6;

export type FlowBandKind = 'input' | 'output' | 'fee' | 'more';

export interface FlowBand {
	kind: FlowBandKind;
	/** Address for a normal input/output; null for coinbase source, OP_RETURN /
	 *  non-address outputs, unknown inputs, the fee band, and "more" aggregates. */
	address: string | null;
	/** Output scriptType (e.g. 'op_return'); null for inputs/fee/more. */
	scriptType: string | null;
	/** Value in sats. Always known here (null-value inputs abort the whole layout). */
	value: number;
	/** Share of the side total, 0..1. Both sides sum to ~1 (outputs + fee = inputs). */
	pct: number;
	/** Rows folded into this band: 1 normally, N for a "more" aggregate. */
	count: number;
	/** Output that pays an address which also funded an input — certain change. */
	isChange: boolean;
	/** Touches one of the viewing user's own wallets (viewer-scoped, opt-in). */
	isYours: boolean;
	/** The synthetic coinbase "New coins" source band. */
	isCoinbaseSource: boolean;
}

export interface TxFlow {
	coinbase: boolean;
	/** The shared denominator both columns are drawn against (= inputTotal). */
	sideTotal: number;
	inputTotal: number;
	outputTotal: number;
	/** Fee in sats, or null when it can't be shown (coinbase / unknown). */
	feeValue: number | null;
	/** Fee share of sideTotal, 0..1 (0 when feeValue is null). */
	feePct: number;
	inputs: FlowBand[];
	outputs: FlowBand[];
	/** The "→ the miner" band, or null (coinbase / zero / unknown fee). */
	fee: FlowBand | null;
	/** Inputs folded into the trailing input "+N more" band (0 when none). */
	inputsMore: number;
	/** Outputs folded into the trailing output "+N more" band (0 when none). */
	outputsMore: number;
}

export interface TxFlowOptions {
	/** Addresses belonging to the viewing user's own wallets, for the "Yours"
	 *  tint. Viewer-scoped; empty/absent means no personal highlighting. */
	yours?: Set<string> | null;
	/** Override the per-side band cap (tests). */
	maxBands?: number;
}

interface RawBand {
	address: string | null;
	scriptType: string | null;
	value: number;
	isChange: boolean;
	isYours: boolean;
}

/** Collapse a raw band list to at most `max` bands: when it overflows, keep the
 *  (max − 1) largest and fold the rest into one honest "+N more" aggregate whose
 *  value is the summed tail. Returns the kept bands (largest-first when capped,
 *  original order otherwise) and the folded count. */
function capBands(
	raw: RawBand[],
	max: number,
	kind: 'input' | 'output',
	sideTotal: number
): { bands: FlowBand[]; more: number } {
	const toBand = (r: RawBand, k: FlowBandKind, count: number): FlowBand => ({
		kind: k,
		address: r.address,
		scriptType: r.scriptType,
		value: r.value,
		pct: sideTotal > 0 ? r.value / sideTotal : 0,
		count,
		isChange: r.isChange,
		isYours: r.isYours,
		isCoinbaseSource: false
	});

	if (raw.length <= max) {
		return { bands: raw.map((r) => toBand(r, kind, 1)), more: 0 };
	}

	const sorted = [...raw].sort((a, b) => b.value - a.value);
	const kept = sorted.slice(0, max - 1);
	const tail = sorted.slice(max - 1);
	const tailValue = tail.reduce((s, r) => s + r.value, 0);
	const bands = kept.map((r) => toBand(r, kind, 1));
	bands.push({
		kind: 'more',
		address: null,
		scriptType: null,
		value: tailValue,
		pct: sideTotal > 0 ? tailValue / sideTotal : 0,
		count: tail.length,
		isChange: false,
		// The aggregate is "yours" only if EVERY folded row is yours — otherwise we
		// must not imply the whole tail belongs to the viewer.
		isYours: tail.length > 0 && tail.every((r) => r.isYours),
		isCoinbaseSource: false
	});
	return { bands, more: tail.length };
}

/**
 * Build the proportional value-flow layout for a decoded transaction, or null
 * when it can't be drawn honestly (non-coinbase tx with any unresolved input
 * value, or a non-positive total). Callers render the textual i/o list instead
 * when this returns null.
 */
export function computeTxFlow(tx: TxDetail, opts: TxFlowOptions = {}): TxFlow | null {
	const yours = opts.yours ?? null;
	const max = Math.max(2, opts.maxBands ?? MAX_FLOW_BANDS);
	const isYours = (addr: string | null) => addr !== null && !!yours && yours.has(addr);

	const coinbase = tx.vin.some((v) => v.coinbase);
	const outputTotal = tx.vout.reduce((s, v) => s + v.value, 0);

	// Addresses that funded an input — an output paying one of these is change.
	const inputAddresses = new Set(
		tx.vin.map((v) => v.address).filter((a): a is string => a !== null)
	);

	const rawOutputs: RawBand[] = tx.vout.map((v) => ({
		address: v.address,
		scriptType: v.scriptType,
		value: v.value,
		isChange: v.address !== null && inputAddresses.has(v.address),
		isYours: isYours(v.address)
	}));

	if (coinbase) {
		// No inputs to proportion; the left side is a single "New coins" band equal
		// to the total claimed by the outputs. No separate fee band.
		const sideTotal = outputTotal;
		if (sideTotal <= 0) return null;
		const inputs: FlowBand[] = [
			{
				kind: 'input',
				address: null,
				scriptType: null,
				value: sideTotal,
				pct: 1,
				count: 1,
				isChange: false,
				isYours: false,
				isCoinbaseSource: true
			}
		];
		const { bands: outputs, more: outputsMore } = capBands(rawOutputs, max, 'output', sideTotal);
		return {
			coinbase: true,
			sideTotal,
			inputTotal: sideTotal,
			outputTotal,
			feeValue: null,
			feePct: 0,
			inputs,
			outputs,
			fee: null,
			inputsMore: 0,
			outputsMore
		};
	}

	// Non-coinbase: every input value must be known to draw honest proportions.
	if (tx.vin.some((v) => v.value === null)) return null;
	const inputTotal = tx.vin.reduce((s, v) => s + (v.value ?? 0), 0);
	if (inputTotal <= 0) return null;

	const sideTotal = inputTotal;
	// Prefer the derived fee (inputs − outputs) so the two columns sum to exactly
	// the same total; fall back to the reported fee if inputs somehow exceed the
	// side total by rounding. Never negative.
	const derivedFee = inputTotal - outputTotal;
	const feeValue = derivedFee >= 0 ? derivedFee : Math.max(0, tx.fee ?? 0);

	const rawInputs: RawBand[] = tx.vin.map((v) => ({
		address: v.address,
		scriptType: null,
		value: v.value ?? 0,
		isChange: false,
		isYours: isYours(v.address)
	}));

	const { bands: inputs, more: inputsMore } = capBands(rawInputs, max, 'input', sideTotal);
	const { bands: outputs, more: outputsMore } = capBands(rawOutputs, max, 'output', sideTotal);

	const fee: FlowBand | null =
		feeValue > 0
			? {
					kind: 'fee',
					address: null,
					scriptType: null,
					value: feeValue,
					pct: sideTotal > 0 ? feeValue / sideTotal : 0,
					count: 1,
					isChange: false,
					isYours: false,
					isCoinbaseSource: false
				}
			: null;

	return {
		coinbase: false,
		sideTotal,
		inputTotal,
		outputTotal,
		feeValue,
		feePct: fee ? fee.pct : 0,
		inputs,
		outputs,
		fee,
		inputsMore,
		outputsMore
	};
}

// ------------------------------------------------------------------ Fee sliver

export interface FeePosition {
	/** This tx's fee rate, sat/vB. */
	feeRate: number;
	/** Lowest / highest fee rate present in the mempool histogram, sat/vB. */
	min: number;
	max: number;
	/** Fraction of pending vsize paying a STRICTLY higher rate — roughly how much
	 *  of the mempool is ahead of this tx in the queue. 0..1. */
	ahead: number;
	/** Marker position of feeRate mapped into [min,max], clamped 0..1. */
	pos: number;
}

/**
 * Where this tx's fee rate sits in the current mempool fee distribution, derived
 * from the persisted snapshot histogram (no chain call). Returns null when the
 * histogram is absent/empty or the fee rate is unknown — the sliver then simply
 * isn't rendered (degrade to nothing, never fake a position).
 *
 * `histogram` is [feeRate sat/vB, vsize] pairs (order irrelevant here).
 */
export function computeFeePosition(
	feeRate: number | null,
	histogram: [number, number][] | null | undefined
): FeePosition | null {
	if (feeRate === null || !Number.isFinite(feeRate)) return null;
	if (!histogram || histogram.length === 0) return null;

	let totalVsize = 0;
	let aheadVsize = 0;
	let min = Infinity;
	let max = -Infinity;
	for (const [rate, vsize] of histogram) {
		if (!Number.isFinite(rate) || !Number.isFinite(vsize) || vsize < 0) continue;
		totalVsize += vsize;
		if (rate > feeRate) aheadVsize += vsize;
		if (rate < min) min = rate;
		if (rate > max) max = rate;
	}
	if (totalVsize <= 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null;

	const ahead = aheadVsize / totalVsize;
	const pos = max > min ? Math.min(1, Math.max(0, (feeRate - min) / (max - min))) : 0.5;
	return { feeRate, min, max, ahead, pos };
}
