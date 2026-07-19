<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import { triggerChainRefresh } from '$lib/chainRefresh';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import Term from '$lib/components/Term.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import ExplorerSearch from '$lib/components/heartwood/ExplorerSearch.svelte';
	import CairnChart, { type ChartBar } from '$lib/components/heartwood/CairnChart.svelte';
	import { formatNumber, formatBtc, formatDuration, formatDateTime, timeAgo } from '$lib/format';
	import { blockSubsidy } from '$lib/bitcoin';

	let { data } = $props();

	// Stale-while-revalidate: difficulty info + history render instantly from the
	// persisted SQLite snapshot load() read (data.difficulty); the client refreshes
	// it in the background (on mount + on every new block) and invalidate('cairn:chain')
	// re-runs load() to pick up the fresh snapshot.
	let diff = $derived(data.difficulty);

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
		return onNewBlock(() => void refresh(true));
	});

	const syncLabel = $derived(
		syncing
			? 'updating…'
			: data.lastSyncedAt
				? `synced ${timeAgo(Math.floor(data.lastSyncedAt / 1000))}`
				: ''
	);

	// Loading = no snapshot yet AND the first refresh hasn't failed.
	const loading = $derived(diff === null && !syncFailed);
	const info = $derived(diff?.info ?? null);
	const history = $derived(diff?.history ?? null);
	const chainError = $derived(diff?.error ?? null);
	// Error banner: a stored error, or the first snapshot refresh failing before
	// anything was ever persisted.
	const showError = $derived(chainError !== null || (diff === null && syncFailed));

	/** "+3.42%" / "-1.20%" with a fixed number of decimals. */
	function signedPercent(n: number, dp = 2): string {
		return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
	}

	/** Compact difficulty: 126984103, e12 -> "126.98 T". */
	function compactDifficulty(d: number): { value: string; unit: string } {
		if (d >= 1e15) return { value: (d / 1e15).toFixed(2), unit: 'P' };
		if (d >= 1e12) return { value: (d / 1e12).toFixed(2), unit: 'T' };
		if (d >= 1e9) return { value: (d / 1e9).toFixed(2), unit: 'G' };
		if (d >= 1e6) return { value: (d / 1e6).toFixed(2), unit: 'M' };
		// A true tiny value (e.g. regtest's near-zero real difficulty) would round to
		// a bare "0" and read like a bug — show it's small but non-zero (cairn-t6t7).
		if (d > 0 && d < 1) return { value: '<0.01', unit: '' };
		return { value: formatNumber(d), unit: '' };
	}

	// Cap the per-block pace used for the far-out halving estimate to the consensus
	// 4x band. A slow test/regtest chain otherwise extrapolates a nonsensical
	// five-digit-year halving date (observed: year 27506) — cairn-t6t7.
	const HALVING_PACE_CAP = 2400; // 10-minute target × 4

	/** 597.4 seconds -> "9m 57s" */
	function minSec(seconds: number): string {
		const total = Math.round(seconds);
		return `${Math.floor(total / 60)}m ${total % 60}s`;
	}

	function shortDate(unixSeconds: number): string {
		return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	const projected = $derived(info?.projectedChangePercent ?? null);
	const rising = $derived(projected !== null && projected >= 0);

	const secondsUntilRetarget = $derived(
		info?.estimatedRetargetDate != null
			? Math.max(0, info.estimatedRetargetDate - Math.floor(Date.now() / 1000))
			: null
	);

	// Block pace vs the 10-minute target, with a ±2s "close enough" band.
	const pace = $derived.by(() => {
		const avg = info?.avgBlockTimeSeconds;
		if (avg == null) return null;
		if (Math.abs(avg - 600) <= 2) {
			return { badge: 'badge-success', label: 'on target' };
		}
		return avg < 600
			? { badge: 'badge-warning', label: 'ahead of schedule' }
			: { badge: 'badge-neutral', label: 'behind schedule' };
	});

	const diffCompact = $derived(info ? compactDifficulty(info.currentDifficulty) : null);

	// Halving countdown. The tip's timestamp isn't in DifficultyInfo, so the
	// date estimate anchors on "now" — good enough at ten-minute granularity.
	const HALVING_INTERVAL = 210_000;
	const halving = $derived.by(() => {
		if (!info) return null;
		const nextHeight = (Math.floor(info.tipHeight / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
		const blocksRemaining = nextHeight - info.tipHeight;
		const pace = Math.min(info.avgBlockTimeSeconds ?? 600, HALVING_PACE_CAP);
		const estimatedUnix = Math.floor((Date.now() + blocksRemaining * pace * 1000) / 1000);
		return {
			nextHeight,
			blocksRemaining,
			estimatedUnix,
			currentSubsidy: blockSubsidy(info.tipHeight),
			nextSubsidy: blockSubsidy(nextHeight)
		};
	});

	// Bars for the retarget history chart (last 10 retargets). Rendered by the
	// shared CairnChart in signed bar mode: copper for a rise, dim copper for a
	// fall — neither direction is "bad" (mirrors the hero's quiet falling tone).
	const chart = $derived.by((): ChartBar[] | null => {
		if (!history || history.length < 2) return null;
		const entries = history.filter((h) => h.changePercent !== null).slice(-10);
		if (entries.length === 0) return null;
		return entries.map((e) => {
			const change = e.changePercent as number;
			return {
				label: shortDate(e.time),
				value: change,
				color: change >= 0 ? 'var(--accent)' : 'var(--accent-dim)',
				valueLabel: signedPercent(change, 2),
				note: formatDateTime(e.time)
			};
		});
	});

	/** Difficulty value-axis tick: "0%", "+2%", "-2%" (no misleading "+0%"). */
	function axisPercent(v: number): string {
		if (Math.abs(v) < 0.5) return '0%';
		return `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
	}
</script>

<svelte:head>
	<title>Difficulty — Heartwood</title>
</svelte:head>

<div class="diff-page">
<GroveField volume="present" />
<div class="page-body">
<div class="top-row fade-in">
	<a
		href="/explorer"
		class="back"
		onclick={(e) => {
			e.preventDefault();
			goto('/explorer', { replaceState: true });
		}}
	>
		<Icon name="chevron-left" size={15} /> Explorer
	</a>
	<div class="top-search"><ExplorerSearch variant="compact" /></div>
</div>

<div class="head fade-in">
	<EyebrowBreadcrumb path={['Explorer']} current="Difficulty" />
	<h1 class="page-title">Difficulty</h1>
	{#if syncLabel}
		<span class="sync-status" class:updating={syncing}>{syncLabel}</span>
	{/if}
</div>

<HowItWorks id="difficulty">
	<p>
		<strong>Difficulty is Bitcoin's thermostat.</strong> It sets how hard miners must work to find
		a valid block. Every 2,016 blocks — roughly two weeks — the network measures how fast blocks
		actually arrived and retunes the difficulty so blocks keep coming
		<strong>about every ten minutes</strong>, no matter how much mining power joins or leaves.
	</p>
	<p>
		This self-correction is why difficulty exists at all: without it, more hashrate would mean
		faster blocks and a coin supply racing ahead of plan. With it,
		<strong>Bitcoin's issuance schedule stays on time</strong> for decades, whether mining is done
		on a laptop or in a gigawatt farm.
	</p>
</HowItWorks>

{#if showError}
	<div class="form-error" role="alert">
		Can't reach chain data sources{#if chainError} — {chainError}{/if}.
		<button type="button" class="retry-link" onclick={() => refresh(true)}>Retry</button>
	</div>
{:else if loading}
	<!-- Streamed placeholder: hero + stat scaffold while difficulty data lands. -->
	<section class="hero fade-in" aria-busy="true" aria-label="Loading difficulty">
		<span class="overline">Projected adjustment</span>
		<span class="hero-number hero-pct tabular skeleton">+0.00%</span>
		<p class="hero-sentence skeleton">
			Based on how fast blocks have arrived this difficulty period, difficulty is expected to
			change soon.
		</p>
	</section>
	<section class="stats fade-in">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="stat">
				<span class="overline skeleton">Loading</span>
				<span class="hero-number stat-hero tabular skeleton">000</span>
				<span class="hint skeleton">placeholder detail</span>
			</div>
		{/each}
	</section>
{:else if info}
	<!-- Projected adjustment hero -->
	<section class="hero fade-in">
		<span class="overline">Projected adjustment</span>
		{#if projected !== null}
			<span class="hero-number hero-pct tabular" class:falling={!rising}>
				{signedPercent(projected)}
			</span>
			<p class="hero-sentence">
				Based on how fast blocks have arrived this difficulty period,
				<Term
					tip="A number encoding how hard it is to find a valid block hash. Higher difficulty = more hashing needed per block."
					>difficulty</Term
				>
				is expected to {rising ? 'increase' : 'decrease'} by about
				<span class="tabular">{Math.abs(projected).toFixed(2)}%</span> at block
				<span class="tabular">{formatNumber(info.nextRetargetHeight)}</span>.
			</p>
		{:else}
			<span class="hero-number hero-pct">—</span>
			<p class="hero-sentence">projection unavailable on this backend</p>
		{/if}
	</section>

	<!-- Difficulty-period progress -->
	<section class="section fade-in">
		<div class="section-head">
			<Icon name="clock" size={17} />
			<span class="card-title">This difficulty period</span>
		</div>
		<div>
			<div class="progress-labels">
				<span class="tabular">
					{formatNumber(info.blocksIntoEpoch)} of
					<Term
						tip="One difficulty period (an 'epoch'). 2,016 blocks at exactly 10 minutes each is two weeks; the retarget multiplies difficulty by (two weeks ÷ actual time taken), clamped to 4x either direction."
						>2,016 blocks</Term
					>
				</span>
				<span class="tabular remaining">{formatNumber(info.blocksRemaining)} remaining</span>
			</div>
			<div class="progress-track">
				<div class="progress-fill" style:width="{Math.min(info.progressPercent, 100)}%"></div>
			</div>
		</div>
		<div class="facts">
			<div class="fact">
				<span class="fact-label">Estimated retarget</span>
				{#if info.estimatedRetargetDate != null}
					<span class="fact-value tabular" title={formatDateTime(info.estimatedRetargetDate)}>
						{formatDateTime(info.estimatedRetargetDate)}
						{#if secondsUntilRetarget !== null}
							<span class="fact-sub">(~in {formatDuration(secondsUntilRetarget)})</span>
						{/if}
					</span>
				{:else}
					<span class="fact-value">—</span>
				{/if}
			</div>
			<div class="fact">
				<span class="fact-label">Previous retarget</span>
				{#if info.previousChangePercent != null}
					<span class="fact-value tabular">
						last adjustment {signedPercent(info.previousChangePercent)}
					</span>
				{:else}
					<span class="fact-value">—</span>
				{/if}
			</div>
		</div>
	</section>

	<!-- Stat cards -->
	<section class="stats fade-in">
		<div class="stat">
			<span class="overline">Current difficulty</span>
			{#if diffCompact}
				<span
					class="hero-number stat-hero tabular"
					title={formatNumber(info.currentDifficulty)}
				>
					{diffCompact.value}{#if diffCompact.unit}&nbsp;<span class="stat-unit">{diffCompact.unit}</span>{/if}
				</span>
			{/if}
			<span class="hint">hashes-per-block scale, unitless</span>
		</div>
		<div class="stat">
			<span class="overline">
				Average
				<Term
					tip="Average spacing between blocks so far this difficulty period. Faster than 10 minutes means more hashrate than difficulty accounts for — the next retarget will push difficulty up to compensate."
					>block time</Term
				>
				this period
			</span>
			{#if info.avgBlockTimeSeconds != null}
				<span class="hero-number stat-hero tabular">{minSec(info.avgBlockTimeSeconds)}</span>
				<span class="hint stat-target">
					<span class="tabular">target 10m 0s</span>
					{#if pace}
						<span class="badge {pace.badge}">{pace.label}</span>
					{/if}
				</span>
			{:else}
				<span class="hero-number stat-hero">—</span>
				<span class="hint">unavailable on this backend</span>
			{/if}
		</div>
		<div class="stat">
			<span class="overline">Next retarget height</span>
			<span class="hero-number stat-hero tabular">{formatNumber(info.nextRetargetHeight)}</span>
			<span class="hint">block that triggers the adjustment</span>
		</div>
		{#if halving}
			<div class="stat">
				<span class="overline">
					Next
					<Term
						tip="Every 210,000 blocks (~4 years) the new-bitcoin subsidy paid to miners halves — the mechanism enforcing the 21 million cap."
						>halving</Term
					>
				</span>
				<span class="hero-number stat-hero tabular" title="at block {formatNumber(halving.nextHeight)}">
					{formatNumber(halving.blocksRemaining)}
					<span class="stat-unit">blocks</span>
				</span>
				<span class="hint">
					<span class="tabular">~{formatDateTime(halving.estimatedUnix)}</span> — subsidy drops
					from <span class="tabular">{formatBtc(halving.currentSubsidy)}</span> to
					<span class="tabular">{formatBtc(halving.nextSubsidy)}</span> BTC
				</span>
			</div>
		{/if}
	</section>

	<!-- Retarget history -->
	{#if chart}
		<section class="section fade-in">
			<div class="section-head">
				<Icon name="activity" size={17} />
				<span class="card-title">Recent adjustments</span>
			</div>
			<CairnChart
				kind="bar"
				bars={chart}
				height={200}
				ariaLabel="Recent difficulty adjustments"
				valueFormat={axisPercent}
			/>
			<span class="hint">
				Each bar is one retarget — the network correcting for hashrate that joined or left
				during that difficulty period.
			</span>
		</section>
	{:else if history === null}
		<p class="hint degrade-note">
			Adjustment history couldn't be read from your Electrum server right now.
		</p>
	{/if}
{/if}
</div>
</div>

<style>
	.diff-page {
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
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 26px;
	}

	.top-search {
		width: 320px;
		max-width: 100%;
		flex-shrink: 1;
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
		gap: 8px;
		margin-bottom: 18px;
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 24px 0;
		border-top: 1px solid var(--hairline);
	}

	.hero-pct {
		font-size: 44px;
		color: var(--accent);
	}

	/* Falling difficulty is not "bad" — a quiet warm grey, never red (spec). */
	.hero-pct.falling {
		color: var(--text-secondary);
	}

	.hero-sentence {
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		max-width: 52ch;
		margin: 0;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 20px 0;
		border-top: 1px solid var(--hairline);
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.progress-labels {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 13px;
		color: var(--text-secondary);
		margin-bottom: 8px;
	}

	.remaining {
		color: var(--text-muted);
		font-size: 12px;
	}

	.progress-track {
		height: 12px;
		background: var(--bg-input);
		border-radius: 6px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-hover));
		border-radius: 6px;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 36px;
	}

	.fact {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.fact-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.fact-value {
		font-size: 13.5px;
		color: var(--text);
	}

	.fact-sub {
		color: var(--text-muted);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 14px;
		margin-bottom: 14px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	.stat-hero {
		font-size: 30px;
	}

	.stat-unit {
		font-size: 20px;
		color: var(--text-secondary);
	}

	.stat-target {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.degrade-note {
		margin-top: 4px;
	}

	@media (max-width: 900px) {
		.diff-page {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.top-row {
			margin-bottom: 18px;
		}

		.top-search {
			width: 100%;
		}
	}

	@media (max-width: 480px) {
		.hero-pct {
			font-size: 36px;
		}
	}
</style>
