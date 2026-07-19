<script lang="ts">
	/**
	 * PoolLeaderboard — "High scores" (cairn-192dr). Bragging-rights only, no
	 * pot: a per-user best-share ranking with an honest caption ("every share
	 * is a lottery ticket") so it never reads as competitive skill. Keyed on
	 * `name`, not `rank` — rank can shuffle as live session-bests overtake the
	 * stored best, and a row's identity is the person, not their position.
	 */
	import { formatNumber } from '$lib/format';

	let {
		leaderboard
	}: {
		leaderboard: {
			rank: number;
			name: string;
			isYou: boolean;
			bestShareDifficulty: number;
			hashrateNow: number;
			online: boolean;
		}[];
	} = $props();
</script>

<section class="card card-pad leaderboard-card">
	<span class="card-title">High scores</span>
	<p class="leaderboard-caption">
		Every share is a lottery ticket — this is the closest anyone here has come to finding a block.
	</p>

	{#if leaderboard.length === 0}
		<p class="empty-note">No shares yet — once a miner connects, its best attempt will show up here.</p>
	{:else}
		<ul class="leaderboard-list">
			{#each leaderboard as row (row.name)}
				<li class="leaderboard-row">
					<span class="rank tabular">{row.rank}</span>
					<span
						class="pip"
						class:online={row.online}
						title={row.online ? 'Online now' : 'Offline'}
						aria-label={row.online ? 'Online now' : 'Offline'}
					></span>
					<span class="name grow truncate">{row.name}</span>
					{#if row.isYou}<span class="you-chip">you</span>{/if}
					<span class="best tabular">{formatNumber(row.bestShareDifficulty)}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.leaderboard-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.leaderboard-caption {
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.empty-note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.leaderboard-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.leaderboard-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 2px;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.leaderboard-row:last-child {
		border-bottom: none;
	}

	.rank {
		width: 1.5em;
		color: var(--text-faint);
		font-size: 12.5px;
	}

	.pip {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}

	.pip.online {
		background: var(--sage);
	}

	.name {
		color: var(--text-rows);
	}

	.you-chip {
		padding: 2px 8px;
		border-radius: var(--radius-badge);
		background: var(--sage-muted);
		color: var(--sage);
		font-size: 11px;
		font-weight: 500;
	}

	.best {
		color: var(--text-rows);
		font-weight: 500;
	}
</style>
