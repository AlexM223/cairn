<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import ExplorerNav from '$lib/components/ExplorerNav.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatNumber, formatBtc, formatBytes, formatFeeRate, timeAgo } from '$lib/format';

	let { data } = $props();

	// Live new-block updates: refresh the mempool stats when the chain advances.
	// This page exposes no tip height, so the initial SSE event triggers one
	// harmless refresh shortly after mount.
	let lastSeenHeight: number | null = null;
	onMount(() =>
		onNewBlock((height) => {
			if (lastSeenHeight !== null && height === lastSeenHeight) return;
			lastSeenHeight = height;
			invalidate('cairn:chain');
		})
	);

	// A full block holds ~1M vB; how many block-fulls are waiting right now.
	const blocksWorth = $derived(data.summary ? data.summary.vsize / 1_000_000 : 0);

	// Group the raw [rate, vsize] histogram into readable fee bands.
	const BANDS = [
		{ min: 0, max: 2, label: '1–2' },
		{ min: 2, max: 5, label: '2–5' },
		{ min: 5, max: 10, label: '5–10' },
		{ min: 10, max: 20, label: '10–20' },
		{ min: 20, max: 50, label: '20–50' },
		{ min: 50, max: 100, label: '50–100' },
		{ min: 100, max: Infinity, label: '100+' }
	];

	const feeBands = $derived.by(() => {
		if (!data.histogram) return null;
		const bands = BANDS.map((b) => ({ ...b, vsize: 0 }));
		for (const [rate, vsize] of data.histogram) {
			const band = bands.find((b) => rate >= b.min && rate < b.max) ?? bands[bands.length - 1];
			band.vsize += vsize;
		}
		const max = Math.max(...bands.map((b) => b.vsize), 1);
		return bands.map((b) => ({ ...b, share: b.vsize / max }));
	});

	// Sparkline geometry for the 2-hour trend.
	const spark = $derived.by(() => {
		if (!data.trend || data.trend.length < 2) return null;
		const points = data.trend;
		const maxV = Math.max(...points.map((p) => p.vsize), 1);
		const minT = points[0].time;
		const spanT = Math.max(points[points.length - 1].time - minT, 1);
		const path = points
			.map((p, i) => {
				const x = ((p.time - minT) / spanT) * 100;
				const y = 34 - (p.vsize / maxV) * 30;
				return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
			})
			.join(' ');
		return { path, maxV, from: points[0].time, to: points[points.length - 1].time };
	});

	const tiers = $derived(
		data.fees
			? [
					{
						rate: data.fees.fastest,
						label: 'Fastest',
						context: 'to be picked for the very next block (~10 minutes)'
					},
					{
						rate: data.fees.halfHour,
						label: 'Half hour',
						context: 'to confirm within about 30 minutes'
					},
					{ rate: data.fees.hour, label: 'Hour', context: 'to confirm within about an hour' },
					{
						rate: data.fees.economy,
						label: 'Economy',
						context: 'to save money and wait — possibly hours'
					}
				]
			: []
	);
</script>

<svelte:head>
	<title>Mempool — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<h1 class="page-title">Mempool</h1>
</div>

<ExplorerNav active="mempool" />

<HowItWorks id="mempool">
	<p>
		<strong>The mempool is Bitcoin's waiting room.</strong> Every transaction broadcast to the
		network sits here until a miner includes it in a block. There is no single mempool — each
		node keeps its own — but well-connected nodes see nearly the same picture.
	</p>
	<p>
		Block space is scarce (about 1 MB of virtual bytes every ten minutes), so miners fill
		blocks with the highest-paying transactions first. That turns the mempool into a
		<strong>fee auction</strong>: the more you pay per virtual byte, the sooner you confirm.
		When the mempool empties, even 1 sat/vB confirms quickly.
	</p>
</HowItWorks>

