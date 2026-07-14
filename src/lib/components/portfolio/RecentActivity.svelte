<script lang="ts">
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { timeAgo } from '$lib/format';

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

	let {
		items,
		price
	}: {
		items: ActivityItem[];
		/** Forwarded straight to each row's Amount (cairn-r7si). Home passes its
		 *  hero privacy-gated price here so the feed never shows fiat the hero
		 *  toggle has hidden; omit to fall back to Amount's default auto-refreshing
		 *  $lib/price store (e.g. for a future non-Home call site). */
		price?: number | null;
	} = $props();
	// /explorer/tx/[txid] is exempt from the `explorer` feature flag
	// (cairn-5yz3.3) — it's tx *detail*, not chain browsing, and it's the only
	// tx-detail surface in the app. So every row always links there, flag on
	// or off; there's no dead-end degrade to a plain div anymore.
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

					<Amount sats={item.sats} size="row" direction={item.direction} sign {price} />
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

	.row :global(.hw-amount) {
		flex-shrink: 0;
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
	}
</style>
