// Geometry and synthesis for the mempool block visualizer.
//
// Public APIs expose projected blocks only as aggregates (tx count, vsize,
// fee range) plus a mempool-wide fee histogram — there is no per-transaction
// projection feed. The rectangles rendered here are therefore *representative*
// transactions: their fee rates and the vsize they cover come from the live
// histogram, their count and typical size from the projected block's own
// aggregates. The page says as much to the user.

import type { FeeHistogram, MempoolBlockProjection } from '$lib/types';

export interface VizRect {
	/** Layout in unit coordinates (0..1) — scale by container size. */
	x: number;
	y: number;
	w: number;
	h: number;
	feeRate: number; // sat/vB
	vsize: number; // virtual bytes this rectangle covers
	txCount: number; // ≥1; >1 means the rectangle stands for several small txs
	fee: number; // sats, estimated: feeRate * vsize
	key: string; // stable across refreshes for smooth CSS transitions
}

export interface VizBlock {
	projection: MempoolBlockProjection;
	rects: VizRect[];
}

const MAX_RECTS_PER_BLOCK = 90;

/**
 * Cheap stable fingerprint of the inputs to `synthesizeBlocks`. Callers can
 * compare keys between polls and skip re-synthesizing (and re-rendering) when
 * the mempool picture hasn't moved. Not a cryptographic hash — just lengths,
 * first/last entries and totals, which is plenty to detect real changes.
 */
export function synthKey(
	histogram: FeeHistogram | null,
	projected: MempoolBlockProjection[] | null
): string {
	const parts: (string | number)[] = [];
	if (histogram && histogram.length > 0) {
		let totalVsize = 0;
		for (const [, vsize] of histogram) totalVsize += vsize;
		const [firstRate, firstVsize] = histogram[0];
		const [lastRate, lastVsize] = histogram[histogram.length - 1];
		parts.push('h', histogram.length, firstRate, firstVsize, lastRate, lastVsize, Math.round(totalVsize));
	} else {
		parts.push('h0');
	}
	if (projected && projected.length > 0) {
		parts.push('p', projected.length);
		for (const b of projected) {
			parts.push(b.nTx, Math.round(b.vsize), b.totalFees, b.medianFee, b.feeRange[0], b.feeRange[1]);
		}
	} else {
		parts.push('p0');
	}
	return parts.join('|');
}

/** Deterministic hash → [0,1). Stable keys/sizes across polls, no Math.random. */
function unitHash(...parts: number[]): number {
	let h = 2166136261;
	for (const p of parts) {
		h ^= Math.round(p * 1000) & 0xffffffff;
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 100000) / 100000;
}

/**
 * Distribute the fee histogram (highest fee rate first) across the projected
 * blocks and synthesize a rectangle set for each.
 */
export function synthesizeBlocks(
	histogram: FeeHistogram | null,
	projected: MempoolBlockProjection[] | null,
	maxBlocks = 6
): VizBlock[] {
	if (!projected || projected.length === 0) return [];
	const blocks = projected.slice(0, maxBlocks);

	// Walk the histogram once, slicing each block its share of vsize.
	const slices: { rate: number; vsize: number }[][] = blocks.map(() => []);
	if (histogram && histogram.length > 0) {
		let blockIdx = 0;
		let remaining = blocks[0].vsize;
		for (const [rate, vsize] of histogram) {
			let left = vsize;
			while (left > 0 && blockIdx < blocks.length) {
				const take = Math.min(left, remaining);
				if (take > 0) slices[blockIdx].push({ rate, vsize: take });
				left -= take;
				remaining -= take;
				if (remaining <= 0) {
					blockIdx++;
					remaining = blockIdx < blocks.length ? blocks[blockIdx].vsize : 0;
				}
			}
			if (blockIdx >= blocks.length) break;
		}
	}

	return blocks.map((projection, bi) => {
		let blockSlices = slices[bi];
		// Histogram exhausted (or absent): fall back to the block's own range.
		if (blockSlices.length === 0) {
			blockSlices = [{ rate: projection.medianFee, vsize: projection.vsize }];
		}

		const avgTxVsize = projection.vsize / Math.max(1, projection.nTx);
		const totalEstTxs = blockSlices.reduce((s, sl) => s + sl.vsize / avgTxVsize, 0);
		const scale = Math.min(1, MAX_RECTS_PER_BLOCK / Math.max(1, totalEstTxs));

		const rects: Omit<VizRect, 'x' | 'y' | 'w' | 'h'>[] = [];
		blockSlices.forEach((slice, si) => {
			const estTxs = Math.max(1, slice.vsize / avgTxVsize);
			const rectCount = Math.max(1, Math.round(estTxs * scale));
			// Organic-looking size spread that still sums to the slice's vsize.
			const weights: number[] = [];
			for (let ri = 0; ri < rectCount; ri++) {
				weights.push(0.35 + unitHash(bi, si, ri, slice.rate) * 2.25);
			}
			const weightSum = weights.reduce((a, b) => a + b, 0);
			for (let ri = 0; ri < rectCount; ri++) {
				const vsize = (slice.vsize * weights[ri]) / weightSum;
				rects.push({
					feeRate: slice.rate,
					vsize,
					txCount: Math.max(1, Math.round(estTxs / rectCount)),
					fee: Math.round(slice.rate * vsize),
					key: `${bi}:${si}:${ri}`
				});
			}
		});

		return { projection, rects: squarify(rects, projection.vsize) };
	});
}

