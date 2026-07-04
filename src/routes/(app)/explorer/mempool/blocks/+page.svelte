<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import ExplorerNav from '$lib/components/ExplorerNav.svelte';
	import { synthesizeBlocks, feeColor, type VizRect } from '$lib/mempoolViz';
	import { formatNumber, formatBtc, formatBytes, formatSats, formatFeeRate } from '$lib/format';
	import type { FeeHistogram, MempoolBlockProjection } from '$lib/types';

	let { data } = $props();

	// Live feed — seeded once by the server load, then owned by polling.
	// svelte-ignore state_referenced_locally
	let projected = $state<MempoolBlockProjection[] | null>(data.projected);
	// svelte-ignore state_referenced_locally
	let histogram = $state<FeeHistogram | null>(data.histogram);
	// svelte-ignore state_referenced_locally
	let tipHeight = $state<number | null>(data.tipHeight);
	let lastUpdated = $state(Date.now());
	let stale = $state(false);

	const POLL_MS = 10_000;

	onMount(() => {
		const timer = setInterval(async () => {
			if (document.hidden) return;
			try {
				const res = await fetch('/api/mempool/projected');
				if (!res.ok) throw new Error(String(res.status));
				const next = await res.json();
				projected = next.projected;
				histogram = next.histogram;
				tipHeight = next.tipHeight;
				lastUpdated = Date.now();
				stale = false;
			} catch {
				stale = true; // keep showing the last good picture
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const blocks = $derived(synthesizeBlocks(histogram, projected, 6));

	// Shared tooltip that follows the pointer.
	let tip = $state<{ x: number; y: number; rect: VizRect } | null>(null);

	function showTip(e: MouseEvent, rect: VizRect) {
		tip = { x: e.clientX, y: e.clientY, rect };
	}

	const LEGEND = [1, 5, 12, 25, 60, 150];
</script>

<svelte:head>
	<title>Next blocks — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<div>
		<span class="overline">Explorer</span>
		<h1 class="page-title">Next blocks</h1>
	</div>
	<span class="live" class:stale title={stale ? 'Last refresh failed — retrying' : 'Refreshes every 10 seconds'}>
		<span class="live-dot"></span>
		{stale ? 'reconnecting…' : 'live'}
		{#if tipHeight}
			<span class="tip-height tabular">· tip {formatNumber(tipHeight)}</span>
		{/if}
	</span>
</div>

<ExplorerNav active="blocks" />

<HowItWorks id="mempool-blocks">
	<p>
		<strong>What am I looking at?</strong> These blocks represent the next groups of
		transactions miners will confirm. Transactions paying higher fees are included first.
		Each colored rectangle is a transaction — larger rectangles are bigger transactions,
		warmer colors mean higher fee rates. The leftmost block is next in line.
	</p>
	<p>
		The picture is drawn from the live fee distribution of the mempool. Public data sources
		don't reveal exactly which transaction lands where, so each rectangle is a
		<strong>representative transaction</strong>: its fee rate and the space it occupies are
		real, its exact boundaries are illustrative.
	</p>
</HowItWorks>

{#if data.error}
	<div class="form-error" role="alert">
		Can't reach chain data sources — {data.error}.
		<a href="/explorer/mempool/blocks">Retry</a>
	</div>
{:else if blocks.length === 0}
	<div class="card empty-state fade-in">
		<span class="empty-title">No projection available</span>
		<p>
			Block projections need a mempool.space-compatible backend. The configured Esplora
			server only provides basic mempool totals — see Admin → Settings.
		</p>
	</div>
{:else}
	<div class="blocks-row fade-in">
		{#each blocks as block, i (i)}
			<div class="block-card" class:next={i === 0} style:--depth={i}>
				<div class="block-head">
					{#if i === 0}
						<span class="next-label"><Icon name="zap" size={12} /> Next block</span>
					{:else}
						<span class="eta">~{(i + 1) * 10} min</span>
					{/if}
					<span class="median tabular">{formatFeeRate(block.projection.medianFee)}</span>
				</div>

				<div class="viz" role="img" aria-label="Projected block {i + 1}: {formatNumber(block.projection.nTx)} transactions, median {formatFeeRate(block.projection.medianFee)}">
					{#each block.rects as rect (rect.key)}
						<div
							class="tx-rect"
							role="presentation"
							style:left="{rect.x * 100}%"
							style:top="{rect.y * 100}%"
							style:width="{rect.w * 100}%"
							style:height="{rect.h * 100}%"
							style:background={feeColor(rect.feeRate)}
							onmouseenter={(e) => showTip(e, rect)}
							onmousemove={(e) => showTip(e, rect)}
							onmouseleave={() => (tip = null)}
						></div>
					{/each}
				</div>

				<div class="block-stats">
					<span class="range tabular">
						{block.projection.feeRange[0]}–{block.projection.feeRange[1]} sat/vB
					</span>
					<span class="meta tabular">
						{formatNumber(block.projection.nTx)} txs · {formatBtc(block.projection.totalFees)} BTC
					</span>
				</div>
			</div>
		{/each}
	</div>

	<div class="legend fade-in">
		<span class="hint">fee rate</span>
		<div class="legend-ramp">
			{#each LEGEND as rate (rate)}
				<span class="legend-stop">
					<span class="legend-swatch" style:background={feeColor(rate)}></span>
					<span class="legend-label tabular">{rate}</span>
				</span>
			{/each}
			<span class="hint">sat/vB</span>
		</div>
		<a href="/explorer/mempool" class="legend-link">
			Mempool overview <Icon name="arrow-right" size={13} />
		</a>
	</div>
{/if}

{#if tip}
	<div class="tooltip" style:left="{Math.min(tip.x + 14, window.innerWidth - 210)}px" style:top="{tip.y + 14}px">
		<div class="tooltip-head">
			{tip.rect.txCount > 1
				? `~${formatNumber(tip.rect.txCount)} transactions`
				: 'Representative transaction'}
		</div>
		<div class="tooltip-row">
			<span>Fee rate</span>
			<span class="tabular" style:color={feeColor(tip.rect.feeRate)}>
				{formatFeeRate(tip.rect.feeRate)}
			</span>
		</div>
		<div class="tooltip-row"><span>Size</span><span class="tabular">{formatBytes(Math.round(tip.rect.vsize))}</span></div>
		<div class="tooltip-row"><span>Est. fees</span><span class="tabular">{formatSats(tip.rect.fee)} sats</span></div>
	</div>
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
		margin-bottom: 14px;
	}

	.head > div {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.live {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--success);
		padding-bottom: 3px;
	}

	.live.stale {
		color: var(--warning);
	}

	.live-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	.tip-height {
		color: var(--text-muted);
	}

	.blocks-row {
		display: flex;
		gap: 14px;
		overflow-x: auto;
		padding: 4px 2px 10px;
	}

	.block-card {
		flex: 1 0 186px;
		max-width: 230px;
		display: flex;
		flex-direction: column;
		gap: 9px;
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		padding: 14px;
		opacity: calc(1 - var(--depth) * 0.06);
	}

	.block-card.next {
		border-color: var(--accent);
		box-shadow: 0 0 24px rgba(232, 147, 90, 0.12);
	}

	.block-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.next-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.eta {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.median {
		font-family: var(--font-serif);
		font-size: 15px;
		font-weight: 560;
	}

	.viz {
		position: relative;
		aspect-ratio: 1;
		background: var(--bg);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.tx-rect {
		position: absolute;
		box-shadow: inset 0 0 0 1px var(--bg);
		transition:
			left 500ms var(--ease),
			top 500ms var(--ease),
			width 500ms var(--ease),
			height 500ms var(--ease),
			filter 100ms var(--ease);
		animation: rect-in 400ms var(--ease) both;
	}

	@keyframes rect-in {
		from {
			opacity: 0;
		}
	}

	.tx-rect:hover {
		filter: brightness(1.3);
		z-index: 2;
	}

	.block-stats {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.range {
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.meta {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.legend {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.legend-ramp {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.legend-stop {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.legend-swatch {
		width: 14px;
		height: 10px;
		border-radius: 2px;
	}

	.legend-label {
		font-size: 11px;
		color: var(--text-muted);
	}

	.legend-link {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
	}

	.tooltip {
		position: fixed;
		z-index: 50;
		width: 196px;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
		padding: 10px 12px;
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.tooltip-head {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 2px;
	}

	.tooltip-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 12.5px;
	}

	.tooltip-row > span:first-child {
		color: var(--text-secondary);
	}

	@media (max-width: 700px) {
		.blocks-row {
			flex-direction: column;
			overflow-x: visible;
		}

		.block-card {
			flex: none;
			max-width: 360px;
			width: 100%;
			margin: 0 auto;
		}
	}
</style>
