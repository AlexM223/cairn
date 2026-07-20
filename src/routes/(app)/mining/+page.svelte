<script lang="ts">
	/**
	 * /mining — this user's own per-user mining dashboard (cairn-vn43.7/.9/.24).
	 * Every figure here is already scoped to the viewing user by
	 * getUserMiningView; this page never renders another user's workers,
	 * shares, or found blocks.
	 */
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { subscribe } from '$lib/live/liveClient';
	import { debounced } from '$lib/live/walletEvents';
	import Icon from '$lib/components/Icon.svelte';
	import CoreRpcRequiredNotice from '$lib/components/CoreRpcRequiredNotice.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import MiningHero from '$lib/components/mining/MiningHero.svelte';
	import MiningBestShare from '$lib/components/mining/MiningBestShare.svelte';
	import MiningConnectionCard from '$lib/components/mining/MiningConnectionCard.svelte';
	import MiningPayoutWallet from '$lib/components/mining/MiningPayoutWallet.svelte';
	import MiningWorkersList from '$lib/components/mining/MiningWorkersList.svelte';
	import MiningEarnings from '$lib/components/mining/MiningEarnings.svelte';
	import MiningOddsPanel from '$lib/components/mining/MiningOddsPanel.svelte';
	import MiningOnboarding from '$lib/components/mining/MiningOnboarding.svelte';

	// Local mirror of the getUserMiningView contract (worker A's
	// $lib/server/mining/readModels.ts) — declared explicitly here rather than
	// relied on via inference so the /api/mining/me poll response (a plain
	// `fetch().json()`, which TS can't type from the network) and this page's
	// own local state both get real type-checking instead of falling through
	// to `any`.
	interface MiningView {
		engine: {
			status: 'running' | 'stopped' | 'core_missing';
			stratumPort: number;
			bind: 'loopback' | 'lan' | 'all';
			/** Difficulty floor of the standard (small-miner) port. */
			shareDifficulty: number;
			/** High-difficulty-floor listener for ASIC-class hardware, null when disabled. */
			asicPort: { port: number; shareDifficulty: number } | null;
			/** Native Stratum V2 listener, null when the admin hasn't enabled it. */
			sv2: { port: number; authorityPubkey: string } | null;
		};
		connection: { miningId: string; workerFormat: string; password: string } | null;
		payout: { walletId: number; walletName: string; address: string } | null;
		workers: {
			name: string;
			online: boolean;
			lastShareAgoSec: number | null;
			hashrate: { now: number; h1: number; h24: number };
			shares: { accepted: number; stale: number; rejected: number };
			bestShareDifficulty: number;
		}[];
		totals: {
			hashrateNow: number;
			hashrate24h: number;
			bestShareEver: number;
			acceptedShares: number;
			staleShares: number;
		};
		earnings: {
			blocksFound: {
				height: number;
				txid: string | null;
				vout: number;
				reward: number;
				/** ISO timestamp string, as stored — not unix seconds. */
				foundAt: string;
				status: 'maturing' | 'mature' | 'rejected';
			}[];
			totalMaturedSats: number;
			totalPendingSats: number;
		};
		odds: {
			userHashrate: number;
			networkHashps: number;
			expectedYearsPerBlock: number;
			probPerDayPct: number;
		} | null;
		wallets: { id: number; name: string; eligible: boolean }[];
		/** Context for the best-share card ("N% of the way to a block"); null when unknown. */
		networkDifficulty: number | null;
	}

	let { data }: { data: { view: MiningView; loadError: string | null } } = $props();

	// Live-refreshed mirror of the server-loaded view. Reset whenever the
	// server load reruns (e.g. after a form action's `update()`), then kept
	// current in between by the live `mining` nudge below.
	let view = $state<MiningView>(untrack(() => data.view));
	$effect(() => {
		view = data.view;
	});

	async function refetch() {
		try {
			const res = await fetch('/api/mining/me');
			if (!res.ok) return;
			view = (await res.json()) as MiningView;
		} catch {
			// Best-effort — keep showing the last good view rather than
			// flashing an error over a routine transient fetch failure.
		}
	}

	function onVisibilityChange() {
		if (!document.hidden) void refetch();
	}

	onMount(() => {
		// Invalidate-driven (docs/LIVE-UPDATES-DESIGN.md §4.2, §5): the 10s poll is
		// gone. The user-scoped `mining` nudge (fired on each aggregates flush and
		// immediately on a block-found) triggers a debounced refetch of the same
		// endpoint; a burst collapses into one reload. Foreground still refetches so
		// a tab that was backgrounded when a nudge fired catches up on return.
		const nudged = debounced(() => void refetch());
		const unsub = subscribe('mining', () => nudged());
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			nudged.cancel();
			unsub();
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});

	const eligibleWallets = $derived(view.wallets.filter((w) => w.eligible));

	// True only in the live-dashboard branch below (mirrors that {:else}'s exact
	// conditions). Drives the desktop layout: onboarding/disabled/error states
	// stay a calm reading-measure column; the running dashboard widens to the
	// data lane and splits into a workers-list main + a panel rail at >=1160
	// (docs/DESKTOP-LAYOUT-DESIGN.md §4 Mining).
	const isDashboard = $derived(
		!data.loadError &&
			view.engine.status !== 'core_missing' &&
			view.engine.status !== 'stopped' &&
			eligibleWallets.length > 0 &&
			!!view.connection
	);

	let disabling = $state(false);
	function actionError(result: { type: string; data?: Record<string, unknown> }, key: string): string | null {
		if (result.type !== 'failure') return null;
		const msg = result.data?.[key];
		return typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.';
	}
