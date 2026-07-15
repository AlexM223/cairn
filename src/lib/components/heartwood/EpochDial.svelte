<script lang="ts">
	/**
	 * EpochDial — node/sync status ring.
	 *
	 * Faint inner rings + a track ring + a progress arc showing how far the
	 * current difficulty epoch ("forming ring") has grown:
	 * progress = (height − N·2016) / 2016. Pulsing tip dot rides the arc's
	 * leading edge; core dot at the pith.
	 *
	 * Geometry follows the HWRail.dc.html reference SVG (34-unit viewBox:
	 * inner rings r5/r9, track+arc r13.5), scaled to `size`.
	 * Sizes per spec: 14–16 in pills, 38 in the rail, 72–96 on the node page.
	 *
	 * `pulseKey`: bump this to any new value (e.g. the block height) to
	 * retrigger the one-shot new-ring sweep — call sites wire it to their
	 * live tip feed later.
	 */
	type DialState = 'at-tip' | 'syncing' | 'behind';

	// The prop is named `state` for callers; locally aliased to `dialState`
	// because a binding called `state` collides with the $state rune.
	let {
		state: dialState,
		progress,
		size = 38,
		showPercent = false,
		pulseKey = undefined
	}: {
		state: DialState;
		/** 0–1 forming-ring progress within the current epoch. */
		progress: number;
		size?: number;
		/** Syncing only: render the numeric % in the dial center. */
		showPercent?: boolean;
		/** Change this value to replay the one-shot sweep (e.g. block height). */
		pulseKey?: unknown;
	} = $props();

	const R = 13.5;
	const C = 2 * Math.PI * R;

	const p = $derived(Math.min(Math.max(progress, 0), 1));
	const arc = $derived(Math.max(p * C, 0.001));
	const tipAngle = $derived(-Math.PI / 2 + p * 2 * Math.PI);
	const tipX = $derived(17 + R * Math.cos(tipAngle));
	const tipY = $derived(17 + R * Math.sin(tipAngle));

	// at-tip: slate-blue accent · syncing: a dim blend between --accent and
	// --accent-dim · behind: --accent-dim, duller still.
	const arcColor = $derived(
		dialState === 'at-tip'
			? 'var(--accent)'
			: dialState === 'syncing'
				? 'color-mix(in srgb, var(--accent) 55%, var(--accent-dim))'
				: 'var(--accent-dim)'
	);

	// One-shot sweep retrigger: any change to pulseKey after the first render
	// unmounts and remounts the sweep circle so hwSweepOnce replays.
	let showSweep = $state(false);
	let prevKey: unknown = undefined;
	let seeded = false;
	$effect(() => {
		const k = pulseKey;
		if (seeded && k !== prevKey) {
			showSweep = false;
			requestAnimationFrame(() => {
				showSweep = true;
			});
		}
		prevKey = k;
		seeded = true;
	});
</script>

<svg
	viewBox="0 0 34 34"
	width={size}
	height={size}
	class="dial"
	role="img"
	aria-label={dialState === 'at-tip'
		? 'Node at tip'
		: dialState === 'syncing'
			? `Syncing — ${Math.round(p * 100)}%`
			: 'Node behind'}
>
	<!-- Faint inner rings -->
	<circle cx="17" cy="17" r="5" fill="none" stroke={arcColor} stroke-width="1.1" opacity="0.45" />
	<circle cx="17" cy="17" r="9" fill="none" stroke={arcColor} stroke-width="1.1" opacity="0.6" />
	<!-- Track -->
	<circle cx="17" cy="17" r={R} fill="none" stroke="var(--border-subtle)" stroke-width="1.6" />
	<!-- Forming-ring progress arc, 12 o'clock start -->
	<circle
		cx="17"
		cy="17"
		r={R}
		fill="none"
		stroke={arcColor}
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-dasharray="{arc} {C}"
		transform="rotate(-90 17 17)"
		style={dialState === 'at-tip' ? 'filter: drop-shadow(0 0 3px rgba(103, 150, 201, 0.5))' : ''}
	/>
	<!-- Tip dot at the arc's leading edge -->
	<circle
		class:pulse={dialState === 'at-tip'}
		cx={tipX}
		cy={tipY}
		r="2"
		fill="var(--accent-glow)"
		opacity={dialState === 'behind' ? 0.55 : 1}
	/>
	{#if showSweep}
		<!-- Once per new block: a ring closes. -->
		<circle
			class="sweep"
			cx="17"
			cy="17"
			r="16"
			fill="none"
			stroke="var(--accent-glow)"
			stroke-width="1.2"
			onanimationend={() => (showSweep = false)}
		/>
	{/if}
	<!-- Center: core dot, or the state glyph that replaces it -->
	{#if dialState === 'behind'}
		<text x="17" y="20.6" text-anchor="middle" class="glyph" fill="var(--attention)">!</text>
	{:else if dialState === 'syncing' && showPercent}
		<text x="17" y="19.6" text-anchor="middle" class="pct" fill="var(--text-secondary)">
			{Math.round(p * 100)}%
		</text>
	{:else}
		<circle cx="17" cy="17" r="1.6" fill="var(--accent-core)" />
	{/if}
</svg>

<style>
	.dial {
		display: block;
		overflow: visible;
		flex-shrink: 0;
	}

	.pulse {
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.sweep {
		transform-box: fill-box;
		transform-origin: center;
		animation: hwSweepOnce 2.4s ease-out both;
	}

	.glyph {
		font: 700 10px var(--font-ui);
	}

	.pct {
		font: 600 7.5px var(--font-ui);
		font-variant-numeric: tabular-nums;
	}
</style>
