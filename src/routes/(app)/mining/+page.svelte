<script lang="ts">
	/**
	 * /mining — this user's own per-user mining dashboard (cairn-vn43.7/.9/.24).
	 * Every figure here is already scoped to the viewing user by
	 * getUserMiningView; this page never renders another user's workers,
	 * shares, or found blocks.
	 */
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import CoreRpcRequiredNotice from '$lib/components/CoreRpcRequiredNotice.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import MiningHero from '$lib/components/mining/MiningHero.svelte';
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
		engine: { status: 'running' | 'stopped' | 'core_missing'; stratumPort: number; bind: string };
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
	}

	let { data }: { data: { view: MiningView; loadError: string | null } } = $props();

	// Live-refreshed mirror of the server-loaded view. Reset whenever the
	// server load reruns (e.g. after a form action's `update()`), then kept
	// current in between by the /api/mining/me poll below.
	let view = $state<MiningView>(data.view);
	$effect(() => {
		view = data.view;
	});

	let pollTimer: ReturnType<typeof setInterval> | undefined;

	async function pollOnce() {
		try {
			const res = await fetch('/api/mining/me');
			if (!res.ok) return;
			view = (await res.json()) as MiningView;
		} catch {
			// Best-effort — keep showing the last good view rather than
			// flashing an error over a routine transient fetch failure.
		}
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(pollOnce, 10_000);
	}
	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	}
	function onVisibilityChange() {
		if (document.hidden) stopPolling();
		else {
			pollOnce();
			startPolling();
		}
	}

	onMount(() => {
		startPolling();
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			stopPolling();
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});

	const eligibleWallets = $derived(view.wallets.filter((w) => w.eligible));

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

<div class="page-shell stack">
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
	{:else if eligibleWallets.length === 0}
		<MiningOnboarding kind="no-wallet" />
	{:else if !view.connection}
		<MiningOnboarding kind="not-enabled" />
	{:else}
		<MiningHero hashrateNow={view.totals.hashrateNow} hashrate24h={view.totals.hashrate24h} />

		<div class="grid stack">
			<MiningConnectionCard
				miningId={view.connection.miningId}
				workerFormat={view.connection.workerFormat}
				password={view.connection.password}
				stratumPort={view.engine.stratumPort}
				hasWorkers={view.workers.length > 0}
			/>

			<MiningPayoutWallet payout={view.payout} wallets={view.wallets} />

			{#if view.workers.length > 0}
				<MiningWorkersList workers={view.workers} />
			{/if}

			<MiningEarnings
				blocksFound={view.earnings.blocksFound}
				totalMaturedSats={view.earnings.totalMaturedSats}
				totalPendingSats={view.earnings.totalPendingSats}
			/>

			<MiningOddsPanel odds={view.odds} hashrateNow={view.totals.hashrateNow} />
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
	.page-shell {
		max-width: 640px;
		margin: 0 auto;
		padding: 0 16px 48px;
		gap: 24px;
	}

	.grid {
		gap: 16px;
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
