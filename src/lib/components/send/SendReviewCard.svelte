<script lang="ts">
	// Shared plain-language REVIEW/CONFIRM surface (cairn-krwp). Pure
	// presentational: no fetches, no plumbing. Reads canonical sats + the review
	// shape both send pages already have and renders the fiat-primary layout the
	// UX spec calls for (summary sentence → money hero → recipient → fee as money
	// + arrival → total-out → one calm irreversibility line → a single Details
	// expander holding ALL technical detail).
	import type { Snippet } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { btcUsd } from '$lib/price';
	import { formatSats, formatFeeRate, formatFiat, formatBtc, truncateMiddle } from '$lib/format';
	import { summarySentence } from './sendCopy';

	type ReviewRecipient = { address: string; amount: number };
	type ReviewInput = { txid: string; vout: number; value: number | null };

	let {
		mode,
		amountSats,
		recipients,
		feeSats,
		feeRate,
		changeSats = null,
		inputs = [],
		vsize = null,
		recipientLabel = null,
		arrivalWords,
		multisig = null,
		detailExtra = undefined,
		onDetailsOpen = undefined
	}: {
		mode: 'review' | 'confirm';
		amountSats: number;
		recipients: ReviewRecipient[];
		feeSats: number;
		feeRate: number;
		changeSats?: number | null;
		inputs?: ReviewInput[];
		vsize?: number | null;
		recipientLabel?: string | null;
		arrivalWords: string;
		multisig?: { threshold: number; keysTotal: number; quorumLabel: string } | null;
		detailExtra?: Snippet;
		/** Fired the first time the Details expander opens — lets a page trigger a
		 *  lazy fetch (e.g. multisig per-coin signing masses) only when revealed. */
		onDetailsOpen?: () => void;
	} = $props();

	const SATS_PER_BTC = 100_000_000;
	const totalSats = $derived(amountSats + feeSats);
	const isBatch = $derived(recipients.length > 1);

	const feePct = $derived.by(() => {
		if (amountSats <= 0) return null;
		return (feeSats / amountSats) * 100;
	});

	const recipientText = $derived.by(() => {
		if (isBatch || recipients.length === 0) return '';
		return recipientLabel ?? truncateMiddle(recipients[0].address, 8, 8);
	});

	// The amount string for the summary sentence: "$250.00 (0.0031 BTC)" when a
	// price is known, else "0.0031 BTC". Display-only text (Amount.svelte owns
	// every visual money readout).
	const amountText = $derived.by(() => {
		const btc = `${formatBtc(amountSats)} BTC`;
		if ($btcUsd == null) return btc;
		return `${formatFiat((amountSats / SATS_PER_BTC) * $btcUsd)} (${btc})`;
	});

	const sentence = $derived(
		summarySentence({
			amountText,
			recipientText,
			arrivalWords,
			isBatch,
			recipientCount: recipients.length,
			multisig: multisig ? { threshold: multisig.threshold, keysTotal: multisig.keysTotal } : null
		})
	);

	const totalIn = $derived.by(() => {
		if (inputs.length === 0) return null;
		return inputs.every((i) => i.value != null)
			? inputs.reduce((s, i) => s + (i.value ?? 0), 0)
			: null;
	});

	const irreversibility = $derived.by(() => {
		if (mode === 'confirm') {
			return "Broadcasting hands this transaction to the network. Once it's broadcast, there is no undo.";
		}
		if (multisig) {
			return `Check every detail now — ${multisig.threshold} devices will each confirm this exact transaction, and once broadcast it can't be reversed.`;
		}
		return "Bitcoin payments can't be undone once sent. Double-check the address above.";
	});

	let detailsOpen = $state(false);
</script>

