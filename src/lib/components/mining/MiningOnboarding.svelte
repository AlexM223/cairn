<script lang="ts">
	/**
	 * MiningOnboarding — the degraded/first-run states for /mining that aren't
	 * covered by MiningEarnings/MiningConnectionCard (cairn-vn43.24):
	 *  - `no-wallet`: user has no eligible wallet to mint a mining ID against.
	 *    Blocking — the Enable action can't do anything useful yet.
	 *  - `engine-stopped`: the instance-level mining engine is off. Distinct
	 *    from "you haven't set up a worker yet" — nothing the user does here
	 *    would help; it's an operator-level state.
	 *  - `not-enabled`: user hasn't turned mining on for themselves yet.
	 */
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { toast } from '$lib/components/toast.svelte';

	let {
		kind
	}: {
		kind: 'no-wallet' | 'engine-stopped' | 'not-enabled';
	} = $props();

	let enabling = $state(false);

	function actionError(result: { type: string; data?: Record<string, unknown> }, key: string): string | null {
		if (result.type !== 'failure') return null;
		const msg = result.data?.[key];
		return typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.';
	}
</script>

{#if kind === 'no-wallet'}
	<div class="empty-state onboarding-panel">
		<span class="notice-icon" aria-hidden="true"><Icon name="wallet" size={22} /></span>
		<span class="empty-title">You need a wallet first</span>
		<p class="notice-body">
			Mining rewards need somewhere to land. Create a wallet, then come back here to turn mining
			on.
		</p>
		<a class="btn btn-secondary btn-sm" href="/wallets">
			<Icon name="wallet" size={14} /> Go to wallets
		</a>
	</div>
{:else if kind === 'engine-stopped'}
	<div class="empty-state onboarding-panel">
		<span class="notice-icon" aria-hidden="true"><Icon name="server" size={22} /></span>
		<span class="empty-title">Mining isn't running yet</span>
		<p class="notice-body">Your operator hasn't started the pool yet. Check back later.</p>
	</div>
{:else}
	<div class="empty-state onboarding-panel">
		<span class="notice-icon" aria-hidden="true"><Icon name="flame" size={22} /></span>
		<span class="empty-title">Turn on mining</span>
		<p class="notice-body">
			Once you turn this on, you'll get your own mining address to point a miner at. Any block you
			find pays your wallet in full.
		</p>
		<form
			method="POST"
			action="?/enable"
			use:enhance={() => {
				enabling = true;
				return async ({ update, result }) => {
					enabling = false;
					await update();
					const err = actionError(result, 'enableError');
					if (err) toast.error(err);
				};
			}}
		>
			<button type="submit" class="btn btn-primary" disabled={enabling}>
				{enabling ? 'Turning on…' : 'Enable mining'}
			</button>
		</form>
	</div>
{/if}

<style>
	.onboarding-panel {
		gap: 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
	}

	.notice-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 42px;
		height: 42px;
		margin-bottom: 2px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
	}

	.notice-body {
		max-width: 42ch;
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.onboarding-panel .btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}
</style>
