<script lang="ts">
	/**
	 * BreathingCounter — a number that feels alive. It "breathes" with a very
	 * subtle, slow opacity pulse so a live tip/count reads as a living value
	 * rather than a frozen figure, and gives a brief copper highlight the moment
	 * its value actually changes (a new block drained the mempool, say).
	 *
	 * Motion is CSS-only and calm; under `prefers-reduced-motion: reduce` both the
	 * idle breath and the change-flash are disabled and the number is simply
	 * static. The caller passes an already-formatted string plus the raw value so
	 * we can detect a real change without re-parsing the display text.
	 */
	let {
		value,
		display,
		unit = ''
	}: {
		/** Raw numeric value — used only to detect a genuine change to flash on. */
		value: number | null;
		/** Pre-formatted text to show (e.g. "12,481", "184 MB"). */
		display: string;
		/** Optional trailing unit rendered in muted type. */
		unit?: string;
	} = $props();

	let flash = $state(false);
	let prev: number | null = null;

	// Flash briefly whenever the value moves (not on first paint). A keyed class
	// toggle restarts the CSS animation; the timeout clears it.
	$effect(() => {
		const v = value;
		if (prev !== null && v !== null && v !== prev) {
			flash = false;
			// Force a reflow-free restart on the next microtask.
			queueMicrotask(() => {
				flash = true;
				setTimeout(() => (flash = false), 900);
			});
		}
		prev = v;
	});
</script>

<span class="breathing" class:flash aria-live="off">
	<span class="num tabular">{display}</span>{#if unit}<span class="unit">{unit}</span>{/if}
</span>

<style>
	.breathing {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
	}

	.num {
		animation: breathe 4.5s ease-in-out infinite;
		transition: color 900ms var(--ease, ease);
	}

	.breathing.flash .num {
		animation: flash-pulse 900ms var(--ease, ease);
		color: var(--accent-bright, var(--accent));
	}

	.unit {
		font-size: 0.62em;
		color: var(--text-muted);
		font-weight: 500;
	}

	@keyframes breathe {
		0%,
		100% {
			opacity: 0.9;
		}
		50% {
			opacity: 1;
		}
	}

	@keyframes flash-pulse {
		0% {
			color: var(--accent-bright, var(--accent));
			transform: translateY(-1px);
		}
		100% {
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.num,
		.breathing.flash .num {
			animation: none;
			transform: none;
		}
	}
</style>
