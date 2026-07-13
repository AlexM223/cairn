<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import ChainStrip from '$lib/components/heartwood/ChainStrip.svelte';
	import NodeTrustChip from '$lib/components/heartwood/NodeTrustChip.svelte';
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import CoreRpcRequiredNotice from '$lib/components/CoreRpcRequiredNotice.svelte';
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

	// The block, its transactions, and the tip are STREAMED (cairn-2zxt.3): the
	// page chrome paints instantly with a skeleton hero, then fills in when the
	// backend answers. loadBlockData never rejects — a missing block resolves to
	// `notFound`, a backend failure to `chainError`.
	type ChainData = Awaited<(typeof data)['chain']>;
	let chain = $state<ChainData | null>(null);
	$effect(() => {
		const promise = data.chain;
		let stale = false;
		void promise.then((c) => {
			if (!stale) chain = c;
		});
		return () => {
			stale = true;
		};
	});
	const loading = $derived(chain === null);
	const block = $derived(chain?.block ?? null);
	const notFound = $derived(chain?.notFound ?? false);
	const chainError = $derived(chain?.error ?? null);
	const tipHeight = $derived(chain?.tipHeight ?? null);
	const txs = $derived(chain?.txs ?? []);
	const txTotal = $derived(chain?.txTotal ?? 0);
	const txPage = $derived(chain?.txPage ?? 0);
	const txError = $derived(chain?.txError ?? null);

	const confirmations = $derived(
		block !== null && tipHeight !== null ? Math.max(1, tipHeight - block.height + 1) : null
	);
	const totalTxPages = $derived(Math.max(1, Math.ceil(txTotal / 25)));
	const hasPrev = $derived(block !== null && block.height > 0);
	const hasNext = $derived(block !== null && tipHeight !== null && block.height < tipHeight);
	const subsidy = $derived(block !== null ? blockSubsidy(block.height) : 0);

	// Locator strip data streams in after first paint (cached hard after the
	// pipeline's first-ever run).
	type StripData = Awaited<(typeof data)['strip']>;
	let strip = $state<StripData>(null);
	$effect(() => {
		const promise = data.strip;
		let stale = false;
		void promise.then((s) => {
			if (!stale && s) strip = s;
		});
		return () => {
			stale = true;
		};
	});
	const epochIndex = $derived(block !== null ? Math.floor(block.height / 2016) : 0);
	const locatorCaption = $derived.by(() => {
		if (confirmations === null) return 'where this block sits in the wood';
		if (confirmations >= 6) {
			return confirmations === 6
				? 'where this block sits in the wood — six rings under the bark'
				: 'where this block sits in the wood — sealed deep under the bark';
		}
		return `where this block sits in the wood — ${confirmations} ring${confirmations === 1 ? '' : 's'} under the bark`;
	});

	function valueOut(tx: TxDetail): number {
		return tx.vout.reduce((sum, v) => sum + v.value, 0);
	}

	// Regtest's real difficulty is a tiny fraction that formatNumber rounds to a
	// bare "0", which reads like a bug next to the other stats — show it's small
	// but non-zero instead (cairn-8sbh).
	const difficultyText = $derived(
		block !== null && block.difficulty > 0 && block.difficulty < 1
			? '<0.01'
			: block !== null
				? formatNumber(block.difficulty)
				: '—'
	);

	// Secondary header fields live behind a quiet disclosure — the hero keeps
	// the five numbers that matter, per the inline-serif-stats grammar.
	let moreOpen = $state(false);
	$effect(() => {
		void block?.hash;
		moreOpen = false;
	});
</script>

<svelte:head>
	<title>{block !== null ? `Block ${formatNumber(block.height)}` : 'Block'} — Heartwood</title>
</svelte:head>

