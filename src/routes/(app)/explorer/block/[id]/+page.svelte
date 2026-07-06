<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { blockSubsidy } from '$lib/bitcoin';
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
	import type { TxDetail } from '$lib/types';

	let { data } = $props();

	const block = $derived(data.block);
	const confirmations = $derived(
		data.tipHeight !== null ? Math.max(1, data.tipHeight - block.height + 1) : null
	);
	const totalTxPages = $derived(Math.max(1, Math.ceil(data.txTotal / 25)));
	const hasPrev = $derived(block.height > 0);
	const hasNext = $derived(data.tipHeight !== null && block.height < data.tipHeight);
	const subsidy = $derived(blockSubsidy(block.height));

	function valueOut(tx: TxDetail): number {
		return tx.vout.reduce((sum, v) => sum + v.value, 0);
	}

	// Regtest's real difficulty is a tiny fraction that formatNumber rounds to a
	// bare "0", which reads like a bug next to the other stats — show it's small
	// but non-zero instead (cairn-8sbh).
	const difficultyText = $derived(
		block.difficulty > 0 && block.difficulty < 1 ? '<0.01' : formatNumber(block.difficulty)
	);
</script>

<svelte:head>
	<title>Block {formatNumber(block.height)} — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<div class="head-text">
		<span class="overline">Block</span>
		<h1 class="hero-number height">{formatNumber(block.height)}</h1>
		<div class="hash mono text-secondary">
			<span class="overline">
				<Term
					tip="A unique fingerprint created by double-hashing the block header. The long run of leading zeros is not decoration — it is the proof of work itself."
					>Hash</Term
				>
			</span>
			<CopyText value={block.hash} truncate={16} />
		</div>
		<div class="meta">
			<span title={formatDateTime(block.time)}>
				<Icon name="clock" size={13} />
				{formatDateTime(block.time)} · {timeAgo(block.time)}
			</span>
			{#if confirmations !== null}
				<span
					class="badge badge-success"
					title="Each block mined on top of this one makes it exponentially harder to reverse. Six confirmations is the customary threshold for treating history as settled."
				>
					<Icon name="check" size={12} />
					{formatNumber(confirmations)} confirmation{confirmations === 1 ? '' : 's'}
				</span>
			{/if}
			{#if block.miner}
				<span
					class="badge badge-neutral"
					title="Mined by {block.miner} — the pool whose hardware found a header hash below the difficulty target, winning the right to add this block."
				>
					<Icon name="flame" size={11} />
					{block.miner}
				</span>
			{/if}
		</div>
	</div>
	<div class="nav-btns">
		{#if hasPrev}
			<a href="/explorer/block/{block.height - 1}" class="btn btn-secondary btn-sm">
				<Icon name="chevron-left" size={14} /> {formatNumber(block.height - 1)}
			</a>
		{/if}
		{#if hasNext}
			<a href="/explorer/block/{block.height + 1}" class="btn btn-secondary btn-sm">
				{formatNumber(block.height + 1)} <Icon name="chevron-right" size={14} />
			</a>
		{/if}
	</div>
</div>

<HowItWorks id="block">
	<p>
		<strong>A block is a bundle of confirmed transactions</strong> added to the blockchain
		roughly every ten minutes. Miners compete to find a valid block by hashing its header
		over and over until the result falls below the network's difficulty target — proof that
		real work was spent.
	</p>
	<p>
		The winning miner collects the <strong>block reward</strong>: newly created bitcoin (the
		subsidy) plus every fee paid by the transactions inside. Each block references the hash
		of the one before it, forming the chain that makes rewriting history impractical.
	</p>
</HowItWorks>

<section class="card card-pad fade-in details-card">
	<div class="details">
		<div class="detail">
			<span class="overline">Transactions</span>
			<span class="detail-value tabular">{formatNumber(block.txCount)}</span>
		</div>
		<div class="detail">
			<span class="overline">Size</span>
			<span class="detail-value tabular">{formatBytes(block.size)}</span>
		</div>
		<div class="detail">
			<span class="overline">
				<Term
					tip="Blocks are limited by weight (4 million weight units), not raw bytes. SegWit signature data counts less toward the limit, which is what made blocks larger than 1 MB possible."
					>Weight</Term
				>
			</span>
			<span class="detail-value tabular">{formatNumber(block.weight)} WU</span>
		</div>
		{#if block.totalFees !== null}
			<div class="detail">
				<span class="overline">
					<Term
						tip="Every transaction pays a fee to be included. Fees are the miner's incentive to pick your transaction from the mempool — and as the subsidy halves over time, they become the network's long-term security budget."
						>Total fees</Term
					>
				</span>
				<span class="detail-value tabular" title="{formatSats(block.totalFees)} sats">
					{formatBtc(block.totalFees)} BTC
				</span>
			</div>
		{/if}
		{#if block.reward !== null}
			<div class="detail">
				<span class="overline">
					<Term
						tip="{formatBtc(subsidy)} BTC subsidy (newly created bitcoin) + {formatBtc(block.totalFees ?? Math.max(0, block.reward - subsidy))} BTC in fees = {formatBtc(block.reward)} BTC paid to the miner via the coinbase transaction."
						>Block reward</Term
					>
				</span>
				<span class="detail-value tabular" title="{formatSats(block.reward)} sats">
					{formatBtc(block.reward)} BTC
				</span>
			</div>
		{/if}
		{#if block.medianFee !== null}
			<div class="detail">
				<span class="overline">
					<Term
						tip="Half the transactions in this block paid more than this rate, half paid less — a snapshot of what confirmation cost when it was mined."
						>Median fee</Term
					>
				</span>
				<span class="detail-value tabular">{formatFeeRate(block.medianFee)}</span>
			</div>
		{/if}
		<div class="detail">
			<span class="overline">
				<Term
					tip="How hard it was to find this block. The network retunes difficulty every 2,016 blocks (~2 weeks) so blocks keep arriving about every 10 minutes no matter how much mining hardware joins."
					>Difficulty</Term
				>
			</span>
			<span class="detail-value tabular">{difficultyText}</span>
		</div>
		<div class="detail">
			<span class="overline">
				<Term
					tip="The number miners changed over and over to get a different header hash — the knob they turn while searching for a hash below the target. Finding it is the 'work' in proof of work."
					>Nonce</Term
				>
			</span>
			<span class="detail-value tabular">{formatNumber(block.nonce)}</span>
		</div>
		<div class="detail">
			<span class="overline">
				<Term
					tip="The difficulty target in the block header's compact encoding. A valid block's hash must be below the value these bits encode."
					>Bits</Term
				>
			</span>
			<span class="detail-value mono">{block.bits}</span>
		</div>
		<div class="detail">
			<span class="overline">
				<Term
					tip="Header version bits. Miners also use spare bits here to signal readiness for protocol upgrades."
					>Version</Term
				>
			</span>
			<span class="detail-value mono">0x{block.version.toString(16)}</span>
		</div>
		<div class="detail wide">
			<span class="overline">
				<Term
					tip="A fingerprint of every transaction in this block, folded together pairwise into a single hash. If even one transaction changed by one byte, this value would change too."
					>Merkle root</Term
				>
			</span>
			<span class="detail-value"><CopyText value={block.merkleRoot} truncate={12} /></span>
		</div>
		{#if block.prevHash}
			<div class="detail wide">
				<span class="overline">Previous block</span>
				<a href="/explorer/block/{block.prevHash}" class="detail-value mono truncate">
					{truncateMiddle(block.prevHash, 12, 12)}
				</a>
			</div>
		{/if}
	</div>
</section>

<section class="card fade-in">
	<div class="txs-head">
		<Icon name="activity" size={17} />
		<span class="card-title">{formatNumber(data.txTotal)} transaction{data.txTotal === 1 ? '' : 's'}</span>
		{#if totalTxPages > 1}
			<span class="hint pages">Page {data.txPage + 1} of {totalTxPages}</span>
		{/if}
	</div>

	{#if data.txError}
		<div class="form-error tx-error" role="alert">
			<Icon name="alert-triangle" size={15} />
			<span>Couldn't load transactions — {data.txError}</span>
		</div>
	{:else if data.txs.length === 0}
		<div class="empty-state">
			<span class="empty-title">No transactions on this page</span>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>Txid</th>
						<th></th>
						<th class="num">In → Out</th>
						<th class="num">Value out</th>
						<th class="num">Fee rate</th>
					</tr>
				</thead>
				<tbody>
					{#each data.txs as tx (tx.txid)}
						<tr>
							<td>
								<a href="/explorer/tx/{tx.txid}" class="mono">{truncateMiddle(tx.txid, 10, 10)}</a>
							</td>
							<td>
								{#if tx.vin.some((v) => v.coinbase)}
									<span
										class="badge badge-accent"
										title="The special first transaction of every block: it has no inputs and creates new bitcoin — the miner's reward (subsidy plus all fees in this block)."
									>
										<Icon name="flame" size={11} /> Coinbase
									</span>
								{/if}
							</td>
							<td class="num text-muted">{tx.vin.length} → {tx.vout.length}</td>
							<td class="num" title="{formatSats(valueOut(tx))} sats">{formatBtc(valueOut(tx))} BTC</td>
							<td class="num text-muted">{formatFeeRate(tx.feeRate)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if totalTxPages > 1}
		<div class="pager">
			{#if data.txPage > 0}
				<a href="?page={data.txPage - 1}" class="btn btn-secondary btn-sm">
					<Icon name="chevron-left" size={14} /> Previous
				</a>
			{:else}
				<span></span>
			{/if}
			{#if data.txPage + 1 < totalTxPages}
				<a href="?page={data.txPage + 1}" class="btn btn-secondary btn-sm">
					Next <Icon name="chevron-right" size={14} />
				</a>
			{/if}
		</div>
	{/if}
</section>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 16px;
	}

	.head-text {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	.height {
		font-size: 42px;
	}

	.hash {
		font-size: 13px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		color: var(--text-secondary);
		font-size: 13px;
		margin-top: 2px;
	}

	.meta > span:first-child {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.nav-btns {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	.details-card {
		margin-bottom: 14px;
	}

	.details {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 18px 24px;
	}

	.detail {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.detail.wide {
		grid-column: span 2;
	}

	.detail-value {
		font-size: 14px;
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

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		border-top: 1px solid var(--border-subtle);
	}

	@media (max-width: 600px) {
		.detail.wide {
			grid-column: span 1;
		}
	}
</style>
