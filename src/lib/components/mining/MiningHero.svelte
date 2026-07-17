<script lang="ts">
	/**
	 * MiningHero — the one hero number on /mining: this user's own live
	 * hashrate. Follows the manifesto's hero grammar (DESIGN-MANIFESTO.md §3):
	 * Fraunces serif, warm ivory `--text-hero` (never accent/green-colored —
	 * found by size, not hue), tabular numerals, a muted unit suffix. Mirrors
	 * the Home balance hero's markup shape, swapped from sats to hashrate.
	 */
	import { formatHashrate } from '$lib/shared/hashrate';

	let { hashrateNow, hashrate24h }: { hashrateNow: number; hashrate24h: number } = $props();

	function splitUnit(formatted: string): { value: string; unit: string } {
		const idx = formatted.indexOf(' ');
		return idx === -1 ? { value: formatted, unit: '' } : { value: formatted.slice(0, idx), unit: formatted.slice(idx + 1) };
	}

	const now = $derived(splitUnit(formatHashrate(hashrateNow)));
	const day = $derived(formatHashrate(hashrate24h));
</script>

<header class="hero fade-in">
	<div class="hero-eyebrow">
		<span class="hero-label">Your hashrate</span>
	</div>

	<div class="hero-amount-row">
		<span class="hero-number tabular">{now.value}</span>
		{#if now.unit}<span class="hero-unit">{now.unit}</span>{/if}
	</div>

	<div class="hero-sub">
		<span class="sub-note tabular">{day} average over 24h</span>
	</div>
</header>

<style>
	.hero {
		display: flex;
		flex-direction: column;
		padding-top: 32px;
	}

	.hero-eyebrow {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.hero-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.hero-amount-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-top: 18px;
	}

	/* Delegates to the shared .hero-number token class (app.css) for
	   family/weight/tracking/tabular-nums, then overrides size (responsive
	   clamp, matching Amount.svelte's size="hero") and color (--text-hero,
	   the one bright warm thing on the page — never accent/green). */
	.hero-number {
		font-size: clamp(40px, 6.5vw, 72px);
		line-height: 0.95;
		color: var(--text-hero);
	}

	@media (max-width: 900px) {
		.hero-number {
			font-size: clamp(34px, 11vw, 48px);
		}
	}

	.hero-unit {
		font-family: var(--font-ui);
		font-size: 18px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.hero-sub {
		margin-top: 10px;
	}

	.sub-note {
		font-size: 13px;
		color: var(--text-secondary);
	}
</style>
