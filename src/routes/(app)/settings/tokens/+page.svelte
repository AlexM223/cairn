<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo, formatDateTime } from '$lib/format';

	let { data, form } = $props();

	let name = $state('');
	let expiresDays = $state('');

	function since(iso: string): string {
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// The token value is shown exactly once (form.created). Selecting the field
	// on focus keeps manual copy easy even where the clipboard API is blocked
	// (plain-HTTP Umbrel deployments — cairn-w6gg).
	function selectAll(e: Event) {
		(e.currentTarget as HTMLInputElement).select();
	}
</script>

<svelte:head>
	<title>API tokens — Settings — Cairn</title>
</svelte:head>

<div class="tokens stack fade-in">
	<div>
		<a href="/settings" class="hint">&larr; Back to settings</a>
		<h1 class="page-title">API tokens</h1>
		<p class="hint">
			Personal access tokens let scripts and tools use Cairn's API as you — pull balances into a
			spreadsheet, trigger a backup from cron, or build your own tooling. Send one as
			<code>Authorization: Bearer &lt;token&gt;</code> on any API request. A token has the same
			access as your account, so treat it like a password and revoke any you no longer use.
		</p>
	</div>

	{#if form?.error}
		<div class="form-error" role="alert">{form.error}</div>
	{/if}

	{#if form?.created}
		<div class="saved-note token-reveal" role="status">
			<strong>Token “{form.created.name}” created.</strong> Copy it now — it will never be shown
			again.
			<input
				class="input mono token-value"
				type="text"
				readonly
				value={form.created.token}
				onfocus={selectAll}
				onclick={selectAll}
			/>
		</div>
	{/if}

	<section class="card card-pad section">
		<span class="card-title">Create a token</span>
		<form
			method="POST"
			action="?/create"
			class="create-form"
			use:enhance={() =>
				async ({ update }) => {
					name = '';
					await update();
				}}
		>
			<div class="field grow">
				<label class="label" for="name">Name</label>
				<input
					class="input"
					id="name"
					name="name"
					type="text"
					maxlength="64"
					placeholder="e.g. balance-spreadsheet"
					bind:value={name}
				/>
			</div>
			<div class="field">
				<label class="label" for="expires">Expires</label>
				<select class="input" id="expires" name="expiresDays" bind:value={expiresDays}>
					<option value="">Never</option>
					<option value="30">30 days</option>
					<option value="90">90 days</option>
					<option value="365">1 year</option>
				</select>
			</div>
			<button class="btn btn-primary">Create token</button>
		</form>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Your tokens</span>
		{#if data.tokens.length === 0}
			<p class="hint">No tokens yet.</p>
		{:else}
			<ul class="rows">
				{#each data.tokens as t (t.id)}
					<li class="row-item">
						<div class="row-meta">
							<div class="row-name">{t.name}</div>
							<div class="row-sub">
								Created {since(t.createdAt)}
								· {t.lastUsedAt ? `last used ${since(t.lastUsedAt)}` : 'never used'}
								{#if t.expiresAt}
									· expires {formatDateTime(Math.floor(new Date(t.expiresAt).getTime() / 1000))}
								{/if}
							</div>
						</div>
						<form method="POST" action="?/revoke" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button class="btn btn-ghost btn-sm danger">Revoke</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.tokens {
		gap: 14px;
		max-width: 640px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.create-form {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
	}

	.create-form .grow {
		flex: 1;
		min-width: 200px;
	}

	.saved-note {
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
		line-height: 1.5;
	}

	.token-reveal {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.token-value {
		width: 100%;
		font-size: 12.5px;
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

	.row-sub {
		font-size: 0.85em;
		color: var(--text-muted, #9a9a9a);
	}

	.danger {
		color: var(--error);
	}

	code {
		font-family: var(--font-mono, monospace);
		font-size: 0.9em;
	}
</style>
