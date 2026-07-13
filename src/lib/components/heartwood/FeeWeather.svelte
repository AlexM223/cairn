<script lang="ts">
	/**
	 * FeeWeather — a "ridge" silhouette of the mempool fee distribution: the mass
	 * of waiting virtual bytes across the fee-rate spectrum, tinted cool→warm on
	 * the forge ramp, with a marker where the next-block fee sits.
	 *
	 * CSS/SVG-first, no charting dependency. The geometry is pure and unit-tested
	 * in $lib/feeWeather. A plain horizontal bar chart is rendered alongside and
	 * swapped in — purely via CSS media queries, no JS — whenever the viewport is
	 * narrow or the viewer prefers reduced motion (the ridge's gentle drift is
	 * then inappropriate). When there is no histogram to draw, this component
	 * renders nothing and the parent shows an honest degrade note instead.
	 */
	import { buildRidge, ridgeAreaPath, feeRateToX } from '$lib/feeWeather';
	import { feeColor } from '$lib/mempoolViz';
	import { formatBytes, formatFeeRate } from '$lib/format';
	import type { FeeHistogram } from '$lib/types';

	let {
		histogram,
		nextBlockFee = null
	}: {
		histogram: FeeHistogram | null;
		/** sat/vB the mempool projects for the next block, for the marker. */
		nextBlockFee?: number | null;
	} = $props();

	const W = 320;
	const H = 120;

	const ridge = $derived(buildRidge(histogram));
	const areaPath = $derived(ridge ? ridgeAreaPath(ridge.points, W, H) : '');
	const maxBar = $derived(ridge ? Math.max(...ridge.buckets.map((b) => b.vsize), 1) : 1);

	// Marker x (px) for the next-block fee, only when we have both a ridge and a fee.
	const markerX = $derived(
		ridge && nextBlockFee != null && nextBlockFee > 0 ? feeRateToX(nextBlockFee) * W : null
	);

	// A handful of gradient stops sampled across the ramp so the fill reads
	// cool steel (cheap) → copper/amber (a bidding war), matching the app's fee
	// color language. Rates chosen to span the drawn spectrum.
	const GRADIENT_STOPS = [1, 6, 20, 55, 150];
	// Sparse axis ticks — every third bucket keeps labels readable.
	const axisTicks = $derived(
		ridge ? ridge.buckets.filter((_, i) => i % 3 === 0 || i === ridge.buckets.length - 1) : []
	);
	// Stable id so multiple instances don't share a <defs> gradient.
	const gradId = `fw-grad-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#if ridge}
	<figure class="fee-weather" aria-label="Fee distribution ridge — waiting virtual bytes by fee rate">
		<!-- Ridge (default) -->
		<div class="ridge-wrap">
			<svg
				class="ridge"
				viewBox="0 0 {W} {H}"
				preserveAspectRatio="none"
				role="img"
				aria-hidden="true"
			>
				<defs>
					<linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
						{#each GRADIENT_STOPS as rate, i (rate)}
							<stop
								offset="{(i / (GRADIENT_STOPS.length - 1)) * 100}%"
								stop-color={feeColor(rate)}
							/>
						{/each}
					</linearGradient>
				</defs>
				<path class="ridge-fill" d={areaPath} fill="url(#{gradId})" />
				<path class="ridge-line" d={areaPath} fill="none" />
				{#if markerX != null}
					<line
						class="marker"
						x1={markerX}
						y1="0"
						x2={markerX}
						y2={H}
					/>
				{/if}
			</svg>
			{#if markerX != null && nextBlockFee != null}
				<span
					class="marker-label"
					style:left="{(markerX / W) * 100}%"
					class:flip={markerX / W > 0.75}
				>
					next block · {formatFeeRate(nextBlockFee)}
				</span>
			{/if}
			<div class="axis" aria-hidden="true">
				{#each axisTicks as t (t.min)}
					<span class="tick" style:left="{(feeRateToX(t.min)) * 100}%">{t.min}</span>
				{/each}
				<span class="axis-unit">sat/vB</span>
			</div>
		</div>

		<!-- Bar-chart fallback (reduced motion / narrow viewport). Same data,
		     no motion, easier to read at a glance on a phone. -->
		<div class="bars" role="img" aria-label="Fee distribution by fee rate band">
			{#each ridge.buckets as b (b.min)}
				<div class="bar-row">
					<span class="bar-label tabular">{b.label}</span>
					<div class="bar-track">
						<div
							class="bar-fill"
							style:width="{(b.vsize / maxBar) * 100}%"
							style:background={feeColor(b.min)}
						></div>
					</div>
					<span class="bar-val tabular">{b.vsize > 0 ? formatBytes(b.vsize) : '—'}</span>
				</div>
			{/each}
		</div>
		<figcaption class="hint">
			fee rate (sat/vB) →<span class="cap-sep"> · </span>height = waiting virtual bytes
		</figcaption>
	</figure>
{/if}

<style>
	.fee-weather {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ridge-wrap {
		position: relative;
	}

	.ridge {
		display: block;
		width: 100%;
		height: 132px;
		/* A very slow, subtle vertical breath so the sap looks alive without
		   distracting. Disabled entirely under reduced motion below. */
		animation: ridge-breathe 9s ease-in-out infinite;
		transform-origin: bottom;
	}

	@keyframes ridge-breathe {
		0%,
		100% {
			transform: scaleY(1);
			opacity: 0.96;
		}
		50% {
			transform: scaleY(1.015);
			opacity: 1;
		}
	}

	.ridge-fill {
		opacity: 0.9;
	}

	.ridge-line {
		stroke: var(--accent-bright, var(--accent));
		stroke-width: 1.4;
		vector-effect: non-scaling-stroke;
		opacity: 0.55;
	}

	.marker {
		stroke: var(--text-hero, var(--text));
		stroke-width: 1;
		stroke-dasharray: 3 3;
		vector-effect: non-scaling-stroke;
		opacity: 0.7;
	}

	.marker-label {
		position: absolute;
		top: 2px;
		transform: translateX(-50%);
		white-space: nowrap;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--bg) 78%, transparent);
		padding: 1px 5px;
		border-radius: var(--radius-chip, 4px);
		pointer-events: none;
	}

	.marker-label.flip {
		transform: translateX(-100%);
	}

	.axis {
		position: relative;
		height: 14px;
		margin-top: 2px;
	}

	.tick {
		position: absolute;
		transform: translateX(-50%);
		font-size: 10px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.tick:first-child {
		transform: translateX(0);
	}

	.axis-unit {
		position: absolute;
		right: 0;
		font-size: 10px;
		color: var(--text-faint);
	}

	/* Fallback bars: hidden by default, shown only when the ridge is inappropriate. */
	.bars {
		display: none;
		flex-direction: column;
		gap: 4px;
	}

	.bar-row {
		display: grid;
		grid-template-columns: 46px 1fr auto;
		align-items: center;
		gap: 8px;
	}

	.bar-label {
		font-size: 11px;
		color: var(--text-muted);
		text-align: right;
	}

	.bar-track {
		height: 12px;
		background: var(--bg-input, var(--bg));
		border-radius: 3px;
		overflow: hidden;
	}

	.bar-fill {
		height: 100%;
		min-width: 2px;
		border-radius: 3px;
		transition: width 400ms var(--ease, ease);
	}

	.bar-val {
		font-size: 10.5px;
		color: var(--text-faint);
		min-width: 52px;
		text-align: right;
	}

	.cap-sep {
		color: var(--border-ghost, var(--text-faint));
	}

	/* Narrow viewports: the ridge is hard to read at a glance; show the bars. */
	@media (max-width: 560px) {
		.ridge-wrap {
			display: none;
		}
		.bars {
			display: flex;
		}
	}

	/* Reduced motion: no breathing ridge — swap in the still bar chart. */
	@media (prefers-reduced-motion: reduce) {
		.ridge {
			animation: none;
		}
		.ridge-wrap {
			display: none;
		}
		.bars {
			display: flex;
		}
	}
</style>
