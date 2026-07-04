<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import ConfirmMeter from '$lib/components/ConfirmMeter.svelte';
	import { feeOutlook } from '$lib/bitcoin';
	import {
		formatNumber,
		formatBtc,
		formatSats,
		formatBytes,
		timeAgo,
		formatDateTime,
		formatFeeRate,
		truncateMiddle
	} from '$lib/format';

	let { data } = $props();

	const tx = $derived(data.tx);
	const isCoinbase = $derived(tx.vin.some((v) => v.coinbase));
	const totalIn = $derived(tx.vin.reduce((sum, v) => sum + (v.value ?? 0), 0));
	const totalOut = $derived(tx.vout.reduce((sum, v) => sum + v.value, 0));

	// An output paying an address that also funded an input is certainly
	// change. (Modern wallets avoid address reuse, so absence of this badge
	// doesn't mean absence of change — the panel copy explains the concept.)
	const inputAddresses = $derived(
		new Set(tx.vin.map((v) => v.address).filter((a): a is string => a !== null))
	);

	const outlook = $derived(
		!tx.confirmed && tx.feeRate !== null && data.fees ? feeOutlook(tx.feeRate, data.fees) : null
	);

	function outputLabel(scriptType: string): string {
		if (scriptType === 'op_return') return 'OP_RETURN';
		return `Non-standard (${scriptType})`;
	}
</script>

<svelte:head>
	<title>Tx {truncateMiddle(tx.txid, 8, 8)} — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<span class="overline">Transaction</span>
	<h1 class="txid mono"><CopyText value={tx.txid} truncate={18} /></h1>
</div>

<HowItWorks id="tx">
	<p>
		<strong>Bitcoin doesn't have accounts — it has unspent outputs.</strong> A transaction
		consumes whole outputs from earlier transactions as its inputs and creates new outputs
		locked to the recipients' addresses. This one consumed
		{isCoinbase ? 'no inputs (it mints new coins)' : `${tx.vin.length} input${tx.vin.length === 1 ? '' : 's'}`}
		and created {tx.vout.length} output{tx.vout.length === 1 ? '' : 's'}.
	</p>
	<p>
		Because inputs must be spent whole, one output usually returns leftover funds to the
		sender — that's <strong>change</strong>, like the bills you get back after paying with a
		twenty. Whatever isn't claimed by an output is the <strong>fee</strong>, collected by the
		miner who confirms the transaction.
	</p>
</HowItWorks>

