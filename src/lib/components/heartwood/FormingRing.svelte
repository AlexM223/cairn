<script lang="ts">
	/**
	 * FormingRing — the next block being born (T-A, cairn-6efi.2). The head element
	 * of the explorer index's "Up next" strip: a conic growth arc that fills as
	 * seconds-since-last-block climbs toward the ~10-minute target, sealing with a
	 * one-shot copper bloom when a new block actually lands.
	 *
	 * Vocabulary is deliberately continuous with RingStub: the not-yet-formed part
	 * of the ring is a dashed dim track (the "pending" ring that hasn't grown yet),
	 * the grown-so-far part is bright copper with a glowing leading tip.
	 *
	 * Motion is CSS-only and honors prefers-reduced-motion:
	 *  - `growth` (0..1) positions the copper arc; it is a value, not an animation,
	 *    so it is always correct even with motion disabled.
	 *  - the ambient "breathing" of the leading tip and the seal bloom are the only
	 *    animations, and both are suppressed under reduced-motion.
	 *
	 * The seal bloom is a one-shot: bump `sealKey` (from a real tip-height increase)
	 * and the {#key} re-mounts the bloom layer, restarting its CSS animation exactly
	 * once. No JS timers drive the animation itself.
	 */
	let {
		growth = 0,
		nextFee = null,
		sealKey = 0
	}: {
		/** 0..1 — min(1, secondsSinceLastBlock / 600). */
		growth?: number;
		/** ~sat/vB to make it into the next block, or null when unknown. */
		nextFee?: number | null;
		/** Increment on a genuine new block to fire the seal bloom once. */
		sealKey?: number;
	} = $props();

	// viewBox 0 0 48 48, centre 24, r 20 → circumference for the dash math.
	const R = 20;
	const C = 2 * Math.PI * R;
	const g = $derived(Math.min(1, Math.max(0, growth)));
	// Leading-tip marker sits at the end of the grown arc (12 o'clock = -90°).
	const tipAngle = $derived(-90 + g * 360);
	const tipX = $derived(24 + R * Math.cos((tipAngle * Math.PI) / 180));
	const tipY = $derived(24 + R * Math.sin((tipAngle * Math.PI) / 180));
</script>

<div class="forming" style:--growth={g}>
	<div class="ring-wrap">
		<svg viewBox="0 0 48 48" width="46" height="46" class="ring" aria-hidden="true">
			<!-- pending track: the ring that hasn't formed yet (RingStub's dashed
			     "pending" vocabulary). -->
			<circle cx="24" cy="24" r={R} class="track" />
			<!-- grown-so-far copper arc. -->
			<circle
				cx="24"
				cy="24"
				r={R}
				class="grown"
				stroke-dasharray="{g * C} {C}"
				transform="rotate(-90 24 24)"
			/>
			{#if g > 0.01 && g < 0.999}
				<circle cx={tipX} cy={tipY} r="2.2" class="tip-dot" />
			{/if}
			<circle cx="24" cy="24" r="2" class="core" />
		</svg>
		{#key sealKey}
			{#if sealKey > 0}
				<span class="bloom" aria-hidden="true"></span>
				<span class="seal-flash" aria-hidden="true"></span>
			{/if}
		{/key}
	</div>
	<div class="label">
		<span class="lead">forming now</span>
		{#if nextFee !== null}
			<span class="sub">~{nextFee} sat/vB to make it</span>
		{/if}
	</div>
</div>

<style>
	.forming {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border-radius: var(--radius-strip);
		background: linear-gradient(160deg, rgba(103, 150, 201, 0.16), rgba(103, 150, 201, 0.03));
		border: 1px solid var(--accent);
	}

	.ring-wrap {
		position: relative;
		width: 46px;
		height: 46px;
	}

	.ring {
		display: block;
		overflow: visible;
	}

	.track {
		fill: none;
		stroke: var(--accent-dim-2);
		stroke-width: 3;
		stroke-dasharray: 3 3.4;
		stroke-linecap: butt;
	}

	.grown {
		fill: none;
		stroke: var(--accent-bright);
		stroke-width: 3;
		stroke-linecap: round;
		filter: drop-shadow(0 0 3px rgba(103, 150, 201, 0.55));
		transition: stroke-dasharray 600ms var(--ease);
	}

	.tip-dot {
		fill: var(--accent-core);
		animation: breathe 2.6s ease-in-out infinite;
	}

	.core {
		fill: var(--accent-dim);
		opacity: 0.6;
	}

	/* One-shot seal: bloom radiates outward once, arc-flash completes the ring. */
	.bloom {
		position: absolute;
		inset: -6px;
		border-radius: 50%;
		border: 2px solid var(--accent-bright);
		opacity: 0;
		pointer-events: none;
		animation: bloom 1.1s var(--ease) 1;
	}

	.seal-flash {
		position: absolute;
		inset: 3px;
		border-radius: 50%;
		border: 3px solid var(--accent-core);
		opacity: 0;
		pointer-events: none;
		animation: seal-flash 0.9s var(--ease) 1;
	}

	.label {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		line-height: 1.2;
	}

	.lead {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.sub {
		font-size: 10.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	@keyframes breathe {
		0%,
		100% {
			opacity: 0.55;
			r: 2;
		}
		50% {
			opacity: 1;
			r: 2.6;
		}
	}

	@keyframes bloom {
		0% {
			opacity: 0.7;
			transform: scale(0.7);
		}
		100% {
			opacity: 0;
			transform: scale(1.5);
		}
	}

	@keyframes seal-flash {
		0% {
			opacity: 0.85;
		}
		100% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.grown {
			transition: none;
		}
		.tip-dot {
			animation: none;
		}
		.bloom,
		.seal-flash {
			animation: none;
			opacity: 0;
		}
	}
</style>
