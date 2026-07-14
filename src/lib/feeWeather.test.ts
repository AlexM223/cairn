import { describe, it, expect } from 'vitest';
import { bucketFees, buildRidge, feeRateToX, ridgeAreaPath } from './feeWeather';
import type { FeeHistogram } from '$lib/types';

const HISTOGRAM: FeeHistogram = [
	[120, 400_000],
	[55, 300_000],
	[22, 250_000],
	[9, 200_000],
	[3, 150_000],
	[1, 100_000]
];

describe('bucketFees', () => {
	it('returns null for absent/empty histograms (honest absence, not a flat zero)', () => {
		expect(bucketFees(null)).toBeNull();
		expect(bucketFees(undefined)).toBeNull();
		expect(bucketFees([])).toBeNull();
	});

	it('returns null when every entry has zero vsize', () => {
		expect(bucketFees([[10, 0], [50, 0]])).toBeNull();
	});

	it('conserves total vsize across the buckets', () => {
		const buckets = bucketFees(HISTOGRAM)!;
		const summed = buckets.reduce((s, b) => s + b.vsize, 0);
		const expected = HISTOGRAM.reduce((s, [, v]) => s + v, 0);
		expect(summed).toBe(expected);
	});

	it('files each rate into the band that contains it', () => {
		const buckets = bucketFees([[6, 111]])!;
		const band = buckets.find((b) => b.vsize > 0)!;
		expect(band.min).toBeLessThanOrEqual(6);
		expect(band.max).toBeGreaterThan(6);
	});

	it('folds a below-floor rate into the lowest band and a huge rate into the top band', () => {
		const buckets = bucketFees([[0.5, 10], [9999, 20]])!;
		expect(buckets[0].vsize).toBe(10);
		expect(buckets[buckets.length - 1].vsize).toBe(20);
		expect(buckets[buckets.length - 1].label).toMatch(/\+$/);
	});

	it('places a 19 sat/vB next-block estimate in the 15-20 band, well clear of the lowest "cheap" band (ported regression, cairn-6efi QA P2-b)', () => {
		// Source: explorer/heartwood-wave2's mempoolWeather.test.ts pinned a
		// 19 sat/vB next-block fee to a discrete "Normal (5-20)" band, never
		// "Cheap" -- that lineage's FeeWeather classifies into named bands.
		// Canonical's FeeWeather (this file) has no discrete band labels; it's
		// a continuous ridge over bucketFees()/feeRateToX(). This re-implements
		// the same invariant against that model: 19 sat/vB must bucket into
		// [15, 20), not the lowest ~1-2 sat/vB bucket, and its ridge-marker
		// x-position must sit well right of that lowest bucket's edge -- i.e.
		// the marker can never visually read as sitting in the "cheap" region.
		const buckets = bucketFees([[19, 1000]])!;
		const hit = buckets.find((b) => b.vsize > 0)!;
		expect(hit.min).toBe(15);
		expect(hit.max).toBe(20);
		const x19 = feeRateToX(19);
		const xCheapEdge = feeRateToX(2); // right edge of the lowest bucket
		expect(x19).toBeGreaterThan(xCheapEdge + 0.3);
	});
});

describe('buildRidge', () => {
	it('returns null when there is nothing to draw', () => {
		expect(buildRidge(null)).toBeNull();
		expect(buildRidge([])).toBeNull();
	});

	it('normalizes y to 0..1 with the tallest bucket at exactly 1', () => {
		const ridge = buildRidge(HISTOGRAM)!;
		const ys = ridge.points.map((p) => p.y);
		expect(Math.max(...ys)).toBe(1);
		for (const y of ys) {
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
		}
	});

	it('spans x from 0 to 1 in bucket order', () => {
		const ridge = buildRidge(HISTOGRAM)!;
		expect(ridge.points[0].x).toBe(0);
		expect(ridge.points[ridge.points.length - 1].x).toBe(1);
		for (let i = 1; i < ridge.points.length; i++) {
			expect(ridge.points[i].x).toBeGreaterThan(ridge.points[i - 1].x);
		}
	});

	it('reports maxVsize and totalVsize consistent with the buckets', () => {
		const ridge = buildRidge(HISTOGRAM)!;
		expect(ridge.maxVsize).toBe(Math.max(...ridge.buckets.map((b) => b.vsize)));
		expect(ridge.totalVsize).toBe(ridge.buckets.reduce((s, b) => s + b.vsize, 0));
	});
});

describe('feeRateToX', () => {
	it('clamps to 0 at/below the floor and 1 at the open top', () => {
		expect(feeRateToX(0.2)).toBe(0);
		expect(feeRateToX(1)).toBe(0);
		expect(feeRateToX(100_000)).toBe(1);
	});

	it('is monotonic increasing across rates', () => {
		const rates = [1, 3, 8, 20, 55, 120, 300];
		const xs = rates.map(feeRateToX);
		for (let i = 1; i < xs.length; i++) {
			expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
		}
	});

	it('stays within the unit interval', () => {
		for (const r of [0.1, 2.5, 47, 199, 5000]) {
			const x = feeRateToX(r);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(1);
		}
	});

	// cairn-eacw.6: sub-1 sat/vB rates (a node with a relay floor below 1) are
	// real, honest data now — this pins the deliberate degradation the audit
	// signed off on (EDGES starts at 1, so sub-1 mass lands in the lowest band
	// and its marker sits at the left wall) as INTENTIONAL, not silently lossy:
	// the mass is still counted (never dropped), just not visually distinguished
	// from the [1,2) band until sub-1 rates are common enough to earn their own
	// leading edge.
	it('folds sub-1 sat/vB mass into the lowest band honestly (counted, not dropped) rather than a dedicated sub-1 edge', () => {
		expect(feeRateToX(0.04)).toBe(0);
		const buckets = bucketFees([[0.04, 500]])!;
		expect(buckets[0].vsize).toBe(500); // counted in the lowest band...
		expect(buckets[0].min).toBe(1); // ...which still reads "1–2", not "0.04–…"
	});
});

describe('ridgeAreaPath', () => {
	it('produces a closed area path for a real ridge', () => {
		const ridge = buildRidge(HISTOGRAM)!;
		const d = ridgeAreaPath(ridge.points, 300, 120);
		expect(d.startsWith('M')).toBe(true);
		expect(d.trimEnd().endsWith('Z')).toBe(true);
		expect(d).toContain('C'); // smoothed with cubic segments
		expect(d).not.toContain('NaN');
	});

	it('degrades to a flat baseline for empty input instead of an invalid path', () => {
		const d = ridgeAreaPath([], 300, 120);
		expect(d).toBe('M0 120 L300 120 Z');
	});

	it('handles a single point without emitting NaN', () => {
		const ridge = buildRidge([[10, 500]])!;
		const single = ridge.points.filter((p) => p.y > 0);
		const d = ridgeAreaPath(single.length ? single : ridge.points.slice(0, 1), 200, 100);
		expect(d).not.toContain('NaN');
		expect(d.startsWith('M')).toBe(true);
		expect(d.trimEnd().endsWith('Z')).toBe(true);
	});
});