<!-- Status -->
<section class="card card-pad status fade-in">
	{#if tx.confirmed}
		<span class="badge badge-success"><Icon name="check" size={12} /> Confirmed</span>
		<span class="status-detail">
			{#if tx.blockHeight !== null}
				in block
				<a href="/explorer/block/{tx.blockHeight}" class="tabular">{formatNumber(tx.blockHeight)}</a>
			{/if}
			{#if tx.blockTime !== null}
				<span title={formatDateTime(tx.blockTime)}>
					· {formatDateTime(tx.blockTime)} ({timeAgo(tx.blockTime)})
				</span>
			{/if}
		</span>
		<span class="confs"><ConfirmMeter confirmations={tx.confirmations} /></span>
	{:else}
		<span class="badge badge-warning"><Icon name="clock" size={12} /> In mempool</span>
		<span class="status-detail">
			Broadcast but not yet in a block{outlook ? ` — at ${formatFeeRate(tx.feeRate)}, ${outlook}` : ''}
		</span>
		<span class="confs"><ConfirmMeter confirmations={0} /></span>
	{/if}
	{#if tx.segwit}
		<Term
			tip="This transaction uses Segregated Witness: signatures live in a separate 'witness' section that counts less toward block limits, so it takes less block space and pays lower fees than the legacy format."
		>
			<span class="badge badge-neutral">SegWit</span>
		</Term>
	{/if}
	{#if tx.rbf && !tx.confirmed}
		<Term
			tip="This transaction signals replace-by-fee (BIP125): the sender can rebroadcast it with a higher fee if it's taking too long to confirm. Treat it as tentative until it has a confirmation."
		>
			<span class="badge badge-warning">Replaceable</span>
		</Term>
	{:else if tx.rbf}
		<Term
			tip="While unconfirmed, this transaction signalled replace-by-fee (BIP125), letting the sender bump the fee. Now that it's confirmed, that no longer matters."
		>
			<span class="badge badge-neutral">RBF</span>
		</Term>
	{/if}
</section>

<!-- Metrics -->
<section class="card card-pad metrics fade-in">
	<div class="metric">
		<span class="overline">
			<Term
				tip="The difference between what the inputs brought in and what the outputs claim. Miners keep it, so a higher fee per virtual byte gets a transaction picked from the mempool sooner."
				>Fee</Term
			>
		</span>
		<span class="metric-value tabular">
			{#if tx.fee !== null}
				{formatSats(tx.fee)} <span class="unit">sats</span>
			{:else}
				—
			{/if}
		</span>
		{#if tx.feeRate !== null}
			<span class="hint tabular">{formatFeeRate(tx.feeRate)}</span>
		{/if}
	</div>
	<div class="metric">
		<span class="overline">
			<Term
				tip="Raw size is the serialized bytes; virtual size (vB) discounts SegWit witness data to a quarter weight. Fees are priced per virtual byte, which is why SegWit transactions are cheaper."
				>Size</Term
			>
		</span>
		<span class="metric-value tabular">{formatBytes(tx.size)}</span>
		<span class="hint tabular">{formatNumber(tx.vsize)} vB · {formatNumber(tx.weight)} WU</span>
	</div>
	<div class="metric">
		<span class="overline">
			<Term tip="Transaction format version. Version 2 enables relative timelocks (BIP68).">
				Version
			</Term>
		</span>
		<span class="metric-value tabular">{tx.version}</span>
	</div>
	<div class="metric">
		<span class="overline">
			<Term
				tip="The earliest block height (or time) this transaction could be mined. Zero means no restriction — spendable immediately."
				>Locktime</Term
			>
		</span>
		<span class="metric-value tabular">{formatNumber(tx.locktime)}</span>
	</div>
</section>

<!-- Inputs / outputs -->
<section class="card card-pad fade-in">
	<div class="io">
		<div class="io-col">
			<span class="overline io-title">{tx.vin.length} input{tx.vin.length === 1 ? '' : 's'}</span>
			{#each tx.vin as vin, i (i)}
				<div class="io-row">
					{#if vin.coinbase}
						<span
							class="badge badge-accent"
							title="This special transaction creates new bitcoin out of nothing — the miner's reward for finding this block. It's the only kind of transaction with no inputs."
						>
							<Icon name="flame" size={11} /> Coinbase
						</span>
						<span class="io-value text-muted">New coins</span>
					{:else}
						<span class="io-addr">
							{#if vin.address}
								<a href="/explorer/address/{vin.address}" class="mono truncate">
									{truncateMiddle(vin.address, 12, 10)}
								</a>
							{:else}
								<span class="text-muted mono truncate" title={vin.txid ? `${vin.txid}:${vin.vout}` : undefined}>
									{vin.txid ? `${truncateMiddle(vin.txid, 8, 8)}:${vin.vout}` : 'Unknown'}
								</span>
							{/if}
						</span>
						<span class="io-value tabular" title={vin.value !== null ? `${formatSats(vin.value)} sats` : undefined}>
							{vin.value !== null ? `${formatBtc(vin.value)} BTC` : '—'}
						</span>
					{/if}
				</div>
			{/each}
			<div class="io-total">
				<span class="hint">Total in</span>
				<span class="tabular" title={!isCoinbase ? `${formatSats(totalIn)} sats` : undefined}>
					{isCoinbase ? '—' : `${formatBtc(totalIn)} BTC`}
				</span>
			</div>
		</div>

		<div class="io-arrow" aria-hidden="true">
			<Icon name="arrow-right" size={18} />
		</div>

		<div class="io-col">
			<span class="overline io-title">{tx.vout.length} output{tx.vout.length === 1 ? '' : 's'}</span>
			{#each tx.vout as vout, i (i)}
				<div class="io-row">
					<span class="io-addr">
						{#if vout.address}
							<a href="/explorer/address/{vout.address}" class="mono truncate">
								{truncateMiddle(vout.address, 12, 10)}
							</a>
						{:else}
							<span class="text-muted">{outputLabel(vout.scriptType)}</span>
						{/if}
					</span>
					<span class="io-end">
						{#if vout.address && inputAddresses.has(vout.address)}
							<span
								class="badge badge-accent"
								title="This output pays an address that also funded an input — leftover funds returning to the sender, like getting bills back after paying with a larger one."
							>
								Change
							</span>
						{/if}
						<span class="io-value tabular" title="{formatSats(vout.value)} sats">
							{formatBtc(vout.value)} BTC
						</span>
						{#if vout.scriptType === 'op_return'}
							<span class="badge badge-neutral" title="This output embeds data in the blockchain and is provably unspendable — the coins (if any) are destroyed.">Unspendable</span>
						{:else if vout.spent === true}
							<span class="badge badge-neutral" title="A later transaction has already consumed this output.">Spent</span>
						{:else if vout.spent === false}
							<span class="badge badge-success" title="Still part of the UTXO set — these coins sit at this address until spent.">Unspent</span>
						{/if}
					</span>
				</div>
			{/each}
			<div class="io-total">
				<span class="hint">Total out</span>
				<span class="tabular" title="{formatSats(totalOut)} sats">{formatBtc(totalOut)} BTC</span>
			</div>
			{#if tx.fee !== null}
				<div class="io-total fee-line">
					<span class="hint">Fee (in − out)</span>
					<span class="tabular text-secondary" title="{formatSats(tx.fee)} sats">{formatBtc(tx.fee)} BTC</span>
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.head {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-bottom: 16px;
		min-width: 0;
	}

	.txid {
		font-size: 19px;
		font-weight: 550;
		min-width: 0;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.status-detail {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.confs {
		margin-left: auto;
	}

	.metrics {
		display: flex;
		gap: 40px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.metric {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.metric-value {
		font-family: var(--font-serif);
		font-size: 21px;
		font-weight: 560;
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--text-muted);
		font-weight: 400;
	}

	.io {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 20px;
		align-items: start;
	}

	.io-col {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.io-title {
		margin-bottom: 4px;
	}

	.io-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		font-size: 13px;
		min-width: 0;
	}

	.io-addr {
		min-width: 0;
		display: flex;
	}

	.io-end {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.io-value {
		white-space: nowrap;
	}

	.io-arrow {
		color: var(--text-muted);
		align-self: center;
	}

	.io-total {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 10px 0;
		border-top: 1px solid var(--border-subtle);
		font-size: 13px;
		margin-top: 4px;
	}

	.fee-line {
		border-top: none;
		padding-top: 0;
		margin-top: 0;
	}

	@media (max-width: 800px) {
		.io {
			grid-template-columns: 1fr;
		}

		.io-arrow {
			justify-self: center;
			transform: rotate(90deg);
		}
	}
</style>
