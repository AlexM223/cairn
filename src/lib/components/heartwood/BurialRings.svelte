<script module lang="ts">
	/**
	 * Brand copy for burial depth — never "N confirmations".
	 * 0 → "no rings yet" · 1–5 → "buried N ring(s) deep" · 6+ → "sealed · six rings deep".
	 */
	export function burialRingsLabel(confirmations: number): string {
		if (confirmations <= 0) return 'no rings yet';
		if (confirmations >= 6) return 'sealed · six rings deep';
		return `buried ${confirmations} ring${confirmations === 1 ? '' : 's'} deep`;
	}
</script>

<script lang="ts">
	/**
	 * BurialRings — the confirmation glyph. One thin ring grows around the
	 * center dot per confirmation; at six the glyph is "sealed" (it becomes
	 * the logo — the ring count caps there). Mempool (0 conf) is a single
	 * dashed ring pulsing. Sage for incoming, copper for outgoing.
	 *
	 * Conceptual replacement for the old ConfirmMeter segment bar (that file
	 * is retired by page lanes, not here).
	 */
	let {
		confirmations,
		direction,
		size = 28
	}: {
		confirmations: number;
		direction: 'in' | 'out';
		/** Rendered px size — 26–34 per spec. */
		size?: number;
	} = $props();

	// Ring radii in the 36-unit viewBox, innermost first (up to 6 rings).
	const RADII = [4.9, 7.3, 9.7, 12.1, 14.5, 16.9];
	// Alternating opacity outward, repeating.
	const OPACITY = [0.85, 0.55, 0.32];

	const ringCount = $derived(Math.min(Math.max(Math.floor(confirmations), 0), 6));
	const color = $derived(direction === 'in' ? 'var(--sage)' : 'var(--accent)');
	const label = $derived(burialRingsLabel(confirmations));
</script>

<svg viewBox="0 0 36 36" width={size} height={size} class="burial" role="img" aria-label={label}>
	<circle cx="18" cy="18" r="2.4" fill={color} />
	{#if ringCount === 0}
		<!-- Mempool: one dashed ring, pulsing until the first ring buries it. -->
		<circle
			class="mempool"
			cx="18"
			cy="18"
			r={RADII[1]}
			fill="none"
			stroke={color}
			stroke-width="1.1"
			stroke-dasharray="3.5 4"
		/>
	{:else}
		{#each RADII.slice(0, ringCount) as r, i (r)}
			<circle
				cx="18"
				cy="18"
				{r}
				fill="none"
				stroke={color}
				stroke-width="1.1"
				opacity={OPACITY[i % OPACITY.length]}
			/>
		{/each}
	{/if}
</svg>

<style>
	.burial {
		display: block;
		overflow: visible;
		flex-shrink: 0;
	}

	.mempool {
		animation: hwPulse 2.4s ease-in-out infinite;
	}
</style>
