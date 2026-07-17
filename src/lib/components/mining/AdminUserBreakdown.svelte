<script lang="ts">
	/**
	 * AdminUserBreakdown — per-user rollup of the miners table (cairn-vn43.10):
	 * how many workers, combined hashrate, and share of the pool total.
	 */
	import { formatHashrate } from '$lib/shared/hashrate';
	import { formatNumber } from '$lib/format';
	import type { AdminUserBreakdownRow } from './adminMiningView';

	let { rows }: { rows: AdminUserBreakdownRow[] } = $props();
</script>

<section class="hw-section user-breakdown">
	<div class="section-head">
		<span class="hw-title">By user</span>
		<p class="hint">Each user's combined contribution to the pool.</p>
	</div>

	{#if rows.length === 0}
		<div class="empty-state">
			<span class="empty-title">Nothing to break down yet.</span>
			<p>This fills in once a user's worker starts submitting shares.</p>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>User</th>
						<th class="num">Workers</th>
						<th class="num">Hashrate</th>
						<th class="num">Share</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.userId)}
						<tr>
							<td>{r.userName}</td>
							<td class="num tabular">{formatNumber(r.workers)}</td>
							<td class="num tabular">{formatHashrate(r.hashrate)}</td>
							<td class="num tabular">{r.sharePct.toFixed(1)}%</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.user-breakdown {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
</style>