{#if data.error}
	<div class="form-error" role="alert">
		Can't reach chain data sources — {data.error}.
		<a href="/explorer/mempool">Retry</a>
	</div>
{:else if data.summary}
	<!-- Summary stats -->
	<section class="stats fade-in">
		<div class="card card-pad stat">
			<span class="overline">Unconfirmed</span>
			<span class="hero-number stat-hero">{formatNumber(data.summary.txCount)}</span>
			<span class="hint">transactions waiting</span>
		</div>
		<div class="card card-pad stat">
			<span class="overline">
				<Term
					tip="The combined virtual size of everything waiting. A block fits about 1 million virtual bytes, so this backlog is roughly {blocksWorth.toFixed(1)} blocks deep."
					>Backlog</Term
				>
			</span>
			<span class="hero-number stat-hero">{formatBytes(data.summary.vsize)}</span>
			<span class="hint">≈ {blocksWorth.toFixed(1)} blocks worth</span>
		</div>
		<div class="card card-pad stat">
			<span class="overline">Pending fees</span>
			<span class="hero-number stat-hero">{formatBtc(data.summary.totalFees)}</span>
			<span class="hint">BTC waiting to be collected by miners</span>
		</div>
	</section>

	<!-- Projected next blocks -->
	{#if data.projected && data.projected.length > 0}
		<section class="card card-pad fade-in section">
			<div class="section-head">
				<Icon name="blocks" size={17} />
				<span class="card-title">Projected next blocks</span>
				<Term
					tip="A simulation of the blocks miners would assemble from the current mempool, greedily taking the highest fee rates first. Your transaction lands in the first projected block whose fee range it beats."
				>
					<span class="hint">how is this known?</span>
				</Term>
				<a href="/explorer/mempool/blocks" class="viz-link">
					Visualize <Icon name="arrow-right" size={13} />
				</a>
			</div>
			<div class="proj-row">
				{#each data.projected.slice(0, 6) as block, i (i)}
					<div class="proj-block" style:--depth={i}>
						<span class="proj-eta">~{(i + 1) * 10} min</span>
						<span class="proj-fee tabular">{formatFeeRate(block.medianFee)}</span>
						<span class="proj-range tabular">
							{block.feeRange[0]}–{block.feeRange[1]} sat/vB
						</span>
						<span class="proj-meta">
							{formatNumber(block.nTx)} txs · {formatBtc(block.totalFees)} BTC fees
						</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<div class="columns">
		<!-- Recommended fees with context -->
		{#if tiers.length}
			<section class="card card-pad section">
				<div class="section-head">
					<Icon name="zap" size={17} />
					<span class="card-title">What should I pay?</span>
				</div>
				<div class="tier-list">
					{#each tiers as tier (tier.label)}
						<div class="tier">
							<span class="tier-rate tabular">{Math.round(tier.rate)}</span>
							<span class="tier-unit">sat/vB</span>
							<span class="tier-context">{tier.context}</span>
						</div>
					{/each}
				</div>
				<p class="hint tier-note">
					Rates move with demand — a quiet Sunday mempool can clear at 1 sat/vB while a busy
					day pushes the next block past 100.
				</p>
			</section>
		{/if}

		<!-- Fee distribution -->
		{#if feeBands}
			<section class="card card-pad section">
				<div class="section-head">
					<Icon name="activity" size={17} />
					<span class="card-title">Fee distribution</span>
					<Term
						tip="How the waiting transactions are spread across fee rates, by virtual size. Tall bands near the bottom mean cheap transactions dominate; weight near the top means a bidding war."
					>
						<span class="hint">what am I seeing?</span>
					</Term>
				</div>
				<div class="bands">
					{#each feeBands as band (band.label)}
						<div class="band">
							<span class="band-label tabular">{band.label}</span>
							<div class="band-track">
								<div class="band-fill" style:width="{Math.max(band.share * 100, band.vsize > 0 ? 2 : 0)}%"></div>
							</div>
							<span class="band-size tabular">{band.vsize > 0 ? formatBytes(band.vsize) : '—'}</span>
						</div>
					{/each}
				</div>
				<span class="hint">sat/vB bands · bar length = share of waiting virtual bytes</span>
			</section>
		{/if}
	</div>

	<!-- Trend -->
	{#if spark}
		<section class="card card-pad section fade-in">
			<div class="section-head">
				<Icon name="clock" size={17} />
				<span class="card-title">Backlog over the last two hours</span>
			</div>
			<svg viewBox="0 0 100 36" preserveAspectRatio="none" class="spark" aria-hidden="true">
				<path d={spark.path} fill="none" stroke="var(--accent)" stroke-width="0.8" vector-effect="non-scaling-stroke" />
			</svg>
			<div class="spark-axis">
				<span class="hint">{timeAgo(spark.from)}</span>
				<span class="hint">peak {formatBytes(spark.maxV)}</span>
				<span class="hint">now</span>
			</div>
		</section>
	{:else if data.projected === null}
		<p class="hint degrade-note">
			Projected blocks and history need a mempool.space-compatible backend — the configured
			Esplora server provides basic mempool totals only.
		</p>
	{/if}
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 18px;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 14px;
		margin-bottom: 14px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.stat-hero {
		font-size: 30px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-bottom: 14px;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.section-head .hint {
		margin-left: auto;
	}

	.viz-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		white-space: nowrap;
	}

	.proj-row {
		display: flex;
		gap: 12px;
		overflow-x: auto;
		padding-bottom: 4px;
	}

	.proj-block {
		flex: 0 0 150px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 14px;
		border-radius: var(--radius-control);
		background: linear-gradient(
			160deg,
			rgba(232, 147, 90, calc(0.22 - var(--depth) * 0.03)),
			rgba(232, 147, 90, 0.05)
		);
		border: 1px solid rgba(232, 147, 90, calc(0.35 - var(--depth) * 0.05));
	}

	.proj-eta {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.proj-fee {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
		margin-top: 2px;
	}

	.proj-range {
		font-size: 11.5px;
		color: var(--text-secondary);
	}

	.proj-meta {
		font-size: 11px;
		color: var(--text-muted);
		margin-top: 6px;
	}

	.columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
		align-items: start;
	}

	.columns > section {
		min-width: 0;
		margin-bottom: 0;
	}

	@media (max-width: 860px) {
		.columns {
			grid-template-columns: 1fr;
		}
	}

	.tier-list {
		display: flex;
		flex-direction: column;
	}

	.tier {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border-subtle);
	}

	.tier:last-child {
		border-bottom: none;
	}

	.tier-rate {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
		min-width: 48px;
		text-align: right;
	}

	.tier-unit {
		font-size: 11.5px;
		color: var(--text-muted);
		min-width: 44px;
	}

	.tier-context {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.tier-note {
		border-top: 1px solid var(--border-subtle);
		padding-top: 10px;
		margin: 0;
	}

	.bands {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.band {
		display: grid;
		grid-template-columns: 52px 1fr 64px;
		align-items: center;
		gap: 10px;
		font-size: 12px;
	}

	.band-label {
		color: var(--text-secondary);
		text-align: right;
	}

	.band-track {
		height: 14px;
		background: var(--bg);
		border-radius: 3px;
		overflow: hidden;
	}

	.band-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-hover));
		border-radius: 3px;
		transition: width 300ms var(--ease);
	}

	.band-size {
		color: var(--text-muted);
	}

	.spark {
		width: 100%;
		height: 90px;
		display: block;
	}

	.spark-axis {
		display: flex;
		justify-content: space-between;
	}

	.degrade-note {
		margin-top: 4px;
	}
</style>
