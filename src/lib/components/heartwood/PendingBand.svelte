<script lang="ts">
	/**
	 * PendingBand — the sage "your pending txs" band on the mempool page. Lists
	 * the viewing user's OWN unconfirmed transactions (from their wallet
	 * snapshots, computed server-side by viewerPendingTxs) so they can see their
	 * waiting sends amid the anonymous mempool crowd.
	 *
	 * Honesty: it shows only what the wallet already knows — amount and fee — and
	 * never claims WHERE the tx sits inside the anonymized fee histogram (public
	 * mempool data can't reveal that). Each row links to the explorer tx detail.
	 * Renders nothing when the viewer has no pending txs.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';

	interface PendingRow {
		txid: string;
		wallet: { name: string; href: string };
		delta: number;
		fee: number | null;
		time: number | null;
	}

	let { pending }: { pending: PendingRow[] } = $props();
</script>

{#if pending.length > 0}
	<section class="pending-band" aria-label="Your pending transactions">
		<div class="band-head">
			<span class="band-title">
				<Icon name="clock" size={14} />
				{pending.length === 1
					? 'You have 1 transaction waiting'
					: `You have ${pending.length} transactions waiting`}
			</span>
			<span class="band-sub">in this mempool, from your own wallets</span>
		</div>
		<ul class="rows">
			{#each pending as tx (tx.txid)}
				<li class="row">
					<a class="tx-link" href="/explorer/tx/{tx.txid}" title={tx.txid}>
						<span class="mono">{tx.txid.slice(0, 10)}…{tx.txid.slice(-6)}</span>
						<Icon name="arrow-right" size={12} />
					</a>
					<span class="amount tabular" class:in={tx.delta > 0} class:out={tx.delta < 0}>
						{tx.delta > 0 ? '+' : tx.delta < 0 ? '−' : ''}{formatBtc(Math.abs(tx.delta))} BTC
					</span>
					<span class="meta tabular">
						{#if tx.fee != null}fee {formatSats(tx.fee)} sats{/if}
						{#if tx.time != null}<span class="sep" aria-hidden="true">·</span> {timeAgo(tx.time)}{/if}
					</span>
					<a class="wallet" href={tx.wallet.href}>{tx.wallet.name}</a>
				</li>
			{/each}
		</ul>
		<p class="band-note hint">
			These are yours — where they land in the ordering above depends on their fee rate against
			everyone else's. Only your node knows they're yours.
		</p>
	</section>
{/if}

<style>
	/* Sage band — a calm, wallet-owned green distinct from the copper fee
	   language, so "yours" reads instantly against the anonymous mempool. */
	.pending-band {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px 18px;
		border-radius: var(--radius-card, 10px);
		border: 1px solid color-mix(in srgb, var(--success, #7c9c73) 40%, transparent);
		background: color-mix(in srgb, var(--success, #7c9c73) 9%, transparent);
	}

	.band-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
	}

	.band-title {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 14.5px;
		font-weight: 600;
		color: var(--text);
	}

	.band-title :global(svg) {
		color: var(--success, #7c9c73);
	}

	.band-sub {
		font-size: 12px;
		color: var(--text-muted);
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
		padding: 7px 0;
		border-top: 1px solid color-mix(in srgb, var(--success, #7c9c73) 18%, transparent);
	}

	.row:first-child {
		border-top: none;
	}

	.tx-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.tx-link:hover {
		color: var(--accent);
	}

	.mono {
		font-family: var(--font-mono, monospace);
	}

	.amount {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-rows, var(--text));
	}

	.amount.in {
		color: var(--success, #7c9c73);
	}

	.meta {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.meta .sep {
		color: var(--border-ghost, var(--text-faint));
		margin: 0 2px;
	}

	.wallet {
		margin-left: auto;
		font-size: 12px;
		color: var(--text-muted);
	}

	.wallet:hover {
		color: var(--accent);
	}

	.band-note {
		margin: 2px 0 0;
		font-size: 11.5px;
		line-height: 1.5;
	}
</style>
