<script lang="ts">
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
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
					<BurialRings
						confirmations={item.time === null ? 0 : item.confirmations}
						direction={item.direction}
						size={28}
					/>

					<span class="mid">
						<span class="title">{item.direction === 'in' ? 'Received' : 'Sent'}</span>
						<span class="meta">
							<span class="truncate">{item.walletName}</span>
							<span class="sep">·</span>
							<span class="burial-label"
								>{burialRingsLabel(item.time === null ? 0 : item.confirmations)}</span
							>
							{#if item.time !== null}
								<span class="sep">·</span>
								<span class="time">{timeAgo(item.time)}</span>
							{/if}
						</span>
					</span>

					<span
						class="amount tabular"
						class:in={item.direction === 'in'}
						class:out={item.direction === 'out'}
					>
						{item.direction === 'in' ? '+' : '−'}{formatBtc(item.sats)}<span class="unit"
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

	/* Hairline rows — no cards, no chips. */
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.list li {
		border-bottom: 1px solid var(--hairline);
	}

	.list li:last-child {
		border-bottom: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 15px 2px;
		text-decoration: none;
		color: inherit;
		transition: background-color 0.15s var(--ease);
	}

	.row:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.mid {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		flex: 1;
	}

	.title {
		font-family: var(--font-ui);
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
		line-height: 1.3;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.meta .truncate {
		min-width: 0;
		flex-shrink: 1;
	}

	.sep {
		color: var(--text-faint);
	}

	.burial-label,
	.time {
		white-space: nowrap;
	}

	/* Amount: serif — a number that matters. Sage in, quiet rows-text out. */
	.amount {
		flex-shrink: 0;
		text-align: right;
		font-family: var(--font-serif);
		font-size: 15.5px;
		font-weight: 600;
		white-space: nowrap;
	}

	.amount.in {
		color: var(--sage);
	}

	.amount.out {
		color: var(--text-rows);
	}

	.unit {
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-weight: 500;
		font-size: 12px;
	}

	@media (max-width: 900px) {
		/* Mobile Home (8a) shows just the two freshest rows — the Activity tab
		   has the rest. */
		.list li:nth-child(n + 3) {
			display: none;
		}

		.row {
			padding: 13px 0;
		}

		.title {
			font-size: 13px;
		}

		.meta {
			font-size: 10.5px;
		}

		.amount {
			font-size: 13.5px;
		}
	}
</style>
