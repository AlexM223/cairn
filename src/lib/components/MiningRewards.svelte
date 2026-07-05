<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatBtc, formatSats } from '$lib/format';
	import { coinbaseMaturity } from '$lib/shared/coinbase';

	// Coinbase-only UTXOs (mining rewards). The caller filters upstream, so an
	// empty list here should never happen — but rendering nothing is harmless.
	let {
		utxos,
		tipHeight
	}: {
		utxos: { txid: string; vout: number; value: number; height: number }[];
		tipHeight: number;
	} = $props();

	// Sort youngest-block-first so the coins with the longest wait to maturity
	// sit at the top, where the "still cooling" story matters most.
	const rows = $derived(
		utxos
			.map((u) => ({ ...u, maturity: coinbaseMaturity(u.height, tipHeight) }))
			.toSorted((a, b) => b.height - a.height)
	);
</script>

<section class="card card-pad mining-card">
	<div class="row" style="gap: 8px">
		<Icon name="flame" size={15} />
		<span class="card-title grow">
			<Term
				tip="This bitcoin was earned by mining a block. Coinbase rewards must wait 100 confirmations (~16 hours) before they can be spent — this protects against loss if the block is reorganized."
				>Mining rewards</Term
			>
		</span>
	</div>

	<ul class="reward-list">
		{#each rows as row (`${row.txid}:${row.vout}`)}
			<li class="reward-row">
				<div class="reward-head">
					<span class="reward-block">
						<Icon name="blocks" size={13} />
						Block {formatSats(row.height)}
					</span>
					<span class="reward-amount tabular" title="{formatSats(row.value)} sats">
						{formatBtc(row.value)} BTC
					</span>
				</div>

				{#if row.maturity.mature}
					<span class="maturity mature">
						<Icon name="check" size={13} />
						Mature — spendable
					</span>
				{:else}
					<div class="maturity immature">
						<div class="immature-line">
							<Icon name="clock" size={13} />
							<span class="immature-label">
								Immature — {formatSats(row.maturity.confirmations)}/{row.maturity.required} confirmations
							</span>
							<span class="immature-eta">~{row.maturity.etaHours}h until spendable</span>
						</div>
						<div
							class="progress-track"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={row.maturity.required}
							aria-valuenow={row.maturity.confirmations}
							aria-label="Confirmations toward maturity"
						>
							<div
								class="progress-fill"
								style="width: {Math.min(
									100,
									(row.maturity.confirmations / row.maturity.required) * 100
								)}%"
							></div>
						</div>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<style>
	.mining-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 18px;
	}

	.reward-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.reward-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.reward-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.reward-block {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.reward-block :global(svg) {
		align-self: center;
	}

	.reward-amount {
		margin-left: auto;
		font-weight: 500;
		font-size: 13.5px;
	}

	.maturity {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}

	.maturity.mature {
		color: var(--success);
	}

	.maturity.immature {
		display: flex;
		flex-direction: column;
		gap: 7px;
		color: var(--text-muted);
	}

	.immature-line {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.immature-label {
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.immature-eta {
		margin-left: auto;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.progress-track {
		width: 100%;
		height: 5px;
		border-radius: 99px;
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: 99px;
		background: var(--text-secondary);
		transition: width 200ms var(--ease);
	}
</style>
