<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import {
		formatNumber,
		formatBtc,
		formatBytes,
		formatHashrate,
		formatSats,
		timeAgo,
		formatFeeRate
	} from '$lib/format';

	let { data } = $props();

	// Live new-block updates: refresh the server data when the chain advances.
	let lastSeenHeight: number | null = null;
	onMount(() => {
		lastSeenHeight = data.chain.tipHeight;
		return onNewBlock((height) => {
			if (lastSeenHeight !== null && height === lastSeenHeight) return;
			lastSeenHeight = height;
			invalidateAll();
		});
	});

	// One-time orientation for new users; dismissal is remembered per account.
	const tourKey = $derived(`cairn.tour.${page.data.user?.id ?? 'anon'}`);
	let showTour = $state(false);

	$effect(() => {
		showTour = localStorage.getItem(tourKey) !== 'done';
	});

	function dismissTour() {
		showTour = false;
		localStorage.setItem(tourKey, 'done');
	}

	const feeTiers = $derived(
		data.chain.fees
			? [
					{ label: 'Fastest', desc: '~10 min', rate: data.chain.fees.fastest },
					{ label: 'Half hour', desc: '~30 min', rate: data.chain.fees.halfHour },
					{ label: 'Hour', desc: '~60 min', rate: data.chain.fees.hour },
					{ label: 'Economy', desc: 'whenever', rate: data.chain.fees.economy }
				]
			: []
	);
</script>

<svelte:head>
	<title>Dashboard — Cairn</title>
</svelte:head>

