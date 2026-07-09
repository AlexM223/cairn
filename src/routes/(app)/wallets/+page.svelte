<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import SyncIndicator from '$lib/components/heartwood/SyncIndicator.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';
	import { SCRIPT_TYPE_LABELS, walletTypeLabel } from './labels';

	let { data } = $props();

	// Stale-while-revalidate (cairn-2zxt): the list renders instantly from
	// persisted snapshots read synchronously in load() — no Electrum on
	// navigation. `refresh()` fires each wallet's /refresh endpoint in parallel and,
	// once they settle, re-invalidates the loader to pick up the fresh snapshots.
	let syncing = $state(false);
	const hasSynced = $derived(data.lastSyncedAt !== null);

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

	// Skeleton only on a true cold first load: we have wallets but none has ever
	// synced and a refresh is in flight. A returning user (snapshots present) sees
	// cached rows instantly; a user with no wallets falls straight to the onboard.
	const loading = $derived(!hasSynced && syncing && items.length > 0);

	const totalSats = $derived(
		items.filter((i) => !i.unreachable).reduce((sum, i) => sum + i.balance, 0)
	);

	/** Refresh every wallet's snapshot in parallel (each single-flighted +
	 *  throttled server-side), then re-read the fresh list. Never throws. */
	async function refresh() {
		if (syncing) return;
		syncing = true;
		try {
			await Promise.allSettled([
				...data.wallets.map((w) =>
					fetch(`/api/wallets/${w.id}/refresh`, { method: 'POST' })
				),
				...data.multisigs.map((m) =>
					fetch(`/api/wallets/multisig/${m.id}/refresh`, { method: 'POST' })
				)
			]);
			await invalidate('cairn:wallets');
		} catch {
			// Best-effort — keep the cached list up on any failure.
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

		{#if !loading && items.length === 0}
			<!-- ------------------------------------------- first-run onboard -->
			<section class="onboard fade-in">
				<div class="onboard-icon"><Icon name="wallet" size={26} /></div>
				<h2 class="onboard-title">Bring your first wallet</h2>
				<p class="onboard-copy">
					Add a wallet with a single key, or a multisig wallet that needs several keys to spend.
					Heartwood only ever sees <em>public</em> keys — it tracks your balance and history, and
					you sign every spend on your own device. Nothing here can move your bitcoin on its own.
				</p>
				<div class="onboard-actions">
					<a href="/wallets/new" class="btn btn-primary pill-lg">
						<Icon name="plus" size={15} />
						Add your first wallet
					</a>
					<a href="/wallets/new?restore=1" class="restore-link">
						<Icon name="arrow-down-left" size={14} />
						Restore from a backup
					</a>
				</div>
			</section>
		{:else}
			<!-- ------------------------------------------- eyebrow + hero -->
			<header class="head">
				<span class="head-eyebrow">Wallets</span>
				{#if loading}
					<div class="head-hero">
						<span class="hero-number head-btc skeleton">0.0000</span>
					</div>
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
		max-width: 520px;
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

	.onboard-actions {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
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
	}
</style>
