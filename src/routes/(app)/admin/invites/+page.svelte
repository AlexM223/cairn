<script lang="ts">
	import { enhance } from '$app/forms';
	import { copyToClipboard } from '$lib/clipboard';
	import Banner from '$lib/components/Banner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';

	let { data, form } = $props();
	let creating = $state(false);
	let copied = $state<string | null>(null);

	async function copy(code: string) {
		if (!(await copyToClipboard(code))) return;
		copied = code;
		setTimeout(() => (copied = null), 1500);
	}

	function since(iso: string | null): string {
		if (!iso) return '—';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	function until(iso: string | null): string {
		if (!iso) return 'never';
		const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
		if (days < 0) return 'expired';
		if (days === 0) return 'today';
		return `in ${days}d`;
	}

	const badgeClass: Record<string, string> = {
		active: 'badge-success',
		exhausted: 'badge-neutral',
		expired: 'badge-warning',
		revoked: 'badge-error'
	};
</script>

<svelte:head>
	<title>Invites — Admin — Heartwood</title>
</svelte:head>

<section class="hw-section create-section fade-in">
	<span class="hw-title">Create invites</span>
	<form
		method="POST"
		action="?/create"
		class="create-form"
		use:enhance={({ cancel }) => {
			// Guard re-entrant submits: a fast double/triple-click can fire before the
			// button's reactive `disabled` attribute is flushed to the DOM, creating
			// duplicate invites (cairn-u6eg). Cancel any submit while one is in flight.
			if (creating) return cancel();
			creating = true;
			return async ({ update }) => {
				creating = false;
				await update();
			};
		}}
	>
		<div class="field">
			<label class="label" for="label">Label <span class="opt">optional</span></label>
			<input class="input" id="label" name="label" placeholder="e.g. Family" />
		</div>
		<div class="field narrow">
			<label class="label" for="count">How many</label>
			<input class="input" id="count" name="count" type="number" min="1" max="50" value="1" />
		</div>
		<div class="field narrow">
			<label class="label" for="maxUses">Uses each</label>
			<input class="input" id="maxUses" name="maxUses" type="number" min="1" max="1000" value="1" />
		</div>
		<div class="field narrow">
			<label class="label" for="expiresDays">Expires in days <span class="opt">0 = never</span></label>
			<input class="input" id="expiresDays" name="expiresDays" type="number" min="0" value="30" />
		</div>
		<button type="submit" class="btn btn-primary" disabled={creating}>
			{#if creating}<span class="spinner"></span>{:else}<Icon name="plus" size={15} />{/if}
			Create
		</button>
	</form>

	{#if form?.error}
		<Banner variant="error">{form.error}</Banner>
	{/if}

	{#if form?.created?.length}
		<div class="created-box">
			<span class="hint">Created {form.created.length} invite{form.created.length === 1 ? '' : 's'} — click to copy:</span>
			<div class="created-codes">
				{#each form.created as code (code)}
					<button class="code-chip mono" onclick={() => copy(code)}>
						{code}
						<Icon name={copied === code ? 'check' : 'copy'} size={13} />
					</button>
				{/each}
			</div>
		</div>
	{/if}
</section>

<section class="hw-section fade-in">
	{#if data.invites.length === 0}
		<div class="empty-state">
			<div class="empty-title">No invites yet</div>
			<p>Create invite codes above to let people join this instance.</p>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>Code</th>
						<th>Label</th>
						<th>Status</th>
						<th class="num">Uses</th>
						<th>Created</th>
						<th>Expires</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.invites as invite (invite.id)}
						<tr>
							<td>
								<button class="code-chip mono" onclick={() => copy(invite.code)} title="Copy code">
									{invite.code}
									<Icon name={copied === invite.code ? 'check' : 'copy'} size={13} />
								</button>
							</td>
							<td>{invite.label ?? '—'}</td>
							<td><span class="badge {badgeClass[invite.status]}">{invite.status}</span></td>
							<td class="num">{invite.usedCount}/{invite.maxUses}</td>
							<td class="text-muted">{since(invite.createdAt)}</td>
							<td class="text-muted">{until(invite.expiresAt)}</td>
							<td style="text-align: right">
								{#if invite.status === 'active'}
									<form method="POST" action="?/revoke" use:enhance style="display: inline">
										<input type="hidden" name="id" value={invite.id} />
										<button class="btn btn-ghost btn-sm">Revoke</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.create-section {
		gap: 14px;
	}

	.create-form {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.create-form .field {
		flex: 1;
		min-width: 140px;
	}

	.create-form .narrow {
		flex: 0 0 120px;
	}

	@media (max-width: 560px) {
		.create-form {
			flex-direction: column;
			align-items: stretch;
		}

		.create-form .field,
		.create-form .narrow {
			flex: none;
			width: 100%;
		}
	}

	.opt {
		font-weight: 400;
		color: var(--text-muted);
	}

	/* Fresh codes: a filled input-tone surface (the one allowed fill). */
	.created-box {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--bg-input);
		border-radius: var(--radius-strip);
		padding: 12px 14px;
	}

	.created-codes {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.code-chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-badge);
		color: var(--text-rows);
		padding: 4px 9px;
		font-size: 12.5px;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.code-chip:hover {
		border-color: var(--accent);
	}
</style>
