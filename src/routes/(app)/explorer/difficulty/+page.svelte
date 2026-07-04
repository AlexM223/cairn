<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import Term from '$lib/components/Term.svelte';
	import ExplorerNav from '$lib/components/ExplorerNav.svelte';
	import { formatNumber, formatBtc, formatDuration, formatDateTime } from '$lib/format';
	import { blockSubsidy } from '$lib/bitcoin';

	let { data } = $props();

	const info = $derived(data.info);

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
		return { value: formatNumber(d), unit: '' };
	}

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
		const estimatedUnix = Math.floor(
			(Date.now() + blocksRemaining * (info.avgBlockTimeSeconds ?? 600) * 1000) / 1000
		);
		return {
			nextHeight,
			blocksRemaining,
			estimatedUnix,
			currentSubsidy: blockSubsidy(info.tipHeight),
			nextSubsidy: blockSubsidy(nextHeight)
		};
	});

	// Bars for the retarget history chart, scaled to the largest swing.
	const BAR_CAP = 64; // px, tallest bar
	const chart = $derived.by(() => {
		if (!data.history || data.history.length < 2) return null;
		const entries = data.history.filter((h) => h.changePercent !== null).slice(-10);
		if (entries.length === 0) return null;
		const maxAbs = Math.max(...entries.map((e) => Math.abs(e.changePercent as number)), 0.1);
		return {
			hasNegative: entries.some((e) => (e.changePercent as number) < 0),
			bars: entries.map((e) => {
				const change = e.changePercent as number;
				return {
					positive: change >= 0,
					height: Math.max((Math.abs(change) / maxAbs) * BAR_CAP, 3),
					label: signedPercent(change, 1),
					date: shortDate(e.time),
					time: e.time,
					height_: e.height
				};
			})
		};
	});
</script>

<svelte:head>
	<title>Difficulty — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<span class="overline">Explorer</span>
	<h1 class="page-title">Difficulty</h1>
</div>

<ExplorerNav active="difficulty" />

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

{#if data.error}
	<div class="form-error" role="alert">
		Can't reach chain data sources — {data.error}.
		<a href="/explorer/difficulty">Retry</a>
	</div>
{:else if info}
	<!-- Projected adjustment hero -->
	<section class="card hero fade-in">
		<span class="overline">Projected adjustment</span>
		{#if projected !== null}
			<span class="hero-number hero-pct tabular" class:falling={!rising}>
				{signedPercent(projected)}
			</span>
			<p class="hero-sentence">
				Based on how fast blocks have arrived this epoch,
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

	<!-- Epoch progress -->
	<section class="card card-pad section fade-in">
		<div class="section-head">
			<Icon name="clock" size={17} />
			<span class="card-title">Epoch progress</span>
		</div>
		<div>
			<div class="progress-labels">
				<span class="tabular">
					{formatNumber(info.blocksIntoEpoch)} of
					<Term
						tip="One difficulty epoch. 2,016 blocks at exactly 10 minutes each is two weeks; the retarget multiplies difficulty by (two weeks ÷ actual time taken), clamped to 4x either direction."
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
		<div class="card card-pad stat">
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
		<div class="card card-pad stat">
			<span class="overline">
				Average
				<Term
					tip="Average spacing between blocks so far this epoch. Faster than 10 minutes means more hashrate than difficulty accounts for — the next retarget will push difficulty up to compensate."
					>block time</Term
				>
				this epoch
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
		<div class="card card-pad stat">
			<span class="overline">Next retarget height</span>
			<span class="hero-number stat-hero tabular">{formatNumber(info.nextRetargetHeight)}</span>
			<span class="hint">block that triggers the adjustment</span>
		</div>
		{#if halving}
			<div class="card card-pad stat">
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
		<section class="card card-pad section fade-in">
			<div class="section-head">
				<Icon name="activity" size={17} />
				<span class="card-title">Recent adjustments</span>
			</div>
			<div class="chart-scroll">
				<div class="chart">
					{#each chart.bars as bar (bar.height_)}
						<div class="bar-col" title={formatDateTime(bar.time)}>
							<div class="bar-zone top">
								{#if bar.positive}
									<span class="bar-val tabular">{bar.label}</span>
									<div class="bar pos" style:height="{bar.height}px"></div>
								{/if}
							</div>
							<div class="baseline" class:solo={!chart.hasNegative}></div>
							{#if chart.hasNegative}
								<div class="bar-zone bottom">
									{#if !bar.positive}
										<div class="bar neg" style:height="{bar.height}px"></div>
										<span class="bar-val tabular">{bar.label}</span>
									{/if}
								</div>
							{/if}
							<span class="bar-date">{bar.date}</span>
						</div>
					{/each}
				</div>
			</div>
			<span class="hint">
				Each bar is one retarget — the network correcting for hashrate that joined or left
				during the epoch.
			</span>
		</section>
	{:else if data.history === null}
		<p class="hint degrade-note">
			Adjustment history needs a mempool.space-compatible backend.
		</p>
	{/if}
{/if}

<style>
	.head {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 14px;
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 28px 24px;
		margin-bottom: 14px;
	}

	.hero-pct {
		font-size: 44px;
		color: var(--accent);
	}

	/* Falling difficulty is not "bad" — a cool steel tone, not an error red. */
	.hero-pct.falling {
		color: #7d8a94;
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
		margin-bottom: 14px;
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
		background: var(--bg);
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

	.chart-scroll {
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.chart {
		display: flex;
		align-items: stretch;
		gap: 10px;
		min-width: min-content;
	}

	.bar-col {
		flex: 1 0 52px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.bar-zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		height: 82px; /* bar cap (64px) + value label */
	}

	.bar-zone.top {
		justify-content: flex-end;
		gap: 4px;
	}

	.bar-zone.bottom {
		justify-content: flex-start;
		gap: 4px;
	}

	.bar {
		width: min(26px, 60%);
		border-radius: 3px;
	}

	.bar.pos {
		background: linear-gradient(180deg, var(--accent-hover), var(--accent));
		border-radius: 3px 3px 1px 1px;
	}

	/* Steel blue-grey mirrors the hero's "falling" tone — neither direction is bad. */
	.bar.neg {
		background: linear-gradient(180deg, #7d8a94, #66727c);
		border-radius: 1px 1px 3px 3px;
	}

	.bar-val {
		font-size: 11px;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.baseline {
		width: 100%;
		border-top: 1px solid var(--border-subtle);
	}

	.baseline.solo {
		border-top-color: transparent;
	}

	.bar-date {
		font-size: 11px;
		color: var(--text-muted);
		margin-top: 8px;
		white-space: nowrap;
	}

	.degrade-note {
		margin-top: 4px;
	}

	@media (max-width: 480px) {
		.hero-pct {
			font-size: 36px;
		}
	}
</style>
