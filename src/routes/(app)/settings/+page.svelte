<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';
	import { addPasskey } from '$lib/passkey';
	import type { CredentialInfo } from '$lib/types';

	let { data, form } = $props();

	const user = $derived(page.data.user);
	let savingProfile = $state(false);
	let savingPassword = $state(false);

	// Passkeys: first paint from the server load; mutations replace the list.
	let override = $state<CredentialInfo[] | null>(null);
	const passkeys = $derived(override ?? (data.passkeys as CredentialInfo[]));

	let busy = $state(false);
	let pkError = $state<string | null>(null);
	let editingId = $state<number | null>(null);
	let editName = $state('');

	async function onAdd() {
		pkError = null;
		busy = true;
		try {
			override = await addPasskey();
		} catch (e) {
			pkError = e instanceof Error ? e.message : 'Could not add a passkey.';
		} finally {
			busy = false;
		}
	}

	async function onRemove(id: number, label: string) {
		pkError = null;
		if (!confirm(`Remove the passkey “${label}”? You'll no longer be able to sign in with it.`))
			return;
		busy = true;
		try {
			const res = await fetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not remove that passkey.');
			override = body.passkeys;
		} catch (e) {
			pkError = e instanceof Error ? e.message : 'Could not remove that passkey.';
		} finally {
			busy = false;
		}
	}

	function startRename(pk: CredentialInfo) {
		editingId = pk.id;
		editName = pk.name ?? '';
	}

	async function saveRename(id: number) {
		busy = true;
		pkError = null;
		try {
			const res = await fetch(`/api/auth/passkeys/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: editName })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not rename that passkey.');
			override = body.passkeys;
			editingId = null;
		} catch (e) {
			pkError = e instanceof Error ? e.message : 'Could not rename that passkey.';
		} finally {
			busy = false;
		}
	}

	function since(iso: string | null): string {
		if (!iso) return 'never';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}
</script>

<svelte:head>
	<title>Settings — Cairn</title>
</svelte:head>

<h1 class="page-title" style="margin-bottom: 24px">Settings</h1>

<div class="stack settings fade-in">
	<section class="card card-pad section">
		<span class="card-title">Profile</span>
		<form
			method="POST"
			action="?/profile"
			class="stack inner"
			use:enhance={() => {
				savingProfile = true;
				return async ({ update }) => {
					savingProfile = false;
					await update({ reset: false });
				};
			}}
		>
			{#if form?.profileError}
				<div class="form-error" role="alert">{form.profileError}</div>
			{:else if form?.profileSaved}
				<div class="saved-note" role="status">Profile updated.</div>
			{/if}

			<div class="field">
				<label class="label" for="displayName">Display name</label>
				<input class="input" id="displayName" name="displayName" required value={user.displayName} />
			</div>
			<div class="field">
				<label class="label" for="email">Email</label>
				<input class="input" id="email" name="email" type="email" required value={user.email} />
			</div>
			<div class="actions">
				<button class="btn btn-primary" disabled={savingProfile}>
					{#if savingProfile}<span class="spinner"></span>{/if}
					Save profile
				</button>
			</div>
		</form>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Password</span>
		<form
			method="POST"
			action="?/password"
			class="stack inner"
			use:enhance={() => {
				savingPassword = true;
				return async ({ update }) => {
					savingPassword = false;
					await update();
				};
			}}
		>
			{#if form?.passwordError}
				<div class="form-error" role="alert">{form.passwordError}</div>
			{:else if form?.passwordSaved}
				<div class="saved-note" role="status">
					Password {data.hasPassword ? 'changed' : 'set'}. Other sessions were signed out.
				</div>
			{/if}

			{#if data.hasPassword}
				<div class="field">
					<label class="label" for="currentPassword">Current password</label>
					<input
						class="input"
						id="currentPassword"
						name="currentPassword"
						type="password"
						autocomplete="current-password"
						required
					/>
				</div>
			{:else}
				<p class="hint">
					This account signs in with a passkey. Set a password to also sign in with email and
					password.
				</p>
			{/if}
			<div class="two-col">
				<div class="field">
					<label class="label" for="newPassword">New password</label>
					<input
						class="input"
						id="newPassword"
						name="newPassword"
						type="password"
						autocomplete="new-password"
						minlength="8"
						required
					/>
				</div>
				<div class="field">
					<label class="label" for="confirmPassword">Confirm new password</label>
					<input
						class="input"
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						autocomplete="new-password"
						minlength="8"
						required
					/>
				</div>
			</div>
			<div class="actions">
				<button class="btn btn-primary" disabled={savingPassword}>
					{#if savingPassword}<span class="spinner"></span>{/if}
					{data.hasPassword ? 'Change password' : 'Set password'}
				</button>
			</div>
		</form>
	</section>

	<section class="card card-pad section">
		<div class="row" style="gap: 10px">
			<span class="card-title grow">Passkeys</span>
			<button class="btn btn-secondary btn-sm" onclick={onAdd} disabled={busy}>
				{#if busy}<span class="spinner"></span>{:else}<Icon name="plus" size={14} />{/if}
				Add passkey
			</button>
		</div>

		<p class="hint">
			Passkeys are how you sign in — biometrics or a security key, no password. Manage the devices
			that can access this account.
		</p>

		{#if pkError}
			<div class="form-error" role="alert">{pkError}</div>
		{/if}

		{#if passkeys.length < 2}
			<div class="warn-note" role="status">
				<Icon name="alert-triangle" size={15} />
				<span
					>We recommend adding a backup passkey on another device — a phone and a computer, or a
					security key. If your only passkey is lost, you'd need to create a new account and
					re-import your wallets.</span
				>
			</div>
		{/if}

		<ul class="pk-list">
			{#each passkeys as pk (pk.id)}
				<li class="pk">
					<span class="pk-icon"><Icon name="qr" size={16} /></span>
					<div class="pk-body">
						{#if editingId === pk.id}
							<div class="rename">
								<input
									class="input"
									bind:value={editName}
									placeholder="Passkey name"
									maxlength="64"
								/>
								<button class="btn btn-primary btn-sm" onclick={() => saveRename(pk.id)} disabled={busy}
									>Save</button
								>
								<button class="btn btn-ghost btn-sm" onclick={() => (editingId = null)}>Cancel</button>
							</div>
						{:else}
							<div class="pk-name">
								{pk.name || 'Unnamed passkey'}
								{#if pk.backedUp}
									<span class="badge badge-success">Synced</span>
								{:else}
									<span class="badge badge-neutral">This device</span>
								{/if}
							</div>
							<div class="pk-meta">
								Added {since(pk.createdAt)} · last used {since(pk.lastUsedAt)}
							</div>
						{/if}
					</div>
					{#if editingId !== pk.id}
						<div class="pk-actions">
							<button class="btn btn-ghost btn-sm" onclick={() => startRename(pk)} disabled={busy}
								>Rename</button
							>
							<button
								class="btn btn-ghost btn-sm danger"
								onclick={() => onRemove(pk.id, pk.name || 'Unnamed passkey')}
								disabled={busy}>Remove</button
							>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Appearance</span>
		<div class="field" style="max-width: 240px">
			<label class="label" for="theme">Theme</label>
			<select class="select input" id="theme" disabled title="Light theme is on the roadmap">
				<option selected>The Forge (dark)</option>
				<option>Light — coming soon</option>
			</select>
			<span class="hint">One theme for now. The toggle lights up in a future release.</span>
		</div>
	</section>
</div>

<style>
	.settings {
		gap: 14px;
		max-width: 640px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.inner {
		gap: 14px;
	}

	.two-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	@media (max-width: 560px) {
		.two-col {
			grid-template-columns: 1fr;
		}
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.saved-note {
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
	}

	.warn-note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12.5px;
		color: var(--warning);
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		line-height: 1.5;
	}

	.pk-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.pk {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg);
	}

	.pk-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--surface-elevated);
		color: var(--text-secondary);
	}

	.pk-body {
		flex: 1;
		min-width: 0;
	}

	.pk-name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		font-weight: 500;
	}

	.pk-meta {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.rename {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.rename .input {
		flex: 1;
	}

	.pk-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.danger:hover:not(:disabled) {
		color: var(--error);
	}
</style>
