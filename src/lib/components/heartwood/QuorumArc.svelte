<script lang="ts">
	/**
	 * QuorumArc — multisig signature-quorum ring. The ring is split into
	 * `total` equal segments: collected ones glow slate-blue, the segment
	 * currently being signed (when `active`) pulses cream, the rest are a
	 * dim track.
	 *
	 * 26px beside "Signatures · 1 of 2 collected" on desktop, 18–20px in the
	 * mobile eyebrow.
	 */
	let {
		total,
		collected,
		active = false,
		size = 26
	}: {
		/** m — total signatures required. */
		total: number;
		/** Signatures collected so far. */
		collected: number;
		/** Pulse the next uncollected segment as "currently being signed". */
		active?: boolean;
		size?: number;
	} = $props();

	const R = 11;
	const C = 2 * Math.PI * R;

	const segs = $derived(Math.max(Math.floor(total), 1));
	const gap = $derived(Math.min(3, (C / segs) * 0.25));
	const dash = $derived(C / segs - gap);
	const segments = $derived(
		Array.from({ length: segs }, (_, i) => ({
			i,
			kind: i < collected ? 'collected' : active && i === collected ? 'active' : 'track',
			rot: -90 + (i * 360) / segs
		}))
	);
</script>

<svg
	viewBox="0 0 30 30"
	width={size}
	height={size}
	class="quorum"
	role="img"
	aria-label="{Math.min(collected, segs)} of {segs} signatures collected"
>
	{#each segments as s (s.i)}
		<circle
			cx="15"
			cy="15"
			r={R}
			class="seg {s.kind}"
			stroke-dasharray="{dash} {C}"
			transform="rotate({s.rot} 15 15)"
		/>
	{/each}
</svg>

<style>
	.quorum {
		display: block;
		overflow: visible;
		flex-shrink: 0;
	}

	.seg {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
	}

	.seg.collected {
		stroke: var(--accent);
		filter: drop-shadow(0 0 3px rgba(103, 150, 201, 0.5));
	}

	.seg.active {
		stroke: var(--accent-glow-strong);
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.seg.track {
		/* White-alpha wash, same family as --border-control. */
		stroke: var(--border-control);
	}
</style>
