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
	import {
		formatSats,
		formatFeeRate,
		formatFiat,
		formatBtc,
		btcToFiat,
		truncateMiddle,
		chunkString
	} from '$lib/format';
	import { summarySentence } from './sendCopy';
	// R2 (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md): stake-triggered recipient
	// verification. Pure trigger/match logic lives in recipientVerify.ts —
	// this component only wires it to the card's own props/state.
	import { shouldVerifyRecipient, matchesAddressTail, addressTail } from './recipientVerify';

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
		onDetailsOpen = undefined,
		balanceSats = null,
		knownAddresses = [],
		recipientVerified = $bindable(true)
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
		/** This wallet's spendable balance, for the R2 stake-relative trigger.
		 *  Null while unknown/streaming — the flat sats floor still applies. */
		balanceSats?: number | null;
		/** Addresses this wallet has already paid or saved as a contact — the R2
		 *  first-send signal. A known address never triggers the micro-step. */
		knownAddresses?: readonly string[];
		/** Bindable: true once the R2 micro-step (if shown) is satisfied, or
		 *  always true when no check applies. The CALLER gates its own primary
		 *  CTA on this — the card stays presentational and never owns navigation. */
		recipientVerified?: boolean;
	} = $props();

	const SATS_PER_BTC = 100_000_000;
	const totalSats = $derived(amountSats + feeSats);
	const isBatch = $derived(recipients.length > 1);

	// ------------------------------------------------------- R2 recipient check
	// Gated to mode==='review' only: Confirm re-renders the same recipient a
	// moment later as a fresh card instance, and re-asking there would be a
	// second exposure to the exact same check — the habituation failure F4
	// warns against. Verification happens once, at Review, or not at all.
	const singleRecipient = $derived(!isBatch && recipients.length === 1 ? recipients[0] : null);
	// Grouped-display chunks for the single-recipient address (R2 §1) — computed
	// once per render rather than inline in the {#each} so the "last chunk"
	// index check doesn't re-run chunkString per iteration.
	const singleRecipientChunks = $derived(
		recipients.length === 1 ? chunkString(recipients[0].address) : []
	);

	const needsRecipientCheck = $derived.by(() => {
		if (mode !== 'review' || !singleRecipient) return false;
		return shouldVerifyRecipient({
			address: singleRecipient.address,
			amountSats: singleRecipient.amount,
			balanceSats,
			knownAddresses,
			isBatch
		});
	});

	const recipientTail = $derived(singleRecipient ? addressTail(singleRecipient.address) : '');

	let recipientCheckInput = $state('');
	let recipientCheckWrong = $state(false);

	// Reset the micro-step's local state whenever what it's checking changes —
	// a fresh recipient/amount on this card instance (e.g. Back & edit, then
	// Review again with a different address) never inherits a stale match or
	// a leftover "wrong" message. Also seeds `recipientVerified` for the
	// caller: true immediately when no check applies, false while one is
	// pending.
	$effect(() => {
		void needsRecipientCheck;
		void recipientTail;
		recipientCheckInput = '';
		recipientCheckWrong = false;
		recipientVerified = !needsRecipientCheck;
	});

	function checkRecipientInput() {
		if (!needsRecipientCheck) return;
		const ok = matchesAddressTail(recipientCheckInput, singleRecipient!.address);
		recipientCheckWrong = !ok;
		recipientVerified = ok;
	}

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

	// Fiat suffix for Details-expander money rows (change/total-input/per-UTXO):
	// muted "· $12.34" alongside the sats value, matching the fee-pct suffix
	// style already in the fee-rate row. Degrades to null (sats-only, no
	// broken/empty fiat text) when no price is available — same rule Amount.svelte
	// applies everywhere else money is shown.
	function fiatSuffix(sats: number): string | null {
		if ($btcUsd == null) return null;
		return formatFiat(btcToFiat(sats / SATS_PER_BTC, $btcUsd));
	}

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
			<!-- Grouped, not truncated (R2): the full address stays on screen,
			     chunked into scannable 4-char groups with the first/last group
			     emphasized and the middle muted — forensics of wrong-sends shows
			     people actually compare the ends, so the ends are what pop. -->
			<span class="recipient mono grouped" aria-label={recipients[0].address}>
				{#each singleRecipientChunks as chunk, i (i)}
					<span
						class="addr-chunk"
						class:addr-end={i === 0 || i === singleRecipientChunks.length - 1}>{chunk}</span
					>
				{/each}
			</span>
		</div>

		{#if needsRecipientCheck}
			<!-- The R2 micro-step: rare by construction (shouldVerifyRecipient),
			     and deliberately unlike anything else on this card — a distinct
			     bordered panel with its own accent, not a checkbox or a modal,
			     so it stays neurally "alive" instead of habituating (F4). Plain
			     language, no jargon, no alarm register (confident, not scary —
			     doctrine's friction-ladder tone for this stakes tier). -->
			<div class="recipient-check" class:matched={recipientVerified} role="group" aria-label="Verify recipient address">
				<div class="recipient-check-head">
					<Icon name="eye" size={15} />
					<span
						>First time sending here, and it's a meaningful amount — verify the last 4
						characters of the address.</span
					>
				</div>
				<div class="recipient-check-row">
					<label class="sr-only" for="recipient-check-input"
						>Last 4 characters of the address</label
					>
					<input
						id="recipient-check-input"
						class="recipient-check-input mono"
						type="text"
						inputmode="text"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						maxlength="8"
						placeholder="····"
						bind:value={recipientCheckInput}
						oninput={() => (recipientCheckWrong = false)}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								checkRecipientInput();
							}
						}}
					/>
					<button type="button" class="btn btn-secondary btn-sm" onclick={checkRecipientInput}>
						Check
					</button>
				</div>
				{#if recipientVerified}
					<p class="recipient-check-note ok">
						<Icon name="check" size={13} strokeWidth={2.5} /> Matches — this address is confirmed.
					</p>
				{:else if recipientCheckWrong}
					<p class="recipient-check-note wrong">
						That doesn't match "{recipientTail}" — check the address above before continuing.
					</p>
				{/if}
			</div>
		{/if}
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
					<span class="detail-val tabular"
						>{formatSats(changeSats)} sats{#if fiatSuffix(changeSats) != null}
							<span class="text-muted">· {fiatSuffix(changeSats)}</span>
						{/if}</span
					>
				</div>
			{/if}
			{#if totalIn != null}
				<div class="detail-row">
					<span class="text-secondary">Total input</span>
					<span class="detail-val tabular"
						>{formatSats(totalIn)} sats{#if fiatSuffix(totalIn) != null}
							<span class="text-muted">· {fiatSuffix(totalIn)}</span>
						{/if}</span
					>
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
								<span class="tabular"
									>{formatSats(inp.value)} sats{#if fiatSuffix(inp.value) != null}
										<span class="text-muted">· {fiatSuffix(inp.value)}</span>
									{/if}</span
								>
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
		font-weight: var(--t-hero-weight);
		font-size: 21px;
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
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

	/* Grouped address display (R2 §1): full address, chunked, first/last group
	   emphasized at full --text, middle muted — the eye verifies the ends. */
	.grouped {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0 6px;
		color: var(--text-muted);
	}

	.addr-chunk.addr-end {
		color: var(--text);
		font-weight: 600;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* R2 §2 micro-step: visually distinct from the routine card body (accent
	   border + tinted fill, not amber/red — this isn't a warning, it's a
	   recognition check) so rarity + variation keep it from habituating (F4). */
	.recipient-check {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 16px;
		border: 1px solid var(--accent-border);
		border-radius: 12px;
		background: var(--accent-muted);
	}

	.recipient-check.matched {
		border-color: var(--sage);
		background: var(--sage-muted);
	}

	.recipient-check-head {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text);
	}

	.recipient-check-head :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
		color: var(--accent);
	}

	.recipient-check-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.recipient-check-input {
		width: 6.5em;
		padding: 8px 10px;
		border: 1px solid var(--hairline);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		font-size: 15px;
		letter-spacing: 0.08em;
		text-transform: lowercase;
	}

	.recipient-check-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.recipient-check-note {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		margin: 0;
	}

	.recipient-check-note.ok {
		color: var(--sage);
	}

	.recipient-check-note.wrong {
		color: var(--attention);
	}
</style>
