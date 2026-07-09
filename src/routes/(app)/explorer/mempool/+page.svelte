<script lang="ts">
	import { onMount } from 'svelte';
	import { onNewBlock } from '$lib/liveBlocks';
	import { triggerChainRefresh } from '$lib/chainRefresh';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import CairnChart from '$lib/components/heartwood/CairnChart.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatNumber, formatBtc, formatBytes, formatFeeRate, timeAgo } from '$lib/format';

	let { data } = $props();

	// Stale-while-revalidate: the mempool view renders instantly from the persisted
	// SQLite snapshot load() read (data.mempool); the client refreshes it in the
	// background (on mount + on every new block) and invalidate('cairn:chain')
	// re-runs load() to pick up the fresh snapshot.
	let snap = $derived(data.mempool);

	// Background-refresh state driving the "last synced …" indicator.
	let syncing = $state(false);
	let syncFailed = $state(false);
	async function refresh(force = false) {
		if (syncing) return;
		syncing = true;
		const ok = await triggerChainRefresh(force);
		syncing = false;
		syncFailed = !ok;
	}
	onMount(() => {
		void refresh();
	});

	const syncLabel = $derived(
		syncing
			? 'updating…'
			: data.lastSyncedAt
				? `synced ${timeAgo(Math.floor(data.lastSyncedAt / 1000))}`
				: ''
	);

	const loading = $derived(snap === null && !syncFailed);
	const summary = $derived(snap?.summary ?? null);
	const fees = $derived(snap?.fees ?? null);
	const histogram = $derived(snap?.histogram ?? null);
	const projected = $derived(snap?.projected ?? null);
	const trend = $derived(snap?.trend ?? null);
	const chainError = $derived(snap?.error ?? null);
	// Error banner: a stored error, or the first snapshot refresh failing before
	// anything was ever persisted.
	const showError = $derived(chainError !== null || (snap === null && syncFailed));

	// Live new-block updates: refresh the mempool stats when the chain advances.
	// This page exposes no tip height, so the initial SSE event triggers one
	// harmless forced refresh shortly after mount.
	let lastSeenHeight: number | null = null;
	onMount(() =>
		onNewBlock((height) => {
			if (lastSeenHeight !== null && height === lastSeenHeight) return;
			lastSeenHeight = height;
			void refresh(true);
		})
	);

	// A full block holds ~1M vB; how many block-fulls are waiting right now.
	const blocksWorth = $derived(summary ? summary.vsize / 1_000_000 : 0);

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
		if (!histogram) return null;
		const bands = BANDS.map((b) => ({ ...b, vsize: 0 }));
		for (const [rate, vsize] of histogram) {
			const band = bands.find((b) => rate >= b.min && rate < b.max) ?? bands[bands.length - 1];
			band.vsize += vsize;
		}
		const max = Math.max(...bands.map((b) => b.vsize), 1);
		return bands.map((b) => ({ ...b, share: b.vsize / max }));
	});

	// Trend chart series for the 2-hour backlog history (cairn-49wy: now
	// rendered by the shared CairnChart rather than a hand-rolled SVG path).
	const trendSeries = $derived.by(() => {
		if (!trend || trend.length < 2) return null;
		return [
			{
				points: trend.map((p) => ({ x: p.time, y: p.vsize })),
				label: 'Backlog'
			}
		];
	});

	const tiers = $derived(
		fees
			? [
					{
						rate: fees.fastest,
						label: 'Fastest',
						context: 'to make the very next ring (~10 minutes)'
					},
					{
						rate: fees.halfHour,
						label: 'Half hour',
						context: 'to take a ring within about 30 minutes'
					},
					{ rate: fees.hour, label: 'Hour', context: 'to take a ring within about an hour' },
					{
						rate: fees.economy,
						label: 'Economy',
						context: 'to save money and wait — possibly hours'
					}
				]
			: []
	);
</script>

<svelte:head>
	<title>Mempool — Heartwood</title>
</svelte:head>

