<script lang="ts">
	import { formatBtc } from '$lib/format';
	import Amount from '$lib/components/Amount.svelte';
	import { computeBalanceDelta } from './balanceDelta';

	type Point = { t: number; sats: number };
	let { series }: { series: Point[] } = $props();

	// Heartwood Home (7a): 24h / 7d / 30d range toggles with per-range paths
	// and a delta chip. "All" is kept so long histories stay reachable.
	type RangeKey = '24h' | '7d' | '30d' | 'all';
	const RANGES: { key: RangeKey; label: string; seconds: number; caption: string }[] = [
		{ key: '24h', label: '24h', seconds: 86400, caption: 'last 24 hours' },
		{ key: '7d', label: '7d', seconds: 7 * 86400, caption: 'last 7 days' },
		{ key: '30d', label: '30d', seconds: 30 * 86400, caption: 'last 30 days' },
		{ key: 'all', label: 'All', seconds: Infinity, caption: 'full history' }
	];

	let activeRange = $state<RangeKey>('30d');
	const range = $derived(RANGES.find((r) => r.key === activeRange)!);

	// Sorted, defensive copy of the incoming series (oldest first expected, but be safe).
	const sorted = $derived([...series].sort((a, b) => a.t - b.t));

	const filtered = $derived.by(() => {
		if (sorted.length === 0) return [];
		if (range.seconds === Infinity) return sorted;
		const latest = sorted[sorted.length - 1].t;
		const cutoff = latest - range.seconds;
		return sorted.filter((p) => p.t >= cutoff);
	});

	// Per-range delta chip: change across the visible window. Sage up, calm
	// amber down — never red (Heartwood grammar). Dust-level windows (#22)
	// render a neutral em-dash instead — see computeBalanceDelta's `dust` flag.
	const delta = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return null;
		return computeBalanceDelta(pts[0].sats, pts[pts.length - 1].sats);
	});

	// Layout: the SVG viewBox tracks the rendered width so scaling stays
	// uniform (round dots, honest dash lengths for the draw-in).
	let plotWidth = $state(720);
	const VB_H = 190;
	const PAD_L = 4;
	const PAD_R = 10;
	const PAD_T = 14;
	const PAD_B = 24;
	const VB_W = $derived(Math.max(plotWidth, 240));
	const PLOT_W = $derived(VB_W - PAD_L - PAD_R);
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
		for (let i = 0; i < coords.length - 1; i++) {
			const p0 = coords[i - 1] ?? coords[i];
			const p1 = coords[i];
			const p2 = coords[i + 1];
			const p3 = coords[i + 2] ?? p2;
			const c1x = p1.x + (p2.x - p0.x) / 6;
			const c1y = p1.y + (p2.y - p0.y) / 6;
			const c2x = p2.x - (p3.x - p1.x) / 6;
			const c2y = p2.y - (p3.y - p1.y) / 6;
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

	const endPoint = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return null;
		const p = pts[pts.length - 1];
		return { x: xFor(p.t), y: yFor(p.sats) };
	});

	// Draw-in on mount and on every range change (hwGrow): the line hides
	// behind a dash gap as long as itself, then the offset animates to 0.
	let lineEl = $state<SVGPathElement | null>(null);
	let lineLen = $state(0);
	$effect(() => {
		void linePath;
		if (!lineEl || !linePath) {
			lineLen = 0;
			return;
		}
		lineLen = lineEl.getTotalLength();
	});

	// X-axis ticks: dates normally, clock time on the 24h window.
	function formatTick(unix: number): string {
		const d = new Date(unix * 1000);
		if (range.seconds <= 86400) {
			return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		}
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

	// Up to 5 ticks, evenly spaced by TIME (not by array index) and snapped to
	// the nearest data point — index spacing bunched ticks together on sparse
	// series, producing adjacent identical labels like "Jul 4 … Jul 4 … Jul 6"
	// (cairn-b4ys). A tick that would repeat the previous tick's label (or land
	// on the same point) is skipped rather than reformatted, so the axis stays
	// clean: every label is distinct or absent.
	const xTicks = $derived.by(() => {
		const pts = filtered;
		if (pts.length < 2) return [];
		const COUNT = Math.min(5, pts.length);
		const { minT, maxT } = bounds;
		const ticks: { x: number; label: string }[] = [];
		let lastIdx = -1;
		let lastLabel = '';
		for (let i = 0; i < COUNT; i++) {
			const frac = COUNT === 1 ? 0 : i / (COUNT - 1);
			const target = minT + frac * (maxT - minT);
			let idx = 0;
			let best = Infinity;
			for (let j = 0; j < pts.length; j++) {
				const d = Math.abs(pts[j].t - target);
				if (d < best) {
					best = d;
					idx = j;
				}
			}
			if (idx === lastIdx) continue; // two targets snapped to the same point
			const label = formatTick(pts[idx].t);
			if (label === lastLabel) continue; // same label — skip the duplicate
			lastIdx = idx;
			lastLabel = label;
			ticks.push({ x: xFor(pts[idx].t), label });
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
	<div class="chart-head">
		{#if delta}
			<span
				class="delta-chip tabular"
				class:up={!delta.dust && delta.dir === 'up'}
				class:down={!delta.dust && delta.dir === 'down'}
			>
				{#if delta.dust}
					<!-- Dust-level window (#22): a %/BTC change here is noise, not a
					     trend — a neutral dash reads honestly instead of a colored
					     up/down badge that overstates a handful of sats moving. -->
					—
				{:else}
					{delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '—'}
					{#if delta.pct !== null}
						{Math.abs(delta.pct) < 0.05 && delta.sats !== 0 ? '<0.1' : Math.abs(delta.pct).toFixed(1)}%
					{:else}
						{formatBtc(Math.abs(delta.sats))} BTC
					{/if}
				{/if}
				<span class="delta-range">{range.label}</span>
			</span>
		{:else}
			<span></span>
		{/if}
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
	</div>

	{#if filtered.length < 2}
		<div class="empty">
			{#if sorted.length < 2}
				No balance history to chart yet. History starts from when a wallet is added to
				Heartwood (wallets with past transactions chart their full history), and fills in from
				here as balances change.
			{:else}
				Not enough history in the {range.caption} window yet — try a longer range. Send or
				receive bitcoin to see activity here.
			{/if}
		</div>
	{:else}
		<div class="chart-wrap" bind:clientWidth={plotWidth}>
			<svg
				bind:this={svgEl}
				viewBox="0 0 {VB_W} {VB_H}"
				role="img"
				aria-label="Balance over time"
				onpointermove={handlePointerMove}
				onpointerleave={handlePointerLeave}
			>
				<defs>
					<linearGradient id="balance-area-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.2" />
						<stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
					</linearGradient>
				</defs>

				<!-- Unboxed: a single faint baseline, no gridbox. -->
				<line
					class="baseline"
					x1={PAD_L}
					y1={PAD_T + PLOT_H}
					x2={VB_W - PAD_R}
					y2={PAD_T + PLOT_H}
				/>

				{#key activeRange}
					<!-- Area fill fades in behind the draw-in. -->
					<path class="area" d={areaPath} fill="url(#balance-area-fill)" />

					<!-- The line: hidden behind its own dash length, offset animated to 0. -->
					<path
						bind:this={lineEl}
						class="line"
						d={linePath}
						fill="none"
						stroke="var(--accent)"
						stroke-width="2"
						stroke-linejoin="round"
						stroke-linecap="round"
						style={lineLen > 0
							? `stroke-dasharray:${lineLen};stroke-dashoffset:${lineLen};animation:hwGrow 1.8s ease-out forwards;`
							: 'opacity:0'}
					/>

					<!-- Pulsing end dot appears once the line reaches it. -->
					{#if endPoint}
						<circle class="end-halo" cx={endPoint.x} cy={endPoint.y} r="7" />
						<circle class="end-dot" cx={endPoint.x} cy={endPoint.y} r="3.2" />
					{/if}
				{/key}

				<!-- X-axis ticks -->
				{#each xTicks as tick (tick.x)}
					<text class="axis-label" x={tick.x} y={VB_H - 6} text-anchor="middle">
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
					<div class="tooltip-balance">
						<Amount sats={hoverPoint.p.sats} size="row" align="start" />
					</div>
					<div class="tooltip-date">{formatTooltipDate(hoverPoint.p.t)}</div>
				</div>
			{/if}
		</div>
		<div class="caption">balance · {range.caption}</div>
	{/if}
</div>

<style>
	.balance-chart {
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
	}

	.chart-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	/* Delta chip: sage up, calm amber down — never red. */
	.delta-chip {
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.delta-chip.up {
		color: var(--sage);
	}

	.delta-chip.down {
		color: var(--attention);
	}

	.delta-range {
		color: var(--text-faint);
		font-weight: 400;
	}

	/* Text toggles (Heartwood toggle grammar): active copper-bright on copper
	   tint, radius 14; inactive quiet text — no boxed toggle group. */
	.range-row {
		display: flex;
		gap: 2px;
	}

	.range-btn {
		appearance: none;
		border: none;
		background: transparent;
		color: var(--eyebrow-path);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		letter-spacing: 0.01em;
		padding: 5px 12px;
		border-radius: var(--radius-toggle);
		cursor: pointer;
		transition:
			color 0.15s var(--ease),
			background 0.15s var(--ease);
	}

	.range-btn:hover {
		color: var(--text-secondary);
	}

	.range-btn.active {
		background: var(--accent-muted);
		color: var(--accent-bright);
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 190px;
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
		height: 190px;
		overflow: visible;
		touch-action: none;
	}

	.baseline {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	.area {
		animation: hwAreaIn 1.8s ease-out both;
	}

	@keyframes hwAreaIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* End dot: hidden until the draw-in arrives, then pulses forever. */
	.end-dot {
		fill: var(--accent-glow);
		animation:
			hwDotIn 1.7s step-end both,
			hwPulse 2.4s ease-in-out 1.7s infinite;
	}

	.end-halo {
		fill: var(--accent-glow);
		opacity: 0.18;
		animation: hwDotIn 1.7s step-end both;
	}

	@keyframes hwDotIn {
		from {
			opacity: 0;
		}
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
		background: color-mix(in srgb, var(--bg) 60%, transparent);
		padding: 0 0.2rem;
		border-radius: 3px;
	}

	.y-max {
		top: 0.2rem;
	}

	.y-min {
		bottom: 1.9rem;
	}

	.caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
	}

	.tooltip {
		position: absolute;
		transform: translate(0, calc(-100% - 12px));
		pointer-events: none;
		background: #201a16;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-strip);
		padding: 0.4rem 0.6rem;
		min-width: 120px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		z-index: 2;
	}

	.tooltip-balance {
		font-family: var(--font-serif);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--text-rows);
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
