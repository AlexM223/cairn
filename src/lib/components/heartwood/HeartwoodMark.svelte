<script lang="ts">
	/**
	 * HeartwoodMark — the rings logo.
	 *
	 * Direct port of the ring math in
	 * `heartwood design 2/design_handoff_heartwood_v3/source/HeartwoodMark.dc.html`:
	 * concentric growth rings with an eccentric pith sitting up-left, rings
	 * drifting down-right as they grow (real heartwood), alternating
	 * bold/hair bands like earlywood/latewood.
	 *
	 * This is the visual source of truth for the mark — shell/rail, favicon
	 * and rebrand lanes consume it by this exact API.
	 */
	type Tone = 'copper' | 'cream' | 'ink' | 'mono';
	type Detail = 'full' | 'simple' | 'min';

	let {
		size = 120,
		tone = 'copper',
		detail = 'full',
		core = true,
		sweep = false
	}: {
		size?: number;
		tone?: Tone;
		detail?: Detail;
		/** Show the center pith dot. */
		core?: boolean;
		/** One-shot new-ring sweep animation (hwSweepOnce). */
		sweep?: boolean;
	} = $props();

	// [radius, strokeWidth, opacity] per detail level (100-unit viewBox).
	const DEFS: Record<Detail, [number, number, number][]> = {
		min: [
			[43, 3.2, 0.95],
			[28, 2.6, 0.82],
			[15, 2.4, 0.82]
		],
		simple: [
			[44, 2.4, 0.95],
			[36, 1.2, 0.6],
			[27.5, 1.9, 0.85],
			[18.5, 1.2, 0.6],
			[10.5, 1.7, 0.8]
		],
		full: [
			[45, 2.3, 0.95],
			[39.5, 0.9, 0.5],
			[34, 1.7, 0.9],
			[28.5, 0.9, 0.5],
			[23, 1.7, 0.9],
			[17.5, 0.9, 0.5],
			[12, 1.5, 0.85],
			[6.8, 0.9, 0.52]
		]
	};

	const TONES: Record<Tone, { stroke: string; core: string; glow: string }> = {
		copper: {
			stroke: 'var(--accent)',
			core: 'var(--accent-core)',
			glow: 'drop-shadow(0 0 3px rgba(232, 147, 90, 0.85))'
		},
		cream: {
			stroke: '#f1e4d6',
			core: '#ffffff',
			glow: 'drop-shadow(0 0 2px rgba(255, 240, 225, 0.5))'
		},
		ink: { stroke: '#241812', core: '#3a241a', glow: 'none' },
		mono: { stroke: 'var(--accent)', core: 'var(--accent)', glow: 'none' }
	};

	// Eccentric pith: cx/cy drift with the ring's relative radius t = r/45.
	const rings = $derived(
		DEFS[detail].map(([r, w, o]) => {
			const t = r / 45;
			return { cx: 49 + t * 2, cy: 45 + t * 7, rx: r, ry: r * 0.955, w, o };
		})
	);
	const tm = $derived(TONES[tone]);
	const coreR = $derived(detail === 'min' ? 5.5 : detail === 'simple' ? 4 : 3.4);
</script>

<svg
	viewBox="0 0 100 100"
	width={size}
	height={size}
	class="mark"
	role="img"
	aria-label="Heartwood"
>
	{#each rings as ring (ring.rx)}
		<ellipse
			cx={ring.cx}
			cy={ring.cy}
			rx={ring.rx}
			ry={ring.ry}
			fill="none"
			stroke={tm.stroke}
			stroke-width={ring.w}
			opacity={ring.o}
		/>
	{/each}
	{#if sweep}
		<!-- One-shot ring-close sweep: scale .18→1 + fade (app.css hwSweepOnce). -->
		<circle class="sweep" cx="49.3" cy="46" r="45" fill="none" stroke={tm.core} stroke-width="1.3" />
	{/if}
	{#if core}
		<circle cx="49.3" cy="46" r={coreR} fill={tm.core} style="filter: {tm.glow}" />
	{/if}
</svg>

<style>
	.mark {
		overflow: visible;
		display: block;
	}

	.sweep {
		transform-box: fill-box;
		transform-origin: center;
		animation: hwSweepOnce 2.4s ease-out both;
	}
</style>
