<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import { synthesizeBlocks, synthKey, feeColor, type VizRect } from '$lib/mempoolViz';
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
	// Fingerprint of the last inputs handed to synthesizeBlocks — when a poll
	// returns the same picture, we skip reassigning state entirely so the DOM
	// (and its 500+ CSS-transitioned rects) doesn't churn for nothing.
	// svelte-ignore state_referenced_locally
	let lastKey = $state(synthKey(data.histogram, data.projected));
	// Screen-reader announcement — only set on meaningful changes (new tip block).
	let announcement = $state('');

	const POLL_MS = 10_000;

	onMount(() => {
		const timer = setInterval(async () => {
			if (document.hidden) return;
			try {
				const res = await fetch('/api/mempool/projected');
				if (!res.ok) throw new Error(String(res.status));
				const next = await res.json();
				if (
					typeof next.tipHeight === 'number' &&
					tipHeight !== null &&
					next.tipHeight !== tipHeight
				) {
					announcement = `New block ${formatNumber(next.tipHeight)} — projections updated`;
				}
				tipHeight = next.tipHeight;
				const key = synthKey(next.histogram, next.projected);
				if (key !== lastKey) {
					lastKey = key;
					projected = next.projected;
					histogram = next.histogram;
				}
				lastUpdated = Date.now();
				stale = false;
			} catch {
				stale = true; // keep showing the last good picture
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const blocks = $derived(synthesizeBlocks(histogram, projected, 6));

	// Shared tooltip that follows the pointer (or, for keyboard users, sits
	// below-right of the focused rectangle).
	let tip = $state<{ x: number; y: number; rect: VizRect } | null>(null);

	function showTip(e: MouseEvent, rect: VizRect) {
		tip = { x: e.clientX, y: e.clientY, rect };
	}

	function showTipFromFocus(e: FocusEvent, rect: VizRect) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		// Anchor below-right of the rect, clamped so the ~200x120px tooltip
		// stays inside the viewport (the template clamps x again).
		tip = {
			x: Math.max(0, Math.min(r.right, window.innerWidth - 224)),
			y: Math.max(0, Math.min(r.bottom, window.innerHeight - 150)),
			rect
		};
	}

	/** Plain-language summary of the tooltip for the button's aria-label. */
	function rectLabel(rect: VizRect): string {
		const txs =
			rect.txCount > 1 ? `~${formatNumber(rect.txCount)} transactions` : '1 transaction';
		const rate = formatFeeRate(rect.feeRate).replace('sat/vB', 'sat per virtual byte');
		const size = formatBytes(Math.round(rect.vsize))
			.replace(/ kB$/, ' kilobytes')
			.replace(/ MB$/, ' megabytes')
			.replace(/ B$/, ' bytes');
		return `${txs}, ${rate}, ${size}, about ${formatSats(rect.fee)} sats in fees`;
	}

	/**
	 * Roving keyboard navigation within one block. Each block is a single tab
	 * stop (first rect tabindex 0, the rest -1); arrows move between rects.
	 * Simplification: rects live in treemap order (largest first), not a grid,
	 * so Left/Right step ±1 through that order and Up/Down jump ±8 — an
	 * approximation of spatial movement that keeps this dependency-free.
	 */
	// True roving tabindex: the last-focused rect in each block carries
	// tabindex=0, so tabbing back into a block resumes where the user left
	// off. Focus events (keyboard or mouse) keep this in sync; the clamp in
	// activeFor() handles polls shrinking a block's rect count.
	let activeRect = $state<Record<number, number>>({});

	function activeFor(blockIdx: number, rectCount: number): number {
		return Math.min(activeRect[blockIdx] ?? 0, rectCount - 1);
	}

	function onRectKeydown(e: KeyboardEvent, blockIdx: number) {
		if (e.key === 'Escape') {
			tip = null; // hide the tooltip, keep focus where it is
			return;
		}
		const delta =
			e.key === 'ArrowRight' ? 1
			: e.key === 'ArrowLeft' ? -1
			: e.key === 'ArrowDown' ? 8
			: e.key === 'ArrowUp' ? -8
			: 0;
		if (delta === 0) return;
		e.preventDefault(); // don't scroll the page
		const btn = e.currentTarget as HTMLButtonElement;
		const group = btn.closest('.viz');
		if (!group) return;
		const rects = Array.from(group.querySelectorAll<HTMLButtonElement>('.tx-rect'));
		const idx = rects.indexOf(btn);
		if (idx === -1) return;
		const next = Math.max(0, Math.min(rects.length - 1, idx + delta));
		// Update the roving tab stop here as well as in onfocus — focus events
		// don't fire reliably in unfocused (automated) documents.
		activeRect[blockIdx] = next;
		rects[next]?.focus();
	}

	const LEGEND = [1, 5, 12, 25, 60, 150];
</script>

<svelte:head>
	<title>Next rings — Heartwood</title>
</svelte:head>

<div class="blocks-page">
<GroveField volume="present" />
<div class="page-body">
<div class="top-row fade-in">
	<a href="/explorer/mempool" class="back">
		<Icon name="chevron-left" size={15} /> Mempool
	</a>
</div>

<div class="head fade-in">
	<div>
		<EyebrowBreadcrumb path={['Explorer', 'Mempool']} current="Next rings" />
		<h1 class="page-title">Next rings</h1>
	</div>
	<span class="live" class:stale title={stale ? 'Last refresh failed — retrying' : 'Refreshes every 10 seconds'}>
		<span class="live-dot"></span>
		{stale ? 'reconnecting…' : 'live'}
		{#if tipHeight}
			<span class="tip-height tabular">· tip {formatNumber(tipHeight)}</span>
		{/if}
	</span>
</div>

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
	<div class="empty-state fade-in">
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
						<span class="next-label"><Icon name="zap" size={12} /> Next ring</span>
					{:else}
						<span class="eta">~{(i + 1) * 10} min</span>
					{/if}
					<span class="median tabular">{formatFeeRate(block.projection.medianFee)}</span>
				</div>

				<div
					class="viz"
					role="group"
					aria-label="Projected block {i + 1} of {blocks.length}: {formatNumber(block.projection.nTx)} transactions, median {formatFeeRate(block.projection.medianFee)}. Use arrow keys to explore transactions."
				>
					{#each block.rects as rect, ri (rect.key)}
						<button
							type="button"
							class="tx-rect"
							tabindex={ri === activeFor(i, block.rects.length) ? 0 : -1}
							aria-label={rectLabel(rect)}
							style:left="{rect.x * 100}%"
							style:top="{rect.y * 100}%"
							style:width="{rect.w * 100}%"
							style:height="{rect.h * 100}%"
							style:background={feeColor(rect.feeRate)}
							onmouseenter={(e) => showTip(e, rect)}
							onmousemove={(e) => showTip(e, rect)}
							onmouseleave={() => (tip = null)}
							onfocus={(e) => {
							activeRect[i] = ri;
							showTipFromFocus(e, rect);
						}}
							onblur={() => (tip = null)}
							onkeydown={(e) => onRectKeydown(e, i)}
						></button>
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
					<span class="legend-swatch" aria-hidden="true" style:background={feeColor(rate)}></span>
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

<div class="sr-only" aria-live="polite">{announcement}</div>

{#if tip}
	<div
		class="tooltip"
		style:left="{Math.max(8, Math.min(tip.x + 14, window.innerWidth - 210))}px"
		style:top="{tip.y + 14}px"
	>
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
</div>
</div>

<style>
	.blocks-page {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.page-body {
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

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
		margin-bottom: 14px;
	}

	.head .page-title {
		margin-top: 6px;
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
		background: var(--bg-input);
		border: 1px solid var(--hairline);
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
		/* Reset button chrome — geometry and background come from inline styles. */
		appearance: none;
		border: none;
		padding: 0;
		margin: 0;
		font: inherit;
		cursor: pointer;
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

	.tx-rect:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		z-index: 3; /* keep the outline above sibling rects */
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
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
		width: min(196px, calc(100vw - 16px));
		background: var(--surface-elevated);
		border: 1px solid var(--border-control);
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

	@media (max-width: 900px) {
		.blocks-page {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.top-row {
			margin-bottom: 18px;
		}
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