<div class="review-card">
	<p class="summary-sentence">{sentence}</p>

	<div class="money-hero">
		<Amount sats={amountSats} size="hero" />
	</div>

	{#if isBatch}
		<div class="recipient-rows">
			{#each recipients as r, i (i)}
				<div class="recipient-row">
					<Amount sats={r.amount} size="inline" />
					<span class="recipient mono">{truncateMiddle(r.address, 10, 8)}</span>
				</div>
			{/each}
		</div>
	{:else if recipients.length === 1}
		<div class="recipient-line">
			<span class="recipient-to">To</span>
			<span class="recipient-name">{recipientLabel ?? truncateMiddle(recipients[0].address, 12, 10)}</span>
			<span class="recipient mono">{recipients[0].address}</span>
		</div>
	{/if}

	<div class="core-rows">
		<div class="core-row">
			<span class="core-label">Network fee</span>
			<span class="core-val">
				<Amount sats={feeSats} size="inline" />
				<span class="arrival">· arrives in {arrivalWords}</span>
			</span>
		</div>
		<div class="core-row total">
			<span class="core-label">Total from wallet</span>
			<Amount sats={totalSats} size="inline" />
		</div>
	</div>

	<p class="step-lead">{irreversibility}</p>

	<button
		class="details-toggle"
		aria-expanded={detailsOpen}
		aria-controls="review-details"
		onclick={() => {
			detailsOpen = !detailsOpen;
			if (detailsOpen) onDetailsOpen?.();
		}}
	>
		<Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
		<span>Details</span>
	</button>

	{#if detailsOpen}
		<div class="detail-list fade-in" id="review-details">
			<div class="detail-row">
				<span class="text-secondary">Fee rate</span>
				<span class="detail-val tabular">
					{formatFeeRate(feeRate)}
					{#if feePct != null}
						<span class="text-muted">· {feePct < 0.01 ? '<0.01' : feePct.toFixed(2)}% of amount</span>
					{/if}
				</span>
			</div>
			{#if multisig}
				<div class="detail-row">
					<span class="text-secondary">Signatures required</span>
					<span class="detail-val">{multisig.quorumLabel}</span>
				</div>
			{/if}
			{#if vsize != null && vsize > 0}
				<div class="detail-row">
					<span class="text-secondary">Transaction size</span>
					<span class="detail-val tabular">{formatSats(vsize)} vbytes</span>
				</div>
			{/if}
			{#if changeSats != null}
				<div class="detail-row">
					<span class="text-secondary">Change back to your wallet</span>
					<span class="detail-val tabular">{formatSats(changeSats)} sats</span>
				</div>
			{/if}
			{#if totalIn != null}
				<div class="detail-row">
					<span class="text-secondary">Total input</span>
					<span class="detail-val tabular">{formatSats(totalIn)} sats</span>
				</div>
			{/if}
			{#if inputs.length > 0}
				<div class="detail-row coins">
					<span class="text-secondary"
						>Coins being spent ({inputs.length} {inputs.length === 1 ? 'input' : 'inputs'})</span
					>
				</div>
				<div class="utxo-list">
					{#each inputs as inp (inp.txid + inp.vout)}
						<div class="utxo-row">
							<span class="mono text-muted">{truncateMiddle(inp.txid, 10, 8)}:{inp.vout}</span>
							{#if inp.value != null}
								<span class="tabular">{formatSats(inp.value)} sats</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#if detailExtra}
				{@render detailExtra()}
			{/if}
		</div>
	{/if}
</div>

<style>
	.review-card {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.summary-sentence {
		font-family: var(--font-serif);
		font-size: 21px;
		line-height: 1.4;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.money-hero {
		display: flex;
	}

	.recipient-rows {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.recipient-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.recipient-line {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.recipient-to {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.recipient-name {
		font-size: 15px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.recipient {
		font-size: 13px;
		word-break: break-all;
		max-width: 100%;
		color: var(--text-muted);
	}

	.core-rows {
		display: flex;
		flex-direction: column;
	}

	.core-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.core-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.core-label {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.core-row.total .core-label {
		font-weight: 600;
		color: var(--text);
	}

	.core-val {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.arrival {
		font-size: 12px;
		color: var(--text-muted);
	}

	.step-lead {
		font-size: 14px;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.details-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 0;
		cursor: pointer;
		align-self: flex-start;
	}

	.details-toggle:hover {
		color: var(--accent);
	}

	.detail-list {
		display: flex;
		flex-direction: column;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.detail-row.coins {
		border-bottom: none;
		padding-bottom: 4px;
	}

	.detail-val {
		color: var(--text-rows);
		font-weight: 500;
		text-align: right;
	}

	.utxo-list {
		display: flex;
		flex-direction: column;
	}

	.utxo-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.utxo-row:last-child {
		border-bottom: none;
	}
</style>
