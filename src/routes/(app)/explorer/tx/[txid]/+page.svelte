<script lang="ts">
	import { copyToClipboard } from '$lib/clipboard';
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

	// Replace-by-fee timeline (oldest → newest). The newest entry is the only
	// version that can still confirm; if it isn't the tx being viewed, this
	// page shows a stale version.
	const rbf = $derived(data.rbf);
	const newestRbf = $derived(rbf ? rbf.chain[rbf.chain.length - 1] : null);
	const replacedByNewer = $derived(newestRbf !== null && newestRbf.txid !== tx.txid);

	// CPFP only matters when the package rate meaningfully differs (>5%) from
	// this transaction's own fee rate — otherwise the child changes nothing.
	const cpfp = $derived(data.cpfp);
	const cpfpActive = $derived(
		cpfp !== null &&
			tx.feeRate !== null &&
			tx.feeRate > 0 &&
			Math.abs(cpfp.effectiveFeeRate - tx.feeRate) / tx.feeRate > 0.05
	);

	// Per-row script disclosures and the raw-hex viewer; reset on navigation
	// since the component instance is reused across tx pages.
	let openInputScripts = $state<Record<number, boolean>>({});
	let openOutputScripts = $state<Record<number, boolean>>({});
	let rawOpen = $state(false);
	let hexCopied = $state(false);

	$effect(() => {
		void tx.txid;
		openInputScripts = {};
		openOutputScripts = {};
		rawOpen = false;
		hexCopied = false;
	});

	async function copyRawHex() {
		if (!data.rawHex) return;
		if (!(await copyToClipboard(data.rawHex))) return;
		hexCopied = true;
		setTimeout(() => (hexCopied = false), 1500);
	}

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

