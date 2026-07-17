<script lang="ts">
	/**
	 * AdminHashrateChart — thin CairnChart wrapper for the pool hashrate
	 * time series (cairn-vn43.10). Neutral stroke color, deliberately NOT
	 * `var(--accent)` (CairnChart's own default) — the manifesto reserves the
	 * accent for the one primary action + active nav, never a chart line.
	 */
	import CairnChart from '$lib/components/heartwood/CairnChart.svelte';
	import { formatHashrate } from '$lib/shared/hashrate';
	import { timeAgo } from '$lib/format';
	import type { AdminMiningHashratePoint } from './adminMiningView';

	let { points }: { points: AdminMiningHashratePoint[] } = $props();

	const series = $derived([
		{
			points: points.map((p) => ({ x: p.t, y: p.hashrate })),
			color: 'var(--text-secondary)',
			label: 'Pool hashrate'
		}
	]);
</script>

<div class="hashrate-chart">
	<CairnChart
		{series}
		height={140}
		xFormat={(v) => timeAgo(v)}
		yFormat={(v) => formatHashrate(v)}
		ariaLabel="Pool hashrate over time"
	/>
</div>

<style>
	.hashrate-chart {
		margin-top: 4px;
	}
</style>
