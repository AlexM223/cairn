// FeeWeather — pure geometry + bucketing for the mempool fee-distribution ridge.
//
// The mempool exposes a fee histogram as [feeRate sat/vB, vsize] pairs (highest
// rate first). This module turns that into a "ridge" (an area-chart silhouette of
// the waiting virtual-byte mass across the fee-rate spectrum) plus the flat band
// buckets that the bar-chart fallback renders. It is deliberately dependency-free
// and deterministic so it can be unit-tested and so the visualization stays
// CSS/SVG-first with no charting library.
//
// Honesty (Cardinal rules): an absent/empty histogram returns null — the caller
// then degrades that panel honestly rather than drawing a flat "zero" ridge. We
// never invent mass where the backend reported none.

import type { FeeHistogram } from '$lib/types';

/** One fee-rate bucket of the ridge / fallback bars. */
export interface FeeBucket {
	/** Lower bound, sat/vB (inclusive). */
	min: number;
	/** Upper bound, sat/vB (exclusive); Infinity for the open-ended top bucket. */
	max: number;
	/** Human label, e.g. "1–2", "100+". */
	label: string;
	/** Total waiting virtual bytes whose fee rate falls in [min, max). */
	vsize: number;
}

/** A point on the ridge silhouette in the unit square: x left→right across the
 *  fee spectrum, y where 0 = baseline and 1 = the tallest bucket. */
export interface RidgePoint {
	x: number;
	y: number;
	bucket: FeeBucket;
}

export interface Ridge {
	buckets: FeeBucket[];
	points: RidgePoint[];
	/** Waiting vsize in the tallest bucket (the y=1 reference). */
	maxVsize: number;
	/** Sum of vsize across all buckets. */
	totalVsize: number;
}

// Log-ish fee-rate edges. The spread mirrors the sat/vB rates users actually see
// (1 sat/vB floor through a >250 sat/vB bidding war), finer near the bottom where
// most mempools live. The top edge is open-ended so extreme fees never fall off.
const EDGES = [1, 2, 3, 4, 6, 8, 10, 15, 20, 30, 50, 75, 100, 150, 250, Infinity] as const;

/** Bucket a raw fee histogram into fixed fee-rate bands, or null when there is no
 *  histogram to bucket (absent backend field or an empty mempool). */
export function bucketFees(histogram: FeeHistogram | null | undefined): FeeBucket[] | null {
	if (!histogram || histogram.length === 0) return null;
	const buckets: FeeBucket[] = [];
	for (let i = 0; i < EDGES.length - 1; i++) {
		const min = EDGES[i];
		const max = EDGES[i + 1];
		buckets.push({
			min,
			max,
			label: max === Infinity ? `${min}+` : `${min}–${max}`,
			vsize: 0
		});
	}
	let any = false;
	for (const [rate, vsize] of histogram) {
		if (!(vsize > 0)) continue;
		// Rates below the floor still count toward the lowest band.
		const b =
			buckets.find((x) => rate >= x.min && rate < x.max) ??
			(rate < buckets[0].min ? buckets[0] : buckets[buckets.length - 1]);
		b.vsize += vsize;
		any = true;
	}
	// A histogram that summed to nothing is honestly "no mass", not a flat ridge.
	return any ? buckets : null;
}

/** Build the ridge silhouette from a histogram, or null when there's nothing to
 *  draw. Points are in the unit square; the caller scales them to its viewBox. */
export function buildRidge(histogram: FeeHistogram | null | undefined): Ridge | null {
	const buckets = bucketFees(histogram);
	if (!buckets) return null;
	let maxVsize = 0;
	let totalVsize = 0;
	for (const b of buckets) {
		if (b.vsize > maxVsize) maxVsize = b.vsize;
		totalVsize += b.vsize;
	}
	const denom = maxVsize > 0 ? maxVsize : 1;
	const lastX = buckets.length - 1;
	const points: RidgePoint[] = buckets.map((bucket, i) => ({
		x: lastX === 0 ? 0 : i / lastX,
		y: bucket.vsize / denom,
		bucket
	}));
	return { buckets, points, maxVsize, totalVsize };
}

/**
 * Fraction 0..1 across the ridge x-axis where a given fee rate sits, using the
 * same bucket edges as the ridge so a marker (e.g. the next-block fee) lines up
 * with the silhouette. Clamped to the drawn range.
 */
export function feeRateToX(rate: number): number {
	const lastX = EDGES.length - 2; // number of buckets - 1
	if (rate <= EDGES[0]) return 0;
	for (let i = 0; i < EDGES.length - 1; i++) {
		const lo = EDGES[i];
		const hi = EDGES[i + 1];
		if (rate >= lo && (hi === Infinity || rate < hi)) {
			if (hi === Infinity) return 1;
			// Interpolate within the bucket in log space so the marker tracks the
			// visually log-spaced edges.
			const t = (Math.log(rate) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
			return Math.min(1, Math.max(0, (i + t) / lastX));
		}
	}
	return 1;
}

/**
 * A smooth closed SVG path (area under a Catmull-Rom spline through the points)
 * scaled to a `w`×`h` box, with y inverted so a taller bucket rises. Baseline is
 * `h` (the bottom). Deterministic; used by the ridge <svg>. Falls back to a flat
 * baseline path for degenerate input so callers never emit an invalid `d`.
 */
export function ridgeAreaPath(points: RidgePoint[], w: number, h: number): string {
	if (points.length === 0) return `M0 ${h} L${w} ${h} Z`;
	const px = points.map((p) => ({ x: p.x * w, y: h - p.y * h }));
	if (px.length === 1) {
		return `M0 ${h} L0 ${round(px[0].y)} L${w} ${round(px[0].y)} L${w} ${h} Z`;
	}
	let d = `M${round(px[0].x)} ${h} L${round(px[0].x)} ${round(px[0].y)}`;
	for (let i = 0; i < px.length - 1; i++) {
		const p0 = px[i - 1] ?? px[i];
		const p1 = px[i];
		const p2 = px[i + 1];
		const p3 = px[i + 2] ?? p2;
		// Catmull-Rom → cubic Bézier control points (tension 1/6).
		const c1x = p1.x + (p2.x - p0.x) / 6;
		const c1y = p1.y + (p2.y - p0.y) / 6;
		const c2x = p2.x - (p3.x - p1.x) / 6;
		const c2y = p2.y - (p3.y - p1.y) / 6;
		d += ` C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2.x)} ${round(p2.y)}`;
	}
	d += ` L${round(px[px.length - 1].x)} ${h} Z`;
	return d;
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}
