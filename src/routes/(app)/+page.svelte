<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { onNewBlock } from '$lib/liveBlocks';
	import { triggerChainRefresh } from '$lib/chainRefresh';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BalanceChart from '$lib/components/portfolio/BalanceChart.svelte';
	import AllocationBar from '$lib/components/portfolio/AllocationBar.svelte';
	import RecentActivity from '$lib/components/portfolio/RecentActivity.svelte';
	import Sparkline from '$lib/components/portfolio/Sparkline.svelte';
	import SyncIndicator from '$lib/components/heartwood/SyncIndicator.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { formatNumber, formatBtc, formatBytes, formatSats, timeAgo } from '$lib/format';
	import type { PortfolioDetail } from '$lib/types';

	let { data } = $props();

	// Stale-while-revalidate: the chain snapshot renders instantly from the
	// persisted SQLite data that load() read (data.chain); the client refreshes it
	// in the background (on mount + on every new block) and invalidate('cairn:chain')
	// re-runs load() to pick up the fresh snapshot. `chain` mirrors data.chain but
	// stays a mutable $state so a new-block SSE event can optimistically bump the
	// tip before the refetch lands. Seeded from data.chain and re-synced whenever
	// load() re-runs (the $effect below) — the initial-value capture is intended.
	// svelte-ignore state_referenced_locally
	let chain = $state(data.chain);
	$effect(() => {
		chain = data.chain;
	});

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

	// Live new-block updates refresh only the chain snapshot — the portfolio is
	// deliberately outside the invalidation path so wallets aren't rescanned on
	// every block.
	let lastSeenHeight: number | null = null;
	onMount(() =>
		onNewBlock((height) => {
			if (lastSeenHeight !== null && height <= lastSeenHeight) return;
			const first = lastSeenHeight === null;
			lastSeenHeight = height;
			if (chain !== null && chain.tipHeight !== null) {
				// SSE replays the current tip on connect — ignore what we already show.
				if (height <= chain.tipHeight) return;
				// Optimistic tip (cairn-9vav): paint the new height immediately from
				// the SSE payload; the full snapshot (blocks/mempool/fees) refreshes in
				// the background via the forced refresh below.
				chain = { ...chain, tipHeight: height, tipTime: Math.floor(Date.now() / 1000) };
				void refresh(true);
			} else if (!first) {
				// No snapshot yet — a new block is a good moment to retry, but the very
				// first replay-on-connect isn't (mount already kicked a refresh).
				void refresh(true);
			}
		})
	);

	// Portfolio is stale-while-revalidate, mirroring the wallets list (cairn —
	// dashboard SWR): GET /api/portfolio is now a synchronous read of the persisted
	// aggregate (never a live scan), so it paints instantly. On mount we read that
	// cached aggregate, then fire ONE coalesced POST /api/portfolio/refresh (the
	// same server-side pass the wallets list uses — most-stale-first, capped at the
	// pool size) and, on success, refetch the now-fresh aggregate. A SyncIndicator
	// shows the freshness, consistent with the rest of the app.
	let portfolio = $state<PortfolioDetail | null>(null);
	let portfolioSyncedAt = $state<number | null>(null);
	let portfolioLoading = $state(false);
	let portfolioSyncing = $state(false);

	async function loadPortfolio() {
		const res = await fetch('/api/portfolio');
		if (!res.ok) return;
		const body = await res.json();
		portfolio = body?.portfolio ?? null;
		portfolioSyncedAt = body?.lastSyncedAt ?? null;
	}

	async function refreshPortfolio() {
		if (portfolioSyncing) return;
		portfolioSyncing = true;
		try {
			const res = await fetch('/api/portfolio/refresh', { method: 'POST' });
			if (res.ok) await loadPortfolio();
		} catch {
			/* keep whatever is cached — the indicator just stays stale */
		} finally {
			portfolioSyncing = false;
		}
	}

	onMount(() => {
		if (!data.hasWallets) return;
		portfolioLoading = true;
		void loadPortfolio()
			.catch(() => {})
			.finally(() => {
				portfolioLoading = false;
				void refreshPortfolio();
			});
	});

	// --- hide-balance eye toggle (7a) — persisted, hero-scoped ---
	let hideBalance = $state(false);
	onMount(() => {
		hideBalance = localStorage.getItem('cairn.hideBalance') === '1';
	});
	function toggleHide() {
		hideBalance = !hideBalance;
		localStorage.setItem('cairn.hideBalance', hideBalance ? '1' : '0');
	}

	// --- optional fiat estimate (privacy-first: OFF by default, no price call
	//     until the user turns it on). Reuses the Amount component + format.ts
	//     fiat helpers (bead cairn-vnfs seam), but keeps its own gated fetch
	//     rather than the shared auto-refreshing $lib/price store — that store
	//     starts fetching as soon as any component references it, which would
	//     defeat the "no price call until opt-in" privacy contract here. ---
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
	const heroPrice = $derived(showFiat ? usdPrice : null);

	// Today's change (sage ▲ chip in the hero sub-line, 7a). Down is calm
	// amber, never red.
	const todayDelta = $derived.by(() => {
		if (!portfolio || portfolio.change.d1 === null || portfolio.change.d1 === 0) return null;
		const sats = portfolio.change.d1;
		const base = portfolio.confirmed - sats;
		const pct = base > 0 ? (sats / base) * 100 : null;
		return { sats, pct, up: sats > 0 };
	});

	const unreachable = $derived(portfolio ? portfolio.walletCount - portfolio.scannedCount : 0);

	function sendHref(s: { kind: string; id: number }): string {
		return s.kind === 'multisig' ? `/wallets/multisig/${s.id}/send` : `/wallets/${s.id}/send`;
	}

	// Hero pills: with exactly one wallet they go straight to it; otherwise to
	// the wallet list (there is no cross-wallet send/receive flow).
	const soloWallet = $derived(
		portfolio && portfolio.allocation.length === 1 ? portfolio.allocation[0] : null
	);
	const sendTarget = $derived(soloWallet ? sendHref(soloWallet) : '/wallets');
	const receiveTarget = $derived(soloWallet ? soloWallet.href : '/wallets');

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

	// Next-block footer: 3-segment mempool bar — the share that fits the next
	// ring (bright copper), the ~2 rings behind it (dim), and the long tail
	// (dimmest). Track shows remaining headroom up to a 4-ring display cap.
	const mempoolSegs = $derived.by(() => {
		const v = chain?.mempool?.vsize ?? 0;
		if (v <= 0) return null;
		const BLOCK = 1_000_000; // ~1M vB per block
		const s1 = Math.min(v, BLOCK);
		const s2 = Math.min(Math.max(v - BLOCK, 0), 2 * BLOCK);
		const s3 = Math.max(v - 3 * BLOCK, 0);
		const cap = Math.max(v, 4 * BLOCK);
		return {
			widths: [(s1 / cap) * 100, (s2 / cap) * 100, (s3 / cap) * 100],
			blocks: Math.max(1, Math.ceil(v / BLOCK))
		};
	});

	const sparkPoints = $derived(portfolio ? portfolio.balanceSeries.map((p) => p.sats) : []);
