<script lang="ts">
	interface Props {
		/** Balance values over time, oldest first. */
		points: number[];
		width?: number;
		height?: number;
		color?: string;
		strokeWidth?: number;
		/**
		 * Fill the container's width (mobile Home's edge-to-edge sparkline).
		 * The viewBox tracks the measured width so scaling stays uniform.
		 */
		stretch?: boolean;
	}

	let {
		points,
		width = 96,
		height = 28,
		color = 'var(--accent)',
		strokeWidth = 1.5,
		stretch = false
	}: Props = $props();

	// Unique gradient id per instance (several sparklines can share a page).
	const uid = $props.id();

	// In stretch mode the drawing width follows the rendered width.
	let measuredWidth = $state(0);
	const drawWidth = $derived(stretch && measuredWidth > 0 ? measuredWidth : width);

	// Vertical inset so the stroke and last-point dot never clip at the edges.
	const pad = $derived(strokeWidth + 1);

	// Map raw values to (x, y) coordinates scaled to fit the box.
	const coords = $derived.by(() => {
		const n = points.length;
		if (n === 0) return [];

		const min = Math.min(...points);
		const max = Math.max(...points);
		const range = max - min;

		const top = pad;
		const bottom = height - pad;
		const usableH = Math.max(0, bottom - top);

		// Single point, or a flat series -> centered horizontal line.
		const flat = n === 1 || range === 0;

		const stepX = n > 1 ? drawWidth / (n - 1) : 0;

		return points.map((v, i) => {
			const x = n > 1 ? i * stepX : drawWidth / 2;
			// Invert y: higher value -> higher on screen (smaller y).
			const y = flat ? height / 2 : bottom - ((v - min) / range) * usableH;
			return { x, y };
		});
	});

	const linePoints = $derived(coords.map((c) => `${c.x},${c.y}`).join(' '));
	const last = $derived(coords.length ? coords[coords.length - 1] : null);

	// Gradient area fill: trace the line, then drop to the baseline and close.
	const areaPath = $derived.by(() => {
		if (coords.length < 2) return '';
		const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
		return `${line} L${coords[coords.length - 1].x},${height} L${coords[0].x},${height} Z`;
	});
</script>

{#if stretch}
	<div class="stretch-wrap" bind:clientWidth={measuredWidth}>
		{#if coords.length > 0 && measuredWidth > 0}
			<svg
				viewBox="0 0 {drawWidth} {height}"
				style="width: 100%; height: {height}px;"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				role="img"
				aria-label="Balance trend sparkline"
			>
				<defs>
					<linearGradient id="spark-fill-{uid}" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color={color} stop-opacity="0.18" />
						<stop offset="100%" stop-color={color} stop-opacity="0" />
					</linearGradient>
				</defs>
				{#if areaPath}
					<path d={areaPath} fill="url(#spark-fill-{uid})" />
				{/if}
				{#if coords.length === 1}
					<circle cx={coords[0].x} cy={coords[0].y} r={strokeWidth + 1} fill={color} />
				{:else}
					<polyline
						points={linePoints}
						stroke={color}
						stroke-width={strokeWidth}
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{/if}
				{#if last && coords.length > 1}
					<circle
						class="end-dot"
						cx={last.x}
						cy={last.y}
						r={strokeWidth + 1.5}
						fill="var(--accent-glow)"
					/>
				{/if}
			</svg>
		{/if}
	</div>
{:else if coords.length > 0}
	<svg
		{width}
		{height}
		viewBox="0 0 {drawWidth} {height}"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		role="img"
		aria-label="Balance trend sparkline"
	>
		<defs>
			<linearGradient id="spark-fill-{uid}" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color={color} stop-opacity="0.12" />
				<stop offset="100%" stop-color={color} stop-opacity="0" />
			</linearGradient>
		</defs>
		{#if areaPath}
			<path d={areaPath} fill="url(#spark-fill-{uid})" />
		{/if}
		{#if coords.length === 1}
			<!-- Single point: still show the anchor dot. -->
			<circle cx={coords[0].x} cy={coords[0].y} r={strokeWidth + 1} fill={color} />
		{:else}
			<polyline
				points={linePoints}
				stroke={color}
				stroke-width={strokeWidth}
				stroke-linejoin="round"
				stroke-linecap="round"
			/>
		{/if}
		{#if last && coords.length > 1}
			<circle cx={last.x} cy={last.y} r={strokeWidth + 1} fill={color} />
		{/if}
	</svg>
{/if}

<style>
	.stretch-wrap {
		width: 100%;
	}

	.stretch-wrap svg {
		display: block;
		overflow: visible;
	}

	/* The live tip pulses (hwPulse is global in app.css). */
	.end-dot {
		animation: hwPulse 2.4s ease-in-out infinite;
	}
</style>
