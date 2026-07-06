<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo } from '$lib/format';

	let { data, form } = $props();

	function since(iso: string): string {
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}
</script>

<svelte:head>
	<title>Your devices — Settings — Cairn</title>
</svelte:head>

<div class="devices stack fade-in">
	<div>
		<a href="/settings" class="hint">&larr; Back to settings</a>
		<h1 class="page-title">Your devices</h1>
		<p class="hint">
			Where you're signed in, and the devices Cairn remembers for new-device alerts. Revoking a
			session signs that device out immediately; forgetting a device just means its next sign-in
			triggers a "new device" alert again.
		</p>
	</div>

	{#if form?.error}
		<div class="form-error" role="alert">{form.error}</div>
	{/if}

	<section class="card card-pad section">
		<span class="card-title">Active sessions</span>
		{#if data.sessions.length === 0}
			<p class="hint">No active sessions.</p>
		{:else}
			<ul class="rows">
				{#each data.sessions as s (s.id)}
					<li class="row-item">
						<div class="row-meta">
							<div class="row-name">
								{s.device}
								{#if s.current}<span class="badge badge-accent">this device</span>{/if}
							</div>
							<div class="row-sub">Signed in {since(s.createdAt)} · expires {since(s.expiresAt)}</div>
						</div>
						{#if !s.current}
							<form method="POST" action="?/revokeSession" use:enhance>
								<input type="hidden" name="id" value={s.id} />
								<button class="btn btn-ghost btn-sm danger">Revoke</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card card-pad section">
		<span class="card-title">Remembered devices</span>
		{#if data.devices.length === 0}
			<p class="hint">No remembered devices yet — they appear after you sign in.</p>
		{:else}
			<ul class="rows">
				{#each data.devices as d (d.fingerprint)}
					<li class="row-item">
						<div class="row-meta">
							<div class="row-name">{d.device}</div>
							<div class="row-sub">First seen {since(d.firstSeen)} · last seen {since(d.lastSeen)}</div>
						</div>
						<form method="POST" action="?/forgetDevice" use:enhance>
							<input type="hidden" name="fingerprint" value={d.fingerprint} />
							<button class="btn btn-ghost btn-sm">Forget</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.devices {
		gap: 14px;
		max-width: 640px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.row-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
	}

	.row-item:last-child {
		border-bottom: none;
	}

	.row-name {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.row-sub {
		font-size: 0.85em;
		color: var(--text-muted, #9a9a9a);
	}

	.danger {
		color: var(--error);
	}
</style>
