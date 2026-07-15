<script lang="ts">
	/**
	 * WalletStepChart — the Heartwood wallet detail's 148px "stepped" balance
	 * chart (spec 5d/8e): deposits and spends read as steps, not a smoothed
	 * line. Unboxed per the grammar — it bleeds to content width with a
	 * caption underneath, no frame.
	 *
	 * Built from the wallet's confirmed transaction deltas: the series walks
	 * from zero to the current confirmed balance, one horizontal tread per
	 * quiet stretch, one vertical riser per transaction. Height is a prop so
	 * mobile can drop to the 88px variant.
	 *
	 * Annotated (cairn-p2ol): the line used to float with no context. It now
	 * carries faint Y-axis gridlines + BTC labels, X-axis date ticks, and a
	 * hover/tap tooltip with a vertical guideline that reports the exact
	 * balance + date at any transaction step. Interaction patterns are ported
	 * from Home's BalanceChart (nearest-point-by-x lookup, skip-repeated-label
	 * ticks, HTML-overlay labels for crisp text) but adapted to this
	 * component's own pixel-space geometry and stepped visual style — the
	 * step look, gradient fill, draw-in and pulsing end dot are unchanged.
	 *
	 * Local to the wallet pages on purpose — Home's BalanceChart (a smoothed
	 * portfolio line) is a different component owned by a different lane.
	 */
	import { formatBtc } from '$lib/format';

	let {
		txs,
		confirmed,
		height = 148
	}: {
		/** Wallet scan txs — only confirmed ones (height > 0, so time is set)
		 *  are charted; unconfirmed rows (time: null) are filtered out here. */
		txs: { time: number | null; height: number; delta: number }[];
		/** Current confirmed balance in sats (anchors the series' end). */
		confirmed: number;
		height?: number;
	} = $props();

	let width = $state(0);

	const PAD_TOP = 10;
	const PAD_BOTTOM = 18; // room for the x-axis date labels (was 4)
	const END_GUTTER = 14; // room for the pulsing end dot

	const series = $derived.by(() => {
		const conf = txs
			.filter((t): t is { time: number; height: number; delta: number } =>
				t.height > 0 && t.time != null && t.time > 0
			)
			.toSorted((a, b) => a.time - b.time || a.height - b.height);
		if (conf.length === 0) return null;
		// Walk deltas forward, then shift so the walk ends exactly at the
		// scanner's confirmed balance (deltas already include fees, so the
		// shift is normally zero — it just absorbs rounding/scan drift).
		let run = 0;
		const raw = conf.map((t) => ({ time: t.time, value: (run += t.delta) }));
		const shift = confirmed - run;
		return raw.map((p) => ({ time: p.time, value: p.value + shift }));
	});

	const geometry = $derived.by(() => {
		const s = series;
		if (!s || width < 60) return null;
		const w = width - END_GUTTER;
		const h = height;
		const t0 = s[0].time;
		const t1 = Math.max(Math.floor(Date.now() / 1000), s[s.length - 1].time);
		const tSpan = Math.max(1, t1 - t0);
		const values = s.map((p) => p.value);
		const vMax = Math.max(...values, confirmed, 1);
		const vMin = Math.min(...values, 0);
		const vSpan = Math.max(1, vMax - vMin);
		const plotBottom = h - PAD_BOTTOM;
		const x = (t: number) => ((t - t0) / tSpan) * w;
		const y = (v: number) => PAD_TOP + (1 - (v - vMin) / vSpan) * (plotBottom - PAD_TOP);

		// Step path: tread at the previous value up to each tx, then a riser.
		const zeroY = y(Math.max(0, vMin));
		let d = `M 0 ${zeroY.toFixed(1)}`;
		let prevY = zeroY;
		for (const p of s) {
			const px = x(p.time);
			const py = y(p.value);
			d += ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
			prevY = py;
		}
		const endX = w;
		d += ` L ${endX.toFixed(1)} ${prevY.toFixed(1)}`;
		const fill = `${d} L ${endX.toFixed(1)} ${plotBottom.toFixed(1)} L 0 ${plotBottom.toFixed(1)} Z`;
		return { line: d, fill, endX, endY: prevY, x, y, w, vMin, vMax, plotBottom };
	});

	// One gradient id per instance so two charts on a page don't collide.
	const gradId = `hw-step-grad-${Math.random().toString(36).slice(2, 8)}`;

	// Short axis-tick date ("Jul 4"); full tooltip date ("Jul 4, 2026").
	function formatTick(unix: number): string {
		return new Date(unix * 1000).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	}

	function formatFullDate(unix: number): string {
		return new Date(unix * 1000).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	// X-axis ticks: up to 4, evenly spaced by TIME (not array index) and snapped
	// to the nearest real data point. A tick that lands on the same point as the
	// previous one, or that would repeat its label, is skipped rather than
	// reformatted — same guard BalanceChart added for cairn-b4ys so sparse
	// series never show adjacent identical labels.
	const xTicks = $derived.by(() => {
		const s = series;
		const g = geometry;
		if (!s || !g || s.length < 2) return [];
		const COUNT = Math.min(4, s.length);
		const t0 = s[0].time;
		const t1 = s[s.length - 1].time;
		const ticks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[] = [];
		let lastIdx = -1;
		let lastLabel = '';
		for (let i = 0; i < COUNT; i++) {
			const frac = COUNT === 1 ? 0 : i / (COUNT - 1);
			const target = t0 + frac * (t1 - t0);
			let idx = 0;
			let best = Infinity;
			for (let j = 0; j < s.length; j++) {
				const dd = Math.abs(s[j].time - target);
				if (dd < best) {
					best = dd;
					idx = j;
				}
			}
			if (idx === lastIdx) continue; // two targets snapped to the same point
			const label = formatTick(s[idx].time);
			if (label === lastLabel) continue; // same label — skip the duplicate
			lastIdx = idx;
			lastLabel = label;
			const px = g.x(s[idx].time);
			// Keep edge labels from clipping past the plot bounds.
			const anchor = px < 18 ? 'start' : px > g.w - 18 ? 'end' : 'middle';
			ticks.push({ x: px, label, anchor });
		}
		return ticks;
	});

	// Y-axis: up to 3 gridline+label rows across the value range geometry already
	// computed (vMin/vMax — usually 0 → current balance). Labels use formatBtc to
	// match the rest of the wallet page's balance unit; a row whose label repeats
	// the previous one (tiny spans) is dropped.
	const yTicks = $derived.by(() => {
		const g = geometry;
		if (!g) return [];
		const COUNT = 3;
		const rows: { y: number; label: string }[] = [];
		let lastLabel = '';
		for (let i = 0; i < COUNT; i++) {
			const frac = i / (COUNT - 1); // 0 = top (vMax) … 1 = bottom (vMin)
			const v = g.vMax - frac * (g.vMax - g.vMin);
			const label = formatBtc(v);
			if (label === lastLabel) continue;
			lastLabel = label;
			rows.push({ y: g.y(v), label });
		}
		return rows;
	});

	// Hover / tap state. Pointer events cover mouse, touch and pen; pointerdown
	// is wired alongside pointermove so a plain tap (which fires no pointermove)
	// still surfaces the tooltip — press-and-drag then scrubs, lift dismisses.
	let hoverIndex = $state<number | null>(null);
	let svgEl = $state<SVGSVGElement | null>(null);

	function updateHover(event: PointerEvent) {
		const s = series;
		const g = geometry;
		if (!s || !g || !svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		// SVG is drawn 1:1 in pixels (width={width}); scale through rect.width in
		// case CSS ever stretches it, then match the nearest point by x-distance.
		const relX = ((event.clientX - rect.left) / rect.width) * width;
		let nearest = 0;
		let best = Infinity;
		for (let i = 0; i < s.length; i++) {
			const dd = Math.abs(g.x(s[i].time) - relX);
			if (dd < best) {
				best = dd;
				nearest = i;
			}
		}
		hoverIndex = nearest;
	}

	function clearHover() {
		hoverIndex = null;
	}

	const hoverPoint = $derived.by(() => {
		const s = series;
		const g = geometry;
		if (hoverIndex === null || !s || !g) return null;
		if (hoverIndex < 0 || hoverIndex >= s.length) return null;
		const p = s[hoverIndex];
		return { p, x: g.x(p.time), y: g.y(p.value) };
	});

	// Tooltip placement (pixel space): clamp horizontally to the chart, and flip
	// below the point when it sits near the top so it never clips the container.
	const TOOLTIP_W = 132;
	const tooltipLeft = $derived.by(() => {
		if (!hoverPoint) return 0;
		let x = hoverPoint.x - TOOLTIP_W / 2;
		if (x < 0) x = 0;
		if (x + TOOLTIP_W > width) x = Math.max(0, width - TOOLTIP_W);
		return x;
	});
	const tooltipBelow = $derived(hoverPoint ? hoverPoint.y < 46 : false);
</script>

{#if series && series.length > 0}
	<div class="step-chart" style:height="{height}px" bind:clientWidth={width}>
		{#if geometry}
			<svg
				bind:this={svgEl}
				{width}
				{height}
				role="img"
				aria-label="Balance over time, ending at {formatBtc(confirmed)} BTC"
				onpointerdown={updateHover}
				onpointermove={updateHover}
				onpointerleave={clearHover}
			>
				<defs>
					<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="rgba(103, 150, 201, 0.16)" />
						<stop offset="100%" stop-color="rgba(103, 150, 201, 0)" />
					</linearGradient>
				</defs>

				<!-- Y-axis gridlines — faint hairlines behind the fill, no gridbox. -->
				{#each yTicks as t (t.y)}
					<line class="gridline" x1="0" y1={t.y} x2={geometry.w} y2={t.y} />
				{/each}

				<path d={geometry.fill} fill="url(#{gradId})" />
				<path
					class="line"
					d={geometry.line}
					fill="none"
					stroke="var(--accent)"
					stroke-width="2"
					stroke-linejoin="round"
					pathLength="1"
				/>
				<circle class="end-dot" cx={geometry.endX} cy={geometry.endY} r="3.5" fill="var(--accent-glow)" />

				<!-- X-axis date ticks -->
				{#each xTicks as t (t.x)}
					<text class="axis-label" x={t.x} y={height - 4} text-anchor={t.anchor}>{t.label}</text>
				{/each}

				<!-- Hover guideline + halo dot -->
				{#if hoverPoint}
					<line
						class="guide"
						x1={hoverPoint.x}
						y1={PAD_TOP}
						x2={hoverPoint.x}
						y2={geometry.plotBottom}
					/>
					<circle class="dot-halo" cx={hoverPoint.x} cy={hoverPoint.y} r="6" />
					<circle class="dot" cx={hoverPoint.x} cy={hoverPoint.y} r="3.5" />
				{/if}
			</svg>

			<!-- Y-axis labels (HTML overlay for crisp text regardless of SVG scale) -->
			{#each yTicks as t (t.y)}
				<div class="y-label" style:top="{t.y}px">{t.label}</div>
			{/each}

			<!-- Tooltip (HTML, positioned in pixel space) -->
			{#if hoverPoint}
				<div
					class="tooltip"
					class:below={tooltipBelow}
					style:left="{tooltipLeft}px"
					style:top="{hoverPoint.y}px"
				>
					<div class="tooltip-balance tabular">{formatBtc(hoverPoint.p.value)} BTC</div>
					<div class="tooltip-date">{formatFullDate(hoverPoint.p.time)}</div>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.step-chart {
		position: relative;
		width: 100%;
		overflow: hidden;
	}

	svg {
		display: block;
		overflow: visible;
		touch-action: none; /* let a press-drag scrub the chart, not scroll the page */
	}

	/* Draw-in on mount (spec hwGrow: dashoffset → 0, 1.8s ease-out). */
	.line {
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: hwGrow 1.8s var(--ease) forwards;
	}

	.end-dot {
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.gridline {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	.axis-label {
		fill: var(--text-faint);
		font-family: var(--font-ui);
		font-size: 10.5px;
	}

	.guide {
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		opacity: 0.5;
	}

	.dot-halo {
		fill: var(--accent);
		opacity: 0.2;
	}

	.dot {
		fill: var(--accent);
		stroke: var(--bg);
		stroke-width: 1.5;
	}

	.y-label {
		position: absolute;
		right: 0;
		transform: translateY(-50%);
		font-family: var(--font-ui);
		font-size: 10.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		pointer-events: none;
		background: color-mix(in srgb, var(--bg) 62%, transparent);
		padding: 0 0.2rem;
		border-radius: 3px;
	}

	.tooltip {
		position: absolute;
		transform: translate(0, calc(-100% - 10px));
		pointer-events: none;
		background: var(--surface-elevated);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-strip);
		padding: 0.35rem 0.55rem;
		min-width: 120px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		z-index: 2;
	}

	.tooltip.below {
		transform: translate(0, 10px);
	}

	.tooltip-balance {
		font-family: var(--font-serif);
		font-size: 0.84rem;
		font-weight: var(--t-hero-weight);
		font-variant-numeric: tabular-nums;
		color: var(--text-rows);
		white-space: nowrap;
	}

	.tooltip-date {
		margin-top: 0.1rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--text-muted);
		white-space: nowrap;
	}
</style>
