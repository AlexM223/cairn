<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import BalanceChart from '$lib/components/portfolio/BalanceChart.svelte';
	import AllocationBar from '$lib/components/portfolio/AllocationBar.svelte';
	import RecentActivity from '$lib/components/portfolio/RecentActivity.svelte';
	import Sparkline from '$lib/components/portfolio/Sparkline.svelte';
	import {
		formatNumber,
		formatBtc,
		formatBytes,
		formatHashrate,
		formatSats,
		timeAgo,
		formatFeeRate
	} from '$lib/format';
	import type { PortfolioDetail } from '$lib/types';

	let { data } = $props();

	// Live new-block updates refresh only the chain snapshot — the portfolio is
	// deliberately outside the invalidation path so wallets aren't rescanned on
	// every block.
	let lastSeenHeight: number | null = null;
	onMount(() => {
		lastSeenHeight = data.chain.tipHeight;
		return onNewBlock((height) => {
			if (lastSeenHeight !== null && height === lastSeenHeight) return;
			lastSeenHeight = height;
			invalidate('cairn:chain');
		});
	});

	// Portfolio loads client-side, once per visit (its own endpoint so block
	// refreshes don't rescan wallets).
	let portfolio = $state<PortfolioDetail | null>(null);
	let portfolioLoading = $state(false);
	onMount(() => {
		if (!data.hasWallets) return;
		portfolioLoading = true;
		fetch('/api/portfolio')
			.then((res) => (res.ok ? res.json() : null))
			.then((body) => (portfolio = body?.portfolio ?? null))
			.catch(() => (portfolio = null))
			.finally(() => (portfolioLoading = false));
	});

	// --- optional fiat estimate (privacy-first: OFF by default, no price call
	//     until the user turns it on) ---
	let showFiat = $state(false);
	let usdPrice = $state<number | null>(null);
	let priceTried = $state(false);
	onMount(() => {
		showFiat = localStorage.getItem('cairn.fiat') === 'on';
	});
	async function fetchPrice() {
		priceTried = true;
		try {
			const res = await fetch('/api/price');
			const body = res.ok ? await res.json() : null;
			usdPrice = body?.usd ?? null;
		} catch {
			usdPrice = null;
		}
	}
	function toggleFiat() {
		showFiat = !showFiat;
		localStorage.setItem('cairn.fiat', showFiat ? 'on' : 'off');
		if (showFiat && !priceTried) void fetchPrice();
	}
	$effect(() => {
		if (showFiat && !priceTried) void fetchPrice();
	});
	const fiatValue = $derived(
		showFiat && usdPrice != null && portfolio ? (portfolio.confirmed / 1e8) * usdPrice : null
	);
	function usd(n: number): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 0
		}).format(n);
	}

	// Change chips (24h/7d/30d) — only those with data.
	const changes = $derived(
		portfolio
			? (
					[
						{ label: '24h', sats: portfolio.change.d1 },
						{ label: '7d', sats: portfolio.change.d7 },
						{ label: '30d', sats: portfolio.change.d30 }
					] as const
				).filter((c) => c.sats !== null)
			: []
	);

	const unreachable = $derived(
		portfolio ? portfolio.walletCount - portfolio.scannedCount : 0
	);

	function sendHref(s: { kind: string; id: number }): string {
		return s.kind === 'multisig' ? `/wallets/multisig/${s.id}/send` : `/wallets/${s.id}/send`;
	}

	// One-time orientation for new users; dismissal remembered per account.
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
			<a href="/wallets" class="tour-item" onclick={dismissTour}>
				<Icon name="wallet" size={18} />
				<span class="tour-item-title">Wallets</span>
				<span class="tour-item-desc">
					Import a single-key or multisig wallet to watch balances and spend. Keys never leave
					your devices.
				</span>
			</a>
			<a href="/explorer" class="tour-item" onclick={dismissTour}>
				<Icon name="blocks" size={18} />
				<span class="tour-item-title">Explorer</span>
				<span class="tour-item-desc">
					Browse blocks, transactions, and addresses — every technical term explains itself.
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

