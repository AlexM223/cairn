<script lang="ts">
	/**
	 * MiningPayoutWallet — which of the user's own wallets receives a found
	 * block's reward in full. Changing it is a single tap (reversible; only
	 * affects blocks found after the change — friction ladder "low, reversible"
	 * tier, DESIGN-MANIFESTO.md §5), not a gated subpage.
	 */
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { toast } from '$lib/components/toast.svelte';

	let {
		payout,
		wallets
	}: {
		payout: { walletId: number; walletName: string; address: string } | null;
		wallets: { id: number; name: string; eligible: boolean }[];
	} = $props();

	const eligible = $derived(wallets.filter((w) => w.eligible));

	let saving = $state(false);
	let formEl = $state<HTMLFormElement | null>(null);

	function actionError(result: { type: string; data?: Record<string, unknown> }, key: string): string | null {
		if (result.type !== 'failure') return null;
		const msg = result.data?.[key];
		return typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.';
	}

	function onSelect() {
		formEl?.requestSubmit();
	}
</script>

<section class="card card-pad payout-card">
	<div class="row" style="gap: 8px">
		<Icon name="wallet" size={15} />
		<span class="card-title grow">Payout wallet</span>
	</div>

	<p class="intro">
		When you find a block, the whole reward lands here — no fees, no sharing.
	</p>

	{#if payout}
		<div class="current">
			<span class="current-name">{payout.walletName}</span>
			<CopyText value={payout.address} truncate={8} mono />
		</div>
	{/if}

	{#if eligible.length > 0}
		<form
			method="POST"
			action="?/selectWallet"
			class="select-row"
			bind:this={formEl}
			use:enhance={() => {
				saving = true;
				return async ({ update, result }) => {
					saving = false;
					await update();
					const err = actionError(result, 'walletError');
					if (err) toast.error(err);
					else if (result.type === 'success') toast.success('Payout wallet updated.');
				};
			}}
		>
			<label class="select-label" for="mining-payout-wallet">
				{payout ? 'Change wallet' : 'Choose a wallet'}
			</label>
			<select
				id="mining-payout-wallet"
				name="walletId"
				value={payout?.walletId ?? ''}
				disabled={saving}
				onchange={onSelect}
			>
				{#if !payout}
					<option value="" disabled selected>Select a wallet…</option>
				{/if}
				{#each eligible as w (w.id)}
					<option value={w.id}>{w.name}</option>
				{/each}
			</select>
		</form>
	{/if}
</section>

<style>
	.payout-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.intro {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.current {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.current-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.select-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.select-label {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.select-row select {
		height: 36px;
		padding: 0 10px;
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-control);
		color: var(--text);
		font: inherit;
		font-size: 13.5px;
	}
</style>
