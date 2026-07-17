<script lang="ts">
	/**
	 * AdminBlocksLedger — blocks this pool's users have found (cairn-vn43.10).
	 * Sats-first (MUST): reward is the grouped-digit sats figure, no fiat.
	 * Status chip: maturing = attention gold (in progress, not yet spendable),
	 * mature = sage (settled, healthy), rejected = error red — a genuinely
	 * invalid/orphaned find is the one case here that fits the manifesto's
	 * "red is destructive/irrecoverable-failure only" reservation.
	 */
	import { formatSats, formatNumber, formatDateTime } from '$lib/format';
	import type { AdminBlockRow } from './adminMiningView';

	let { blocks }: { blocks: AdminBlockRow[] } = $props();

	/** `foundAt` is the DB's ISO datetime string — formatDateTime wants unix seconds. */
	function foundAtLabel(iso: string): string {
		const ms = Date.parse(iso);
		return Number.isFinite(ms) ? formatDateTime(Math.floor(ms / 1000)) : '—';
	}

	const CHIP_CLASS: Record<AdminBlockRow['status'], string> = {
		maturing: 'badge-warning',
		mature: 'badge-success',
		rejected: 'badge-error'
	};
	const CHIP_LABEL: Record<AdminBlockRow['status'], string> = {
		maturing: 'Maturing',
		mature: 'Mature',
		rejected: 'Rejected'
	};
</script>

<section class="hw-section blocks-ledger">
	<div class="section-head">
		<span class="hw-title">Blocks found</span>
		<p class="hint">Every block this pool's miners have solved.</p>
	</div>

	{#if blocks.length === 0}
		<div class="empty-state">
			<span class="empty-title">No blocks found yet.</span>
			<p>Solo mining is a long game — this fills in the moment a share clears the network target.</p>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th class="num">Height</th>
						<th>Found by</th>
						<th class="num">Reward</th>
						<th>Found</th>
						<th class="num">Confirmations</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{#each blocks as b (b.blockHash)}
						<tr>
							<td class="num tabular">{formatNumber(b.height)}</td>
							<td>{b.foundByName}</td>
							<td class="num tabular" title="{formatSats(b.reward)} sats">{formatSats(b.reward)} sats</td>
							<td class="tabular">{foundAtLabel(b.foundAt)}</td>
							<td class="num tabular">{formatNumber(b.confirmations)}</td>
							<td><span class="badge {CHIP_CLASS[b.status]}">{CHIP_LABEL[b.status]}</span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.blocks-ledger {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
</style>
