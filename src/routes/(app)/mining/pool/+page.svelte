<script lang="ts">
	/**
	 * /mining/pool — pool-wide stats every signed-in pool user may see
	 * (cairn-et38g + cairn-192dr): pool hashrate + 24h chart, miners online,
	 * the best-share "High scores" leaderboard, and the "Blocks found here"
	 * trophy wall. NOT admin-gated — the missing public view was the bug
	 * (previously this material only existed behind /admin/mining).
	 *
	 * Live refresh mirrors /mining's own pattern exactly (docs/LIVE-UPDATES-
	 * DESIGN.md §4.2, §5): the user-scoped page subscribes to `mining`, this
	 * one subscribes to the now-broadcast `mining:pool` topic, both debounce a
	 * refetch of their own read-model endpoint and both refetch on
	 * foregrounding a backgrounded tab.
	 */
	import { onMount, untrack } from 'svelte';
	import { subscribe } from '$lib/live/liveClient';
	import { debounced } from '$lib/live/walletEvents';
	import Icon from '$lib/components/Icon.svelte';
	import PoolStats from '$lib/components/mining/PoolStats.svelte';
	import PoolLeaderboard from '$lib/components/mining/PoolLeaderboard.svelte';
	import PoolTrophyWall from '$lib/components/mining/PoolTrophyWall.svelte';

	// Local mirror of PublicPoolView (src/lib/server/mining/readModels.ts),
	// declared explicitly for the same reason /mining's own page declares its
	// own MiningView: the /api/mining/pool poll response is a plain
	// `fetch().json()` that TS can't type from the network.
	interface PoolView {
		engine: { status: 'running' | 'stopped' | 'core_missing' };
		pool: {
			connectedWorkers: number;
			connectedUsers: number;
			hashrateNow: number;
			hashrate24h: number;
		};
		hashrateSeries: { t: number; hashrate: number }[];
		networkDifficulty: number | null;
		bestShare: { difficulty: number; holderName: string; isYou: boolean } | null;
		leaderboard: {
			rank: number;
			name: string;
			isYou: boolean;
			bestShareDifficulty: number;
			hashrateNow: number;
			online: boolean;
		}[];
		blocks: {
			height: number;
			blockHash: string;
			foundByName: string;
			isYou: boolean;
			reward: number;
			foundAt: string;
			status: 'maturing' | 'mature' | 'rejected';
		}[];
		totalBlocksFound: number;
	}

	let { data }: { data: { view: PoolView; loadError: string | null } } = $props();

	// Live-refreshed mirror of the server-loaded view, kept current between
	// loads by the `mining:pool` nudge below — same shape as /mining's own
	// `view` state.
	let view = $state<PoolView>(untrack(() => data.view));
	$effect(() => {
		view = data.view;
	});

	async function refetch() {
		try {
			const res = await fetch('/api/mining/pool');
			if (!res.ok) return;
			view = (await res.json()) as PoolView;
		} catch {
			// Best-effort — keep showing the last good view rather than flashing
			// an error over a routine transient fetch failure.
		}
	}

	function onVisibilityChange() {
		if (!document.hidden) void refetch();
	}

	onMount(() => {
		const nudged = debounced(() => void refetch());
		const unsub = subscribe('mining:pool', () => nudged());
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			nudged.cancel();
			unsub();
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});
</script>

<svelte:head>
	<title>The pool · Heartwood</title>
</svelte:head>

<div class="back-link-row">
	<a class="btn-link back-link" href="/mining">‹ Your mining</a>
</div>

<div class="page-shell stack">
	{#if data.loadError}
		<div class="empty-state load-error-panel">
			<Icon name="alert-triangle" size={20} />
			<span class="empty-title">Pool data is temporarily unavailable</span>
			<p class="notice-body">Try refreshing the page in a moment.</p>
		</div>
	{:else}
		<PoolStats pool={view.pool} hashrateSeries={view.hashrateSeries} totalBlocksFound={view.totalBlocksFound} />
		<PoolLeaderboard leaderboard={view.leaderboard} />
		<PoolTrophyWall blocks={view.blocks} />
	{/if}
</div>

<style>
	.back-link-row {
		max-width: var(--measure-data);
		margin: 0 auto;
		padding: 16px 16px 0;
	}

	.back-link {
		font-size: 12.5px;
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

	/* This page is a density surface (chart + leaderboard + trophy wall all
	   live inside bordered panels) so it takes the wider data lane rather
	   than /mining's calm reading measure. */
	.page-shell {
		max-width: var(--measure-data);
		margin: 0 auto;
		padding: 0 16px 48px;
		gap: 24px;
	}

	.load-error-panel {
		margin-top: 48px;
	}

	.notice-body {
		max-width: 42ch;
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
