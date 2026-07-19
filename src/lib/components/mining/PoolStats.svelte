<script lang="ts">
	/**
	 * PoolStats — the /mining/pool summary (cairn-et38g): pool hashrate right
	 * now as the page's ONE hero number (DESIGN-MANIFESTO.md §3/§6.3 — never a
	 * second hero alongside the balance/hashrate heroes elsewhere in the app,
	 * so this page owns the only one), miners online + people mining, and the
	 * all-time blocks-found count. The 24h chart reuses AdminHashrateChart
	 * as-is — same pool-scoped `mining_stats` series the admin page charts,
	 * just with a neutral (non-accent) stroke already baked into that
	 * component, so this public page never needs its own copy.
	 */
	import { formatHashrate } from '$lib/shared/hashrate';
	import { formatNumber } from '$lib/format';
	import AdminHashrateChart from './AdminHashrateChart.svelte';

	let {
		pool,
		hashrateSeries,
		totalBlocksFound
	}: {
		pool: { connectedWorkers: number; connectedUsers: number; hashrateNow: number; hashrate24h: number };
		hashrateSeries: { t: number; hashrate: number }[];
		totalBlocksFound: number;
	} = $props();

	const parts = $derived(formatHashrate(pool.hashrateNow).split(' '));
	const heroValue = $derived(parts[0] ?? '—');
	const heroUnit = $derived(parts[1] ?? '');
</script>

<section class="pool-stats fade-in">
	<div class="hero-row">
		<span class="hero-number t-hero">{heroValue}</span>
		{#if heroUnit}<span class="hero-unit">{heroUnit}</span>{/if}
	</div>
	<span class="hero-sub">pool hashrate right now · 24h avg {formatHashrate(pool.hashrate24h)}</span>

	<div class="secondary-stats">
		<div class="sec-stat">
			<span class="sec-v tabular">{formatNumber(pool.connectedWorkers)}</span>
			<span class="sec-k">miner{pool.connectedWorkers === 1 ? '' : 's'} online</span>
		</div>
		<div class="sec-stat">
			<span class="sec-v tabular">{formatNumber(pool.connectedUsers)}</span>
			<span class="sec-k">{pool.connectedUsers === 1 ? 'person' : 'people'} mining</span>
		</div>
		<div class="sec-stat">
			<span class="sec-v tabular">{formatNumber(totalBlocksFound)}</span>
			<span class="sec-k">block{totalBlocksFound === 1 ? '' : 's'} found here</span>
		</div>
	</div>

	<div class="chart-section">
		<span class="chart-title">Pool hashrate · last 24 hours</span>
		<AdminHashrateChart points={hashrateSeries} />
	</div>
</section>

<style>
	.pool-stats {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.hero-unit {
		font-size: 22px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.hero-sub {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.secondary-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 32px;
		margin-top: 18px;
	}

	.sec-stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sec-v {
		font-size: 20px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.sec-k {
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.chart-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 24px;
	}

	.chart-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-secondary);
	}
</style>
