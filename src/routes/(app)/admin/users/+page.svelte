<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';

	let { data, form } = $props();

	const me = $derived(page.data.user);

	function since(iso: string | null): string {
		if (!iso) return 'never';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// Coarse activity bucket (cairn-o1dp.6) — the server no longer sends exact
	// last-login timestamps to this multi-admin surface.
	const ACTIVITY_LABEL = {
		recent: 'Active in last 30 days',
		inactive: 'Inactive 30+ days',
		never: 'Never logged in'
	} as const;
</script>

<svelte:head>
	<title>Users — Admin — Cairn</title>
</svelte:head>

{#if form?.error}
	<div class="form-error" role="alert" style="margin-bottom: 14px">{form.error}</div>
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
					<th>Activity</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as user (user.id)}
					<tr>
						<td>
							<a class="user-cell" href="/admin/users/{user.id}">
								<span class="user-name">
									{user.displayName}
									{#if user.id === me?.id}<span class="you">you</span>{/if}
									{#if user.overrideCount > 0}
										<span class="override-badge" title="Feature overrides differ from the instance default">
											{user.overrideCount} override{user.overrideCount === 1 ? '' : 's'}
										</span>
									{/if}
								</span>
								<span class="user-email">{user.email}</span>
							</a>
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
						<td class="text-muted">{ACTIVITY_LABEL[user.lastActivity as keyof typeof ACTIVITY_LABEL] ?? 'Never logged in'}</td>
						<td>
							<div class="actions">
								<form method="POST" action={user.isAdmin ? '?/demote' : '?/promote'} use:enhance>
									<input type="hidden" name="id" value={user.id} />
									<button class="btn btn-ghost btn-sm" disabled={user.id === me?.id}>
										{user.isAdmin ? 'Demote' : 'Make admin'}
									</button>
								</form>
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

	a.user-cell:hover .user-name {
		color: var(--accent);
	}

	.user-name {
		font-weight: 500;
	}

	.override-badge {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-chip);
		padding: 1px 5px;
		margin-left: 5px;
		vertical-align: 1px;
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
</style>
