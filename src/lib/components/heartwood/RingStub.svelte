<script lang="ts">
	/**
	 * RingStub — the small block-row glyph (explorer "Latest rings" rows,
	 * activity block events). Two partial arcs with a deliberate gap so it
	 * reads as a growing stub, not a finished ring.
	 *
	 * tip = bright copper + glow + core dot · past = dim copper fading
	 * outward · pending = dashed dim full circles (the ring that hasn't
	 * formed yet).
	 */
	let {
		state,
		size = 15
	}: {
		state: 'tip' | 'past' | 'pending';
		/** Rendered px size — 14–17 per spec. */
		size?: number;
	} = $props();

	// Inner arc r4 spans ~300°, outer arc r7.5 spans ~320°; both start at
	// 12 o'clock (rotate −90°).
	const R1 = 4;
	const R2 = 7.5;
	const C1 = 2 * Math.PI * R1;
	const C2 = 2 * Math.PI * R2;
	const arc1 = C1 * (300 / 360);
	const arc2 = C2 * (320 / 360);
</script>

<svg viewBox="0 0 17 17" width={size} height={size} class="stub {state}" aria-hidden="true">
	{#if state === 'pending'}
		<circle cx="8.5" cy="8.5" r={R1} class="ring" />
		<circle cx="8.5" cy="8.5" r={R2} class="ring" />
	{:else}
		<circle
			cx="8.5"
			cy="8.5"
			r={R1}
			class="ring inner"
			stroke-dasharray="{arc1} {C1}"
			transform="rotate(-90 8.5 8.5)"
		/>
		<circle
			cx="8.5"
			cy="8.5"
			r={R2}
			class="ring outer"
			stroke-dasharray="{arc2} {C2}"
			transform="rotate(-90 8.5 8.5)"
		/>
		{#if state === 'tip'}
			<circle cx="8.5" cy="8.5" r="1.3" class="core" />
		{/if}
	{/if}
</svg>

<style>
	.stub {
		display: block;
		overflow: visible;
		flex-shrink: 0;
	}

	.ring {
		fill: none;
		stroke-width: 1.2;
		stroke-linecap: round;
	}

	.tip .ring {
		stroke: var(--accent-bright);
	}

	.tip {
		filter: drop-shadow(0 0 3px rgba(232, 147, 90, 0.5));
	}

	.tip .core {
		fill: var(--accent-core);
	}

	/* Past blocks fade outward. */
	.past .inner {
		stroke: var(--accent-dim);
		opacity: 0.75;
	}

	.past .outer {
		stroke: var(--accent-dim);
		opacity: 0.45;
	}

	.pending .ring {
		stroke: var(--accent-dim-2);
		stroke-dasharray: 2.6 3;
		stroke-linecap: butt;
	}
</style>
