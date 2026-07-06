<script lang="ts">
	import { formatBtc } from '$lib/format';

	type Point = { t: number; sats: number };
	let { series }: { series: Point[] } = $props();

	type RangeKey = '1W' | '1M' | '3M' | '6M' | '1Y' | 'ALL';
	const RANGES: { key: RangeKey; label: string; seconds: number }[] = [
		{ key: '1W', label: '1W', seconds: 7 * 86400 },
		{ key: '1M', label: '1M', seconds: 30 * 86400 },
		{ key: '3M', label: '3M', seconds: 90 * 86400 },
		{ key: '6M', label: '6M', seconds: 180 * 86400 },
		{ key: '1Y', label: '1Y', seconds: 365 * 86400 },
		{ key: 'ALL', label: 'ALL', seconds: Infinity }
	];

	let activeRange = $state<RangeKey>('1M');

	// Sorted, defensive copy of the incoming series (oldest first expected, but be safe).
	const sorted = $derived([...series].sort((a, b) => a.t - b.t));

	const filtered = $derived.by(() => {
		if (sorted.length === 0) return [];
		const range = RANGES.find((r) => r.key === activeRange)!;
		if (range.seconds === Infinity) return sorted;
		const latest = sorted[sorted.length - 1].t;
		const cutoff = latest - range.seconds;
		return sorted.filter((p) => p.t >= cutoff);
	});

	// Layout constants for the SVG coordinate space.
	const VB_W = 720;
	const VB_H = 220;
	const PAD_L = 8;
	const PAD_R = 8;
	const PAD_T = 16;
	const PAD_B = 26;
	const PLOT_W = VB_W - PAD_L - PAD_R;
	const PLOT_H = VB_H - PAD_T - PAD_B;

	const bounds = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) {
			return { minT: 0, maxT: 1, minS: 0, maxS: 1 };
		}
		const minT = pts[0].t;
		const maxT = pts[pts.length - 1].t;
		let minS = Infinity;
		let maxS = -Infinity;
		for (const p of pts) {
			if (p.sats < minS) minS = p.sats;
			if (p.sats > maxS) maxS = p.sats;
		}
		// Pad the value range a little so the line breathes and never hugs the edges.
		const span = maxS - minS;
		const pad = span === 0 ? Math.max(maxS * 0.05, 1) : span * 0.12;
		return { minT, maxT, minS: minS - pad, maxS: maxS + pad };
	});

	function xFor(t: number): number {
		const { minT, maxT } = bounds;
		const frac = maxT === minT ? 0.5 : (t - minT) / (maxT - minT);
		return PAD_L + frac * PLOT_W;
	}

	function yFor(sats: number): number {
		const { minS, maxS } = bounds;
		const frac = maxS === minS ? 0.5 : (sats - minS) / (maxS - minS);
		// Invert: higher balance -> smaller y (top of chart).
		return PAD_T + (1 - frac) * PLOT_H;
	}

	// Smooth-ish path using a Catmull-Rom -> cubic Bezier conversion for a gentle curve.
	const linePath = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return '';
		const coords = pts.map((p) => ({ x: xFor(p.t), y: yFor(p.sats) }));
		let d = `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;
		const tension = 0.2;
		for (let i = 0; i < coords.length - 1; i++) {
			const p0 = coords[i - 1] ?? coords[i];
			const p1 = coords[i];
			const p2 = coords[i + 1];
			const p3 = coords[i + 2] ?? p2;
			const c1x = p1.x + ((p2.x - p0.x) / 6) * (tension / 0.2) * 1;
			const c1y = p1.y + ((p2.y - p0.y) / 6) * (tension / 0.2) * 1;
			const c2x = p2.x - ((p3.x - p1.x) / 6) * (tension / 0.2) * 1;
			const c2y = p2.y - ((p3.y - p1.y) / 6) * (tension / 0.2) * 1;
			d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
		}
		return d;
	});

	const areaPath = $derived.by(() => {
		const line = linePath;
		if (!line) return '';
		const pts = filtered;
		const firstX = xFor(pts[0].t);
		const lastX = xFor(pts[pts.length - 1].t);
		const baseY = PAD_T + PLOT_H;
		return `${line} L ${lastX.toFixed(2)} ${baseY.toFixed(2)} L ${firstX.toFixed(2)} ${baseY.toFixed(2)} Z`;
	});

	// Horizontal gridlines (values) — a few evenly spaced levels within the padded range.
	const gridLines = $derived.by(() => {
		if (filtered.length < 2) return [];
		const { minS, maxS } = bounds;
		const COUNT = 4;
		const lines: { y: number; sats: number }[] = [];
		for (let i = 0; i <= COUNT; i++) {
			const sats = minS + ((maxS - minS) * i) / COUNT;
			lines.push({ y: yFor(sats), sats });
		}
		return lines;
	});

	// X-axis date ticks.
	function formatDate(unix: number): string {
		const d = new Date(unix * 1000);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function formatTooltipDate(unix: number): string {
		const d = new Date(unix * 1000);
		return d.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	const xTicks = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return [];
		const COUNT = Math.min(5, pts.length);
		const ticks: { x: number; label: string }[] = [];
		for (let i = 0; i < COUNT; i++) {
			const frac = COUNT === 1 ? 0 : i / (COUNT - 1);
			const idx = Math.round(frac * (pts.length - 1));
			const p = pts[idx];
			ticks.push({ x: xFor(p.t), label: formatDate(p.t) });
		}
		return ticks;
	});

	// Y-axis min/max labels (honest actual data extremes, not the padded bounds).
	const dataExtremes = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return null;
		let minS = Infinity;
		let maxS = -Infinity;
		for (const p of pts) {
			if (p.sats < minS) minS = p.sats;
			if (p.sats > maxS) maxS = p.sats;
		}
		return { minS, maxS };
	});

	// Hover state.
	let hoverIndex = $state<number | null>(null);
	let svgEl: SVGSVGElement | null = $state(null);

	function handlePointerMove(event: PointerEvent) {
		const pts = filtered;
		if (pts.length < 2 || !svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		// Map client x into viewBox x-coordinate space.
		const relX = ((event.clientX - rect.left) / rect.width) * VB_W;
		// Find nearest data point by x.
		let nearest = 0;
		let bestDist = Infinity;
		for (let i = 0; i < pts.length; i++) {
			const dist = Math.abs(xFor(pts[i].t) - relX);
			if (dist < bestDist) {
				bestDist = dist;
				nearest = i;
			}
		}
		hoverIndex = nearest;
	}

	function handlePointerLeave() {
		hoverIndex = null;
	}

	const hoverPoint = $derived.by(() => {
		if (hoverIndex === null) return null;
		const pts = filtered;
		if (hoverIndex < 0 || hoverIndex >= pts.length) return null;
		const p = pts[hoverIndex];
		return { p, x: xFor(p.t), y: yFor(p.sats) };
	});

	// Tooltip horizontal placement so it doesn't overflow the plot edges (in viewBox units).
	const TOOLTIP_W = 150;
	const tooltipX = $derived.by(() => {
		if (!hoverPoint) return 0;
		let x = hoverPoint.x - TOOLTIP_W / 2;
		if (x < PAD_L) x = PAD_L;
		if (x + TOOLTIP_W > VB_W - PAD_R) x = VB_W - PAD_R - TOOLTIP_W;
		return x;
	});
</script>

<div class="balance-chart">
	<div class="range-row" role="group" aria-label="Chart time range">
		{#each RANGES as r (r.key)}
			<button
				type="button"
				class="range-btn"
				class:active={activeRange === r.key}
				aria-pressed={activeRange === r.key}
				onclick={() => (activeRange = r.key)}
			>
				{r.label}
			</button>
		{/each}
	</div>

	{#if filtered.length < 2}
		<div class="empty">
			No balance history to chart yet. History starts from when a wallet is added to Cairn
			(wallets with past transactions chart their full history), and fills in from here as
			balances change.
		</div>
	{:else}
		<div class="chart-wrap">
			<svg
				bind:this={svgEl}
				viewBox="0 0 {VB_W} {VB_H}"
				preserveAspectRatio="none"
				role="img"
				aria-label="Balance over time"
				onpointermove={handlePointerMove}
				onpointerleave={handlePointerLeave}
			>
				<defs>
					<linearGradient id="balance-area-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22" />
						<stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
					</linearGradient>
				</defs>

				<!-- Gridlines -->
				{#each gridLines as g, i (i)}
					<line
						class="gridline"
						x1={PAD_L}
						y1={g.y}
						x2={VB_W - PAD_R}
						y2={g.y}
						class:baseline={i === 0}
					/>
				{/each}

				<!-- Area fill -->
				<path d={areaPath} fill="url(#balance-area-fill)" />

				<!-- Line -->
				<path
					d={linePath}
					fill="none"
					stroke="var(--accent)"
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
				/>

				<!-- X-axis date ticks -->
				{#each xTicks as tick (tick.x)}
					<text
						class="axis-label"
						x={tick.x}
						y={VB_H - 8}
						text-anchor="middle"
					>
						{tick.label}
					</text>
				{/each}

				<!-- Hover guide + dot -->
				{#if hoverPoint}
					<line
						class="guide"
						x1={hoverPoint.x}
						y1={PAD_T}
						x2={hoverPoint.x}
						y2={PAD_T + PLOT_H}
					/>
					<circle class="dot-halo" cx={hoverPoint.x} cy={hoverPoint.y} r="6" />
					<circle class="dot" cx={hoverPoint.x} cy={hoverPoint.y} r="3.5" />
				{/if}
			</svg>

			<!-- Y-axis min/max labels overlaid (HTML for crisp text) -->
			{#if dataExtremes}
				<div class="y-label y-max">{formatBtc(dataExtremes.maxS)}</div>
				<div class="y-label y-min">{formatBtc(dataExtremes.minS)}</div>
			{/if}

			<!-- Tooltip (HTML, positioned via % of viewBox) -->
			{#if hoverPoint}
				<div
					class="tooltip"
					style="left: {(tooltipX / VB_W) * 100}%; top: {(hoverPoint.y / VB_H) * 100}%;"
				>
					<div class="tooltip-balance tabular">{formatBtc(hoverPoint.p.sats)} BTC</div>
					<div class="tooltip-date">{formatTooltipDate(hoverPoint.p.t)}</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.balance-chart {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
	}

	.range-row {
		display: flex;
		gap: 0.25rem;
		align-self: flex-end;
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		padding: 0.2rem;
	}

	.range-btn {
		appearance: none;
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		padding: 0.28rem 0.6rem;
		border-radius: var(--radius-chip);
		cursor: pointer;
		transition: color 0.18s var(--ease), background 0.18s var(--ease);
	}

	.range-btn:hover {
		color: var(--text-secondary);
	}

	.range-btn.active {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 220px;
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.chart-wrap {
		position: relative;
		width: 100%;
	}

	svg {
		display: block;
		width: 100%;
		height: 220px;
		overflow: visible;
		touch-action: none;
	}

	.gridline {
		stroke: var(--border-subtle);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.gridline.baseline {
		stroke: var(--border);
	}

	.axis-label {
		fill: var(--text-faint);
		font-family: var(--font-ui);
		font-size: 11px;
	}

	.guide {
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		opacity: 0.5;
		vector-effect: non-scaling-stroke;
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
		right: 0.35rem;
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		pointer-events: none;
		background: color-mix(in srgb, var(--surface) 60%, transparent);
		padding: 0 0.2rem;
		border-radius: 3px;
	}

	.y-max {
		top: 0.2rem;
	}

	.y-min {
		bottom: 1.9rem;
	}

	.tooltip {
		position: absolute;
		transform: translate(0, calc(-100% - 12px));
		pointer-events: none;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 0.4rem 0.55rem;
		min-width: 120px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
		z-index: 2;
	}

	.tooltip-balance {
		font-family: var(--font-ui);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
	}

	.tooltip-date {
		margin-top: 0.1rem;
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--text-muted);
		white-space: nowrap;
	}
</style>
