<!--
	Manual coin control for the Create step: a collapsed-by-default disclosure
	revealing the wallet's confirmed UTXOs as a checkbox list. Selecting none
	keeps the default behaviour (automatic coin selection over everything);
	selecting some restricts selection to exactly those coins — the server
	still runs normal selection semantics (change, send-max) over the subset.
-->
<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import { coinbaseMaturity } from '$lib/shared/coinbase';
	import {
		fetchUtxoMass,
		massChip,
		MASS_LEGEND,
		MASS_WHY_TIP,
		type UtxoMass
	} from '../../_components/signingMass';

	export interface CoinOption {
		txid: string;
		vout: number;
		value: number; // sats
		/** True when this coin is a coinbase (mining reward) output. */
		coinbase?: boolean;
		/** Block height the coin confirmed at — used for coinbase maturity. */
		height?: number;
	}

	let {
		walletId,
		utxos,
		selected = $bindable(),
		tipHeight,
		initialOpen = false,
		massEndpoint
	}: {
		/** Wallet id — the per-coin signing-mass lookup is scoped to it. */
		walletId: number;
		/** Confirmed spendable coins, sorted by value descending. */
		utxos: CoinOption[];
		/** Selected coin keys, "txid:vout". Empty = automatic selection. */
		selected: string[];
		/** Live block tip — coinbase coins are maturity-checked against it. */
		tipHeight: number;
		/** Start disclosed — used by the consolidation handoff so preselected coins are visible. */
		initialOpen?: boolean;
		/** Override the signing-mass endpoint (the multisig send flow points this at
		 *  its own /api/wallets/multisig/:id/utxo-mass). Defaults to the single-sig one. */
		massEndpoint?: string;
	} = $props();

	const keyOf = (u: CoinOption) => `${u.txid}:${u.vout}`;

	// --- coinbase maturity -------------------------------------------------
	// A coinbase (mining reward) output needs 100 confirmations before consensus
	// allows it to be spent. We compute maturity live against `tipHeight` (kept
	// fresh by the send page via onNewBlock), so rows update the moment a block
	// arrives. Non-coinbase coins are always mature. Missing height (shouldn't
	// happen for confirmed coins) is treated as immature — the safe default.
	const maturityOf = (u: CoinOption) =>
		u.coinbase === true ? coinbaseMaturity(u.height ?? 0, tipHeight) : null;
	const isImmature = (u: CoinOption) => {
		const m = maturityOf(u);
		return m !== null && !m.mature;
	};
	const anyCoinbase = $derived(utxos.some((u) => u.coinbase === true));

	// Keep an immature coinbase out of the selection. This runs whenever the set
	// of immature coins changes — e.g. a coin selected while mature that somehow
	// still reads immature, or a preseeded selection that included one. As blocks
	// arrive a maturing coin simply becomes selectable; nothing is auto-added.
	$effect(() => {
		const immatureKeys = new Set(utxos.filter(isImmature).map(keyOf));
		if (immatureKeys.size === 0) return;
		if (selected.some((k) => immatureKeys.has(k))) {
			selected = selected.filter((k) => !immatureKeys.has(k));
		}
	});

	/** Educational copy for the "Coinbase reward" badge. */
	const COINBASE_TIP =
		'This bitcoin was earned by mining a block. Coinbase rewards must wait 100 confirmations (~16 hours) before they can be spent — this protects against loss if the block is reorganized.';

	// svelte-ignore state_referenced_locally — intentional per-mount seed
	let open = $state(initialOpen);

	// --- per-coin signing mass -------------------------------------------
	// Fetched lazily on the first disclosure open, once per mount. Failure or
	// an absent endpoint degrades to no chips — coin control works unchanged.
	let masses = $state<UtxoMass[] | null>(null);
	let massLoading = $state(false);
	let massRequested = false;

	// $effect is client-only, so this covers both the toggle and initialOpen
	// without ever fetching during SSR.
	$effect(() => {
		if (!open || massRequested) return;
		massRequested = true;
		massLoading = true;
		void fetchUtxoMass(walletId, massEndpoint)
			.then((m) => (masses = m))
			.finally(() => (massLoading = false));
	});

	const massByKey = $derived(
		masses ? new Map(masses.map((m) => [`${m.txid}:${m.vout}`, m])) : null
	);
	const anyHighMass = $derived(masses?.some((m) => m.tier === 'high') ?? false);

	const selectedTotal = $derived.by(() => {
		const chosen = new Set(selected);
		return utxos.reduce((s, u) => s + (chosen.has(keyOf(u)) ? u.value : 0), 0);
	});

	function toggleCoin(u: CoinOption) {
		if (isImmature(u)) return; // immature coinbase can't be spent — never select it
		const key = keyOf(u);
		selected = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
	}

	function useAll() {
		selected = [];
	}
</script>