{#if showTour}
	<section class="card card-pad tour fade-in">
		<div class="tour-head">
			<span class="tour-title">Welcome to Cairn</span>
			<button class="tour-close" onclick={dismissTour} aria-label="Dismiss welcome tour">
				<Icon name="x" size={15} />
			</button>
		</div>
		<div class="tour-items">
			<a href="/explorer" class="tour-item" onclick={dismissTour}>
				<Icon name="blocks" size={18} />
				<span class="tour-item-title">Explorer</span>
				<span class="tour-item-desc">
					Browse blocks, transactions, and addresses — every technical term explains itself.
				</span>
			</a>
			<a href="/wallets" class="tour-item" onclick={dismissTour}>
				<Icon name="wallet" size={18} />
				<span class="tour-item-title">Wallets</span>
				<span class="tour-item-desc">
					Import an xpub to watch balances and history. Keys never leave your hardware.
				</span>
			</a>
			<a href="/explorer/mempool" class="tour-item" onclick={dismissTour}>
				<Icon name="zap" size={18} />
				<span class="tour-item-title">Mempool</span>
				<span class="tour-item-desc">
					See what's waiting to confirm and what a transaction costs right now.
				</span>
			</a>
		</div>
	</section>
{/if}

{#if data.chain.error}
	<div class="card card-pad chain-error fade-in">
		<Icon name="alert-triangle" size={18} />
		<div>
			<div style="font-weight: 500">Can't reach chain data sources</div>
			<div class="hint">{data.chain.error} — check the connection in Admin → Settings.</div>
		</div>
	</div>
{:else}
	<!-- Hero -->
	<section class="hero fade-in">
		<div class="hero-main">
			<span class="overline">Block height</span>
			<a href="/explorer/block/{data.chain.tipHeight}" class="hero-height">
				<span class="hero-number">{formatNumber(data.chain.tipHeight ?? 0)}</span>
			</a>
			<span class="hero-sub">
				<Icon name="clock" size={13} />
				last block {timeAgo(data.chain.tipTime)}
			</span>
		</div>
		<div class="hero-side">
			<div class="hero-stat">
				<span class="overline">Hashrate</span>
				<span class="hero-stat-value">
					{data.chain.hashrate ? formatHashrate(data.chain.hashrate) : '—'}
				</span>
			</div>
			<div class="hero-stat">
				<span class="overline">Unconfirmed</span>
				<span class="hero-stat-value">
					{data.chain.mempool ? formatNumber(data.chain.mempool.txCount) : '—'}
					<span class="unit">txs</span>
				</span>
			</div>
			<div class="hero-stat">
				<span class="overline">Mempool fees</span>
				<span class="hero-stat-value">
					{data.chain.mempool ? formatBtc(data.chain.mempool.totalFees) : '—'}
					<span class="unit">BTC</span>
				</span>
			</div>
		</div>
	</section>

	<!-- Portfolio (only when the user has wallets) -->
	{#await data.portfolio then portfolio}
		{#if portfolio}
			<a href="/wallets" class="card card-pad portfolio fade-in">
				<div class="row" style="gap: 10px">
					<Icon name="wallet" size={18} />
					<span class="card-title grow">Portfolio</span>
					<span class="hint">
						{portfolio.walletCount} wallet{portfolio.walletCount === 1 ? '' : 's'}
						{#if portfolio.scannedCount < portfolio.walletCount}
							· {portfolio.walletCount - portfolio.scannedCount} unreachable
						{/if}
					</span>
					<Icon name="chevron-right" size={16} />
				</div>
				<div class="portfolio-balance">
					<span class="hero-number portfolio-btc">{formatBtc(portfolio.confirmed)}</span>
					<span class="portfolio-unit">BTC</span>
					{#if portfolio.unconfirmed !== 0}
						<span class="badge badge-warning">
							{portfolio.unconfirmed > 0 ? '+' : ''}{formatSats(portfolio.unconfirmed)} sats pending
						</span>
					{/if}
				</div>
			</a>
		{/if}
	{:catch}
		<!-- portfolio is best-effort -->
	{/await}

	<div class="columns">
		<!-- Recommended fees -->
		<section class="card card-pad fees fade-in">
			<div class="row" style="gap: 10px; margin-bottom: 14px">
				<Icon name="zap" size={17} />
				<span class="card-title">Recommended fees</span>
			</div>
			{#if feeTiers.length}
				<div class="fee-grid">
					{#each feeTiers as tier (tier.label)}
						<div class="fee-tier">
							<span class="fee-label">{tier.label}</span>
							<span class="fee-rate tabular">{Math.round(tier.rate)}</span>
							<span class="fee-unit">sat/vB</span>
							<span class="fee-desc">{tier.desc}</span>
						</div>
					{/each}
				</div>
			{:else}
				<div class="empty-state">Fee estimates unavailable</div>
			{/if}

			{#if data.chain.mempool}
				<div class="mempool-line">
					<span class="hint">Mempool depth</span>
					<span class="hint tabular">{formatBytes(data.chain.mempool.vsize)} of transactions</span>
				</div>
			{/if}
		</section>

		<!-- Recent blocks -->
		<section class="card blocks fade-in">
			<div class="row blocks-head">
				<Icon name="blocks" size={17} />
				<span class="card-title grow">Recent blocks</span>
				<a href="/explorer" class="see-all">Explorer <Icon name="arrow-right" size={13} /></a>
			</div>
			<div class="table-wrap">
				<table class="table">
					<thead>
						<tr>
							<th>Height</th>
							<th>Mined</th>
							<th class="num">Txs</th>
							<th class="num">Size</th>
							<th class="num">Fee range</th>
						</tr>
					</thead>
					<tbody>
						{#each data.chain.blocks as block (block.hash)}
							<tr>
								<td>
									<a href="/explorer/block/{block.hash}" class="block-link tabular">
										{formatNumber(block.height)}
									</a>
								</td>
								<td class="text-muted">{timeAgo(block.time)}</td>
								<td class="num">{formatNumber(block.txCount)}</td>
								<td class="num text-muted">{formatBytes(block.size)}</td>
								<td class="num text-muted">
									{#if block.feeRange}
										{formatFeeRate(block.feeRange[0]).replace(' sat/vB', '')}–{formatFeeRate(
											block.feeRange[1]
										)}
									{:else}
										—
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>
{/if}

<style>
	.chain-error {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		color: var(--warning);
	}

	.tour {
		margin-bottom: 16px;
		background: linear-gradient(160deg, rgba(232, 147, 90, 0.1), var(--surface) 55%);
		border-color: rgba(232, 147, 90, 0.3);
	}

	.tour-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 14px;
	}

	.tour-title {
		font-family: var(--font-serif);
		font-size: 19px;
		font-weight: 600;
	}

	.tour-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: none;
		border: none;
		border-radius: var(--radius-chip);
		color: var(--text-muted);
		cursor: pointer;
	}

	.tour-close:hover {
		color: var(--text);
		background: var(--surface-elevated);
	}

	.tour-items {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}

	.tour-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		color: var(--accent);
		transition: border-color 120ms var(--ease);
	}

	.tour-item:hover {
		border-color: var(--accent);
	}

	.tour-item-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.tour-item-desc {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.hero {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 24px;
		padding: 12px 4px 28px;
		flex-wrap: wrap;
	}

	.hero-main {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.hero-height {
		color: inherit;
	}

	.hero-height .hero-number {
		font-size: 56px;
		transition: color 120ms var(--ease);
	}

	.hero-height:hover .hero-number {
		color: var(--accent);
	}

	.hero-sub {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-secondary);
		font-size: 13px;
	}

	.hero-side {
		display: flex;
		gap: 36px;
		flex-wrap: wrap;
	}

	.hero-stat {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.hero-stat-value {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
		font-variant-numeric: tabular-nums;
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--text-muted);
		font-weight: 400;
	}

	.portfolio {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 14px;
		color: inherit;
		transition: border-color 120ms var(--ease);
	}

	.portfolio:hover {
		border-color: var(--border);
	}

	.portfolio-balance {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.portfolio-btc {
		font-size: 34px;
	}

	.portfolio-unit {
		font-size: 14px;
		color: var(--text-muted);
	}

	.columns {
		display: grid;
		grid-template-columns: 300px 1fr;
		gap: 14px;
		align-items: start;
	}

	.columns > section {
		min-width: 0;
	}

	@media (max-width: 900px) {
		.columns {
			grid-template-columns: 1fr;
		}
	}

	.fee-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}

	.fee-tier {
		display: flex;
		flex-direction: column;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 12px;
	}

	.fee-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.fee-rate {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 560;
		margin-top: 2px;
	}

	.fee-unit {
		font-size: 11px;
		color: var(--text-muted);
	}

	.fee-desc {
		font-size: 11px;
		color: var(--text-faint);
		margin-top: 6px;
	}

	.mempool-line {
		display: flex;
		justify-content: space-between;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--border-subtle);
	}

	.blocks-head {
		gap: 10px;
		padding: 16px 20px 12px;
	}

	.see-all {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
	}

	.block-link {
		font-weight: 500;
	}
</style>
