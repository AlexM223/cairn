<script lang="ts">
	/**
	 * MiningBestShare — "Your closest call so far" (cairn-20k25). /mining never
	 * surfaced totals.bestShareEver at all; this renders it as a calm secondary
	 * fact directly under the hashrate hero — NOT a second hero number
	 * (DESIGN-MANIFESTO.md §3/§6.3: exactly one --t-hero per screen, found by
	 * size). Plain framing only: never the word "difficulty" in the primary
	 * copy, matching MiningOddsPanel's honest, non-hype register.
	 *
	 * Hidden entirely (by the parent AND defensively here) when there's no
	 * best share yet — a zero-value readout is exactly the doubled-"0 sats"
	 * failure mode the manifesto bans (§4).
	 */
	import { formatNumber } from '$lib/format';

	let {
		bestShareEver,
		networkDifficulty
	}: {
		bestShareEver: number;
		networkDifficulty: number | null;
	} = $props();

	/**
	 * "N% of the way to finding a block" — sensible precision at every
	 * magnitude. A share's difficulty is almost always a tiny fraction of the
	 * network's, so most users will see the "less than 0.0001%" floor; a lucky
	 * near-miss still reads honestly once it clears 1%.
	 */
	function formatPct(pct: number): string {
		if (!Number.isFinite(pct) || pct <= 0) return 'less than 0.0001%';
		if (pct < 0.0001) return 'less than 0.0001%';
		if (pct >= 1) return `${pct.toFixed(1)}%`;
		const fixed = pct.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
		return `${fixed}%`;
	}

	const pctText = $derived(
		networkDifficulty != null && networkDifficulty > 0
			? formatPct((bestShareEver / networkDifficulty) * 100)
			: null
	);
</script>

{#if bestShareEver > 0}
	<section class="card card-pad best-share-card">
		<span class="card-title">Your closest call so far</span>

		<div class="best-row">
			<span class="best-value tabular">{formatNumber(bestShareEver)}</span>
		</div>

		{#if pctText}
			<p class="best-context">That share was {pctText} of the way to finding a block.</p>
		{/if}
	</section>
{/if}

<style>
	.best-share-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.best-row {
		margin-top: 2px;
	}

	.best-value {
		font-family: var(--font-ui);
		font-size: 30px;
		font-weight: 600;
		line-height: 1.1;
		color: var(--text);
	}

	.best-context {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
	}
</style>
