<script module lang="ts">
	export type ChartPoint = { x: number; y: number; label?: string };
	export type ChartSeries = { points: ChartPoint[]; color?: string; label?: string };
	/**
	 * A single categorical bar. `value` is signed (vertical bars support
	 * positive/negative around a zero baseline); `label` is the category-axis
	 * caption. `valueLabel` overrides the tooltip/axis value text when the raw
	 * number needs domain formatting the generic valueFormat can't give; `note`
	 * is an optional extra tooltip line (e.g. a full date-time).
	 */
	export type ChartBar = {
		label: string;
		value: number;
		color?: string;
		valueLabel?: string;
		note?: string;
	};
</script>

<script lang="ts">
	/**
	 * CairnChart — shared chart infrastructure (axes, gridlines, hover tooltip,
	 * legend) for the plain SVG charts scattered across the explorer/dashboard
	 * pages (cairn-49wy). Modeled on the bespoke BalanceChart used for wallet
	 * balances, but generic over any x/y series — it has no domain knowledge of
	 * sats, ranges, or delta chips.
	 *
	 * Two render modes share the same axis/gridline/tooltip primitives:
	 *   - `kind="line"` (default): smooth line/area over continuous `series`.
	 *   - `kind="bar"`: categorical `bars`, either `orientation="vertical"`
	 *     (signed columns around a zero baseline — used by the difficulty
	 *     retarget history) or `orientation="horizontal"` (proportional bars
	 *     from a zero origin — used by the mempool fee distribution).
	 *
	 * SSR-safe: layout math only touches props/state, never `window` or
	 * `document` outside `onMount`/event handlers.
	 */
	let {
		series = [],
		bars = [],
		kind = 'line',
		orientation = 'vertical',
		height = 200,
		xFormat = (v: number) => String(v),
		yFormat = (v: number) => String(v),
		valueFormat,
		ariaLabel,
		showGrid = true,
		showAxes = true,
		showTooltip = true
	}: {
		series?: ChartSeries[];
		bars?: ChartBar[];
		kind?: 'line' | 'bar';
		orientation?: 'vertical' | 'horizontal';
		height?: number;
		xFormat?: (v: number) => string;
		yFormat?: (v: number) => string;
		/** Bar-mode value-axis + tooltip formatter; falls back to `yFormat`. */
		valueFormat?: (v: number) => string;
		ariaLabel?: string;
		showGrid?: boolean;
		showAxes?: boolean;
		showTooltip?: boolean;
	} = $props();

	const isBar = $derived(kind === 'bar');
	const isHorizontal = $derived(kind === 'bar' && orientation === 'horizontal');
	const fmtValue = $derived(valueFormat ?? yFormat);

	// Layout: the SVG viewBox tracks the rendered width so scaling stays
	// uniform, same seam as BalanceChart's bind:clientWidth.
	let plotWidth = $state(720);
	const PAD_L = 44;
	const PAD_R = 12;
	const PAD_T = 12;
	const PAD_B = 24;
	const VB_W = $derived(Math.max(plotWidth, 240));
	const VB_H = $derived(Math.max(height, 80));
	const PLOT_W = $derived(VB_W - PAD_L - PAD_R);
	const PLOT_H = $derived(VB_H - PAD_T - PAD_B);

	const allPoints = $derived(series.flatMap((s) => s.points));
	const hasData = $derived(
		isBar ? bars.length > 0 : series.some((s) => s.points.length >= 2)
	);

	const bounds = $derived.by(() => {
		if (allPoints.length === 0) {
			return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
		}
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of allPoints) {
			if (p.x < minX) minX = p.x;
			if (p.x > maxX) maxX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.y > maxY) maxY = p.y;
		}
		// Pad the value range a little so lines breathe and never hug the edges.
		const span = maxY - minY;
		const pad = span === 0 ? Math.max(Math.abs(maxY) * 0.05, 1) : span * 0.12;
		return { minX, maxX, minY: minY - pad, maxY: maxY + pad };
	});

	function xFor(x: number): number {
		const { minX, maxX } = bounds;
		const frac = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
		return PAD_L + frac * PLOT_W;
	}

	function yFor(y: number): number {
		const { minY, maxY } = bounds;
		const frac = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
		return PAD_T + (1 - frac) * PLOT_H;
	}

	// Smooth-ish path using a Catmull-Rom -> cubic Bezier conversion, same
	// technique as BalanceChart's linePath.
	function pathFor(points: ChartPoint[]): string {
		if (points.length < 2) return '';
		const coords = points.map((p) => ({ x: xFor(p.x), y: yFor(p.y) }));
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
	}

	const paths = $derived(
		series.map((s, i) => ({
			d: pathFor(s.points),
			color: s.color ?? 'var(--accent)',
			label: s.label ?? `Series ${i + 1}`
		}))
	);

	// Y-axis: 4 evenly spaced ticks across the padded bounds.
	const Y_TICKS = 4;
	const yTicks = $derived.by(() => {
		if (!hasData) return [];
		const { minY, maxY } = bounds;
		const ticks: { y: number; label: string }[] = [];
		for (let i = 0; i <= Y_TICKS; i++) {
			const frac = i / Y_TICKS;
			const value = minY + frac * (maxY - minY);
			ticks.push({ y: yFor(value), label: yFormat(value) });
		}
		return ticks;
	});

	// X-axis: up to 5 ticks, snapped to the nearest point of the longest
	// series so labels line up with real data rather than an arbitrary
	// interpolated x (mirrors the "no duplicate labels" care in BalanceChart).
	const X_TICKS = 5;
	const xTicks = $derived.by(() => {
		const longest = [...series].sort((a, b) => b.points.length - a.points.length)[0];
		const pts = longest?.points ?? [];
		if (pts.length < 2) return [];
		const { minX, maxX } = bounds;
		const count = Math.min(X_TICKS, pts.length);
		const ticks: { x: number; label: string }[] = [];
		let lastIdx = -1;
		let lastLabel = '';
		for (let i = 0; i < count; i++) {
			const frac = count === 1 ? 0 : i / (count - 1);
			const target = minX + frac * (maxX - minX);
			let idx = 0;
			let best = Infinity;
			for (let j = 0; j < pts.length; j++) {
				const d = Math.abs(pts[j].x - target);
				if (d < best) {
					best = d;
					idx = j;
				}
			}
			if (idx === lastIdx) continue;
			const label = xFormat(pts[idx].x);
			if (label === lastLabel) continue;
			lastIdx = idx;
			lastLabel = label;
			ticks.push({ x: xFor(pts[idx].x), label });
		}
		return ticks;
	});

	// Hover state — nearest point (by x) across all series.
	let svgEl: SVGSVGElement | null = $state(null);
	let hoverX = $state<number | null>(null);

	function handlePointerMove(event: PointerEvent) {
		if (!showTooltip || !svgEl || allPoints.length === 0) return;
		const rect = svgEl.getBoundingClientRect();
		if (rect.width === 0) return;
		const relX = ((event.clientX - rect.left) / rect.width) * VB_W;
		let nearest = allPoints[0].x;
		let bestDist = Infinity;
		for (const p of allPoints) {
			const dist = Math.abs(xFor(p.x) - relX);
			if (dist < bestDist) {
				bestDist = dist;
				nearest = p.x;
			}
		}
		hoverX = nearest;
	}

	function handlePointerLeave() {
		hoverX = null;
	}

	// One tooltip row per series, snapped to the point nearest hoverX.
	type HoverRow = { point: ChartPoint; color: string; label: string | undefined };
	const hoverRows = $derived.by((): HoverRow[] => {
		if (hoverX === null) return [];
		const rows: HoverRow[] = [];
		for (const s of series) {
			let nearest: ChartPoint | null = null;
			let bestDist = Infinity;
			for (const p of s.points) {
				const dist = Math.abs(p.x - hoverX);
				if (dist < bestDist) {
					bestDist = dist;
					nearest = p;
				}
			}
			if (nearest) rows.push({ point: nearest, color: s.color ?? 'var(--accent)', label: s.label });
		}
		return rows;
	});

	const hoverPlotX = $derived(hoverRows.length > 0 ? xFor(hoverRows[0].point.x) : null);

	const TOOLTIP_W = 150;
	const tooltipX = $derived.by(() => {
		if (hoverPlotX === null) return 0;
		let x = hoverPlotX - TOOLTIP_W / 2;
		if (x < PAD_L) x = PAD_L;
		if (x + TOOLTIP_W > VB_W - PAD_R) x = VB_W - PAD_R - TOOLTIP_W;
		return x;
	});

	// ---------------------------------------------------------------------------
	// Bar mode — categorical columns/rows that reuse the same viewBox, padding,
	// gridline, axis-label and tooltip machinery as the line mode above. The
	// value axis is anchored at zero so signed bars (difficulty swings) render
	// above/below a shared baseline; horizontal bars always start at a zero
	// origin so length reads as a proportion.
	// ---------------------------------------------------------------------------

	// Value domain. Always includes zero so the baseline is meaningful; the
	// non-zero side is padded so the tallest/longest bar never hugs the edge.
	const barDomain = $derived.by(() => {
		if (!isBar || bars.length === 0) return { min: 0, max: 1 };
		const vals = bars.map((b) => b.value);
		if (isHorizontal) {
			const max = Math.max(0, ...vals);
			return { min: 0, max: max === 0 ? 1 : max * 1.08 };
		}
		let min = Math.min(0, ...vals);
		let max = Math.max(0, ...vals);
		if (min === max) max = min + 1;
		const pad = (max - min) * 0.12 || 1;
		if (min < 0) min -= pad;
		if (max > 0) max += pad;
		return { min, max };
	});

	/** Pixel position along the value axis (x for horizontal, y for vertical). */
	function valuePos(v: number): number {
		const { min, max } = barDomain;
		const frac = max === min ? 0 : (v - min) / (max - min);
		return isHorizontal ? PAD_L + frac * PLOT_W : PAD_T + (1 - frac) * PLOT_H;
	}

	// One evenly divided slot per bar along the category axis.
	const barSlot = $derived(
		bars.length === 0 ? 0 : (isHorizontal ? PLOT_H : PLOT_W) / bars.length
	);

	/** Pixel center of bar `i` along the category axis. */
	function barCenter(i: number): number {
		return (isHorizontal ? PAD_T : PAD_L) + (i + 0.5) * barSlot;
	}

	const barThick = $derived(
		Math.min(barSlot * (isHorizontal ? 0.62 : 0.55), isHorizontal ? 18 : 28)
	);

	const barZeroPos = $derived(valuePos(0));

	const barRects = $derived.by(() => {
		if (!isBar) return [];
		return bars.map((b, i) => {
			const center = barCenter(i);
			const vp = valuePos(b.value);
			if (isHorizontal) {
				return {
					x: Math.min(barZeroPos, vp),
					y: center - barThick / 2,
					w: Math.abs(vp - barZeroPos),
					h: barThick,
					bar: b,
					i
				};
			}
			return {
				x: center - barThick / 2,
				y: Math.min(barZeroPos, vp),
				w: barThick,
				h: Math.abs(vp - barZeroPos),
				bar: b,
				i
			};
		});
	});

	// Value-axis ticks — same even-division scheme as the line-mode Y ticks, so
	// the tick math lives in exactly one place conceptually.
	const barValueTicks = $derived.by(() => {
		if (!isBar || !hasData) return [];
		const { min, max } = barDomain;
		const ticks: { pos: number; label: string }[] = [];
		for (let i = 0; i <= Y_TICKS; i++) {
			const value = min + (i / Y_TICKS) * (max - min);
			ticks.push({ pos: valuePos(value), label: fmtValue(value) });
		}
		return ticks;
	});

	// Category-axis captions — one per bar, at each bar's center.
	const barCats = $derived.by(() => {
		if (!isBar) return [];
		return bars.map((b, i) => ({ pos: barCenter(i), label: b.label }));
	});

	// Hover — which bar the pointer is over (by category-axis slot).
	let hoverBar = $state<number | null>(null);

	function handleBarMove(event: PointerEvent) {
		if (!showTooltip || !svgEl || bars.length === 0) return;
		const rect = svgEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		let idx: number;
		if (isHorizontal) {
			const relY = ((event.clientY - rect.top) / rect.height) * VB_H;
			idx = Math.floor((relY - PAD_T) / barSlot);
		} else {
			const relX = ((event.clientX - rect.left) / rect.width) * VB_W;
			idx = Math.floor((relX - PAD_L) / barSlot);
		}
		hoverBar = idx >= 0 && idx < bars.length ? idx : null;
	}

	function handleBarLeave() {
		hoverBar = null;
	}

	const barTooltip = $derived.by(() => {
		if (!isBar || hoverBar === null) return null;
		const bar = bars[hoverBar];
		if (!bar) return null;
		const center = barCenter(hoverBar);
		const vp = valuePos(bar.value);
		return {
			bar,
			anchorX: isHorizontal ? vp : center,
			anchorY: isHorizontal ? center : vp
		};
	});

	const barTooltipX = $derived.by(() => {
		if (!barTooltip) return 0;
		let x = barTooltip.anchorX - TOOLTIP_W / 2;
		if (x < PAD_L) x = PAD_L;
		if (x + TOOLTIP_W > VB_W - PAD_R) x = VB_W - PAD_R - TOOLTIP_W;
		return x;
	});
