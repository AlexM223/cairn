<script lang="ts">
	/**
	 * RingBar — a thin block-fullness sliver for the explorer block rows (T-C,
	 * cairn-6efi.4). The fill width is the block's fullness (weight ÷ 4M WU) and its
	 * colour is tinted cool sage → warm copper by the block's median fee, so a dense,
	 * high-fee block reads warm and a near-empty low-fee block reads cool.
	 *
	 * Fullness is a value (a width), not an animation — correct with motion disabled.
	 * Renders nothing when fullness is unknown (Cardinal rule: absence reads as
	 * absence, never a false empty bar).
	 */
	import { ringBarVisible, ringBarPct } from './ringBarGuard';

	let {
		fullness,
		medianFee = null,
		width = 40
	}: {
		/** 0..1 block fullness, or null when unknown (Electrum-only baseline). */
		fullness: number | null;
		/** sat/vB median fee for the warm/cool tint; null → neutral sage. */
		medianFee?: number | null;
		/** Track width in px. */
		width?: number;
	} = $props();

	const pct = $derived(ringBarPct(fullness));
	// Warm factor: 0 at ~0 sat/vB → 1 at ~100 sat/vB (saturating). color-mix blends
	// sage→copper so the tint is a single continuous scale, tokenized both ends.
	const warm = $derived(medianFee === null ? 0 : Math.min(1, Math.max(0, medianFee / 100)));
</script>

{#if ringBarVisible(fullness)}
	<span
		class="ringbar"
		style:width="{width}px"
		style:--pct="{pct}%"
		style:--fill="color-mix(in oklab, var(--sage), var(--accent-bright) {Math.round(warm * 100)}%)"
		title="{pct}% full"
		aria-hidden="true"
	>
		<span class="fill"></span>
	</span>
{/if}

<style>
	.ringbar {
		display: inline-block;
		height: 4px;
		border-radius: 2px;
		background: var(--accent-dim-2);
		overflow: hidden;
		flex-shrink: 0;
	}

	.fill {
		display: block;
		height: 100%;
		width: var(--pct);
		background: var(--fill);
		border-radius: 2px;
		transition: width 400ms var(--ease);
	}

	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}
	}
</style>
