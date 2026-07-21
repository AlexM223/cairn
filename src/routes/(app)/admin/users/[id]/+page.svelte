<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.subject.displayName} — Users — Health — Heartwood</title>
</svelte:head>

<a
	class="back"
	href="/admin/users"
	onclick={(e) => {
		e.preventDefault();
		goto('/admin/users', { replaceState: true });
	}}
>
	← All users
</a>

<div class="user-head">
	<div class="avatar">{data.subject.displayName.slice(0, 1).toUpperCase()}</div>
	<div>
		<h1 class="page-title">{data.subject.displayName}</h1>
		<span class="user-email">{data.subject.email}</span>
	</div>
	{#if data.subject.isAdmin}<span class="badge badge-accent">Admin</span>{/if}
	{#if data.subject.disabled}<span class="badge badge-error">Disabled</span>{/if}
</div>

<p class="lead">Account details for this user. Manage accounts and invites from the Users list.</p>

<style>
	.back {
		display: inline-block;
		font-size: 12.5px;
		color: var(--text-muted);
		margin-bottom: 14px;
	}

	.back:hover {
		color: var(--accent);
	}

	.user-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.avatar {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		font-weight: 600;
	}

	.user-email {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.lead {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.5;
		margin-bottom: 20px;
		max-width: 660px;
	}
</style>
