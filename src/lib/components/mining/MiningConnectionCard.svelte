<script lang="ts">
	/**
	 * MiningConnectionCard — plain-language "point your miner here" setup card
	 * (cairn-vn43.7/.24). Shows this user's OWN mining ID/worker format/password
	 * (never an instance-wide username — cairn-vn43's multi-user pivot). Also
	 * hosts the regenerate-ID affordance: a small, two-step (reveal-then-
	 * confirm) action rather than a full gated subpage, since it's a medium-
	 * stakes "the old value stops working" change, not a destructive one.
	 *
	 * cairn-bm7c2 (UI half): when the pool is bound to loopback only, an
	 * unconditional copy-paste address is a dishonest affordance — it looks
	 * connectable from any device but only ever works from this machine. Swap
	 * the address block for an honest plain-language state instead.
	 *
	 * cairn-pz8v5 (UI half): when the admin has opened a second, high-
	 * difficulty-floor listener for ASIC-class hardware, show both addresses
	 * with plain labels rather than silently only ever advertising one port.
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
		bind,
		asicPort,
		hasWorkers
	}: {
		miningId: string;
		workerFormat: string;
		password: string;
		stratumPort: number;
		/** Network exposure of the pool's Stratum listener(s). */
		bind: 'loopback' | 'lan' | 'all';
		/** Second (ASIC-class) high-floor listener, null when the admin hasn't enabled it. */
		asicPort: { port: number; shareDifficulty: number } | null;
		hasWorkers: boolean;
	} = $props();

	const host = $derived(page.url.hostname);
	const isAdmin = $derived(page.data.user?.isAdmin ?? false);
	/** Reachable from anywhere but this machine (mirrors bindLabel's 'lan'/'all'). */
	const isOpen = $derived(bind !== 'loopback');

	function address(port: number): string {
		return `stratum+tcp://${host}:${port}`;
	}

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

	{#if !isOpen}
		<div class="access-notice">
			<Icon name="info" size={14} />
			<div class="access-copy">
				<p>The pool is currently only reachable from this computer.</p>
				{#if isAdmin}
					<a class="access-link" href="/admin/mining"
						>An admin can open it to your local network in Pool settings.</a
					>
				{/if}
			</div>
		</div>
	{/if}

	<dl class="fields">
		{#if isOpen}
			{#if asicPort}
				<div class="field">
					<dt>Small miners (Bitaxe, USB sticks)</dt>
					<dd><CopyText value={address(stratumPort)} mono /></dd>
				</div>
				<div class="field">
					<dt>Big machines (Antminer-class)</dt>
					<dd><CopyText value={address(asicPort.port)} mono /></dd>
				</div>
			{:else}
				<div class="field">
					<dt>Pool address</dt>
					<dd><CopyText value={address(stratumPort)} mono /></dd>
				</div>
			{/if}
		{/if}
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

	{#if isOpen && asicPort}
		<p class="access-hint">
			Big machines get a separate lane so their flood of work doesn't drown out the small ones.
		</p>
	{:else if !isOpen}
		<p class="access-hint">These will work once the pool is opened to your network.</p>
	{/if}

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

	/* Honest-state notice replacing the address block when the pool is only
	   reachable from this machine — amber "attend to this," never red (a
	   loopback bind is a normal default, not a broken/destructive state). */
	.access-notice {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 12px;
		background: var(--attention-muted);
		border-radius: var(--radius-control);
		color: var(--attention);
	}

	.access-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.access-copy p {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.access-link {
		font-size: 12px;
		color: var(--attention);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.access-link:hover {
		color: var(--text);
	}

	.access-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
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
