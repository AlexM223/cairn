import { describe, it, expect } from 'vitest';
import { synthesizeBlocks, feeColor } from './mempoolViz';
import type { FeeHistogram, MempoolBlockProjection } from '$lib/types';

function projection(overrides: Partial<MempoolBlockProjection> = {}): MempoolBlockProjection {
	return {
		nTx: 2000,
		vsize: 1_000_000,
		totalFees: 20_000_000,
		medianFee: 10,
		feeRange: [1, 100],
		...overrides
	};
}

// Histogram (highest rate first) with more total vsize than the two blocks hold.
const HISTOGRAM: FeeHistogram = [
	[100, 500_000],
	[50, 500_000],
	[20, 500_000],
	[10, 500_000],
	[5, 500_000]
];

describe('synthesizeBlocks', () => {
	const projections = [projection(), projection()];

	it('rect vsizes per block sum to the projection vsize (±1%)', () => {
		const blocks = synthesizeBlocks(HISTOGRAM, projections);
		expect(blocks).toHaveLength(2);
		for (const block of blocks) {
			const sum = block.rects.reduce((s, r) => s + r.vsize, 0);
			expect(Math.abs(sum - block.projection.vsize) / block.projection.vsize).toBeLessThan(0.01);
		}
	});

	it('treemap areas sum to ~1.0 (±0.5%)', () => {
		const blocks = synthesizeBlocks(HISTOGRAM, projections);
		for (const block of blocks) {
			const area = block.rects.reduce((s, r) => s + r.w * r.h, 0);
			expect(Math.abs(area - 1)).toBeLessThan(0.005);
		}
	});

	it('keeps all rects within the unit square', () => {
		const blocks = synthesizeBlocks(HISTOGRAM, projections);
		const eps = 1e-6;
		for (const block of blocks) {
			for (const r of block.rects) {
				expect(r.x).toBeGreaterThanOrEqual(-eps);
				expect(r.y).toBeGreaterThanOrEqual(-eps);
				expect(r.w).toBeGreaterThanOrEqual(0);
				expect(r.h).toBeGreaterThanOrEqual(0);
				expect(r.x + r.w).toBeLessThanOrEqual(1 + eps);
				expect(r.y + r.h).toBeLessThanOrEqual(1 + eps);
			}
		}
	});

	it('emits at most 90 rects per block', () => {
		const blocks = synthesizeBlocks(HISTOGRAM, projections);
		for (const block of blocks) {
			expect(block.rects.length).toBeGreaterThan(0);
			expect(block.rects.length).toBeLessThanOrEqual(90);
		}
	});

	it('assigns histogram fee rates highest-first across blocks', () => {
		const blocks = synthesizeBlocks(HISTOGRAM, projections);
		const ratesIn = (b: (typeof blocks)[number]) => new Set(b.rects.map((r) => r.feeRate));
		// Block 0 gets the 100 and 50 sat/vB slices, block 1 the 20 and 10 slices.
		expect([...ratesIn(blocks[0])].sort((a, b) => a - b)).toEqual([50, 100]);
		expect([...ratesIn(blocks[1])].sort((a, b) => a - b)).toEqual([10, 20]);
	});

	it('is deterministic — two identical calls deep-equal', () => {
		const a = synthesizeBlocks(HISTOGRAM, projections);
		const b = synthesizeBlocks(HISTOGRAM, projections);
		expect(a).toEqual(b);
	});

	it('returns [] for empty or null projections', () => {
		expect(synthesizeBlocks(HISTOGRAM, null)).toEqual([]);
		expect(synthesizeBlocks(HISTOGRAM, [])).toEqual([]);
		expect(synthesizeBlocks(null, null)).toEqual([]);
	});

	it('falls back to the block median fee when the histogram is missing or empty', () => {
		for (const histogram of [null, [] as FeeHistogram]) {
			const blocks = synthesizeBlocks(histogram, [projection({ medianFee: 7 })]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].rects.length).toBeGreaterThan(0);
			for (const r of blocks[0].rects) expect(r.feeRate).toBe(7);
		}
	});

	it('respects maxBlocks', () => {
		const many = Array.from({ length: 10 }, () => projection());
		expect(synthesizeBlocks(HISTOGRAM, many, 3)).toHaveLength(3);
		expect(synthesizeBlocks(HISTOGRAM, many)).toHaveLength(6); // default 6
	});
});

describe('feeColor', () => {
	const parse = (css: string): [number, number, number] => {
		const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
		expect(m, css).not.toBeNull();
		return [Number(m![1]), Number(m![2]), Number(m![3])];
	};

	it('returns rgb() strings', () => {
		for (const rate of [0.1, 1, 7, 42, 250, 9999]) {
			expect(feeColor(rate)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
		}
	});

	it('low rates are cool steel (blue over red)', () => {
		const [r, , b] = parse(feeColor(1));
		expect(b).toBeGreaterThan(r);
	});

	it('high rates are hot red (red over blue)', () => {
		const [r, , b] = parse(feeColor(250));
		expect(r).toBeGreaterThan(b);
	});

	it('clamps below and above the ramp', () => {
		expect(feeColor(0.001)).toBe(feeColor(1));
		expect(feeColor(100_000)).toBe(feeColor(250));
	});

	it('warmth is monotonic: red channel never decreases from 1 to 250 sat/vB', () => {
		let prev = -Infinity;
		for (let rate = 1; rate <= 250; rate += 0.5) {
			const [r] = parse(feeColor(rate));
			expect(r, `rate ${rate}`).toBeGreaterThanOrEqual(prev);
			prev = r;
		}
	});
});
