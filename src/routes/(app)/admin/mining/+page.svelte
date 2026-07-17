<script lang="ts">
	/**
	 * /admin/mining — the operator's view of this instance's SOLO Stratum
	 * mining engine (cairn-vn43.10): engine health + start/stop/restart, the
	 * pool's live hashrate as the hero number, per-miner and per-user
	 * breakdowns, the blocks-found ledger, and the engine's own config form.
	 *
	 * Live refresh: polls GET /api/admin/mining every 10s (paused while the
	 * tab is hidden) and merges the volatile fields (engine/pool/
	 * hashrateSeries/miners/userBreakdown/blocks) into local state — `settings`
	 * is deliberately excluded from the merge so a poll never clobbers fields
	 * the admin is mid-editing in the settings form below (that form seeds its
	 * own local state once from the initial load and manages saves itself).
	 */
	import { onMount } from 'svelte';
	import Banner from '$lib/components/Banner.svelte';
	import AdminEngineHealth from '$lib/components/mining/AdminEngineHealth.svelte';
	import AdminPoolHero from '$lib/components/mining/AdminPoolHero.svelte';
	import AdminHashrateChart from '$lib/components/mining/AdminHashrateChart.svelte';
	import AdminMinersTable from '$lib/components/mining/AdminMinersTable.svelte';
	import AdminUserBreakdown from '$lib/components/mining/AdminUserBreakdown.svelte';
	import AdminBlocksLedger from '$lib/components/mining/AdminBlocksLedger.svelte';
	import AdminPoolSettingsForm from '$lib/components/mining/AdminPoolSettingsForm.svelte';
	import type { AdminMiningView } from '$lib/components/mining/adminMiningView';

	let { data, form } = $props();

	// Seeded from the load, then only the live-telemetry fields are replaced
	// on each poll tick — see the module doc above.
	// svelte-ignore state_referenced_locally
	let view = $state<AdminMiningView>(data.view);

	onMount(() => {
		let stopped = false;

		async function poll(): Promise<void> {
			if (stopped || document.hidden) return;
			try {
				const res = await fetch('/api/admin/mining', { cache: 'no-store' });
				if (!res.ok) return;
				const body = (await res.json()) as AdminMiningView;
				view = {
					...view,
					engine: body.engine,
					pool: body.pool,
					hashrateSeries: body.hashrateSeries,
					miners: body.miners,
					userBreakdown: body.userBreakdown,
					blocks: body.blocks
				};
			} catch {
				// A missed tick is fine — the next one catches up.
			}
		}

		const timer = setInterval(poll, 10_000);
		function onVisible() {
			if (!document.hidden) void poll();
		}
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>Mining — Admin — Heartwood</title>
</svelte:head>

{#if form?.error}
	<div style="margin-bottom: 16px"><Banner variant="error">{form.error}</Banner></div>
{/if}

<div class="stack">
	<AdminEngineHealth engine={view.engine} />

	<section class="hw-section pool-section">
		<AdminPoolHero pool={view.pool} />
		<AdminHashrateChart points={view.hashrateSeries} />
	</section>

	<AdminMinersTable miners={view.miners} />
	<AdminUserBreakdown rows={view.userBreakdown} />
	<AdminBlocksLedger blocks={view.blocks} />
	<AdminPoolSettingsForm settings={view.settings} saved={form?.saved === true} />
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
	}

	.pool-section {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
</style>
