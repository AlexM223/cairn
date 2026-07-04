<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import {
		formatNumber,
		formatBtc,
		formatSats,
		timeAgo,
		formatDateTime,
		truncateMiddle
	} from '$lib/format';

	let { data } = $props();

	const info = $derived(data.info);
</script>

<svelte:head>
	<title>Address {truncateMiddle(info.address, 8, 8)} — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<span class="overline">Address</span>
	<h1 class="addr mono"><CopyText value={info.address} /></h1>
	<div class="meta">
		{#if info.scriptType}
			<span class="badge badge-neutral">{info.scriptType.toUpperCase()}</span>
		{/if}
		{#if info.used}
			<span class="badge badge-success">Used</span>
		{:else}
			<span class="badge badge-neutral">Never used</span>
		{/if}
	</div>
</div>

<section class="stats fade-in">
	<div class="card card-pad stat">
		<span class="overline">Confirmed balance</span>
		<span class="hero-number stat-hero" title="{formatSats(info.confirmedBalance)} sats">
			{formatBtc(info.confirmedBalance)}
			<span class="unit">BTC</span>
		</span>
	</div>
	<div class="card card-pad stat">
		<span class="overline">Unconfirmed</span>
		<span class="stat-value tabular" title="{formatSats(info.unconfirmedBalance)} sats">
			{#if info.unconfirmedBalance === 0}
				—
			{:else}
				<span class={info.unconfirmedBalance > 0 ? 'pos' : 'neg'}>
					{info.unconfirmedBalance > 0 ? '+' : ''}{formatBtc(info.unconfirmedBalance)} BTC
				</span>
			{/if}
		</span>
	</div>
	<div class="card card-pad stat">
		<span class="overline">Transactions</span>
		<span class="stat-value tabular">{formatNumber(info.txCount)}</span>
	</div>
	{#if info.totalReceived !== null}
		<div class="card card-pad stat">
			<span class="overline">Total received</span>
			<span class="stat-value tabular" title="{formatSats(info.totalReceived)} sats">
				{formatBtc(info.totalReceived)} BTC
			</span>
		</div>
	{/if}
</section>

<section class="card fade-in">
	<div class="txs-head">
		<Icon name="activity" size={17} />
		<span class="card-title">Transaction history</span>
		{#if data.txs.length > 0 && data.txs.length < info.txCount}
			<span class="hint pages">Latest {data.txs.length} of {formatNumber(info.txCount)}</span>
		{/if}
	</div>

	{#if data.txError}
		<div class="form-error tx-error" role="alert">
			<Icon name="alert-triangle" size={15} />
			<span>Couldn't load transactions — {data.txError}</span>
		</div>
	{:else if data.txs.length === 0}
		<div class="empty-state">
			<span class="empty-title">No transactions</span>
			<span>This address hasn't sent or received anything yet.</span>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>Txid</th>
						<th>Time</th>
						<th class="num">Amount</th>
						<th class="num">Fee</th>
					</tr>
				</thead>
				<tbody>
					{#each data.txs as tx (tx.txid)}
						<tr>
							<td>
								<a href="/explorer/tx/{tx.txid}" class="mono">{truncateMiddle(tx.txid, 10, 10)}</a>
							</td>
							<td>
								{#if tx.height === 0}
									<span class="badge badge-warning">pending</span>
								{:else}
									<span class="text-muted" title={formatDateTime(tx.time)}>{timeAgo(tx.time)}</span>
								{/if}
							</td>
							<td class="num tabular">
								{#if tx.delta !== null}
									<span
										class={tx.delta >= 0 ? 'pos' : 'neg'}
										title="{formatSats(tx.delta)} sats"
									>
										{tx.delta >= 0 ? '+' : '−'}{formatBtc(Math.abs(tx.delta))} BTC
									</span>
								{:else}
									—
								{/if}
							</td>
							<td class="num text-muted">
								{tx.fee !== null ? `${formatSats(tx.fee)} sats` : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.head {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 16px;
		min-width: 0;
	}

	.addr {
		font-size: 17px;
		font-weight: 550;
		min-width: 0;
		word-break: break-all;
	}

	.meta {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 14px;
		margin-bottom: 14px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.stat-hero {
		font-size: 28px;
	}

	.stat-value {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 13px;
		color: var(--text-muted);
		font-weight: 400;
	}

	.pos {
		color: var(--success);
	}

	.neg {
		color: var(--error);
	}

	.txs-head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 20px 12px;
	}

	.pages {
		margin-left: auto;
	}

	.tx-error {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 16px 16px;
	}
</style>