<div class="block-page">
	<GroveField volume="present" />
	<div class="body">
		<!-- ============================================= back + prev/next -->
		<div class="top-row fade-in">
			<a
				href="/explorer"
				class="back"
				onclick={(e) => {
					e.preventDefault();
					goto('/explorer', { replaceState: true });
				}}
			>
				<Icon name="chevron-left" size={15} /> Explorer
			</a>
			{#if block}
				<div class="nav-btns">
					{#if hasPrev}
						<a href="/explorer/block/{block.height - 1}" class="btn btn-secondary btn-sm tabular">
							‹ {formatNumber(block.height - 1)}
						</a>
					{/if}
					{#if hasNext}
						<a href="/explorer/block/{block.height + 1}" class="btn btn-secondary btn-sm tabular">
							{formatNumber(block.height + 1)} ›
						</a>
					{/if}
				</div>
			{/if}
		</div>

		{#if loading}
			<!-- Streamed placeholder: hero scaffold while the block lands. -->
			<header class="hero fade-in" aria-busy="true" aria-label="Loading block">
				<div class="hero-row">
					<h1 class="hero-number hero-title skeleton">Block 000,000</h1>
				</div>
				<div class="hash-line">
					<span class="mono hash skeleton">0000000000000000000000000000000000</span>
				</div>
				<div class="stat-line">
					<span class="stat skeleton">0,000 transactions · 0.00 MB · 0.000 BTC fees</span>
				</div>
			</header>
		{:else if notFound}
			<div class="empty-state fade-in">
				<span class="empty-title">Block not found</span>
				<span>No block matches this height or hash.</span>
				<a href="/explorer" class="btn btn-secondary btn-sm">Back to explorer</a>
			</div>
		{:else if chainError && !data.coreRpcConfigured}
			<!-- Full block detail needs the operator's own Bitcoin Core node; when it
			     isn't configured, be honest about what unlocks it (cairn-zoz8.10). -->
			<CoreRpcRequiredNotice feature="Block detail" isAdmin={data.isAdmin} />
		{:else if chainError}
			<div class="block-error fade-in">
				<Banner variant="error">
					Can't reach chain data sources — {chainError}
					{#snippet actions()}
						<a href={page.url.pathname + page.url.search} class="retry">Retry</a>
					{/snippet}
				</Banner>
			</div>
		{:else if block}
			<!-- ========================================================= hero -->
			<header class="hero fade-in">
				<NodeTrustChip trust={data.nodeTrust} />
				<div class="hero-row">
					<h1 class="hero-number hero-title">Block {formatNumber(block.height)}</h1>
					{#if confirmations !== null}
						<span
							class="depth-pill"
							title="Each block mined on top of this one buries it one ring deeper. Six rings is the customary threshold for treating history as settled."
						>
							<BurialRings {confirmations} direction="in" size={16} />
							{burialRingsLabel(confirmations)}
						</span>
					{/if}
				</div>
				<div class="hash-line">
					<span class="mono hash"><CopyText value={block.hash} truncate={16} /></span>
					<span class="hash-dot" aria-hidden="true">·</span>
					<span class="mined" title={formatDateTime(block.time)}>mined {timeAgo(block.time)}</span>
					{#if block.miner}
						<span class="mined">by</span>
						<span class="miner-chip">{block.miner}</span>
					{/if}
				</div>

				<!-- inline serif stats -->
				<div class="stat-line">
					<span class="stat">
						<span class="stat-num tabular">{block.txCount === null ? '—' : formatNumber(block.txCount)}</span> transactions
					</span>
					<span class="sep" aria-hidden="true">·</span>
					<span class="stat"><span class="stat-num tabular">{block.size === null ? '—' : formatBytes(block.size)}</span></span>
					{#if block.totalFees !== null}
						<span class="sep" aria-hidden="true">·</span>
						<span class="stat">
							<Term
								tip="Every transaction pays a fee to be included. Fees are the miner's incentive — and as the subsidy halves over time, the network's long-term security budget."
							>
								<span class="stat-num fees tabular" title="{formatSats(block.totalFees)} sats">
									{formatBtc(block.totalFees)}
								</span>
							</Term>
							BTC fees
						</span>
					{/if}
					{#if block.reward !== null}
						<span class="sep" aria-hidden="true">·</span>
						<span class="stat">
							<Term
								tip="{formatBtc(subsidy)} BTC subsidy (newly created bitcoin) + {formatBtc(block.totalFees ?? Math.max(0, block.reward - subsidy))} BTC in fees, paid to the miner via the coinbase transaction."
							>
								<span class="stat-num tabular" title="{formatSats(block.reward)} sats">
									{formatBtc(block.reward)}
								</span>
							</Term>
							BTC reward
						</span>
					{/if}
					<span class="sep" aria-hidden="true">·</span>
					<span class="stat">
						nonce <span class="stat-num tabular">{formatNumber(block.nonce)}</span>
					</span>
				</div>
			</header>

			<!-- ================================================ locator strip -->
			{#if strip}
				<div class="locator fade-in">
					<ChainStrip
						epochs={strip.epochs}
						mode="locator"
						highlightIndex={Math.min(epochIndex, strip.epochCount - 1)}
						height={64}
					/>
					<div class="locator-caption">{locatorCaption}</div>
				</div>
			{/if}

			<!-- ================================================== more detail -->
		<section class="more" class:open={moreOpen}>
			<button class="more-toggle" onclick={() => (moreOpen = !moreOpen)} aria-expanded={moreOpen}>
				<span>Header detail</span>
				<span class="chev" class:rotated={moreOpen}><Icon name="chevron-down" size={14} /></span>
			</button>
			{#if moreOpen}
				<div class="kv fade-in">
					<div class="kv-row">
						<span class="kv-label">
							<Term
								tip="Blocks are limited by weight (4 million weight units), not raw bytes. SegWit signature data counts less toward the limit, which is what made blocks larger than 1 MB possible."
								>Weight</Term
							>
						</span>
						<span class="kv-value tabular">{block.weight === null ? '—' : `${formatNumber(block.weight)} WU`}</span>
					</div>
					{#if block.medianFee !== null}
						<div class="kv-row">
							<span class="kv-label">
								<Term
									tip="Half the transactions in this block paid more than this rate, half paid less — a snapshot of what confirmation cost when it was mined."
									>Median fee</Term
								>
							</span>
							<span class="kv-value tabular">{formatFeeRate(block.medianFee)}</span>
						</div>
					{/if}
					<div class="kv-row">
						<span class="kv-label">
							<Term
								tip="How hard it was to find this block. The network retunes difficulty every 2,016 blocks (~2 weeks) so blocks keep arriving about every 10 minutes."
								>Difficulty</Term
							>
						</span>
						<span class="kv-value tabular">{difficultyText}</span>
					</div>
					<div class="kv-row">
						<span class="kv-label">
							<Term
								tip="The difficulty target in the block header's compact encoding. A valid block's hash must be below the value these bits encode."
								>Bits</Term
							>
						</span>
						<span class="kv-value mono">{block.bits}</span>
					</div>
					<div class="kv-row">
						<span class="kv-label">
							<Term
								tip="Header version bits. Miners also use spare bits here to signal readiness for protocol upgrades."
								>Version</Term
							>
						</span>
						<span class="kv-value mono">0x{block.version.toString(16)}</span>
					</div>
					<div class="kv-row">
						<span class="kv-label">
							<Term
								tip="A fingerprint of every transaction in this block, folded together pairwise into a single hash. If even one transaction changed by one byte, this value would change too."
								>Merkle root</Term
							>
						</span>
						<span class="kv-value"><CopyText value={block.merkleRoot} truncate={12} /></span>
					</div>
					{#if block.prevHash}
						<div class="kv-row">
							<span class="kv-label">Previous block</span>
							<a href="/explorer/block/{block.prevHash}" class="kv-value mono truncate">
								{truncateMiddle(block.prevHash, 12, 12)}
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- =================================================== tx rows -->
		<section class="txs">
			<div class="txs-head fade-in">
				<span class="txs-title">Transactions</span>
				<span class="txs-count">
					{#if totalTxPages > 1}
						Page {txPage + 1} of {totalTxPages} · {formatNumber(txTotal)} total
					{:else}
						{formatNumber(txTotal)} transaction{txTotal === 1 ? '' : 's'}
					{/if}
				</span>
			</div>

			{#if txError}
				<Banner variant="error">Couldn't load transactions — {txError}</Banner>
			{:else if txs.length === 0}
				<div class="empty-state">
					<span class="empty-title">No transactions on this page</span>
				</div>
			{:else}
				{#each txs as tx (tx.txid)}
					<div class="tx-row">
						<a href="/explorer/tx/{tx.txid}" class="tx-id mono">
							{truncateMiddle(tx.txid, 6, 4)}
						</a>
						<span class="tx-io">
							{tx.vin.length} input{tx.vin.length === 1 ? '' : 's'} → {tx.vout.length}
							output{tx.vout.length === 1 ? '' : 's'}
							{#if tx.vin.some((v) => v.coinbase)}
								<span
									class="badge badge-accent"
									title="The special first transaction of every block: it has no inputs and creates new bitcoin — the miner's reward (subsidy plus all fees in this block)."
								>
									Coinbase
								</span>
							{/if}
						</span>
						<span class="tx-value tabular" title="{formatSats(valueOut(tx))} sats">
							{formatBtc(valueOut(tx))} BTC
						</span>
						<span class="tx-fee tabular">{formatFeeRate(tx.feeRate)}</span>
					</div>
				{/each}
			{/if}

			{#if totalTxPages > 1}
				<div class="pager">
					{#if txPage > 0}
						<a href="?page={txPage - 1}" class="btn btn-secondary btn-sm">
							<Icon name="chevron-left" size={14} /> Previous
						</a>
					{:else}
						<span></span>
					{/if}
					{#if txPage + 1 < totalTxPages}
						<a href="?page={txPage + 1}" class="btn btn-secondary btn-sm">
							Next <Icon name="chevron-right" size={14} />
						</a>
					{/if}
				</div>
			{/if}
		</section>
		{/if}

		<div class="explain">
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
		</div>
	</div>
</div>

<style>
	.block-page {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.body {
		position: relative;
		z-index: 1;
	}

	.top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.back:hover {
		color: var(--accent);
	}

	.nav-btns {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	/* --- hero --- */
	.hero {
		margin-top: 30px;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 16px;
		flex-wrap: wrap;
	}

	.hero-title {
		font-size: 46px;
		font-weight: 700;
		line-height: 1;
		color: var(--text-hero);
	}

	.depth-pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--sage);
		background: var(--sage-muted);
		padding: 6px 12px;
		border-radius: var(--radius-status-pill);
		white-space: nowrap;
	}

	.hash-line {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.hash {
		color: var(--text-secondary);
	}

	.hash-dot {
		color: var(--text-faint);
	}

	.miner-chip {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent-bright);
		background: var(--accent-muted);
		padding: 3px 8px;
		border-radius: var(--radius-badge);
		white-space: nowrap;
	}

	.stat-line {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 28px;
		font-size: 13px;
		color: var(--text-faint);
	}

	.stat-line .sep {
		color: var(--border-ghost);
	}

	.stat-num {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 19px;
		color: var(--text-rows);
	}

	.stat-num.fees {
		color: var(--accent-bright);
	}

	/* --- locator strip --- */
	.locator {
		margin-top: 32px;
	}

	.locator-caption {
		margin-top: 9px;
		font-size: 11.5px;
		color: var(--eyebrow-path);
		text-align: right;
	}

	/* --- header-detail disclosure --- */
	.more {
		margin-top: 30px;
		border-top: 1px solid var(--hairline);
	}

	.more-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 12.5px;
		font-weight: 500;
		padding: 12px 0;
		cursor: pointer;
		text-align: left;
	}

	.more-toggle:hover {
		color: var(--text-secondary);
	}

	.chev {
		margin-left: auto;
		display: inline-flex;
		transition: transform 150ms var(--ease);
	}

	.chev.rotated {
		transform: rotate(180deg);
	}

	.kv {
		padding-bottom: 8px;
	}

	.kv-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 9px 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 13px;
	}

	.kv-row:last-child {
		border-bottom: none;
	}

	.kv-label {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.kv-value {
		color: var(--text-secondary);
		min-width: 0;
		text-align: right;
	}

	/* --- transactions --- */
	.txs {
		margin-top: 34px;
	}

	.txs-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.txs-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.txs-count {
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.tx-row {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.tx-row:last-of-type {
		border-bottom: none;
	}

	.tx-id {
		width: 150px;
		flex-shrink: 0;
		font-size: 13px;
		font-weight: 500;
		color: var(--on-accent-ghost);
	}

	.tx-id:hover {
		color: var(--accent-bright);
	}

	.tx-io {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 13px;
		color: var(--text-faint);
	}

	.tx-value {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 15.5px;
		color: var(--text-rows);
		white-space: nowrap;
	}

	.tx-fee {
		width: 90px;
		flex-shrink: 0;
		text-align: right;
		font-size: 13px;
		color: var(--text-muted);
	}

	.block-error {
		margin-top: 24px;
	}

	.retry {
		color: inherit;
		text-decoration: underline;
		white-space: nowrap;
	}

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-top: 16px;
	}

	.explain {
		margin-top: 40px;
	}

	/* ================================================= mobile (≤900px) */
	@media (max-width: 900px) {
		.block-page {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.hero {
			margin-top: 22px;
		}

		.hero-title {
			font-size: 30px;
		}

		.stat-line {
			margin-top: 20px;
			gap: 10px;
		}

		.stat-num {
			font-size: 16px;
		}

		.tx-id {
			width: 96px;
			font-size: 11.5px;
		}

		.tx-io {
			font-size: 10.5px;
		}

		.tx-value {
			font-size: 13.5px;
		}

		.tx-fee {
			display: none;
		}
	}
</style>
