<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, timeAgo } from '$lib/format';

	type ActivityItem = {
		key: string;
		walletName: string;
		walletHref: string;
		txid: string;
		direction: 'in' | 'out';
		sats: number;
		time: number | null;
		confirmations: number;
	};

	let { items }: { items: ActivityItem[] } = $props();
</script>

{#if items.length === 0}
	<p class="empty">No transactions across your wallets yet.</p>
{:else}
	<ul class="list">
		{#each items as item (item.key)}
			<li>
				<a class="row" href={`/explorer/tx/${item.txid}`}>
					<span
						class="dir"
						class:in={item.direction === 'in'}
						class:out={item.direction === 'out'}
					>
						<Icon
							name={item.direction === 'in' ? 'arrow-down-left' : 'arrow-up-right'}
							size={16}
						/>
						<span class="dir-label">{item.direction === 'in' ? 'Received' : 'Sent'}</span>
					</span>

					<span class="mid">
						<span class="wallet-chip">{item.walletName}</span>
						<span class="meta">
							{#if item.time === null}
								<span class="pending-badge">pending</span>
							{:else}
								<span class="time">{timeAgo(item.time)}</span>
							{/if}
							<span class="conf">
								{item.time === null || item.confirmations === 0
									? 'unconfirmed'
									: `${item.confirmations} conf`}
							</span>
						</span>
					</span>

					<span
						class="amount tabular"
						class:in={item.direction === 'in'}
						class:out={item.direction === 'out'}
					>
						{item.direction === 'in' ? '+' : '-'}{formatBtc(item.sats)}<span class="unit"
							>&nbsp;BTC</span
						>
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.empty {
		margin: 0;
		padding: 1.5rem 0.25rem;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.875rem;
		text-align: center;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.list li + li {
		border-top: 1px solid var(--border-subtle);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 0.5rem;
		text-decoration: none;
		color: inherit;
		border-radius: var(--radius-control);
		transition: background-color 0.15s var(--ease);
	}

	.row:hover {
		background: var(--surface-elevated);
	}

	/* Direction indicator */
	.dir {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		flex-shrink: 0;
		min-width: 6.5rem;
		font-family: var(--font-ui);
		font-size: 0.875rem;
		font-weight: 500;
	}

	.dir.in {
		color: var(--success);
	}

	.dir.out {
		color: var(--error);
	}

	.dir-label {
		white-space: nowrap;
	}

	/* Middle column: wallet chip + meta */
	.mid {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
		flex: 1;
	}

	.wallet-chip {
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0.1rem 0.5rem;
		border-radius: var(--radius-chip);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.time {
		white-space: nowrap;
	}

	.conf {
		white-space: nowrap;
		color: var(--text-faint);
	}

	.pending-badge {
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-chip);
		background: color-mix(in srgb, var(--warning) 15%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
		color: var(--warning);
		font-size: 0.7rem;
		font-weight: 500;
		white-space: nowrap;
	}

	/* Amount */
	.amount {
		flex-shrink: 0;
		text-align: right;
		font-family: var(--font-ui);
		font-size: 0.9375rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.amount.in {
		color: var(--success);
	}

	.amount.out {
		color: var(--text);
	}

	.unit {
		color: var(--text-muted);
		font-weight: 500;
		font-size: 0.8125rem;
	}
</style>