</script>

<div class="cairn-chart">
	{#if !hasData}
		<div class="empty" style="min-height: {VB_H}px">No data to chart yet.</div>
	{:else}
		<div class="chart-wrap" bind:clientWidth={plotWidth}>
			<svg
				bind:this={svgEl}
				viewBox="0 0 {VB_W} {VB_H}"
				style="height: {VB_H}px"
				role="img"
				aria-label={ariaLabel ?? series[0]?.label ?? 'Chart'}
				onpointermove={isBar ? handleBarMove : handlePointerMove}
				onpointerleave={isBar ? handleBarLeave : handlePointerLeave}
			>
				{#if isBar}
					{#if showGrid}
						{#each barValueTicks as tick (tick.pos)}
							{#if isHorizontal}
								<line class="grid-line" x1={tick.pos} y1={PAD_T} x2={tick.pos} y2={PAD_T + PLOT_H} />
							{:else}
								<line class="grid-line" x1={PAD_L} y1={tick.pos} x2={VB_W - PAD_R} y2={tick.pos} />
							{/if}
						{/each}
					{/if}

					<!-- Zero baseline (only distinct from an axis edge when bars are signed) -->
					{#if isHorizontal}
						<line class="baseline-axis" x1={barZeroPos} y1={PAD_T} x2={barZeroPos} y2={PAD_T + PLOT_H} />
					{:else}
						<line class="baseline-axis" x1={PAD_L} y1={barZeroPos} x2={VB_W - PAD_R} y2={barZeroPos} />
					{/if}

					{#each barRects as r (r.i)}
						<rect
							class="bar-rect"
							x={r.x}
							y={r.y}
							width={Math.max(r.w, 0)}
							height={Math.max(r.h, 0)}
							rx="2"
							style="fill: {r.bar.color ?? 'var(--accent)'}"
							opacity={hoverBar === null || hoverBar === r.i ? 1 : 0.72}
						/>
					{/each}

					{#if showAxes}
						{#each barValueTicks as tick (tick.pos)}
							{#if isHorizontal}
								<text class="axis-label" x={tick.pos} y={VB_H - 6} text-anchor="middle">{tick.label}</text>
							{:else}
								<text class="axis-label y-axis-label" x={PAD_L - 8} y={tick.pos + 3} text-anchor="end">{tick.label}</text>
							{/if}
						{/each}
						{#each barCats as cat (cat.pos)}
							{#if isHorizontal}
								<text class="axis-label y-axis-label" x={PAD_L - 8} y={cat.pos + 3} text-anchor="end">{cat.label}</text>
							{:else}
								<text class="axis-label" x={cat.pos} y={VB_H - 6} text-anchor="middle">{cat.label}</text>
							{/if}
						{/each}
					{/if}
				{:else}
					{#if showGrid}
						{#each yTicks as tick (tick.y)}
							<line class="grid-line" x1={PAD_L} y1={tick.y} x2={VB_W - PAD_R} y2={tick.y} />
						{/each}
					{/if}

					{#each paths as p (p.label)}
						<path class="line" d={p.d} fill="none" stroke={p.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
					{/each}

					{#if showAxes}
						{#each yTicks as tick (tick.y)}
							<text class="axis-label y-axis-label" x={PAD_L - 8} y={tick.y + 3} text-anchor="end">
								{tick.label}
							</text>
						{/each}
						{#each xTicks as tick (tick.x)}
							<text class="axis-label" x={tick.x} y={VB_H - 6} text-anchor="middle">
								{tick.label}
							</text>
						{/each}
					{/if}

					{#if showTooltip && hoverPlotX !== null}
						<line class="guide" x1={hoverPlotX} y1={PAD_T} x2={hoverPlotX} y2={PAD_T + PLOT_H} />
						{#each hoverRows as row (row.label ?? row.point.x)}
							<circle class="dot-halo" cx={hoverPlotX} cy={yFor(row.point.y)} r="6" style="fill: {row.color}" />
							<circle class="dot" cx={hoverPlotX} cy={yFor(row.point.y)} r="3.5" style="fill: {row.color}" />
						{/each}
					{/if}
				{/if}
			</svg>

			{#if isBar && showTooltip && barTooltip}
				<div
					class="tooltip"
					style="left: {(barTooltipX / VB_W) * 100}%; top: {(barTooltip.anchorY / VB_H) * 100}%;"
				>
					<div class="tooltip-x">{barTooltip.bar.label}</div>
					<div class="tooltip-row">
						<span class="tooltip-y">{barTooltip.bar.valueLabel ?? fmtValue(barTooltip.bar.value)}</span>
					</div>
					{#if barTooltip.bar.note}
						<div class="tooltip-note">{barTooltip.bar.note}</div>
					{/if}
				</div>
			{:else if !isBar && showTooltip && hoverRows.length > 0 && hoverPlotX !== null}
				<div
					class="tooltip"
					style="left: {(tooltipX / VB_W) * 100}%; top: {(yFor(hoverRows[0].point.y) / VB_H) * 100}%;"
				>
					<div class="tooltip-x">{xFormat(hoverRows[0].point.x)}</div>
					{#each hoverRows as row (row.label ?? row.point.x)}
						<div class="tooltip-row">
							{#if series.length > 1}
								<span class="tooltip-dot" style="background: {row.color}"></span>
							{/if}
							<span class="tooltip-y">{yFormat(row.point.y)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		{#if series.length > 1}
			<div class="legend">
				{#each series as s, i (s.label ?? i)}
					<span class="legend-item">
						<span class="legend-dot" style="background: {s.color ?? 'var(--accent)'}"></span>
						<span class="legend-label">{s.label ?? `Series ${i + 1}`}</span>
					</span>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.cairn-chart {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.85rem;
	}

	.chart-wrap {
		position: relative;
		width: 100%;
	}

	svg {
		display: block;
		width: 100%;
		overflow: visible;
		touch-action: none;
	}

	.grid-line {
		stroke: var(--border-subtle);
		stroke-width: 1;
		opacity: 0.5;
	}

	.line {
		vector-effect: non-scaling-stroke;
	}

	.bar-rect {
		transition: opacity 120ms var(--ease, ease);
	}

	/* Zero baseline for bar mode — a touch stronger than a gridline so signed
	   bars read against a clear origin, but still quiet. */
	.baseline-axis {
		stroke: var(--border-subtle);
		stroke-width: 1;
		opacity: 0.9;
	}

	.tooltip-note {
		font-family: var(--font-ui);
		font-size: 0.68rem;
		color: var(--text-muted);
		margin-top: 0.15rem;
		white-space: nowrap;
	}

	.axis-label {
		fill: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 10px;
	}

	.y-axis-label {
		fill: var(--text-muted);
	}

	.guide {
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		opacity: 0.5;
	}

	.dot-halo {
		opacity: 0.2;
	}

	.dot {
		stroke: var(--bg);
		stroke-width: 1.5;
	}

	.tooltip {
		position: absolute;
		transform: translate(0, calc(-100% - 12px));
		pointer-events: none;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-strip);
		padding: 0.4rem 0.6rem;
		min-width: 110px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		z-index: 2;
	}

	.tooltip-x {
		font-family: var(--font-ui);
		font-size: 0.7rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.tooltip-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 0.1rem;
	}

	.tooltip-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.tooltip-y {
		font-family: var(--font-serif);
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		padding: 0 4px;
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-ui);
		font-size: 11px;
		color: var(--text-muted);
	}

	.legend-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}
</style>
