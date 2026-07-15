<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import RecentActivity from '$lib/components/portfolio/RecentActivity.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import BalanceHorizons from '$lib/components/portfolio/BalanceHorizons.svelte';
	import { formatSats, gatedFiatPrice } from '$lib/format';
	import { deriveHomeHealth, shouldShowRecentActivity, shouldShowWalletList } from '$lib/homeView';
	import { buildHorizonRows } from '$lib/horizonDelta';
	import type { PortfolioDetail } from '$lib/types';

	let { data } = $props();

	// Portfolio is stale-while-revalidate, mirroring the wallets list (cairn —
	// dashboard SWR): GET /api/portfolio is a synchronous read of the persisted
	// aggregate (never a live scan), so it paints instantly. On mount we read
	// that cached aggregate, then fire ONE coalesced POST /api/portfolio/refresh
	// (the same server-side pass the wallets list uses — most-stale-first,
	// capped at the pool size) and, on success, refetch the now-fresh aggregate.
	let portfolio = $state<PortfolioDetail | null>(null);
	let portfolioLoading = $state(false);
	let portfolioSyncing = $state(false);

	async function loadPortfolio() {
		const res = await fetch('/api/portfolio');
		if (!res.ok) return;
		const body = await res.json();
		portfolio = body?.portfolio ?? null;
	}

	async function refreshPortfolio() {
		if (portfolioSyncing) return;
		portfolioSyncing = true;
		try {
			const res = await fetch('/api/portfolio/refresh', { method: 'POST' });
			if (res.ok) await loadPortfolio();
		} catch {
			/* keep whatever is cached — the next mount/poll catches up */
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

	// --- hide-balance eye toggle — persisted, hero-scoped (spec §2.1: an
	//     inline eye affordance on the balance row, not a competing button). ---
	let hideBalance = $state(false);
	onMount(() => {
		hideBalance = localStorage.getItem('cairn.hideBalance') === '1';
	});
	function toggleHide() {
		hideBalance = !hideBalance;
		localStorage.setItem('cairn.hideBalance', hideBalance ? '1' : '0');
	}

	// --- optional fiat estimate (privacy-first: OFF by default, no price call
	//     until the user turns it on). The toggle itself lives in Settings →
	//     Display now (spec §2.1 "Fiat toggle → moves to Settings"); Home just
	//     reads the same `cairn.fiat` localStorage flag and honors it — same
	//     gated-fetch seam (cairn-vnfs), same key, so a preference set in
	//     Settings applies here without any migration. ---
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
	$effect(() => {
		if (showFiat && !priceTried) void fetchPrice();
	});
	// cairn-r7si: same gate feeds the hero AND the recent-activity feed below
	// it, so the privacy setting covers the whole Home page, not just the hero.
	const heroPrice = $derived(gatedFiatPrice(showFiat, usdPrice));

	function sendHref(s: { kind: string; id: number }): string {
		return s.kind === 'multisig' ? `/wallets/multisig/${s.id}/send` : `/wallets/${s.id}/send`;
	}

	// Hero pills: with exactly one wallet they go straight to it. With more
	// than one, a lightweight inline chooser lists every wallet so Send/Receive
	// stop detouring through the full /wallets list on every click
	// (cairn-5yz3.2) — the fallback href is kept as a no-JS/direct-link safety
	// net. Kept verbatim per the redesign spec (§2.1 "Stays prominent").
	const soloWallet = $derived(
		portfolio && portfolio.allocation.length === 1 ? portfolio.allocation[0] : null
	);
	const multiWallet = $derived(portfolio && portfolio.allocation.length > 1);
	const sendTarget = $derived(soloWallet ? sendHref(soloWallet) : '/wallets');
	const receiveTarget = $derived(soloWallet ? soloWallet.href : '/wallets');

	let openPicker = $state<'send' | 'receive' | null>(null);
	let heroActionsEl = $state<HTMLDivElement | null>(null);
	let walletPickerEl = $state<HTMLDivElement | null>(null);
	function togglePicker(kind: 'send' | 'receive') {
		openPicker = openPicker === kind ? null : kind;
	}
	function closePicker() {
		openPicker = null;
	}
	// Click-away: only wired while a picker is open, and only checks clicks
	// outside the hero-actions row (pills) or the picker panel below it.
	function onWindowClick(e: MouseEvent) {
		if (!openPicker) return;
		const target = e.target as Node;
		if (heroActionsEl?.contains(target)) return;
		if (walletPickerEl?.contains(target)) return;
		closePicker();
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (openPicker && e.key === 'Escape') closePicker();
	}

	// Zero-wallet State A only: the multi-panel welcome tour collapses into a
	// single "What Heartwood does ›" expander (spec §2.1) — no more persistent
	// dismiss-once localStorage flag, since it never shows again once a wallet
	// exists (the whole branch is unreachable at that point).
	let showWhatItDoes = $state(false);

	// --- Health line (spec §2.6b) — Phase 1 ships only the one calm line on
	//     Home; it reads the same two signals the layout's own banners already
	//     read: unbackedWallets (layout data, already threaded through
	//     page.data) and chain-health (polled the same way ChainHealthBanner
	//     does — a cheap in-memory last-known signal, no fresh probe). The
	//     full Health page (Node/Backups/Storage/Users) is Phase 3. ---
	let chainHealthy = $state(true);
	onMount(() => {
		let done = false;
		async function poll() {
			if (done) return;
			try {
				const res = await fetch('/api/chain-health', { cache: 'no-store' });
				if (res.ok) {
					const body = await res.json();
					chainHealthy = body?.healthy !== false;
				}
			} catch {
				/* a missed poll is fine; keep the last-known state */
			}
		}
		void poll();
		const timer = setInterval(poll, 15_000);
		return () => {
			done = true;
			clearInterval(timer);
		};
	});
	const unbackedCount = $derived(page.data.unbackedWallets?.length ?? 0);
	const health = $derived(deriveHomeHealth({ unbackedCount, chainHealthy }));

	const showWalletList = $derived(portfolio ? shouldShowWalletList(portfolio.walletCount) : false);
	const showRecentActivity = $derived(
		portfolio ? shouldShowRecentActivity(portfolio.recentActivity.length) : false
	);
	// Empty-but-has-wallet (spec §2.1): a truly zero balance with no history
	// yet gets a nudge toward Receive instead of an omitted/empty RECENT
	// section — the first thing a brand-new funded-or-not wallet needs.
	const isEmptyWallet = $derived(
		portfolio !== null &&
			portfolio.confirmed === 0 &&
			portfolio.unconfirmed === 0 &&
			portfolio.recentActivity.length === 0
	);

	// Multi-horizon balance delta (DESIGN-MANIFESTO.md MUST — cairn-d326, R6):
	// 1d / 30d / 1yr / all-time shown together, never a single naked delta.
	// Suppressed while the balance itself is hidden — a delta figure leaks
	// wealth-change magnitude even with the total masked, which defeats the
	// point of the privacy gesture (F1: fewer evaluation events, hidden or not).
	// Not rendered for a zero-balance wallet — there is nothing to have changed.
	const horizonRows = $derived(
		portfolio && !isEmptyWallet ? buildHorizonRows(portfolio.change, portfolio.confirmed) : null
	);
</script>

<svelte:head>
	<title>Home — Heartwood</title>
</svelte:head>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="home">
	<GroveField volume="present" />
	<div class="home-body">
		{#if !data.hasWallets && !portfolio}
			<!-- ============================================== ZERO-WALLET STATE A -->
			<section class="zero-state fade-in">
				<HeartwoodMark size={40} detail="simple" />
				<h1 class="zero-title">Welcome to Heartwood</h1>
				<p class="zero-copy">Your keys, your node, your bitcoin.</p>
				<a href="/wallets/new" class="btn btn-primary pill-lg">
					<Icon name="plus" size={15} /> Add your first wallet
				</a>

				<div class="what-it-does">
					<button
						type="button"
						class="what-it-does-toggle"
						aria-expanded={showWhatItDoes}
						onclick={() => (showWhatItDoes = !showWhatItDoes)}
					>
						New to this? What Heartwood does
						<Icon name="chevron-right" size={13} />
					</button>
					{#if showWhatItDoes}
						<div class="what-it-does-items fade-in">
							<a href="/wallets" class="wid-item">
								<Icon name="wallet" size={18} />
								<span class="wid-title">Wallets</span>
								<span class="wid-desc">
									Import a single-key or multisig wallet to watch balances and spend. Keys never
									leave your devices.
								</span>
							</a>
							<!-- An Explorer/Mempool tile would be a dead link once the explorer
							     feature flag is off (server-side requireFeature 403s
							     /explorer/**, matching the nav's own flags.explorer !== false
							     hide hook) — never advertise a destination the newcomer can't
							     reach. -->
							{#if data.flags?.explorer !== false}
								<a href="/explorer" class="wid-item">
									<Icon name="blocks" size={18} />
									<span class="wid-title">Explorer</span>
									<span class="wid-desc">
										Browse blocks, transactions, and addresses — every technical term explains
										itself.
									</span>
								</a>
								<a href="/explorer/mempool" class="wid-item">
									<Icon name="zap" size={18} />
									<span class="wid-title">Mempool</span>
									<span class="wid-desc">
										See what's waiting to confirm and what a transaction costs right now.
									</span>
								</a>
							{/if}
						</div>
					{/if}
				</div>
			</section>
		{:else}
			<!-- ========================================= FUNDED / HAS-WALLET STATE B -->
			<header class="hero fade-in">
				<div class="hero-eyebrow">
					<span class="hero-label">Total balance</span>
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
						{#if portfolio.unconfirmed !== 0}
							<div class="hero-sub">
								<span class="pending-note tabular">
									{portfolio.unconfirmed > 0 ? '+' : ''}{formatSats(portfolio.unconfirmed)} sats pending
								</span>
							</div>
						{/if}
						{#if horizonRows}
							<div class="hero-horizons">
								<BalanceHorizons rows={horizonRows} />
							</div>
						{/if}
					{/if}
				{/if}

				<div class="hero-actions" bind:this={heroActionsEl}>
					{#if multiWallet}
						<button
							type="button"
							class="btn btn-primary pill-lg"
							aria-haspopup="menu"
							aria-expanded={openPicker === 'send'}
							onclick={() => togglePicker('send')}
						>
							<Icon name="arrow-up-right" size={16} /> Send
						</button>
						<button
							type="button"
							class="btn btn-secondary pill-lg"
							aria-haspopup="menu"
							aria-expanded={openPicker === 'receive'}
							onclick={() => togglePicker('receive')}
						>
							<Icon name="arrow-down-left" size={16} /> Receive
						</button>
					{:else}
						<a href={sendTarget} class="btn btn-primary pill-lg">
							<Icon name="arrow-up-right" size={16} /> Send
						</a>
						<a href={receiveTarget} class="btn btn-secondary pill-lg">
							<Icon name="arrow-down-left" size={16} /> Receive
						</a>
					{/if}
				</div>

				{#if multiWallet && openPicker && portfolio}
					<!-- Lightweight wallet chooser (cairn-5yz3.2) — replaces the old
					     dumped-to-/wallets detour for 2+ wallet accounts. Rendered
					     in-flow (not absolutely positioned) so it pushes content below
					     it down instead of overlapping it (cairn-pnps). -->
					<div
						class="wallet-picker fade-in"
						role="menu"
						aria-label="Choose a wallet"
						bind:this={walletPickerEl}
					>
						{#each portfolio.allocation as w (w.key)}
							<a
								href={openPicker === 'send' ? sendHref(w) : w.href}
								class="wallet-picker-row"
								role="menuitem"
								onclick={closePicker}
							>
								<span class="wallet-picker-name" title={w.name}>{w.name}</span>
								<Amount sats={w.balance} size="row" price={heroPrice} />
							</a>
						{/each}
					</div>
				{/if}
			</header>

			<!-- ==================================================== HEALTH LINE -->
			<div class="health-line">
				<span class="health-dot" class:ok={health.ok} class:amber={!health.ok}></span>
				<span class="health-label">{health.label}</span>
				<a href="/admin" class="health-details">Details <Icon name="chevron-right" size={12} /></a>
			</div>

			{#if portfolio}
				{#if showWalletList}
					<!-- ============================================ YOUR WALLETS (2+ only) -->
					<section class="wallet-list-section">
						<span class="section-eyebrow">Your wallets</span>
						<ul class="wallet-list">
							{#each portfolio.allocation as w (w.key)}
								<li>
									<a href={w.href} class="wallet-row">
										<span class="wallet-row-name" title={w.name}>{w.name}</span>
										<Amount sats={w.balance} size="row" price={heroPrice} />
										<Icon name="chevron-right" size={14} />
									</a>
								</li>
							{/each}
						</ul>
						<a href="/wallets/new" class="add-wallet-link">
							<Icon name="plus" size={12} /> Add wallet
						</a>
					</section>
				{/if}

				{#if isEmptyWallet}
					<!-- ==================================================== EMPTY NUDGE -->
					<section class="empty-nudge-section">
						<a href={receiveTarget} class="empty-nudge">
							Your wallet is empty. Tap Receive to get your first bitcoin.
							<Icon name="chevron-right" size={13} />
						</a>
					</section>
				{:else if showRecentActivity}
					<!-- ======================================================== RECENT -->
					<section class="recent-section">
						<div class="section-head">
							<span class="section-eyebrow">Recent</span>
							<a href="/activity" class="see-all">
								All activity <Icon name="arrow-right" size={13} />
							</a>
						</div>
						<RecentActivity items={portfolio.recentActivity} price={heroPrice} />
					</section>
				{/if}
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

	/* --- zero-wallet state A (spec §2.1): ring mark, headline, one button,
	   a collapsed explainer — nothing else. --- */
	.zero-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 96px 32px 32px;
		text-align: center;
		max-width: 480px;
		margin: 0 auto;
	}

	.zero-title {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
		margin-top: 6px;
	}

	.zero-copy {
		color: var(--text-secondary);
		font-size: 14px;
		margin-bottom: 6px;
	}

	.what-it-does {
		margin-top: 22px;
	}

	.what-it-does-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: none;
		border: none;
		font: inherit;
		font-size: 13px;
		color: var(--text-muted);
		cursor: pointer;
	}

	.what-it-does-toggle:hover {
		color: var(--accent);
	}

	.what-it-does-items {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 22px;
		margin-top: 22px;
		text-align: left;
	}

	.wid-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		color: var(--accent);
	}

	.wid-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-rows);
	}

	.wid-item:hover .wid-title {
		color: var(--accent-bright);
	}

	.wid-desc {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	/* --- hero --- */
	.hero {
		display: flex;
		flex-direction: column;
		padding-top: 48px;
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

	/* Matches Amount.svelte's own .size-hero clamp exactly (DESIGN-MANIFESTO.md
	   §3/§4 — this class only renders the skeleton and hide-balance glyph, so
	   it must sit at the same size as the real value it stands in for or
	   swapping between them reflows the hero. */
	.hero-amount {
		font-size: clamp(40px, 6.5vw, 72px);
		line-height: 0.95;
		letter-spacing: -0.015em;
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
		margin-top: 10px;
		font-size: 13px;
		color: var(--text-secondary);
	}

	.hidden-note {
		color: var(--text-muted);
	}

	/* Multi-horizon delta row (cairn-d326, R6) — quiet, beneath the hero, above
	   the Send/Receive pills; never a lone delta (DESIGN-MANIFESTO.md MUST). */
	.hero-horizons {
		margin-top: 18px;
	}

	.pending-note {
		font-size: 12.5px;
		color: var(--attention);
	}

	/* --- action pills (52px, radius 26) --- */
	.hero-actions {
		position: relative;
		display: flex;
		gap: 12px;
		margin-top: 32px;
	}

	.pill-lg {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
	}

	/* Multi-wallet Send/Receive chooser (cairn-5yz3.2) — a quiet inline panel
	   anchored under the pills, not a full-screen modal. Renders in normal
	   document flow (cairn-pnps) — no `position: absolute`, so opening it
	   pushes content below it down instead of floating over it. */
	.wallet-picker {
		align-self: flex-start;
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 240px;
		max-width: 320px;
		margin-top: 8px;
		padding: 6px;
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-control);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
	}

	.wallet-picker-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 10px;
		border-radius: calc(var(--radius-control) - 4px);
		color: inherit;
		font-size: 13px;
	}

	.wallet-picker-row:hover {
		background: var(--surface);
	}

	.wallet-picker-row :global(.hw-amount) {
		flex-shrink: 0;
	}

	.wallet-picker-name {
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* --- health line (spec §2.6b) --- */
	.health-line {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 32px;
		padding-bottom: 24px;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.health-dot {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.health-dot.ok {
		background: var(--sage);
	}

	.health-dot.amber {
		background: var(--attention);
	}

	.health-label {
		flex: 1;
		min-width: 0;
		color: var(--text-secondary);
	}

	.health-details {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 12.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.health-details:hover {
		color: var(--accent);
	}

	/* --- your wallets (2+ only) --- */
	.wallet-list-section {
		margin-top: 32px;
		padding-bottom: 24px;
		border-bottom: 1px solid var(--hairline);
	}

	.section-eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.wallet-list {
		list-style: none;
		margin: 14px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.wallet-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 0;
		color: inherit;
		border-bottom: 1px solid var(--hairline);
	}

	.wallet-list li:last-child .wallet-row {
		border-bottom: none;
	}

	.wallet-row:hover .wallet-row-name {
		color: var(--accent);
	}

	.wallet-row-name {
		flex: 1;
		min-width: 0;
		font-size: 14px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-rows);
	}

	.wallet-row :global(.hw-amount) {
		flex-shrink: 0;
	}

	.wallet-row :global(svg) {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.add-wallet-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 10px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.add-wallet-link:hover {
		color: var(--accent);
	}

	/* --- empty-wallet nudge --- */
	.empty-nudge-section {
		margin-top: 32px;
	}

	.empty-nudge {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		color: var(--text-secondary);
	}

	.empty-nudge:hover {
		color: var(--accent);
	}

	/* --- recent activity --- */
	.recent-section {
		margin-top: 32px;
	}

	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--hairline);
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

	/* ================================================= mobile (≤900px) */
	@media (max-width: 900px) {
		.home {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		/* Touch-target batch (cairn-uxdev batch 2, item 3): the eye toggle keeps
		   its visual size, but gets an invisible ::after that extends the
		   actual hit area to the ~44px guideline. */
		.eye-btn::after {
			content: '';
			position: absolute;
			inset: -9px;
		}

		.zero-state {
			padding: 56px 20px 24px;
		}

		.hero {
			align-items: center;
			text-align: center;
			padding-top: 10px;
		}

		.hero-amount-row {
			margin-top: 14px;
			gap: 8px;
		}

		.hero-amount {
			font-size: clamp(34px, 11vw, 48px);
			line-height: 1;
		}

		.hero-sub {
			justify-content: center;
			margin-top: 10px;
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

		.wallet-picker {
			align-self: stretch;
			min-width: 0;
			max-width: none;
		}

		.what-it-does-items {
			gap: 16px;
		}
	}
</style>