</script>

<svelte:head>
	<title>Mining · Heartwood</title>
</svelte:head>

<Toasts />

<div class="pool-link-row">
	<a class="btn-link pool-link" href="/mining/pool">See the whole pool ›</a>
</div>

<div class="page-shell stack" class:is-dashboard={isDashboard}>
	{#if data.loadError}
		<div class="empty-state load-error-panel">
			<Icon name="alert-triangle" size={20} />
			<span class="empty-title">Mining data is temporarily unavailable</span>
			<p class="notice-body">Try refreshing the page in a moment.</p>
		</div>
	{:else if view.engine.status === 'core_missing'}
		<CoreRpcRequiredNotice feature="Mining" isAdmin={page.data.user?.isAdmin ?? false} />
	{:else if view.engine.status === 'stopped'}
		<MiningOnboarding kind="engine-stopped" />
		{#if view.earnings.blocksFound.length > 0}
			<!-- Past blocks are historical fact even while the pool is stopped —
			     same cairn-p10q doctrine as the not-enabled branch below. Found in
			     v0.2.42 QA: this branch used to swallow a user's entire earnings
			     history ("Mining isn't running yet" over 625M pending sats). -->
			<MiningEarnings
				blocksFound={view.earnings.blocksFound}
				totalMaturedSats={view.earnings.totalMaturedSats}
				totalPendingSats={view.earnings.totalPendingSats}
			/>
		{/if}
	{:else if eligibleWallets.length === 0}
		<MiningOnboarding kind="no-wallet" />
	{:else if !view.connection}
		<MiningOnboarding kind="not-enabled" />
		{#if view.earnings.blocksFound.length > 0}
			<!-- Past blocks are historical fact even while mining is turned off;
			     only the live connection/workers UI is gated on being enabled
			     (cairn-p10q). -->
			<MiningEarnings
				blocksFound={view.earnings.blocksFound}
				totalMaturedSats={view.earnings.totalMaturedSats}
				totalPendingSats={view.earnings.totalPendingSats}
			/>
		{/if}
	{:else}
		<div class="mining-hero-wrap">
			<MiningHero hashrateNow={view.totals.hashrateNow} hashrate24h={view.totals.hashrate24h} />
		</div>

		{#if view.totals.bestShareEver > 0}
			<div class="mining-hero-wrap">
				<MiningBestShare
					bestShareEver={view.totals.bestShareEver}
					networkDifficulty={view.networkDifficulty}
				/>
			</div>
		{/if}

		<!-- Desktop (>=1160px): workers hairline list in the main column, the pool/
		     payout/earnings/odds panels in a right-hand rail. DOM order is kept
		     exactly (connection · payout · workers · earnings · odds) so the mobile
		     single-column stack is byte-identical; grid placement alone repositions
		     them at desktop. -->
		<div class="mining-layout">
			<div class="mining-col mining-col-connection">
				<MiningConnectionCard
					miningId={view.connection.miningId}
					workerFormat={view.connection.workerFormat}
					password={view.connection.password}
					stratumPort={view.engine.stratumPort}
					bind={view.engine.bind}
					asicPort={view.engine.asicPort}
					sv2={view.engine.sv2}
					hasWorkers={view.workers.length > 0}
				/>
			</div>

			<div class="mining-col mining-col-payout">
				<MiningPayoutWallet payout={view.payout} wallets={view.wallets} />
			</div>

			{#if view.workers.length > 0}
				<div class="mining-col mining-col-workers">
					<MiningWorkersList workers={view.workers} />
				</div>
			{/if}

			<div class="mining-col mining-col-earnings">
				<MiningEarnings
					blocksFound={view.earnings.blocksFound}
					totalMaturedSats={view.earnings.totalMaturedSats}
					totalPendingSats={view.earnings.totalPendingSats}
				/>
			</div>

			<div class="mining-col mining-col-odds">
				<MiningOddsPanel odds={view.odds} hashrateNow={view.totals.hashrateNow} />
			</div>
		</div>

		<form
			method="POST"
			action="?/disable"
			class="disable-row"
			use:enhance={() => {
				disabling = true;
				return async ({ update, result }) => {
					disabling = false;
					await update();
					const err = actionError(result, 'disableError');
					if (err) toast.error(err);
					else if (result.type === 'success') toast.success('Mining turned off. Turn it back on anytime.');
				};
			}}
		>
			<button type="submit" class="btn-link" disabled={disabling}>
				{disabling ? 'Turning off…' : 'Turn off mining'}
			</button>
		</form>
	{/if}
</div>

<style>
	/* Quiet top-of-page link over to the pool-wide stats page — same reading
	   measure as the page shell so it lines up with the content below it. */
	.pool-link-row {
		max-width: var(--measure-reading);
		margin: 0 auto;
		padding: 16px 16px 0;
	}

	.pool-link {
		font-size: 12.5px;
	}

	/* Calm default: onboarding, disabled, and error states are single-decision
	   screens and stay at reading measure (the old 640 cap is removed per
	   docs/DESKTOP-LAYOUT-DESIGN.md §2). On mobile this cap is inert. */
	.page-shell {
		max-width: var(--measure-reading);
		margin: 0 auto;
		padding: 0 16px 48px;
		gap: 24px;
	}

	/* The running dashboard is a data surface — let it fill the data lane that
	   the layout already caps <main> to (1180 / 1320), so the workers list and
	   the panel rail have room. Only widens at the desktop tier. */
	@media (min-width: 1160px) {
		.page-shell.is-dashboard {
			max-width: none;
		}
	}

	/* Hero stays a calm reading-measure band even when the dashboard around it
	   fills the data lane. */
	.mining-hero-wrap {
		max-width: var(--measure-reading);
	}

	/* Mobile / laptop: a plain stack (same as the old `.grid.stack`). */
	.mining-layout {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Desktop: workers list on the left, panels stacked in a right rail. DOM
	   order is connection · payout · workers · earnings · odds; explicit grid
	   placement moves workers to column 1 and the rest to column 2 without
	   touching the mobile DOM order. */
	@media (min-width: 1160px) {
		.mining-layout {
			display: grid;
			grid-template-columns: minmax(0, 1fr) var(--rail-w);
			column-gap: var(--lane-gutter);
			row-gap: 20px;
			align-items: start;
		}

		.mining-col-workers {
			grid-column: 1;
			grid-row: 1 / span 4;
			min-width: 0;
		}

		.mining-col-connection {
			grid-column: 2;
			grid-row: 1;
		}

		.mining-col-payout {
			grid-column: 2;
			grid-row: 2;
		}

		.mining-col-earnings {
			grid-column: 2;
			grid-row: 3;
		}

		.mining-col-odds {
			grid-column: 2;
			grid-row: 4;
		}
	}

	.load-error-panel,
	:global(.onboarding-panel) {
		margin-top: 48px;
	}

	.notice-body {
		max-width: 42ch;
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.disable-row {
		display: flex;
		justify-content: center;
		padding-top: 8px;
	}

	.btn-link {
		background: none;
		border: none;
		padding: 0;
		font-size: 12.5px;
		color: var(--text-faint);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.btn-link:hover {
		color: var(--text-muted);
	}
</style>
