<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';
	import CopyText from '$lib/components/CopyText.svelte';

	let { data, form } = $props();

	const me = $derived(page.data.user);

	// The temp password arrives once via form data; copy it into local state so
	// it survives later actions on the page and can be dismissed explicitly.
	let tempReveal = $state<{ password: string; email: string } | null>(null);

	$effect(() => {
		if (form?.tempPassword)
			tempReveal = { password: form.tempPassword, email: form.tempPasswordFor ?? '' };
	});

	function since(iso: string | null): string {
		if (!iso) return 'never';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}
</script>

<svelte:head>
	<title>Users — Admin — Cairn</title>
</svelte:head>

{#if form?.error}
	<div class="form-error" role="alert" style="margin-bottom: 14px">{form.error}</div>
{/if}

{#if tempReveal}
	<div class="temp-panel fade-in" role="status">
		<div class="temp-head">
			<span class="temp-title">Temporary password for {tempReveal.email}</span>
			<button
				class="btn btn-ghost btn-sm"
				type="button"
				onclick={() => (tempReveal = null)}
				aria-label="Dismiss temporary password"
			>
				Dismiss
			</button>
		</div>
		<div class="temp-value">
			<CopyText value={tempReveal.password} />
		</div>
		<p class="temp-warning">
			This is the only time it will be shown — copy it now and pass it on securely. They should
			change it after signing in.
		</p>
	</div>
{/if}

<div class="card fade-in">
	<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>User</th>
					<th>Role</th>
					<th>Status</th>
					<th class="num">Wallets</th>
					<th>Joined</th>
					<th>Last login</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as user (user.id)}
					<tr>
						<td>
							<div class="user-cell">
								<span class="user-name">
									{user.displayName}
									{#if user.id === me?.id}<span class="you">you</span>{/if}
								</span>
								<span class="user-email">{user.email}</span>
							</div>
						</td>
						<td>
							{#if user.isAdmin}
								<span class="badge badge-accent">Admin</span>
							{:else}
								<span class="badge badge-neutral">Member</span>
							{/if}
						</td>
						<td>
							{#if user.disabled}
								<span class="badge badge-error">Disabled</span>
							{:else}
								<span class="badge badge-success">Active</span>
							{/if}
						</td>
						<td class="num">{user.walletCount}</td>
						<td class="text-muted">{since(user.createdAt)}</td>
						<td class="text-muted">{since(user.lastLogin)}</td>
						<td>
							<div class="actions">
								<form method="POST" action={user.isAdmin ? '?/demote' : '?/promote'} use:enhance>
									<input type="hidden" name="id" value={user.id} />
									<button class="btn btn-ghost btn-sm" disabled={user.id === me?.id}>
										{user.isAdmin ? 'Demote' : 'Make admin'}
									</button>
								</form>
								{#if user.id !== me?.id}
									<form method="POST" action="?/resetPassword" use:enhance>
										<input type="hidden" name="id" value={user.id} />
										<button class="btn btn-ghost btn-sm">Reset password</button>
									</form>
								{/if}
								<form method="POST" action={user.disabled ? '?/enable' : '?/disable'} use:enhance>
									<input type="hidden" name="id" value={user.id} />
									{#if user.disabled}
										<button class="btn btn-ghost btn-sm">Enable</button>
									{:else}
										<button class="btn btn-ghost btn-sm danger" disabled={user.id === me?.id}>
											Disable
										</button>
									{/if}
								</form>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.user-cell {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 160px;
	}

	.user-name {
		font-weight: 500;
	}

	.you {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-chip);
		padding: 1px 5px;
		margin-left: 5px;
		vertical-align: 1px;
	}

	.user-email {
		font-size: 12px;
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		gap: 4px;
		justify-content: flex-end;
	}

	.danger:hover:not(:disabled) {
		color: var(--error);
	}

	.temp-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.35);
		border-radius: var(--radius-control);
		padding: 12px 14px;
		margin-bottom: 14px;
	}

	.temp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.temp-title {
		font-size: 13px;
		font-weight: 600;
	}

	.temp-value {
		font-size: 15px;
		font-weight: 500;
	}

	.temp-warning {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
	}
</style>
