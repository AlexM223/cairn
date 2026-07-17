<script lang="ts">
	/**
	 * AdminMinersTable — one row per connected worker (cairn-vn43.10). Online
	 * pip is sage (health semantic) when connected, muted when not — never red,
	 * per the manifesto's "red is destructive-confirm only" rule; a miner going
	 * quiet is routine, not an alarm.
	 */
	import { formatHashrate } from '$lib/shared/hashrate';
	import { formatNumber } from '$lib/format';
	import { agoLabel, type AdminMinerRow } from './adminMiningView';

	let { miners }: { miners: AdminMinerRow[] } = $props();
</script>

<section class="hw-section miners-table">
	<div class="section-head">
		<span class="hw-title">Miners</span>
		<p class="hint">Every worker currently or recently connected to this pool.</p>
	</div>

	{#if miners.length === 0}
		<div class="empty-state">
			<span class="empty-title">No miners have connected yet.</span>
			<p>
				Share the <code>/mining</code> page with your users — it walks them through pointing
				their miner at this instance.
			</p>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>User</th>
						<th>Worker</th>
						<th class="num">Hashrate</th>
						<th class="num">Difficulty</th>
						<th class="num">Last share</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each miners as m (m.userId + '/' + m.worker)}
						<tr>
							<td>{m.userName}</td>
							<td class="mono">{m.worker}</td>
							<td class="num tabular">{formatHashrate(m.hashrate)}</td>
							<td class="num tabular">{formatNumber(m.difficulty)}</td>
							<td class="num tabular">{agoLabel(m.lastShareAgoSec)}</td>
							<td class="pip-cell">
								<span
									class="pip"
									class:online={m.online}
									title={m.online ? 'Connected' : 'Offline'}
									aria-label={m.online ? 'Connected' : 'Offline'}
								></span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.miners-table {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.pip-cell {
		width: 1%;
		white-space: nowrap;
	}

	.pip {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
	}

	.pip.online {
		background: var(--sage);
	}
</style>