</script>

<svelte:head>
	<title>Home — Heartwood</title>
</svelte:head>

<div class="home">
	<GroveField volume="present" />
	<div class="home-body">
		{#if showTour}
			<section class="tour fade-in">
				<div class="tour-head">
					<span class="tour-title">Welcome to Heartwood</span>
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
					<!-- UX Wave A: an Explorer/Mempool tour tile would be a dead link once
					     the explorer feature flag is off (server-side requireFeature 403s
					     /explorer/**, matching the nav's own flags.explorer !== false hide
					     hook) — never advertise a destination the newcomer can't reach. -->
					{#if data.flags?.explorer !== false}
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
					{/if}
				</div>
			</section>
		{/if}

		{#if !data.hasWallets && !portfolio}
			<!-- ============================================== FIRST-RUN ONBOARD -->
			<section class="onboard fade-in">
				<div class="onboard-icon"><Icon name="wallet" size={26} /></div>
				<h2 class="onboard-title">Your bitcoin, at a glance</h2>
				<p class="onboard-copy">
					Add a wallet and Heartwood shows your total balance, history, and allocation here — all
					from your <em>public</em> keys. Nothing here can move your bitcoin; you sign every spend
					on your own device.
				</p>
				<a href="/wallets/new" class="btn btn-primary pill-lg">
					<Icon name="plus" size={15} /> Add your first wallet
				</a>
			</section>
		{:else}
			<!-- ======================================================== HERO -->
			<header class="hero fade-in">
				<div class="hero-eyebrow">
					<span class="hero-label">
						<Term
							tip="Everything across the wallets you've imported into Heartwood — single-key and multisig. Heartwood only holds your public keys; your keys stay on your devices."
						>
							Total balance
						</Term>
					</span>
					<button
						type="button"
						class="eye-btn"
						onclick={toggleHide}
						aria-pressed={hideBalance}
						aria-label={hideBalance ? 'Show balance' : 'Hide balance'}
						title={hideBalance ? 'Show balance' : 'Hide balance'}
					>
						{#if hideBalance}
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path
									d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61M2 2l20 20"
								/>
							</svg>
						{:else}
							<Icon name="eye" size={15} />
						{/if}
					</button>
				</div>

				{#if (portfolioLoading || portfolioSyncing) && !portfolio}
					<div class="hero-amount-row">
						<span class="hero-number hero-amount skeleton">0.0000</span>
					</div>
				{:else if portfolio}
					{#if hideBalance}
						<div class="hero-amount-row">
							<span class="hero-number hero-amount hero-hidden">•.••</span>
						</div>
						<div class="hero-sub"><span class="hidden-note">balance hidden</span></div>
					{:else}
						<div class="hero-amount-row">
							<Amount sats={portfolio.confirmed} size="hero" price={heroPrice} />
						</div>
						<div class="hero-sub">
							<span class="tabular">{formatSats(portfolio.confirmed)} sats</span>
							<button
								type="button"
								class="fiat-toggle"
								onclick={toggleFiat}
								title="Show or hide a fiat estimate (off by default — no price is fetched until you turn it on)"
							>
								{showFiat ? 'hide fiat' : 'show fiat'}
							</button>
							{#if todayDelta}
								<span class="today-chip" class:up={todayDelta.up} class:down={!todayDelta.up}>
									{todayDelta.up ? '▲' : '▼'}
									{#if todayDelta.pct !== null}
										{Math.abs(todayDelta.pct) < 0.05
											? '<0.1'
											: Math.abs(todayDelta.pct).toFixed(1)}% today
									{:else}
										{formatBtc(Math.abs(todayDelta.sats))} BTC today
									{/if}
								</span>
							{/if}
							{#if portfolio.unconfirmed !== 0}
								<span class="pending-note tabular">
									{portfolio.unconfirmed > 0 ? '+' : ''}{formatSats(portfolio.unconfirmed)} sats pending
								</span>
							{/if}
						</div>
					{/if}
				{/if}

				<div class="hero-actions">
					<a href={sendTarget} class="btn btn-primary pill-lg">
						<Icon name="arrow-up-right" size={16} /> Send
					</a>
					<a href={receiveTarget} class="btn btn-secondary pill-lg">
						<Icon name="arrow-down-left" size={16} /> Receive
					</a>
				</div>

				{#if portfolio || portfolioSyncing}
					<div class="hero-sync">
						<SyncIndicator lastSyncedAt={portfolioSyncedAt} syncing={portfolioSyncing} />
					</div>
				{/if}
			</header>

			{#if portfolio}
				<!-- ================================================== THE CHART -->
				<section class="chart-zone fade-in">
					<div class="chart-desktop">
						<BalanceChart series={portfolio.balanceSeries} />
					</div>
					{#if sparkPoints.length > 1}
						<div class="chart-mobile">
							<Sparkline points={sparkPoints} stretch height={96} strokeWidth={2} />
							<div class="spark-caption">balance · full history</div>
						</div>
					{/if}
				</section>

				<!-- ============================================ ACTIVITY | WALLETS -->
				<div class="home-grid">
					<section class="col">
						<div class="col-head">
							<span class="col-title">Activity</span>
							<a href="/activity" class="see-all">
								All activity <Icon name="arrow-right" size={13} />
							</a>
						</div>
						<RecentActivity items={portfolio.recentActivity} />
					</section>

					<section class="col">
						<div class="col-head">
							<span class="col-title">
								Wallets · {portfolio.walletCount}
								{#if unreachable > 0}
									<span class="unreachable">· {unreachable} unreachable</span>
								{/if}
							</span>
							<div class="col-head-actions">
								<a href="/wallets/new" class="add-wallet-link">
									<Icon name="plus" size={12} /> Add wallet
								</a>
								<a href="/wallets" class="see-all">All <Icon name="arrow-right" size={13} /></a>
							</div>
						</div>
						<AllocationBar slices={portfolio.allocation} total={portfolio.confirmed} />

						<!-- next-block footer (UX Wave A: block-explorer furniture — mempool
						     depth, next-block fee estimate, "ring" wording — demoted off the
						     newcomer's default surface behind the same flags.explorer hook the
						     nav already uses. Power users / existing installs with the
						     explorer flag on see it exactly as before.) -->
						{#if data.flags?.explorer !== false}
							<div class="next-block">
								<div class="nb-head">
									<span class="nb-label">Latest block</span>
									{#if chain !== null && chain.tipHeight !== null}
										<a href="/explorer/block/{chain.tipHeight}" class="nb-tip tabular">
											{formatNumber(chain.tipHeight)} · {timeAgo(chain.tipTime)}
										</a>
									{:else if chain === null && !syncFailed}
										<span class="nb-tip skeleton">000,000 · just now</span>
									{/if}
								</div>
								{#if chain === null && !syncFailed}
									<div class="nb-fee skeleton">next ring ≈ 00 sat/vB</div>
								{:else if chain === null && syncFailed}
									<div class="nb-error">
										Can't reach chain data sources — check the connection in Admin → Settings.
									</div>
								{:else if chain !== null}
									{#if chain.fees}
										<div class="nb-fee">
											next ring ≈ <span class="nb-fee-num tabular"
												>{Math.round(chain.fees.fastest)}</span
											> sat/vB
										</div>
									{/if}
									{#if mempoolSegs}
										<div
											class="mempool-bar"
											role="img"
											aria-label="Mempool depth: about {mempoolSegs.blocks} blocks of transactions waiting"
										>
											<span class="seg s1" style="width: {mempoolSegs.widths[0]}%"></span>
											<span class="seg s2" style="width: {mempoolSegs.widths[1]}%"></span>
											<span class="seg s3" style="width: {mempoolSegs.widths[2]}%"></span>
										</div>
										<div class="nb-caption">
											{formatBytes(chain.mempool?.vsize ?? 0)} waiting · ~{mempoolSegs.blocks}
											block{mempoolSegs.blocks === 1 ? '' : 's'}
										</div>
									{:else if chain.mempool}
										<div class="nb-caption">mempool is clear</div>
									{/if}
								{/if}
								{#if syncLabel}
									<div class="sync-status" class:updating={syncing}>{syncLabel}</div>
								{/if}
							</div>
						{/if}
					</section>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	/* The grove field bleeds to the content-column edges (negative margins undo
	   the shell's <main> padding), content floats above it. */
	.home {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.home-body {
		position: relative;
		z-index: 1;
	}

	/* --- welcome tour (hairline grammar, no card) --- */
	.tour {
		margin-bottom: 36px;
		padding-bottom: 22px;
		border-bottom: 1px solid var(--hairline);
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
		color: var(--text-hero);
	}

	.tour-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: none;
		border: none;
		border-radius: var(--radius-icon-btn);
		color: var(--text-muted);
		cursor: pointer;
	}

	.tour-close:hover {
		color: var(--text);
		background: var(--bg-input);
	}

	.tour-items {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 22px;
	}

	.tour-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		color: var(--accent);
	}

	.tour-item-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-rows);
	}

	.tour-item:hover .tour-item-title {
		color: var(--accent-bright);
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
		padding: 72px 32px;
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
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
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

	/* --- hero --- */
	.hero {
		display: flex;
		flex-direction: column;
	}

	.hero-eyebrow {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.hero-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.hero-label :global(.term) {
		text-transform: inherit;
		letter-spacing: inherit;
	}

	.eye-btn {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: none;
		border: none;
		border-radius: var(--radius-icon-btn);
		color: var(--text-faint);
		cursor: pointer;
		transition: color 120ms var(--ease);
	}

	.eye-btn:hover {
		color: var(--text-secondary);
	}

	.hero-amount-row {
		display: flex;
		align-items: baseline;
		gap: 14px;
		margin-top: 18px;
	}

	.hero-amount {
		font-size: 86px;
		line-height: 0.92;
		color: var(--text-hero);
	}

	.hero-amount.skeleton {
		color: transparent;
	}

	.hero-hidden {
		color: var(--text-faint);
	}

	.hero-sub {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 16px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hidden-note {
		color: var(--text-muted);
	}

	.fiat-toggle {
		position: relative;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--text-faint);
		cursor: pointer;
	}

	.fiat-toggle:hover {
		color: var(--accent);
	}

	.today-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.today-chip.up {
		color: var(--sage);
	}

	.today-chip.down {
		color: var(--attention);
	}

	.pending-note {
		font-size: 12.5px;
		color: var(--attention);
	}

	/* --- action pills (52px, radius 26) --- */
	.hero-actions {
		display: flex;
		gap: 12px;
		margin-top: 30px;
	}

	.pill-lg {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
	}

	/* SWR freshness for the portfolio aggregate — same quiet indicator the wallets
	   list uses, so the dashboard reads as consistent. */
	.hero-sync {
		margin-top: 16px;
	}

	/* --- chart --- */
	.chart-zone {
		margin-top: 44px;
	}

	.chart-mobile {
		display: none;
	}

	.spark-caption {
		font-size: 10.5px;
		color: var(--eyebrow-path);
		padding: 6px 18px 0;
	}

	/* --- activity | wallets grid --- */
	.home-grid {
		display: grid;
		grid-template-columns: 1.5fr 1fr;
		gap: 64px;
		margin-top: 46px;
		align-items: start;
	}

	.home-grid .col {
		min-width: 0;
	}

	.col-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--hairline);
	}

	.col-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text-hero);
		letter-spacing: -0.01em;
	}

	.unreachable {
		font-size: 12px;
		font-weight: 500;
		color: var(--attention);
	}

	.see-all {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.see-all:hover {
		color: var(--accent);
	}

	.col-head-actions {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.add-wallet-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.add-wallet-link:hover {
		color: var(--accent);
	}

	/* --- next-block footer --- */
	.next-block {
		margin-top: 26px;
		padding-top: 16px;
		border-top: 1px solid var(--hairline);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.nb-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.nb-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.nb-tip {
		font-size: 12px;
		color: var(--text-muted);
	}

	.nb-tip:hover {
		color: var(--accent);
	}

	.nb-fee {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.nb-fee-num {
		font-family: var(--font-serif);
		font-size: 17px;
		font-weight: 600;
		color: var(--text-rows);
	}

	.nb-error {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--attention);
	}

	.mempool-bar {
		display: flex;
		width: 100%;
		height: 6px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--bg-input);
	}

	.seg {
		display: block;
		height: 100%;
	}

	.seg.s1 {
		background: var(--accent);
	}

	.seg.s2 {
		background: var(--accent-dim);
	}

	.seg.s3 {
		background: var(--accent-dim-2);
	}

	.nb-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
	}

	/* SWR freshness indicator: muted when idle, copper while a refresh is in flight. */
	.sync-status {
		font-size: 11px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.sync-status.updating {
		color: var(--accent);
	}

	/* ================================================= mobile (8a, ≤900px) */
	@media (max-width: 900px) {
		.home {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		/* Touch-target batch (cairn-uxdev batch 2, item 3): both toggles keep
		   their visual size, but get an invisible ::after that extends the
		   actual hit area to the ~44px guideline. */
		.eye-btn::after,
		.fiat-toggle::after {
			content: '';
			position: absolute;
			inset: -9px;
		}

		.hero {
			align-items: center;
			text-align: center;
			margin-top: 10px;
		}

		.hero-amount-row {
			margin-top: 14px;
			gap: 8px;
		}

		.hero-amount {
			font-size: 48px;
			line-height: 1;
		}

		.hero-sub {
			justify-content: center;
			margin-top: 12px;
			font-size: 12.5px;
			gap: 10px;
		}

		.hero-actions {
			width: 100%;
			margin-top: 24px;
		}

		.hero-actions .pill-lg {
			flex: 1;
			height: 48px;
			font-size: 14.5px;
		}

		/* Edge-to-edge sparkline replaces the full chart. */
		.chart-zone {
			margin-top: 30px;
		}

		.chart-desktop {
			display: none;
		}

		.chart-mobile {
			display: block;
			margin: 0 -18px;
		}

		.home-grid {
			grid-template-columns: 1fr;
			gap: 34px;
			margin-top: 34px;
		}

		.col-title {
			font-size: 14.5px;
		}

		.tour-items {
			gap: 16px;
		}
	}
</style>