{#if data.replacedFrom}
	<div class="replaced-note fade-in" role="status">
		<Icon name="refresh" size={15} />
		<span>
			The transaction you followed
			(<span class="mono">{truncateMiddle(data.replacedFrom, 8, 8)}</span>) was replaced by
			this one — the sender rebroadcast it with a higher fee, and only this version can
			confirm.
		</span>
	</div>
{/if}

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
	{#if cpfpActive && cpfp && tx.feeRate !== null}
		{#if cpfp.effectiveFeeRate > tx.feeRate}
			<Term
				tip="A child transaction spending this one pays a higher fee, so miners evaluate them as a package at {cpfp.effectiveFeeRate} sat/vB — the child pays for the parent."
			>
				<span class="badge badge-success"><Icon name="zap" size={11} /> CPFP</span>
			</Term>
		{:else}
			<Term
				tip="This transaction is chained to unconfirmed lower-fee ancestors, so miners evaluate the whole package at {cpfp.effectiveFeeRate} sat/vB — it confirms slower than its own rate suggests."
			>
				<span class="badge badge-warning"><Icon name="clock" size={11} /> Fee package</span>
			</Term>
		{/if}
	{/if}
</section>

<!-- Replacement history -->
{#if rbf}
	<section class="card card-pad rbf fade-in">
		<div class="rbf-head">
			<span class="overline">
				<Term
					tip="Replace-by-fee: the sender rebroadcast this payment with a higher fee to speed it up. Every version conflicts with the others by spending the same inputs, so only one can ever confirm."
					>Replacement history</Term
				>
			</span>
			{#if rbf.fullRbf}
				<Term
					tip="This transaction was replaced without signalling replaceability (BIP125). Some miners and nodes accept any higher-fee replacement regardless of signalling — a policy known as full-RBF."
				>
					<span class="badge badge-neutral">full-RBF</span>
				</Term>
			{/if}
		</div>
		{#if replacedByNewer && newestRbf}
			<div class="replaced-callout" role="alert">
				<Icon name="refresh" size={15} />
				<span>
					This transaction was replaced —
					<a href="/explorer/tx/{newestRbf.txid}">see the current version</a>.
				</span>
			</div>
		{/if}
		<ol class="rbf-chain">
			{#each rbf.chain as step, i (step.txid)}
				<li class="rbf-step">
					<span class="rbf-dot" class:current={i === rbf.chain.length - 1} aria-hidden="true"
					></span>
					<span class="rbf-txid">
						{#if step.txid === tx.txid}
							<span class="mono">{truncateMiddle(step.txid, 10, 10)}</span>
							<span class="badge badge-accent">you are here</span>
						{:else}
							<a href="/explorer/tx/{step.txid}" class="mono">
								{truncateMiddle(step.txid, 10, 10)}
							</a>
						{/if}
						{#if i === rbf.chain.length - 1}
							<span class="badge badge-success">current version</span>
						{/if}
					</span>
					<span
						class="rbf-time text-muted"
						title={step.time !== null ? formatDateTime(step.time) : undefined}
					>
						{step.time !== null ? timeAgo(step.time) : '—'}
					</span>
				</li>
			{/each}
		</ol>
	</section>
{/if}

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
		{#if cpfpActive && cpfp}
			<span class="hint cpfp-hint">
				effective <span class="tabular">{formatFeeRate(cpfp.effectiveFeeRate)}</span> via CPFP
				{#if cpfp.descendants[0]}
					— child
					<a href="/explorer/tx/{cpfp.descendants[0]}" class="mono">
						{truncateMiddle(cpfp.descendants[0], 6, 6)}
					</a>
				{/if}
			</span>
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
				<div class="io-item">
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
						{#if vin.scriptSig || vin.witness}
							<button
								type="button"
								class="script-toggle"
								aria-expanded={openInputScripts[i] === true}
								title="Show the unlocking data that proves this input may be spent"
								onclick={() => (openInputScripts[i] = !openInputScripts[i])}
							>
								<Icon name={openInputScripts[i] ? 'chevron-down' : 'chevron-right'} size={11} />
								script
							</button>
						{/if}
					</div>
					{#if openInputScripts[i]}
						<div class="script-detail">
							{#if vin.scriptSig}
								<span class="script-label">scriptSig</span>
								<span class="script-hex mono">{vin.scriptSig}</span>
							{/if}
							{#if vin.witness}
								<span class="script-label">witness</span>
								{#each vin.witness as item, w (w)}
									<span class="script-hex mono">{item === '' ? '(empty)' : item}</span>
								{/each}
							{/if}
						</div>
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
				<div class="io-item">
					<div class="io-row">
						<span class="io-addr">
							{#if vout.address}
								<a href="/explorer/address/{vout.address}" class="mono truncate">
									{truncateMiddle(vout.address, 12, 10)}
								</a>
							{:else}
								<span class="text-muted truncate">{outputLabel(vout.scriptType)}</span>
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
							<button
								type="button"
								class="script-toggle"
								aria-expanded={openOutputScripts[i] === true}
								title="Show the locking script that guards these coins"
								onclick={() => (openOutputScripts[i] = !openOutputScripts[i])}
							>
								<Icon name={openOutputScripts[i] ? 'chevron-down' : 'chevron-right'} size={11} />
								script
							</button>
						</span>
					</div>
					{#if openOutputScripts[i]}
						<div class="script-detail">
							<span class="script-label">scriptPubKey</span>
							<span class="script-hex mono">{vout.scriptPubKey}</span>
						</div>
					{/if}
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

<!-- Raw hex -->
{#if data.rawHex !== null || data.rawTooLarge}
	<section class="raw fade-in" class:open={rawOpen}>
		<button class="raw-toggle" onclick={() => (rawOpen = !rawOpen)} aria-expanded={rawOpen}>
			<Icon name="eye" size={15} />
			<span>Raw transaction</span>
			<span class="chev" class:rotated={rawOpen}><Icon name="chevron-down" size={14} /></span>
		</button>
		{#if rawOpen}
			<div class="raw-body fade-in">
				{#if data.rawHex !== null}
					<p class="raw-caption">
						<Term
							tip="Every field on this page is decoded from these bytes. Nodes relay, verify, and store transactions in exactly this serialized form; the txid is a hash of it."
							>The exact bytes</Term
						>
						this transaction is made of — {formatBytes(data.rawHex.length / 2)} of
						serialized data.
						<button type="button" class="btn btn-ghost btn-sm raw-copy" onclick={copyRawHex}>
							<Icon name={hexCopied ? 'check' : 'copy'} size={13} />
							{hexCopied ? 'Copied' : 'Copy hex'}
						</button>
					</p>
					<div class="raw-hex mono">{data.rawHex}</div>
				{:else}
					<p class="raw-caption">
						This transaction serializes to {formatBytes(tx.size)} — too large to display
						here. The decoded inputs and outputs above tell the full story.
					</p>
				{/if}
			</div>
		{/if}
	</section>
{/if}

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

	.replaced-note {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 13px;
		line-height: 1.55;
		color: var(--accent);
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.3);
		border-radius: var(--radius-control);
		padding: 10px 13px;
		margin-bottom: 14px;
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

	/* ---------- Replacement history ---------- */

	.rbf {
		margin-bottom: 14px;
	}

	.rbf-head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.replaced-callout {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--accent);
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.35);
		border-radius: var(--radius-control);
		padding: 9px 12px;
		margin-bottom: 12px;
	}

	.replaced-callout a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
		font-weight: 500;
	}

	.rbf-chain {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.rbf-step {
		position: relative;
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 5px 0 5px 22px;
		font-size: 13px;
		min-width: 0;
	}

	/* The connecting line between dots. */
	.rbf-step:not(:last-child)::after {
		content: '';
		position: absolute;
		left: 3.5px;
		top: calc(50% + 8px);
		bottom: calc(-50% + 8px);
		width: 1px;
		background: var(--border);
	}

	.rbf-dot {
		position: absolute;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--surface-elevated);
		border: 1px solid var(--text-muted);
	}

	.rbf-dot.current {
		background: var(--success);
		border-color: var(--success);
	}

	.rbf-txid {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.rbf-time {
		margin-left: auto;
		font-size: 12.5px;
		white-space: nowrap;
	}

	.cpfp-hint {
		max-width: 220px;
	}

	/* ---------- Script disclosures ---------- */

	.io-item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.script-toggle {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		background: none;
		border: none;
		padding: 2px 4px;
		margin: -2px -4px;
		font-family: var(--font-ui);
		font-size: 11px;
		color: var(--text-muted);
		cursor: pointer;
		border-radius: var(--radius-control);
		flex-shrink: 0;
	}

	.script-toggle:hover {
		color: var(--text-secondary);
		background: var(--surface-elevated);
	}

	.script-detail {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-top: 4px;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.script-label {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.script-hex {
		font-size: 11px;
		color: var(--text-secondary);
		word-break: break-all;
		line-height: 1.55;
		min-width: 0;
	}

	/* ---------- Raw hex ---------- */

	.raw {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		background: var(--surface);
		margin-top: 14px;
	}

	.raw-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 10px 14px;
		cursor: pointer;
		text-align: left;
	}

	.raw-toggle:hover {
		color: var(--text);
	}

	.chev {
		margin-left: auto;
		display: inline-flex;
		transition: transform 150ms var(--ease);
	}

	.chev.rotated {
		transform: rotate(180deg);
	}

	.raw-body {
		padding: 2px 14px 14px 37px;
		min-width: 0;
	}

	.raw-caption {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 0 0 10px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.raw-copy {
		margin-left: auto;
	}

	.raw-hex {
		max-height: 200px;
		overflow: auto;
		font-size: 11.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		word-break: break-all;
		white-space: pre-wrap;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 10px 12px;
	}

	@media (max-width: 800px) {
		.io {
			grid-template-columns: 1fr;
		}

		.io-arrow {
			justify-self: center;
			transform: rotate(90deg);
		}

		.rbf-time {
			margin-left: 0;
			width: 100%;
			padding-left: 0;
		}

		.raw-body {
			padding-left: 14px;
		}
	}
</style>
