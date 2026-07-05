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
	}

	let {
		walletId,
		utxos,
		selected = $bindable(),
		initialOpen = false
	}: {
		/** Wallet id — the per-coin signing-mass lookup is scoped to it. */
		walletId: number;
		/** Confirmed spendable coins, sorted by value descending. */
		utxos: CoinOption[];
		/** Selected coin keys, "txid:vout". Empty = automatic selection. */
		selected: string[];
		/** Start disclosed — used by the consolidation handoff so preselected coins are visible. */
		initialOpen?: boolean;
	} = $props();

	const keyOf = (u: CoinOption) => `${u.txid}:${u.vout}`;

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
		void fetchUtxoMass(walletId)
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
				<p class="hint mass-loading" role="status">
					<span class="spinner"></span> Checking where these coins came from…
				</p>
			{:else if anyHighMass}
				<!-- Plain-language legend — only when there is actually something to explain. -->
				<p class="mass-legend">
					{MASS_LEGEND}
					<Term tip={MASS_WHY_TIP}>Why?</Term>
				</p>
			{/if}
			{#each utxos as u (keyOf(u))}
				{@const mass = massByKey?.get(keyOf(u))}
				<label class="coin-row">
					<input
						type="checkbox"
						checked={selected.includes(keyOf(u))}
						onchange={() => toggleCoin(u)}
					/>
					<span class="mono coin-ref">{truncateMiddle(u.txid, 10, 8)}:{u.vout}</span>
					{#if mass}
						{@const chip = massChip(mass)}
						<span class="mass-chip {chip.tone}" title={chip.title}>{chip.label}</span>
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

	.coin-row input {
		accent-color: var(--accent);
		flex-shrink: 0;
	}

	.coin-ref {
		color: var(--text-muted);
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
		border: 1px solid rgba(232, 201, 90, 0.45);
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
		border: 1px solid rgba(232, 201, 90, 0.25);
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