<div class="coin-control">
	<button
		type="button"
		class="utxo-toggle"
		aria-expanded={open}
		aria-controls="coin-control-list"
		onclick={() => (open = !open)}
	>
		<Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
		<span>Choose which coins to spend</span>
		{#if selected.length > 0}
			<span class="coin-summary tabular">
				{selected.length} selected · {formatSats(selectedTotal)} sats
			</span>
		{/if}
	</button>

	{#if open}
		<div class="coin-list fade-in" id="coin-control-list">
			<p class="hint">
				Leave everything unchecked and Cairn picks coins automatically. Check specific coins to
				spend only those.
			</p>
			{#if massLoading}
				<p class="hint mass-loading" role="status" aria-live="polite">
					<span class="spinner"></span> Checking where these coins came from…
				</p>
			{:else if anyHighMass}
				<!-- Plain-language legend — only when there is actually something to explain. -->
				<p class="mass-legend">
					{MASS_LEGEND}
					<Term tip={MASS_WHY_TIP}>Why?</Term>
				</p>
			{/if}
			{#if anyCoinbase}
				<!-- One-line explainer whenever a mining reward is present in the list. -->
				<p class="coinbase-legend">
					Some coins are mining rewards, which must reach 100 confirmations before they can be
					spent. <Term tip={COINBASE_TIP}>Why?</Term>
				</p>
			{/if}
			{#each utxos as u (keyOf(u))}
				{@const mass = massByKey?.get(keyOf(u))}
				{@const maturity = maturityOf(u)}
				{@const immature = maturity !== null && !maturity.mature}
				<label class="coin-row" class:immature>
					<input
						type="checkbox"
						checked={selected.includes(keyOf(u))}
						disabled={immature}
						onchange={() => toggleCoin(u)}
					/>
					<span class="mono coin-ref">{truncateMiddle(u.txid, 10, 8)}:{u.vout}</span>
					{#if u.coinbase}
						{#if immature && maturity}
							<Term
								tip={`This mining reward needs ${maturity.blocksRemaining} more confirmation${
									maturity.blocksRemaining === 1 ? '' : 's'
								} before it can be spent (~${maturity.etaHours} hour${
									maturity.etaHours === 1 ? '' : 's'
								}).`}
							>
								<span class="coinbase-badge immature">Coinbase reward · maturing</span>
							</Term>
						{:else}
							<Term tip={COINBASE_TIP}>
								<span class="coinbase-badge">Coinbase reward</span>
							</Term>
						{/if}
					{/if}
					{#if mass}
						{@const chip = massChip(mass)}
						{@const poolPayout = u.coinbase && mass.tier === 'high' && mass.source === 'pool-batch'}
						<span
							class="mass-chip {chip.tone}"
							title={poolPayout
								? 'Mining-pool payout — many outputs, slower to sign. The network fee is not affected.'
								: chip.title}>{poolPayout ? 'Mining-pool payout — slow to sign' : chip.label}</span
						>
					{/if}
					<span class="tabular coin-value">{formatSats(u.value)} sats</span>
				</label>
			{/each}
			<div class="coin-foot">
				{#if selected.length > 0}
					<span class="tabular coin-total">
						{selected.length} of {utxos.length} coins · {formatSats(selectedTotal)} sats selected
					</span>
					<button type="button" class="btn btn-ghost btn-sm" onclick={useAll}>
						<Icon name="x" size={13} /> Use all coins
					</button>
				{:else}
					<span class="hint">Automatic — Cairn will pick from all {utxos.length} coins.</span>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.coin-control {
		display: flex;
		flex-direction: column;
	}

	/* Same disclosure idiom as the Review step's coins-being-spent toggle. */
	.utxo-toggle {
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
	}

	.utxo-toggle:hover {
		color: var(--accent);
	}

	.coin-summary {
		margin-left: auto;
		font-size: 12px;
		color: var(--accent);
	}

	.coin-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 10px;
	}

	.coin-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
		padding: 7px 10px;
		background: var(--bg);
		border-radius: var(--radius-chip);
		cursor: pointer;
	}

	.coin-row:hover {
		outline: 1px solid var(--border);
	}

	/* Immature coinbase: grayed out and non-interactive — the disabled checkbox
	   already blocks selection; this makes the state legible at a glance. The
	   "Coinbase reward · maturing" badge stays legible (its own opacity is 1). */
	.coin-row.immature {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.coin-row.immature:hover {
		outline: none;
	}

	.coin-row input {
		accent-color: var(--accent);
		flex-shrink: 0;
	}

	.coin-row input:disabled {
		cursor: not-allowed;
	}

	.coin-ref {
		color: var(--text-muted);
	}

	/* --- coinbase (mining reward) badge --- */
	.coinbase-legend {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.coinbase-badge {
		font-size: 11px;
		font-weight: 500;
		line-height: 1.6;
		padding: 1px 7px;
		border-radius: 99px;
		white-space: nowrap;
		background: var(--surface-elevated);
		color: var(--text-secondary);
	}

	.coinbase-badge.immature {
		background: var(--warning-muted);
		color: var(--warning);
	}

	.coin-value {
		margin-left: auto;
		color: var(--text);
		flex-shrink: 0;
	}

	/* --- signing-mass chips ---
	   Same chip vocabulary as the app's badges. High mass stays in the warning
	   palette (never error-red): these coins are safe to spend — the only cost
	   is signing time. */
	.mass-chip {
		font-size: 11px;
		font-weight: 500;
		line-height: 1.6;
		padding: 1px 7px;
		border-radius: 99px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.mass-chip.low {
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.mass-chip.medium {
		background: var(--warning-muted);
		color: var(--warning);
	}

	.mass-chip.high {
		background: var(--warning-muted);
		color: var(--warning);
		border: 1px solid var(--warning-border-strong);
		font-weight: 600;
	}

	.mass-loading {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.mass-legend {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-control);
		padding: 9px 12px;
	}

	.coin-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding-top: 4px;
		font-size: 12.5px;
	}

	.coin-total {
		color: var(--text-secondary);
	}

	@media (pointer: coarse) {
		.coin-row {
			min-height: 44px;
		}
	}
</style>
