<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { addressTypeInfo } from '$lib/bitcoin';
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
	const typeInfo = $derived(addressTypeInfo(info.scriptType));

	// Newest-first walk from the current balance yields the balance after each
	// transaction — correct even when we only have the most recent page.
	const rows = $derived.by(() => {
		let running = info.confirmedBalance + info.unconfirmedBalance;
		return data.txs.map((tx) => {
			const balanceAfter = running;
			running -= tx.delta ?? 0;
			return { ...tx, balanceAfter };
		});
	});

	const haveFullHistory = $derived(data.txs.length >= info.txCount);
	const firstSeen = $derived(
		haveFullHistory && data.txs.length > 0 ? (data.txs[data.txs.length - 1].time ?? null) : null
	);
	const lastSeen = $derived(data.txs.length > 0 ? (data.txs[0].time ?? null) : null);
</script>

<svelte:head>
	<title>Address {truncateMiddle(info.address, 8, 8)} — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<span class="overline">Address</span>
	<h1 class="addr mono"><CopyText value={info.address} /></h1>
	<div class="meta">
		{#if typeInfo}
			<Term tip={typeInfo.explanation}>
				<span class="badge badge-accent">{typeInfo.label} · {typeInfo.prefix}</span>
			</Term>
		{:else if info.scriptType}
			<span class="badge badge-neutral">{info.scriptType.toUpperCase()}</span>
		{/if}
		{#if info.used}
			<span class="badge badge-success" title="This address appears in at least one transaction on the blockchain.">Used</span>
		{:else}
			<span
				class="badge badge-neutral"
				title="No transaction has ever touched this address. It exists only as a possibility until someone sends to it."
				>Never used</span
			>
		{/if}
		{#if firstSeen}
			<span class="meta-date" title={formatDateTime(firstSeen)}>
				first seen {timeAgo(firstSeen)}
			</span>
		{/if}
		{#if lastSeen}
			<span class="meta-date" title={formatDateTime(lastSeen)}>
				last active {timeAgo(lastSeen)}
			</span>
		{/if}
	</div>
</div>

<HowItWorks id="address">
	<p>
		<strong>An address is a destination for bitcoin</strong> — a short encoding of the
		conditions someone must satisfy (usually a signature from a private key) to spend coins
		sent to it. Addresses don't hold coins themselves; the blockchain holds
		<strong>unspent outputs</strong> locked to them, and the balance you see is their sum.
	</p>
	<p>
		Formats have evolved for efficiency: Legacy (1…), script-wrapped (3…), Native SegWit
		(bc1q…), and Taproot (bc1p…). Newer formats take less block space to spend from, which
		means lower fees. Wallets generate a fresh address for every payment, so one wallet
		typically controls many addresses.
	</p>
</HowItWorks>

<section class="stats fade-in">
	<div class="card card-pad stat">
		<span class="overline">Confirmed balance</span>
		<span class="hero-number stat-hero" title="{formatSats(info.confirmedBalance)} sats">
			{formatBtc(info.confirmedBalance)}
			<span class="unit">BTC</span>
		</span>
	</div>
	<div class="card card-pad stat">
		<span class="overline">
			<Term
				tip="Pending change from transactions still in the mempool. It becomes part of the confirmed balance once they're mined into a block."
				>Unconfirmed</Term
			>
		</span>
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
	{#if info.totalSent !== null && info.totalSent > 0}
		<div class="card card-pad stat">
			<span class="overline">Total sent</span>
			<span class="stat-value tabular" title="{formatSats(info.totalSent)} sats">
				{formatBtc(info.totalSent)} BTC
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
						<th class="num">Balance after</th>
						<th class="num">Fee</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as tx (tx.txid)}
						<tr>
							<td>
								<a href="/explorer/tx/{tx.txid}" class="mono">{truncateMiddle(tx.txid, 10, 10)}</a>
							</td>
							<td>
								{#if tx.height === 0}
									<span
										class="badge badge-warning"
										title="Waiting in the mempool — not yet included in a block."
										>pending</span
									>
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
							<td
								class="num tabular text-secondary"
								title="{formatSats(tx.balanceAfter)} sats — the address balance once this transaction settled"
							>
								{formatBtc(tx.balanceAfter)} BTC
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
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.meta-date {
		font-size: 12.5px;
		color: var(--text-muted);
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
