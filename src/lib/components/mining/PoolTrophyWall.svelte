<script lang="ts">
	/**
	 * PoolTrophyWall — "Blocks found here" (cairn-et38g): every block this pool
	 * has ever found, any finder, newest first. Mirrors MiningEarnings's row
	 * markup/status-chip conventions (Spendable/Maturing/Not counted) so the
	 * two block-list surfaces read as one family, but keyed on `blockHash`
	 * (globally unique) rather than a per-user coinbase txid, and adds the
	 * finder's name (+ a "you" chip) since this wall spans every pool member.
	 * Rejected (reorged-out) rows stay listed, quietly — honest history, not
	 * hidden, per MiningEarnings's own precedent (cairn-et5a0's neighbor rule).
	 */
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { formatSats, timeAgo } from '$lib/format';

	let {
		blocks
	}: {
		blocks: {
			height: number;
			blockHash: string;
			foundByName: string;
			isYou: boolean;
			reward: number;
			foundAt: string;
			status: 'maturing' | 'mature' | 'rejected';
		}[];
	} = $props();

	/** foundAt is an ISO string; timeAgo() takes unix seconds. */
	function foundAgo(foundAt: string): string {
		const ms = Date.parse(foundAt);
		return Number.isFinite(ms) ? timeAgo(Math.floor(ms / 1000)) : '';
	}
</script>

<section class="card card-pad trophy-card">
	<div class="row" style="gap: 8px">
		<Icon name="flame" size={15} />
		<span class="card-title grow">Blocks found here</span>
	</div>

	{#if blocks.length === 0}
		<p class="empty-note">No blocks yet — the pool keeps trying every second.</p>
	{:else}
		<ul class="block-list">
			{#each blocks as row (row.blockHash)}
				<li class="block-row" class:rejected={row.status === 'rejected'}>
					<div class="block-head">
						<a class="block-link" href={`/explorer/block/${row.blockHash}`}>
							<Icon name="blocks" size={13} />
							Block {formatSats(row.height)}
						</a>
						<span class="block-amount"><Amount sats={row.reward} size="inline" /></span>
					</div>
					<div class="block-meta">
						<span class="block-finder">
							{row.foundByName}
							{#if row.isYou}<span class="you-chip">you</span>{/if}
						</span>
						<span class="block-when">{foundAgo(row.foundAt)}</span>
						{#if row.status === 'mature'}
							<span class="status-chip mature">
								<Icon name="check" size={12} />
								Spendable
							</span>
						{:else if row.status === 'maturing'}
							<span class="status-chip maturing">
								<Icon name="clock" size={12} />
								Maturing
							</span>
						{:else}
							<span
								class="status-chip rejected"
								title="This block was reorganized out of the chain and its reward never confirmed."
							>
								Not counted
							</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.trophy-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.empty-note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.block-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.block-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.block-row.rejected {
		opacity: 0.7;
	}

	.block-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.block-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		text-decoration: none;
	}

	.block-link:hover {
		color: var(--text);
	}

	.block-amount {
		margin-left: auto;
	}

	.block-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.block-finder {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.you-chip {
		padding: 1px 7px;
		border-radius: var(--radius-badge);
		background: var(--sage-muted);
		color: var(--sage);
		font-size: 10.5px;
		font-weight: 500;
	}

	.block-when {
		font-size: 12px;
		color: var(--text-muted);
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-left: auto;
		padding: 3px 8px;
		border-radius: var(--radius-status-pill);
		font-size: 11.5px;
		font-weight: 500;
	}

	.status-chip.mature {
		color: var(--sage);
		background: var(--sage-muted);
	}

	.status-chip.maturing {
		color: var(--attention);
		background: var(--attention-muted);
	}

	.status-chip.rejected {
		color: var(--text-muted);
		background: var(--surface-elevated);
	}
</style>
