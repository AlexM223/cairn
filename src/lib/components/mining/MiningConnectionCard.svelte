<script lang="ts">
	/**
	 * MiningConnectionCard — plain-language "point your miner here" setup card
	 * (cairn-vn43.7/.24). Shows this user's OWN mining ID/worker format/password
	 * (never an instance-wide username — cairn-vn43's multi-user pivot). Also
	 * hosts the regenerate-ID affordance: a small, two-step (reveal-then-
	 * confirm) action rather than a full gated subpage, since it's a medium-
	 * stakes "the old value stops working" change, not a destructive one.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { toast } from '$lib/components/toast.svelte';

	let {
		miningId,
		workerFormat,
		password,
		stratumPort,
		hasWorkers
	}: {
		miningId: string;
		workerFormat: string;
		password: string;
		stratumPort: number;
		hasWorkers: boolean;
	} = $props();

	const host = $derived(page.url.hostname);

	let confirmingRegenerate = $state(false);
	let regenerating = $state(false);

	function actionError(result: { type: string; data?: Record<string, unknown> }, key: string): string | null {
		if (result.type !== 'failure') return null;
		const msg = result.data?.[key];
		return typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.';
	}
</script>

<section class="card card-pad connection-card">
	<div class="row" style="gap: 8px">
		<Icon name="server" size={15} />
		<span class="card-title grow">Connect your miner</span>
	</div>

	<p class="intro">
		Point your Bitaxe, ASIC, or other miner at this address. Once it connects, its shares will
		start showing up below.
	</p>

	<dl class="fields">
		<div class="field">
			<dt>Pool address</dt>
			<dd><CopyText value={`stratum+tcp://${host}:${stratumPort}`} mono /></dd>
		</div>
		<div class="field">
			<dt>Worker username</dt>
			<dd>
				<CopyText value={workerFormat} mono />
				<span class="field-hint">Give each miner its own name after the dot — e.g. “{miningId}.desk1”.</span>
			</dd>
		</div>
		<div class="field">
			<dt>Password</dt>
			<dd><CopyText value={password} mono /></dd>
		</div>
	</dl>

	{#if !hasWorkers}
		<p class="waiting-hint">
			<Icon name="clock" size={13} />
			Waiting for your first share… this can take a few minutes once a miner connects.
		</p>
	{/if}

	<div class="regenerate">
		{#if !confirmingRegenerate}
			<button type="button" class="btn-link" onclick={() => (confirmingRegenerate = true)}>
				Regenerate mining ID
			</button>
		{:else}
			<div class="regenerate-confirm fade-in">
				<p class="regenerate-caution">
					<Icon name="alert-triangle" size={13} />
					Your miners will need the new ID — they'll stop submitting shares until you update them.
				</p>
				<div class="regenerate-actions">
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => (confirmingRegenerate = false)}
						disabled={regenerating}
					>
						Cancel
					</button>
					<form
						method="POST"
						action="?/regenerateId"
						use:enhance={() => {
							regenerating = true;
							return async ({ update, result }) => {
								regenerating = false;
								confirmingRegenerate = false;
								await update();
								const err = actionError(result, 'regenerateError');
								if (err) toast.error(err);
								else toast.success('Mining ID regenerated.');
							};
						}}
					>
						<button type="submit" class="btn btn-secondary btn-sm" disabled={regenerating}>
							{regenerating ? 'Regenerating…' : 'Confirm regenerate'}
						</button>
					</form>
				</div>
			</div>
		{/if}
	</div>
</section>

<style>
	.connection-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.intro {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.field dt {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.field dd {
		margin: 0;
		font-size: 13.5px;
		color: var(--text-rows);
	}

	.field-hint {
		display: block;
		margin-top: 3px;
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.waiting-hint {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 10px 12px;
		background: var(--surface-elevated);
		border-radius: var(--radius-control);
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.regenerate {
		padding-top: 4px;
		border-top: 1px solid var(--hairline);
	}

	.btn-link {
		background: none;
		border: none;
		padding: 6px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.btn-link:hover {
		color: var(--text-secondary);
	}

	.regenerate-confirm {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 8px;
	}

	.regenerate-caution {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--attention);
	}

	.regenerate-actions {
		display: flex;
		gap: 8px;
	}
</style>
