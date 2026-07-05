<!--
	Manual coin control for the Create step: a collapsed-by-default disclosure
	revealing the wallet's confirmed UTXOs as a checkbox list. Selecting none
	keeps the default behaviour (automatic coin selection over everything);
	selecting some restricts selection to exactly those coins — the server
	still runs normal selection semantics (change, send-max) over the subset.
-->
<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';

	export interface CoinOption {
		txid: string;
		vout: number;
		value: number; // sats
	}

	let {
		utxos,
		selected = $bindable()
	}: {
		/** Confirmed spendable coins, sorted by value descending. */
		utxos: CoinOption[];
		/** Selected coin keys, "txid:vout". Empty = automatic selection. */
		selected: string[];
	} = $props();

	const keyOf = (u: CoinOption) => `${u.txid}:${u.vout}`;

	let open = $state(false);

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
			{#each utxos as u (keyOf(u))}
				<label class="coin-row">
					<input
						type="checkbox"
						checked={selected.includes(keyOf(u))}
						onchange={() => toggleCoin(u)}
					/>
					<span class="mono coin-ref">{truncateMiddle(u.txid, 10, 8)}:{u.vout}</span>
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
