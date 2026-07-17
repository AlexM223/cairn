<script lang="ts">
	/**
	 * MiningOddsPanel — "Your odds, honestly." Solo-mining odds copy is a
	 * flagged product-risk item (cairn-vn43.7's comment thread): it must read
	 * as honest expectation-setting, never gambling-adjacent hype. Muted text,
	 * tabular numbers, zero color drama — no chip, no icon color, no "your
	 * odds are great!" framing.
	 */
	import { formatNumber } from '$lib/format';

	let {
		odds,
		hashrateNow
	}: {
		odds: {
			userHashrate: number;
			networkHashps: number;
			expectedYearsPerBlock: number;
			probPerDayPct: number;
		} | null;
		hashrateNow: number;
	} = $props();

	/**
	 * Humane year formatting — "~14,000 years", never "14210.3 years". Rounds
	 * to a precision that matches the number's own uncertainty: exact below
	 * 10, nearest 5/50/500/1000 as the magnitude grows, so a lottery timescale
	 * never dresses up as false precision.
	 */
	function formatYears(years: number): string {
		if (years < 1) return 'less than a year';
		if (years < 10) return `~${Math.round(years)} years`;
		if (years < 100) return `~${Math.round(years / 5) * 5} years`;
		if (years < 1000) return `~${Math.round(years / 50) * 50} years`;
		if (years < 10000) return `~${Math.round(years / 500) * 500} years`;
		return `~${formatNumber(Math.round(years / 1000) * 1000)} years`;
	}

	const known = $derived(odds !== null && hashrateNow > 0);
	const yearsText = $derived(odds ? formatYears(odds.expectedYearsPerBlock) : '');
</script>

<section class="card card-pad odds-card">
	<span class="odds-title">Your odds, honestly</span>

	{#if known && odds}
		<p class="odds-copy">
			At your current speed, finding a block is a lottery — on average about once every <span
				class="tabular">{yearsText}</span
			>. But blocks are luck, not schedule: you could win tomorrow, or never. If you win, the
			entire reward lands in your wallet — no fees, no sharing.
		</p>
	{:else}
		<p class="odds-copy">Connect a miner to see your odds.</p>
	{/if}
</section>

<style>
	.odds-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.odds-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.odds-copy {
		margin: 0;
		max-width: 60ch;
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-muted);
	}
</style>
