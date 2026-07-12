<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import SyncIndicator from '$lib/components/heartwood/SyncIndicator.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';
	import { portfolioViewState } from '$lib/portfolioViewState';
	import { SCRIPT_TYPE_LABELS, walletTypeLabel, featureEnabled } from './labels';

	let { data } = $props();

	// Multisig is the app's differentiator (MULTISIG-UX-DESIGN M1) — visible
	// from both the populated wallets list and the empty-state chooser, mirroring
	// the flag handling already used by the single-sig wizard's hand-off card.
	const multisigCreateEnabled = $derived(featureEnabled(page.data.flags?.multisig_create));

	// Stale-while-revalidate (cairn-2zxt): the list renders instantly from
	// persisted snapshots read synchronously in load() — no Electrum on
	// navigation. `refresh()` now fires ONE coalesced /api/portfolio/refresh call
	// (server-side, most-stale-first, capped at the Electrum pool size) instead of
	// a POST per wallet/multisig — N parallel full scans used to monopolize the
	// pool and make the whole app unresponsive. Once it settles we re-invalidate
	// the loader to pick up the fresh snapshots.
	let syncing = $state(false);
	// Set only when the refresh FAILS with nothing cached to fall back on — drives
	// the explicit "couldn't reach the server" state (never a silently-zeroed
	// balance). Cleared on any successful refresh; ignored once we have a snapshot.
	let refreshError = $state(false);

	// One list, two flavors. Single-sig wallets and multisig wallets are merged
	// into a single hairline-row list (7a's wallet-rows grammar) — the row meta
	// tells them apart (script type + device kind vs. an m-of-n quorum). A wallet
	// with no snapshot yet is NOT "unreachable" — it just shows zeroed until its
	// first background refresh lands (errors stays empty in the cache-first path).
	const items = $derived.by(() => [
		...data.wallets.map((w) => ({
			kind: 'single' as const,
			id: w.id,
			href: `/wallets/${w.id}`,
			name: w.name,
			scriptType: w.scriptType,
			deviceType: w.deviceType,
			balance: w.balance,
			unconfirmed: w.unconfirmed,
			lastActivity: w.lastActivity,
			unreachable: data.errors[w.id] !== undefined,
			error: data.errors[w.id]
		})),
		...data.multisigs.map((m) => ({
			kind: 'multisig' as const,
			id: m.id,
			href: `/wallets/multisig/${m.id}`,
			name: m.name,
			threshold: m.threshold,
			totalKeys: m.totalKeys,
			balance: m.balance,
			unconfirmed: m.unconfirmed,
			lastActivity: m.lastActivity,
			// Collaborative custody: wallets shared WITH this user carry the owner's
			// name so the row can distinguish them from wallets they own outright.
			sharedBy: m.sharedBy,
			unreachable: data.multisigErrors[m.id] !== undefined,
			error: data.multisigErrors[m.id]
		}))
	]);

	// Three explicit states, never a silently-zeroed balance (cairn-2zxt): 'ready'
	// (a snapshot exists), 'first-sync' (never synced, refresh in flight / not yet
	// failed → skeleton), 'unreachable' (never synced AND refresh failed → retry).
	const viewState = $derived(
		portfolioViewState({ lastSyncedAt: data.lastSyncedAt, refreshFailed: refreshError })
	);
	// Skeleton only on a true cold first load: we have wallets but none has ever
	// synced and a refresh is in flight. A returning user (snapshots present) sees
	// cached rows instantly; a user with no wallets falls straight to the onboard.
	const loading = $derived(viewState === 'first-sync' && items.length > 0);
	// Cold start where the refresh failed with nothing to show: a retry banner in
	// place of a fake-zero portfolio.
	const unreachable = $derived(viewState === 'unreachable' && items.length > 0);

	const totalSats = $derived(
		items.filter((i) => !i.unreachable).reduce((sum, i) => sum + i.balance, 0)
	);

	/** Fire ONE coalesced portfolio refresh (server-side: most-stale-first, capped
	 *  at the pool size), then re-read the fresh list. Never throws. Surfaces the
	 *  'unreachable' state only when the pass failed AND we still have nothing
	 *  cached — a partial success sets lastSyncedAt and flips us to 'ready'. */
	async function refresh() {
		if (syncing) return;
		syncing = true;
		try {
			const res = await fetch('/api/portfolio/refresh', { method: 'POST' });
			if (!res.ok) {
				refreshError = data.lastSyncedAt === null;
				return;
			}
			const summary = (await res.json()) as {
				refreshed: number;
				skipped: number;
				failed: number;
				aborted: boolean;
			};
			await invalidate('cairn:wallets');
			refreshError =
				data.lastSyncedAt === null && (summary.aborted || summary.failed > 0);
		} catch {
			// Network error reaching our own endpoint — only an error state if we have
			// nothing cached to keep showing.
			refreshError = data.lastSyncedAt === null;
		} finally {
			syncing = false;
		}
	}

	onMount(() => {
		void refresh();
	});