<div class="mempool-page">
	<GroveField volume="present" />
	<div class="body">
		<div class="top-row fade-in">
			<a href="/explorer" class="back">
				<Icon name="chevron-left" size={15} /> Explorer
			</a>
		</div>

		<header class="head fade-in">
			<EyebrowBreadcrumb path={['Explorer']} current="Mempool" />
			{#if syncLabel}
				<span class="sync-status" class:updating={syncing}>{syncLabel}</span>
			{/if}
			{#if summary}
				<div class="hero-row">
					<span class="hero-number hero-count">{formatNumber(summary.txCount)}</span>
					<span class="hero-sub">transactions waiting · no rings yet</span>
				</div>
				<div class="stat-line tabular">
					<span>
						<Term
							tip="The combined virtual size of everything waiting. A ring segment fits about 1 million virtual bytes, so this backlog is roughly {blocksWorth.toFixed(1)} rings deep."
						>
							<span class="stat-num">{formatBytes(summary.vsize)}</span>
						</Term>
						backlog
					</span>
					<span class="sep" aria-hidden="true">·</span>
					<span>≈ <span class="stat-num">{blocksWorth.toFixed(1)}</span> rings worth</span>
					<span class="sep" aria-hidden="true">·</span>
					<span>
						<span class="stat-num fees">{formatBtc(summary.totalFees)}</span> BTC in waiting fees
					</span>
				</div>
			{:else if loading}
				<div class="hero-row" aria-busy="true" aria-label="Loading mempool">
					<span class="hero-number hero-count skeleton">00,000</span>
					<span class="hero-sub">transactions waiting · no rings yet</span>
				</div>
				<div class="stat-line tabular">
					<span class="stat-num skeleton">000 MB backlog · 0.0 rings · 0.000 BTC</span>
				</div>
			{/if}
		</header>

		{#if showError}
			<div class="form-error" role="alert">
				Can't reach chain data sources{#if chainError} — {chainError}{/if}.
				<button type="button" class="retry-link" onclick={() => refresh(true)}>Retry</button>
			</div>
		{:else if loading}
			<!-- Streamed placeholder: section scaffold while the snapshot lands. -->
			<section class="section fade-in" aria-busy="true">
				<div class="section-head">
					<span class="section-title skeleton">Projected next rings</span>
				</div>
				<div class="proj-row">
					{#each [0, 1, 2, 3, 4, 5] as i (i)}
						<div class="proj-block skeleton" style:--depth={i}>
							<span class="proj-eta">&nbsp;</span>
							<span class="proj-fee tabular">&nbsp;</span>
							<span class="proj-range tabular">&nbsp;</span>
							<span class="proj-meta">&nbsp;</span>
						</div>
					{/each}
				</div>
			</section>
		{:else if summary}
			<!-- Projected next blocks -->
			{#if projected && projected.length > 0}
				<section class="section fade-in">
					<div class="section-head">
						<span class="section-title">Projected next rings</span>
						<Term
							tip="A simulation of the blocks miners would assemble from the current mempool, greedily taking the highest fee rates first. Your transaction lands in the first projected ring whose fee range it beats."
						>
							<span class="hint">how is this known?</span>
						</Term>
						<a href="/explorer/mempool/blocks" class="viz-link">
							Visualize <Icon name="arrow-right" size={13} />
						</a>
					</div>
					<div class="proj-row">
						{#each projected.slice(0, 6) as block, i (i)}
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
					<section class="section">
						<div class="section-head">
							<span class="section-title">What should I pay?</span>
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
							day pushes the next ring past 100.
						</p>
					</section>
				{/if}

				<!-- Fee distribution -->
				{#if feeBands}
					<section class="section">
						<div class="section-head">
							<span class="section-title">Fee distribution</span>
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
										<div
											class="band-fill"
											style:width="{Math.max(band.share * 100, band.vsize > 0 ? 2 : 0)}%"
										></div>
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
			{#if trendSeries}
				<section class="section fade-in">
					<div class="section-head">
						<span class="section-title">Backlog over the last two hours</span>
					</div>
					<CairnChart
						series={trendSeries}
						height={140}
						xFormat={(v) => timeAgo(v)}
						yFormat={(v) => formatBytes(Math.max(v, 0))}
					/>
				</section>
			{:else if projected === null}
				<p class="hint degrade-note">
					Projected rings and history need a mempool.space-compatible backend — the configured
					Esplora server provides basic mempool totals only.
				</p>
			{/if}
		{/if}

		<div class="explain">
			<HowItWorks id="mempool">
				<p>
					<strong>The mempool is Bitcoin's waiting room.</strong> Every transaction broadcast to the
					network sits here until a miner includes it in a block. There is no single mempool — each
					node keeps its own — but well-connected nodes see nearly the same picture.
				</p>
				<p>
					Block space is scarce (about 1 MB of virtual bytes every ten minutes), so miners fill
					blocks with the highest-paying transactions first. That turns the mempool into a
					<strong>fee auction</strong>: the more you pay per virtual byte, the sooner you take a
					ring. When the mempool empties, even 1 sat/vB confirms quickly.
				</p>
			</HowItWorks>
		</div>
	</div>
</div>

<style>
	.mempool-page {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.body {
		position: relative;
		z-index: 1;
	}

	.top-row {
		display: flex;
		align-items: center;
		margin-bottom: 26px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.back:hover {
		color: var(--accent);
	}

	/* SWR freshness indicator: muted when idle, copper while refreshing. */
	.sync-status {
		font-size: 11px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.sync-status.updating {
		color: var(--accent);
	}

	.retry-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.head {
		display: flex;
		flex-direction: column;
		margin-bottom: 36px;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 18px;
	}

	.hero-count {
		font-size: 64px;
		line-height: 0.95;
		color: var(--text-hero);
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	.stat-line {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 18px;
		font-size: 13px;
		color: var(--text-faint);
	}

	.stat-line .sep {
		color: var(--border-ghost);
	}

	.stat-num {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 18px;
		color: var(--text-rows);
	}

	.stat-num.fees {
		color: var(--accent-bright);
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 20px 0;
		border-top: 1px solid var(--hairline);
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
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
		border-radius: var(--radius-strip);
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
		font-weight: 600;
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
		gap: 0 48px;
		align-items: start;
	}

	.columns > section {
		min-width: 0;
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
		border-bottom: 1px solid var(--hairline);
	}

	.tier:last-child {
		border-bottom: none;
	}

	.tier-rate {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 600;
		min-width: 48px;
		text-align: right;
		color: var(--text-rows);
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
		border-top: 1px solid var(--hairline);
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
		background: var(--bg-input);
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

	.degrade-note {
		margin-top: 4px;
	}

	.explain {
		margin-top: 32px;
	}

	@media (max-width: 900px) {
		.mempool-page {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.top-row {
			margin-bottom: 18px;
		}

		.head {
			margin-bottom: 24px;
		}

		.hero-count {
			font-size: 42px;
		}

		.hero-sub {
			font-size: 12px;
		}

		.stat-line {
			margin-top: 12px;
		}

		.stat-num {
			font-size: 15px;
		}
	}
</style>
