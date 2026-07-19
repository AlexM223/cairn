<script lang="ts">
	/**
	 * MiningEarnings — this user's own found blocks and their maturity journey.
	 *
	 * NOT built on top of MiningRewards.svelte (cairn-vn43.9's suggested reuse)
	 * — its props (`utxos: {txid,vout,value,height}[]` + a separate `tipHeight`)
	 * don't fit the read model's shape here: getUserMiningView's blocksFound
	 * already carries a server-computed `status` ('maturing'/'mature'/
	 *'rejected') rather than a raw height to re-derive maturity from, uses
	 * `reward` instead of `value`, and — critically — has a `rejected` (reorged
	 * out) status that MiningRewards has no chip for at all. Re-deriving
	 * maturity from height+tipHeight here would just be duplicate, and
	 * incomplete, logic. A small dedicated presenter is cleaner than bending
	 * MiningRewards's contract to fit.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { formatSats, timeAgo } from '$lib/format';

	let {
		blocksFound,
		totalMaturedSats,
		totalPendingSats
	}: {
		blocksFound: {
			height: number;
			/** Null if the coinbase txid wasn't recorded (e.g. a rejected submit). */
			txid: string | null;
			vout: number;
			reward: number;
			/** ISO timestamp string, as stored — not unix seconds. */
			foundAt: string;
			status: 'maturing' | 'mature' | 'rejected';
		}[];
		totalMaturedSats: number;
		totalPendingSats: number;
	} = $props();

	const rows = $derived([...blocksFound].sort((a, b) => b.height - a.height));

	/** foundAt is an ISO string; timeAgo() takes unix seconds. */
	function foundAgo(foundAt: string): string {
		const ms = Date.parse(foundAt);
		return Number.isFinite(ms) ? timeAgo(Math.floor(ms / 1000)) : '';
	}
</script>

<section class="card card-pad earnings-card">
	<div class="row" style="gap: 8px">
		<Icon name="flame" size={15} />
		<span class="card-title grow">Block rewards</span>
	</div>

	<div class="totals">
		<div class="total">
			<span class="total-label">Spendable</span>
			<Amount sats={totalMaturedSats} size="row" />
		</div>
		<div class="total">
			<span class="total-label">Still maturing</span>
			<Amount sats={totalPendingSats} size="row" />
		</div>
	</div>

	{#if rows.length === 0}
		<p class="empty-note">
			No blocks found yet. It's a long game — see "Your odds, honestly" below.
		</p>
	{:else}
		<ul class="block-list">
			<!--
				Key on the coinbase txid (unique per found block). height:vout is NOT
				unique — regtest/reorg churn records multiple blocksFound rows at the
				same height with vout always 0, and duplicate keys make Svelte 5 throw
				each_key_duplicate during hydration, silently blanking the whole
				dashboard subtree (cairn-et5a0). Index fallback covers null-txid
				(rejected-submit) rows.
			-->
			{#each rows as row, i (row.txid ?? `${row.height}:${row.vout}:${i}`)}
				<li class="block-row">
					<div class="block-head">
						{#if row.txid}
							<a class="block-link" href={`/explorer/tx/${row.txid}`}>
								<Icon name="blocks" size={13} />
								Block {formatSats(row.height)}
							</a>
						{:else}
							<span class="block-link">
								<Icon name="blocks" size={13} />
								Block {formatSats(row.height)}
							</span>
						{/if}
						<span class="block-amount"><Amount sats={row.reward} size="inline" /></span>
					</div>
					<div class="block-meta">
						<span class="block-when">{foundAgo(row.foundAt)}</span>
						{#if row.status === 'mature'}
							<span class="status-chip mature">
								<Icon name="check" size={12} />
								Spendable
							</span>
						{:else if row.status === 'maturing'}
							<span class="status-chip maturing">
								<Icon name="clock" size={12} />
								Maturing
							</span>
						{:else}
							<!-- status 'rejected' = the submit was refused by the network
							     (submit_result 'rejected…'), NOT a reorg — the old tooltip
							     claimed the wrong failure mode (v0.2.42 QA). -->
							<span class="status-chip rejected" title="The network didn't accept this block, so its reward doesn't count.">
								Not counted
							</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.earnings-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.totals {
		display: flex;
		gap: 24px;
	}

	.total {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.total-label {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.empty-note {
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.block-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.block-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.block-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.block-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		text-decoration: none;
	}

	.block-link:hover {
		color: var(--text);
	}

	.block-amount {
		margin-left: auto;
	}

	.block-meta {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.block-when {
		font-size: 12px;
		color: var(--text-muted);
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-left: auto;
		padding: 3px 8px;
		border-radius: var(--radius-status-pill);
		font-size: 11.5px;
		font-weight: 500;
	}

	.status-chip.mature {
		color: var(--sage);
		background: var(--sage-muted);
	}

	.status-chip.maturing {
		color: var(--attention);
		background: var(--attention-muted);
	}

	.status-chip.rejected {
		color: var(--text-muted);
		background: var(--surface-elevated);
	}
</style>