</script>

<svelte:head>
	<title>Wallets — Heartwood</title>
</svelte:head>

<div class="wallets-page fade-in">
	<GroveField volume="present" />
	<div class="page-content">
		{#if data.loadError}
			<div class="load-error" role="alert">
				<Icon name="alert-triangle" size={15} />
				<span>Couldn't load your wallets: {data.loadError}</span>
			</div>
		{/if}

		{#if items.length === 0}
			<!-- ------------------------------------------- first-run onboard -->
			<!-- items are the wallet ROWS (present even before any sync), so an empty
			     list means genuinely no wallets — never a cold-sync placeholder. -->
			<section class="onboard fade-in">
				<div class="onboard-icon"><Icon name="wallet" size={26} /></div>
				<h2 class="onboard-title">Bring your first wallet</h2>
				<p class="onboard-copy">
					Heartwood only ever sees <em>public</em> keys — it tracks balances and history; you
					sign every spend on your own device.
				</p>
				<!-- Two co-equal choices (MULTISIG-UX-DESIGN 1b): a newcomer sees multisig as
				     a first-class option here, not a hidden upgrade discovered later. -->
				<div class="onboard-choices">
					<a href="/wallets/new" class="onboard-choice">
						<span class="onboard-choice-title">Add a wallet</span>
						<p class="onboard-choice-copy">
							Track one wallet from a single key or device. The quick way to start.
						</p>
						<span class="btn btn-primary onboard-choice-cta">
							<Icon name="plus" size={14} />
							Add wallet
						</span>
					</a>
					{#if multisigCreateEnabled}
						<a href="/wallets/multisig/new" class="onboard-choice onboard-choice-multisig">
							<span class="onboard-choice-title">
								<Icon name="shield" size={14} />
								Create a multisig wallet
							</span>
							<p class="onboard-choice-copy">
								Guard savings with several keys — the safest way to self-custody. New to it?
								We'll walk you through.
							</p>
							<span class="btn btn-primary onboard-choice-cta">
								Create multisig wallet
								<Icon name="arrow-right" size={14} />
							</span>
						</a>
					{:else}
						<div
							class="onboard-choice onboard-choice-multisig disabled"
							aria-disabled="true"
						>
							<span class="onboard-choice-title">
								<Icon name="shield" size={14} />
								Create a multisig wallet
							</span>
							<FeatureDisabled
								message="Creating multisig wallets has been disabled by your administrator."
							/>
						</div>
					{/if}
				</div>
				<a href="/wallets/new?restore=1" class="restore-link">
					<Icon name="arrow-down-left" size={14} />
					Restore from a backup
				</a>
			</section>
		{:else if unreachable}
			<!-- ------------------------------------------- cold start, refresh failed -->
			<!-- Never synced AND the refresh failed: show an explicit retry instead of
			     a silently-zeroed portfolio (cairn-2zxt three-state contract). -->
			<header class="head">
				<span class="head-eyebrow">Wallets</span>
				<div class="head-actions">
					<a href="/wallets/new" class="btn btn-primary head-pill">
						<Icon name="plus" size={15} />
						Add wallet
					</a>
				</div>
			</header>
			<section class="unreachable-state" role="alert">
				<div class="unreachable-icon"><Icon name="alert-triangle" size={24} /></div>
				<h2 class="unreachable-title">Couldn't reach the server</h2>
				<p class="unreachable-copy">
					Heartwood couldn't sync your balances with the Bitcoin network just now. Your wallets and
					their history are safe — this is only about fetching the latest balances.
				</p>
				<button type="button" class="btn btn-primary pill-lg" onclick={refresh} disabled={syncing}>
					{#if syncing}
						<span class="retry-spinner" aria-hidden="true"></span>
						Retrying…
					{:else}
						<Icon name="refresh" size={15} />
						Retry
					{/if}
				</button>
			</section>
		{:else}
			<!-- ------------------------------------------- eyebrow + hero -->
			<header class="head">
				<span class="head-eyebrow">Wallets</span>
				{#if loading}
					<div class="head-hero">
						<span class="hero-number head-btc skeleton">0.0000</span>
					</div>
					<p class="head-sub head-first-sync">Syncing with the network for the first time…</p>
				{:else}
					<div class="head-hero">
						<span class="hero-number head-btc" title="{formatSats(totalSats)} sats">
							{formatBtc(totalSats)}
						</span>
						<span class="head-unit">BTC</span>
					</div>
					<p class="head-sub">
						across {items.length} wallet{items.length === 1 ? '' : 's'}
					</p>
				{/if}
				<div class="head-actions">
					<a href="/wallets/new" class="btn btn-primary head-pill">
						<Icon name="plus" size={15} />
						Add wallet
					</a>
				</div>
				{#if !loading}
					<div class="head-sync">
						<SyncIndicator lastSyncedAt={data.lastSyncedAt} {syncing} />
					</div>
				{/if}
			</header>

			<!-- ------------------------------------------- multisig discoverability card -->
			<!-- Persistent invitation (MULTISIG-UX-DESIGN 1a): multisig stays visible even
			     for users who already have a single-sig wallet, since it's the app's
			     differentiator. Sits between the hero header and the wallet rows. -->
			<section class="multisig-card" class:disabled={!multisigCreateEnabled}>
				<div class="multisig-card-head">
					<span class="multisig-card-icon"><Icon name="shield" size={16} /></span>
					<span class="multisig-card-title">Create a multisig wallet</span>
				</div>
				<p class="multisig-card-copy">
					Guard your savings with several keys, so no single lost or stolen key can lose — or
					move — your bitcoin.
				</p>
				{#if multisigCreateEnabled}
					<div class="multisig-card-actions">
						<a href="/wallets/multisig/new" class="btn btn-primary multisig-card-cta">
							<Icon name="shield" size={14} />
							Create multisig wallet
						</a>
						<a href="/wallets/multisig/new" class="multisig-card-learn">
							New to multisig? <span class="underline">What is it?</span> ›
						</a>
					</div>
				{:else}
					<FeatureDisabled
						message="Creating multisig wallets has been disabled by your administrator."
					/>
				{/if}
			</section>

			<!-- ------------------------------------------- hairline wallet rows -->
			{#if loading}
				<div class="rows" aria-busy="true" aria-label="Loading wallets">
					{#each [0, 1, 2] as i (i)}
						<div class="wallet-row">
							<div class="row-main">
								<span class="row-name skeleton">Wallet name</span>
								<span class="row-meta skeleton">Wallet kind · type</span>
							</div>
							<div class="row-right">
								<span class="row-btc skeleton">0.0000</span>
								<span class="row-when skeleton">last activity</span>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="rows">
					{#each items as item (item.kind + '-' + item.id)}
						<a href={item.href} class="wallet-row">
							<div class="row-main">
								<span class="row-name">
									{#if item.kind === 'multisig'}
										<Icon name="shield" size={13} />
									{/if}
									<span class="row-name-text truncate">{item.name}</span>
								</span>
								<span class="row-meta">
									{#if item.kind === 'multisig'}
										{item.threshold} of {item.totalKeys} keys
										{#if item.sharedBy}
											· <span class="shared-by">shared by {item.sharedBy}</span>
										{/if}
									{:else}
										{walletTypeLabel(item.deviceType)} · {SCRIPT_TYPE_LABELS[item.scriptType]}
									{/if}
									{#if item.unreachable}
										· <span class="row-attention" title={item.error}>unreachable</span>
									{:else if item.unconfirmed !== 0}
										· <span class="row-attention tabular">
											{item.unconfirmed > 0 ? '+' : ''}{formatSats(item.unconfirmed)} sats pending
										</span>
									{/if}
								</span>
							</div>
							<div class="row-right">
								{#if item.unreachable}
									<span class="row-btc muted">—</span>
									<span class="row-when">check connection</span>
								{:else}
									<span class="row-btc tabular" title="{formatSats(item.balance)} sats">
										{formatBtc(item.balance)}
									</span>
									<span class="row-when">
										{#if item.lastActivity}
											{timeAgo(item.lastActivity)}
										{:else}
											no activity
										{/if}
									</span>
								{/if}
							</div>
						</a>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	/* Grove field needs a positioned ancestor; content floats above it. */
	.wallets-page {
		position: relative;
	}

	.page-content {
		position: relative;
		z-index: 1;
	}

	.load-error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px 0;
		margin-bottom: 16px;
		border-bottom: 1px solid var(--hairline);
		font-size: 13px;
		line-height: 1.5;
		color: var(--attention);
	}

	.load-error :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	/* --- first-sync + unreachable states (cairn-2zxt three-state contract) --- */

	.head-first-sync {
		color: var(--accent);
	}

	.unreachable-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 64px 32px;
		text-align: center;
		max-width: 480px;
		margin: 40px auto 0;
	}

	.unreachable-icon {
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--attention-muted, rgba(214, 138, 92, 0.12));
		color: var(--attention);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.unreachable-title {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
	}

	.unreachable-copy {
		color: var(--text-secondary);
		font-size: 13.5px;
		line-height: 1.65;
		max-width: 420px;
	}

	.retry-spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid currentColor;
		border-top-color: transparent;
		animation: retry-spin 0.7s linear infinite;
	}

	@keyframes retry-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.retry-spinner {
			animation: none;
		}
	}

	/* --- eyebrow + hero --- */

	.head {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}

	.head-eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.head-hero {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-top: 18px;
		min-width: 0;
		max-width: 100%;
	}

	.head-btc {
		font-size: clamp(44px, 7vw, 72px);
		line-height: 0.95;
		color: var(--text-hero);
	}

	.head-btc.skeleton {
		color: transparent;
	}

	.head-unit {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: clamp(20px, 3vw, 30px);
		color: var(--text-secondary);
	}

	.head-sub {
		margin-top: 14px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.head-actions {
		display: flex;
		gap: 12px;
		margin-top: 28px;
		align-self: stretch;
	}

	.head-sync {
		margin-top: 14px;
	}

	.head-pill {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
	}

	/* --- multisig discoverability card (MULTISIG-UX-DESIGN 1a) --- */

	.multisig-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 32px;
		padding: 18px 20px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--surface);
	}

	.multisig-card.disabled {
		opacity: 0.8;
	}

	.multisig-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.multisig-card-icon {
		display: inline-flex;
		color: var(--accent);
	}

	.multisig-card-title {
		font-family: var(--font-serif);
		font-size: 16px;
		font-weight: 600;
		color: var(--text-hero);
	}

	.multisig-card-copy {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		max-width: 560px;
	}

	.multisig-card-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		margin-top: 6px;
	}

	.multisig-card-cta {
		height: 40px;
		padding: 0 20px;
		font-size: 13.5px;
		font-weight: 600;
	}

	.multisig-card-learn {
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.multisig-card-learn .underline {
		color: var(--accent);
		text-decoration: underline;
	}

	.multisig-card-learn:hover {
		color: var(--accent);
	}

	/* --- hairline wallet rows (7a grammar) --- */

	.rows {
		display: flex;
		flex-direction: column;
		margin-top: 40px;
		border-top: 1px solid var(--hairline);
	}

	.wallet-row {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 2px;
		border-bottom: 1px solid var(--hairline);
		color: var(--text-rows);
		min-width: 0;
		transition: background 0.15s var(--ease);
	}

	.wallet-row:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.wallet-row:hover .row-name-text {
		color: var(--accent-bright);
	}

	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.row-name {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 15px;
		font-weight: 500;
		color: var(--text-rows);
		min-width: 0;
	}

	.row-name :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.row-name-text {
		transition: color 0.15s var(--ease);
	}

	.row-meta {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.shared-by {
		color: var(--accent);
	}

	.row-attention {
		color: var(--attention);
	}

	.row-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex-shrink: 0;
	}

	/* Balances in serif — numbers that matter. */
	.row-btc {
		font-family: var(--font-serif);
		font-size: 16.5px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text-rows);
		white-space: nowrap;
	}

	.row-btc.muted {
		color: var(--text-muted);
	}

	.row-when {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	/* --- onboarding empty state --- */

	.onboard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 72px 32px;
		text-align: center;
		max-width: 600px;
		margin: 40px auto 0;
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

	/* Two co-equal choices (MULTISIG-UX-DESIGN 1b). */
	.onboard-choices {
		display: grid;
		grid-template-columns: repeat(2, minmax(210px, 1fr));
		gap: 14px;
		width: 100%;
		max-width: 520px;
		margin-top: 6px;
	}

	.onboard-choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding: 18px 16px;
		text-align: left;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: inherit;
		transition: border-color 120ms var(--ease);
	}

	.onboard-choice:hover {
		border-color: var(--accent);
	}

	.onboard-choice.disabled {
		cursor: not-allowed;
	}

	.onboard-choice-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		font-weight: 600;
		color: var(--text-hero);
	}

	.onboard-choice-title :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.onboard-choice-copy {
		flex: 1;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.onboard-choice-cta {
		align-self: stretch;
		justify-content: center;
		height: 40px;
		padding: 0 16px;
		font-size: 13px;
		font-weight: 600;
	}

	.pill-lg {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
	}

	.restore-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.restore-link:hover {
		color: var(--accent);
	}

	.restore-link :global(svg) {
		flex-shrink: 0;
	}

	/* --- mobile (≤900px, tab page) --- */

	@media (max-width: 900px) {
		.head {
			align-items: center;
			text-align: center;
			margin-top: 10px;
		}

		.head-hero {
			margin-top: 14px;
			gap: 8px;
		}

		.head-btc {
			font-size: clamp(38px, 11vw, 48px);
			line-height: 1;
		}

		.head-unit {
			font-size: 19px;
		}

		.head-sub {
			margin-top: 12px;
			font-size: 12.5px;
		}

		.head-actions {
			width: 100%;
			margin-top: 24px;
		}

		.head-actions .head-pill {
			flex: 1;
			height: 48px;
			font-size: 14.5px;
		}

		.rows {
			margin-top: 30px;
		}

		.row-name {
			font-size: 13.5px;
		}

		.row-btc {
			font-size: 14px;
		}

		.multisig-card {
			margin-top: 24px;
			padding: 16px;
		}
	}

	/* Narrow screens: stack the onboard choice cards instead of squeezing two
	   columns (the method-grid uses the same 480px breakpoint). */
	@media (max-width: 480px) {
		.onboard-choices {
			grid-template-columns: 1fr;
		}
	}
</style>