<!-- ============================================================ PORTFOLIO -->
{#if !data.hasWallets && !portfolio}
	<section class="card onboard fade-in">
		<div class="onboard-icon"><Icon name="wallet" size={26} /></div>
		<h2 class="onboard-title">Your bitcoin, at a glance</h2>
		<p class="onboard-copy">
			Add a wallet and Cairn shows your total balance, history, and allocation here — all from
			your <em>public</em> keys. Nothing here can move your bitcoin; you sign every spend on your
			own device.
		</p>
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} /> Add your first wallet
		</a>
	</section>
{:else}
	<section class="portfolio-hero card card-pad fade-in">
		<div class="ph-top">
			<span class="overline ph-label">
				<Term
					tip="Your portfolio shows all wallets you've imported into Cairn — single-key and multisig. Cairn only holds your public keys; your keys stay on your devices."
				>
					Portfolio
				</Term>
			</span>
			<span class="grow"></span>
			{#if portfolio}
				<a href="/wallets" class="ph-count">
					{portfolio.walletCount} wallet{portfolio.walletCount === 1 ? '' : 's'}
					{#if unreachable > 0}· <span class="ph-unreachable">{unreachable} unreachable</span>{/if}
					<Icon name="chevron-right" size={14} />
				</a>
			{/if}
		</div>

		{#if portfolioLoading && !portfolio}
			<div class="ph-balance"><span class="hero-number ph-btc skeleton">0.00000000</span></div>
		{:else if portfolio}
			<div class="ph-balance">
				<span class="hero-number ph-btc" title="{formatSats(portfolio.confirmed)} sats">
					{formatBtc(portfolio.confirmed)}
				</span>
				<span class="ph-unit">BTC</span>
				{#if portfolio.unconfirmed !== 0}
					<span class="badge badge-warning">
						{portfolio.unconfirmed > 0 ? '+' : ''}{formatSats(portfolio.unconfirmed)} sats pending
					</span>
				{/if}
			</div>
			<div class="ph-sub">
				<span class="ph-sats tabular">{formatSats(portfolio.confirmed)} sats</span>
				{#if fiatValue != null}
					<span class="ph-fiat tabular">≈ {usd(fiatValue)}</span>
				{/if}
				<button
					type="button"
					class="ph-fiat-toggle"
					onclick={toggleFiat}
					title="Show or hide a fiat estimate (off by default — no price is fetched until you turn it on)"
				>
					<Icon name={showFiat ? 'check' : 'plus'} size={12} />
					{showFiat ? 'Hide fiat' : 'Show fiat'}
				</button>
			</div>

			{#if changes.length > 0}
				<div class="ph-changes">
					{#each changes as c (c.label)}
						{@const up = (c.sats ?? 0) >= 0}
						<span class="change-chip" class:up class:down={!up}>
							<Icon name={up ? 'arrow-up-right' : 'arrow-down-left'} size={12} />
							<span class="change-label">{c.label}</span>
							<span class="tabular">{up ? '+' : '−'}{formatBtc(Math.abs(c.sats ?? 0))} BTC</span>
						</span>
					{/each}
				</div>
			{/if}
		{/if}
	</section>

	{#if portfolio}
		<!-- balance over time -->
		<section class="card card-pad chart-card fade-in">
			<div class="row section-head">
				<Icon name="activity" size={16} />
				<span class="card-title grow">Balance over time</span>
			</div>
			<BalanceChart series={portfolio.balanceSeries} />
		</section>

		<div class="two-col">
			<!-- allocation -->
			<section class="card card-pad fade-in">
				<div class="row section-head">
					<Icon name="wallet" size={16} />
					<span class="card-title grow">Allocation</span>
				</div>
				<AllocationBar slices={portfolio.allocation} total={portfolio.confirmed} />
			</section>

			<!-- recent activity -->
			<section class="card card-pad fade-in">
				<div class="row section-head">
					<Icon name="clock" size={16} />
					<span class="card-title grow">Recent activity</span>
				</div>
				<RecentActivity items={portfolio.recentActivity} />
			</section>
		</div>

		<!-- wallet cards -->
		<div class="row section-head wallets-head">
			<span class="card-title grow">Your wallets</span>
			<a href="/wallets" class="see-all">All wallets <Icon name="arrow-right" size={13} /></a>
		</div>
		<div class="wallet-grid">
			{#each portfolio.allocation as w (w.key)}
				<div class="wallet-card card card-pad" class:multisig={w.kind === 'multisig'}>
					<a href={w.href} class="wc-head">
						{#if w.kind === 'multisig'}
							<span class="wc-badge-icon"><Icon name="shield" size={12} /></span>
						{/if}
						<span class="wc-name truncate">{w.name}</span>
						<span class="badge badge-neutral wc-type">
							{w.kind === 'multisig' ? 'Multisig' : 'Single-sig'}
						</span>
					</a>
					<a href={w.href} class="wc-balance">
						<span class="hero-number wc-btc" title="{formatSats(w.balance)} sats">
							{formatBtc(w.balance)}
						</span>
						<span class="wc-unit">BTC</span>
					</a>
					{#if portfolio.sparklines[w.key]?.length > 1}
						<div class="wc-spark"><Sparkline points={portfolio.sparklines[w.key]} width={220} height={30} /></div>
					{/if}
					<span class="hint wc-activity">
						<Icon name="clock" size={12} />
						{#if w.lastActivity}last activity {timeAgo(w.lastActivity)}{:else}no activity{/if}
					</span>
					<div class="wc-actions">
						<a href={sendHref(w)} class="btn btn-primary btn-sm">
							<Icon name="arrow-up-right" size={13} /> Send
						</a>
						<a href={w.href} class="btn btn-secondary btn-sm">
							<Icon name="arrow-down-left" size={13} /> Receive
						</a>
					</div>
				</div>
			{/each}
		</div>
	{/if}
{/if}

<!-- ============================================================== NETWORK -->
{#if data.chain.error}
	<div class="card card-pad chain-error fade-in">
		<Icon name="alert-triangle" size={18} />
		<div>
			<div style="font-weight: 500">Can't reach chain data sources</div>
			<div class="hint">{data.chain.error} — check the connection in Admin → Settings.</div>
		</div>
	</div>
{:else}
	<div class="row section-head network-head">
		<Icon name="blocks" size={16} />
		<span class="card-title grow">Network</span>
		<a href="/explorer/block/{data.chain.tipHeight}" class="see-all">
			Block {formatNumber(data.chain.tipHeight ?? 0)} · {timeAgo(data.chain.tipTime)}
		</a>
	</div>
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
		margin-top: 16px;
	}

	/* --- welcome tour --- */
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

	/* --- onboarding --- */
	.onboard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 56px 32px;
		text-align: center;
		max-width: 520px;
		margin: 40px auto;
	}
	.onboard-icon {
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.onboard-title {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
		letter-spacing: -0.01em;
	}
	.onboard-copy {
		color: var(--text-secondary);
		font-size: 13.5px;
		line-height: 1.65;
		max-width: 420px;
	}
	.onboard-copy em {
		font-style: normal;
		color: var(--text);
		font-weight: 500;
	}

	/* --- portfolio hero --- */
	.portfolio-hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 14px;
	}
	.ph-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ph-label :global(.term) {
		text-transform: inherit;
		letter-spacing: inherit;
	}
	.ph-count {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}
	.ph-count:hover {
		color: var(--accent);
	}
	.ph-unreachable {
		color: var(--warning);
	}
	.ph-balance {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
	}
	.ph-btc {
		font-size: 48px;
		line-height: 1.05;
	}
	.ph-btc.skeleton {
		color: var(--text-faint);
		opacity: 0.4;
	}
	.ph-unit {
		font-size: 16px;
		color: var(--text-muted);
	}
	.ph-sub {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
	}
	.ph-sats {
		font-size: 13px;
		color: var(--text-muted);
	}
	.ph-fiat {
		font-size: 13px;
		color: var(--text-secondary);
	}
	.ph-fiat-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ph-fiat-toggle:hover {
		color: var(--accent);
	}
	.ph-changes {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 2px;
	}
	.change-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		border-radius: 99px;
		font-size: 12px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
	}
	.change-chip.up {
		color: var(--success);
	}
	.change-chip.down {
		color: var(--error);
	}
	.change-label {
		color: var(--text-muted);
	}

	/* --- section heads --- */
	.section-head {
		gap: 10px;
		margin-bottom: 12px;
	}
	.chart-card {
		margin-bottom: 14px;
	}
	.wallets-head,
	.network-head {
		margin-top: 22px;
		margin-bottom: 12px;
		align-items: center;
	}
	.see-all {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
	}

	.two-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
		margin-bottom: 4px;
		align-items: start;
	}
	.two-col > section {
		min-width: 0;
	}
	@media (max-width: 860px) {
		.two-col {
			grid-template-columns: 1fr;
		}
	}

	/* --- wallet cards --- */
	.wallet-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 14px;
	}
	.wallet-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.wallet-card.multisig {
		border-color: rgba(232, 147, 90, 0.25);
	}
	.wc-head {
		display: flex;
		align-items: center;
		gap: 8px;
		color: inherit;
	}
	.wc-badge-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		flex-shrink: 0;
	}
	.wc-name {
		font-size: 14px;
		font-weight: 600;
		flex: 1;
		min-width: 0;
	}
	.wc-head:hover .wc-name {
		color: var(--accent);
	}
	.wc-type {
		flex-shrink: 0;
	}
	.wc-balance {
		display: flex;
		align-items: baseline;
		gap: 6px;
		color: inherit;
	}
	.wc-btc {
		font-size: 26px;
	}
	.wc-unit {
		font-size: 12px;
		color: var(--text-muted);
	}
	.wc-spark {
		margin: 2px 0;
	}
	.wc-activity {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.wc-actions {
		display: flex;
		gap: 8px;
		margin-top: 6px;
		padding-top: 10px;
		border-top: 1px solid var(--border-subtle);
	}
	.wc-actions .btn {
		flex: 1;
		justify-content: center;
	}

	/* --- network (chain) --- */
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
		color: var(--text-muted);
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
	.block-link {
		font-weight: 500;
	}
</style>