/**
 * Squarified treemap layout in a unit square (Bruls, Huizing, van Wijk).
 * Items are laid out largest-first so aspect ratios stay near 1.
 */
function squarify(
	items: Omit<VizRect, 'x' | 'y' | 'w' | 'h'>[],
	totalVsize: number
): VizRect[] {
	const sorted = [...items].sort((a, b) => b.vsize - a.vsize);
	const total = Math.max(1, totalVsize);
	const out: VizRect[] = [];

	let x = 0;
	let y = 0;
	let w = 1;
	let h = 1;
	let i = 0;

	while (i < sorted.length) {
		const shortSide = Math.min(w, h);
		// Grow the current row while it improves the worst aspect ratio.
		let rowArea = 0;
		let rowEnd = i;
		let worst = Infinity;
		while (rowEnd < sorted.length) {
			const area = sorted[rowEnd].vsize / total;
			const nextRowArea = rowArea + area;
			const rowLen = nextRowArea / shortSide;
			let candidateWorst = 1;
			for (let j = i; j <= rowEnd; j++) {
				const side = sorted[j].vsize / total / rowLen;
				const ratio = Math.max(rowLen / Math.max(side, 1e-9), side / Math.max(rowLen, 1e-9));
				candidateWorst = Math.max(candidateWorst, ratio);
			}
			if (candidateWorst > worst) break;
			worst = candidateWorst;
			rowArea = nextRowArea;
			rowEnd++;
		}
		if (rowEnd === i) rowEnd = i + 1; // always place at least one

		const rowLen = rowArea / shortSide || 0;
		// Lay the row along the short side, then shrink the free area.
		let offset = 0;
		for (let j = i; j < rowEnd; j++) {
			const frac = rowArea > 0 ? sorted[j].vsize / total / rowArea : 1 / (rowEnd - i);
			const side = shortSide * frac;
			if (w >= h) {
				out.push({ ...sorted[j], x: x, y: y + offset, w: rowLen, h: side });
			} else {
				out.push({ ...sorted[j], x: x + offset, y: y, w: side, h: rowLen });
			}
			offset += side;
		}
		if (w >= h) {
			x += rowLen;
			w -= rowLen;
		} else {
			y += rowLen;
			h -= rowLen;
		}
		i = rowEnd;
	}
	return out;
}

// ------------------------------------------------------------------ color

/** Warm ramp anchors: cool steel → copper → amber → hot red, by fee rate. */
const RAMP: [number, [number, number, number]][] = [
	[1, [94, 114, 128]],
	[3, [110, 127, 134]],
	[6, [138, 133, 120]],
	[12, [192, 137, 96]],
	[25, [232, 147, 90]],
	[50, [232, 180, 90]],
	[100, [232, 201, 90]],
	[250, [232, 90, 90]]
];

/** Fee rate (sat/vB) → CSS color on the forge ramp, interpolated in log space. */
export function feeColor(rate: number): string {
	const r = Math.max(RAMP[0][0], Math.min(rate, RAMP[RAMP.length - 1][0]));
	for (let i = 0; i < RAMP.length - 1; i++) {
		const [a, ca] = RAMP[i];
		const [b, cb] = RAMP[i + 1];
		if (r >= a && r <= b) {
			const t = (Math.log(r) - Math.log(a)) / (Math.log(b) - Math.log(a));
			const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
			return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
		}
	}
	return 'rgb(232, 90, 90)';
}
