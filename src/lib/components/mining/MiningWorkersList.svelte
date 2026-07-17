<script lang="ts">
	/**
	 * MiningWorkersList — per-worker status for this user's own miners.
	 * Online/offline is shown as a quiet pip (sage = online, muted = offline)
	 * — never red; an offline miner is routine, not an alarm
	 * (DESIGN-MANIFESTO.md §5 motion/color rules).
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { formatNumber } from '$lib/format';
	import { formatHashrate } from '$lib/shared/hashrate';

	// Duration formatter (mirrors $lib/format's timeAgo bucketing, but takes a
	// plain "seconds ago" duration directly rather than a timestamp to diff
	// against — lastShareAgoSec is already a duration off the server).
	function formatAgo(sec: number | null): string {
		// null = connected but hasn't submitted a share yet.
		if (sec === null) return 'no shares yet';
		if (sec < 5) return 'just now';
		if (sec < 60) return `${Math.floor(sec)}s ago`;
		if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
		if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
		return `${Math.floor(sec / 86400)}d ago`;
	}

	let {
		workers
	}: {
		workers: {
			name: string;
			online: boolean;
			lastShareAgoSec: number | null;
			hashrate: { now: number; h1: number; h24: number };
			shares: { accepted: number; stale: number; rejected: number };
			bestShareDifficulty: number;
		}[];
	} = $props();
</script>

<section class="card card-pad workers-card">
	<div class="row" style="gap: 8px">
		<Icon name="activity" size={15} />
		<span class="card-title grow">Your miners</span>
	</div>

	<ul class="worker-list">
		{#each workers as w (w.name)}
			<li class="worker-row">
				<div class="worker-head">
					<span class="pip" class:online={w.online} aria-hidden="true"></span>
					<span class="worker-name">{w.name}</span>
					<span class="worker-status">
						{w.online ? 'Online' : `Last share ${formatAgo(w.lastShareAgoSec)}`}
					</span>
				</div>

				<div class="worker-stats">
					<div class="stat">
						<span class="stat-label">Now</span>
						<span class="stat-value tabular">{formatHashrate(w.hashrate.now)}</span>
					</div>
					<div class="stat">
						<span class="stat-label">1h</span>
						<span class="stat-value tabular">{formatHashrate(w.hashrate.h1)}</span>
					</div>
					<div class="stat">
						<span class="stat-label">24h</span>
						<span class="stat-value tabular">{formatHashrate(w.hashrate.h24)}</span>
					</div>
					<div class="stat">
						<span class="stat-label">Shares</span>
						<span class="stat-value tabular"
							>{formatNumber(w.shares.accepted)}
							{#if w.shares.stale > 0}<span class="stat-muted"
									>· {formatNumber(w.shares.stale)} stale</span
								>{/if}</span
						>
					</div>
					<div class="stat">
						<span class="stat-label">Best share</span>
						<span class="stat-value tabular">{formatNumber(w.bestShareDifficulty)}</span>
					</div>
				</div>
			</li>
		{/each}
	</ul>
</section>

<style>
	.workers-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.worker-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.worker-row {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.worker-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pip {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}

	.pip.online {
		background: var(--sage);
	}

	.worker-name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.worker-status {
		margin-left: auto;
		font-size: 12px;
		color: var(--text-muted);
	}

	.worker-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
		gap: 10px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.stat-label {
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.stat-value {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.stat-muted {
		color: var(--text-faint);
		font-size: 11.5px;
	}
</style>
