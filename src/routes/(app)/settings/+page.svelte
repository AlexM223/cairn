<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import { addPasskey } from '$lib/passkey';
	import type { CredentialInfo } from '$lib/types';

	let { data } = $props();

	const user = $derived(page.data.user);
	let savingProfile = $state(false);
	let savingPassword = $state(false);

	// Form-action results surface as toasts (cairn-ivae.5). A failed action
	// carries its message under a per-form key (e.g. { profileError }).
	function actionError(result: { type: string; data?: Record<string, unknown> }, key: string): string | null {
		if (result.type !== 'failure') return null;
		const msg = result.data?.[key];
		return typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.';
	}

	// Danger zone: delete my account — two-step typed confirmation, same
	// pattern as the admin instance reset (cairn-5u2i.2).
	let confirmingDelete = $state(false);
	let deleteConfirmText = $state('');
	let deleting = $state(false);

	// Passkeys: first paint from the server load; mutations replace the list.
	let override = $state<CredentialInfo[] | null>(null);
	const passkeys = $derived(override ?? (data.passkeys as CredentialInfo[]));

	let busy = $state(false);
	let editingId = $state<number | null>(null);
	let editName = $state('');

	async function onAdd() {
		busy = true;
		try {
			override = await addPasskey();
			toast.success('Passkey added.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not add a passkey.');
		} finally {
			busy = false;
		}
	}

	async function onRemove(id: number, label: string) {
		if (!confirm(`Remove the passkey “${label}”? You'll no longer be able to sign in with it.`))
			return;
		busy = true;
		try {
			const res = await fetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not remove that passkey.');
			override = body.passkeys;
			toast.success('Passkey removed.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not remove that passkey.');
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
			toast.error(e instanceof Error ? e.message : 'Could not rename that passkey.');
		} finally {
			busy = false;
		}
	}

	function since(iso: string | null): string {
		if (!iso) return 'never';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// --- Account recovery (login recovery — NOT bitcoin) ---------------------
	// The banner is dismissible ONLY by completing setup: there is no "x" — the
	// only way it goes away is finishing the recovery-setup wizard.
	const recovery = $derived(data.recovery);
</script>

<svelte:head>
	<title>Settings — Cairn</title>
</svelte:head>

<h1 class="page-title" style="margin-bottom: 24px">Settings</h1>

{#if !recovery.complete}
	<div class="recovery-banner fade-in" role="status">
		<span class="rb-icon"><Icon name="alert-triangle" size={18} /></span>
		<div class="rb-body">
			<div class="rb-title">Finish setting up account recovery</div>
			<p class="rb-text">
				If you lose all your passkeys, a recovery phrase or code is the only way back into Cairn.
				This recovers your <strong>login only</strong> — it never touches your bitcoin, which stays
				on your hardware wallet.
			</p>
		</div>
		<a class="btn btn-primary btn-sm rb-cta" href="/recovery-setup">Set up recovery</a>
	</div>
{/if}

<div class="stack settings fade-in">
	<section class="card card-pad section">
		<span class="card-title">Profile</span>
		<form
			method="POST"
			action="?/profile"
			class="stack inner"
			use:enhance={() => {
				savingProfile = true;
				return async ({ update, result }) => {
					savingProfile = false;
					await update({ reset: false });
					const err = actionError(result, 'profileError');
					if (err) toast.error(err);
					else if (result.type === 'success') toast.success('Profile updated.');
				};
			}}
		>
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
				// Captured before update() reloads data — a first-time "set" flips
				// hasPassword to true before the success message renders otherwise.
				const hadPassword = data.hasPassword;
				return async ({ update, result }) => {
					savingPassword = false;
					await update();
					const err = actionError(result, 'passwordError');
					if (err) toast.error(err);
					else if (result.type === 'success') {
						toast.success(
							`Password ${hadPassword ? 'changed' : 'set'}. Other sessions were signed out.`
						);
					}
				};
			}}
		>
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
		<span class="card-title">Account recovery</span>

		<p class="hint">
			A way back into Cairn if you lose every passkey. This recovers your <strong>login only</strong>
			— a Cairn recovery phrase or code can never move or access your bitcoin. Your bitcoin keys live
			on your hardware wallet regardless. Store your Cairn recovery secrets separately from your
			hardware-wallet backup; they protect different things.
		</p>

		<ul class="rec-status">
			<li class="rec-row">
				<span class="rec-icon" class:on={recovery.phrase}>
					<Icon name={recovery.phrase ? 'check' : 'x'} size={14} strokeWidth={2.25} />
				</span>
				<div class="rec-meta">
					<div class="rec-name">Recovery phrase</div>
					<div class="rec-sub">
						{recovery.phrase ? 'Set — 12-word phrase stored.' : 'Not set up yet.'}
					</div>
				</div>
			</li>
			<li class="rec-row">
				<span class="rec-icon" class:on={recovery.codesRemaining > 0}>
					<Icon name={recovery.codesRemaining > 0 ? 'check' : 'x'} size={14} strokeWidth={2.25} />
				</span>
				<div class="rec-meta">
					<div class="rec-name">Recovery codes</div>
					<div class="rec-sub">
						{#if recovery.codesRemaining > 0}
							{recovery.codesRemaining} of 8 single-use codes remaining.
						{:else}
							Not set up yet.
						{/if}
					</div>
				</div>
			</li>
		</ul>

		<div class="rec-actions">
			{#if recovery.complete}
				<a class="btn btn-secondary btn-sm" href="/recovery-setup?force=1">Regenerate recovery</a>
				<span class="hint rec-warn">Regenerating replaces your current phrase and codes.</span>
			{:else}
				<a class="btn btn-primary btn-sm" href="/recovery-setup">Set up recovery</a>
			{/if}
		</div>
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

	{#if page.data.instanceMode === 'team'}
		<section class="card card-pad section">
			<span class="card-title">Contacts</span>
			<p class="hint" style="margin: 4px 0 10px">
				The people you can share a multisig wallet with. Add someone by email, then
				invite them to co-sign a wallet you own.
			</p>
			<div class="row">
				<a href="/settings/contacts" class="btn btn-secondary btn-sm">
					<Icon name="users" size={14} /> Manage contacts
				</a>
			</div>
		</section>
	{:else}
		<section class="card card-pad section">
			<span class="card-title">Contacts</span>
			<p class="hint" style="margin: 4px 0 10px">
				Want to share a multisig wallet with a co-signer? {#if user?.isAdmin}
					<a href="/admin/settings">Turn on team features</a>
				{:else}
					Ask your admin to turn on team features
				{/if} to unlock contacts and wallet sharing.
			</p>
		</section>
	{/if}

	<section class="card card-pad section">
		<span class="card-title">Notifications</span>
		<p class="hint" style="margin: 4px 0 10px">
			How Cairn reaches you — in-app alerts plus optional email, Telegram, ntfy push, Nostr, and
			webhooks. Choose which events notify you and where. Everything is opt-in.
		</p>
		<div class="row">
			<a href="/settings/notifications" class="btn btn-secondary btn-sm">
				<Icon name="activity" size={14} /> Manage notifications
			</a>
		</div>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Your data &amp; devices</span>
		<p class="hint" style="margin: 4px 0 10px">
			See where you're signed in and revoke old sessions, or download a copy of everything this
			server stores about you (wallet configuration, labels, activity — never keys, Cairn holds
			none).
		</p>
		<div class="row" style="gap: 10px; flex-wrap: wrap">
			<a href="/settings/devices" class="btn btn-secondary btn-sm">
				<Icon name="shield" size={14} /> Your devices
			</a>
			<a href="/api/account/export" class="btn btn-ghost btn-sm" download>
				<Icon name="copy" size={14} /> Download my data
			</a>
		</div>
	</section>

	<section class="card card-pad section">
		<span class="card-title">API access</span>
		<p class="hint" style="margin: 4px 0 10px">
			Create a personal access token to script against your own instance — pull balances, trigger
			a backup from cron, or build a companion tool. Never required for normal use.
		</p>
		<div class="row">
			<a href="/settings/tokens" class="btn btn-secondary btn-sm">
				<Icon name="zap" size={14} /> Manage tokens
			</a>
		</div>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Terms &amp; agreement</span>
		<p class="hint" style="margin: 4px 0 10px">
			Review the agreement you accepted for this instance, along with Cairn's software disclaimer
			and privacy model — what's stored here and what leaves this server.
		</p>
		<div class="row" style="gap: 10px; flex-wrap: wrap">
			<a href="/agreement" class="btn btn-secondary btn-sm">
				<Icon name="shield" size={14} /> Review the agreement
			</a>
			<a href="/terms" class="btn btn-ghost btn-sm">
				<Icon name="info" size={14} /> Terms &amp; privacy
			</a>
		</div>
	</section>

	<section class="card card-pad section danger-zone">
		<span class="card-title danger-title">Danger zone</span>
		<p class="hint">
			Delete your account and everything it stores on this server: your wallets and their
			configuration, labels, address book, notification settings, and activity. Multisig wallets
			someone shared with you stay intact for their owner — you're just removed from them. Your
			bitcoin is not touched (this server never holds keys), but if you haven't downloaded your
			wallet backups, recovering your wallet setup later will be much harder.
		</p>

		{#if !confirmingDelete}
			<div>
				<button
					type="button"
					class="btn btn-secondary danger-btn"
					onclick={() => {
						confirmingDelete = true;
						deleteConfirmText = '';
					}}
				>
					Delete my account
				</button>
			</div>
		{:else}
			<form
				method="POST"
				action="?/deleteAccount"
				class="delete-confirm"
				use:enhance={() => {
					deleting = true;
					return async ({ update, result }) => {
						deleting = false;
						await update();
						const err = actionError(result, 'deleteError');
						if (err) toast.error(err);
					};
				}}
			>
				<label class="label" for="deleteConfirm">
					This cannot be undone. Type <strong>DELETE</strong> to confirm.
				</label>
				<div class="delete-row">
					<input
						class="input mono"
						id="deleteConfirm"
						name="confirm"
						autocomplete="off"
						spellcheck="false"
						placeholder="DELETE"
						bind:value={deleteConfirmText}
					/>
					<button
						class="btn btn-secondary danger-btn"
						disabled={deleteConfirmText !== 'DELETE' || deleting}
					>
						{#if deleting}<span class="spinner"></span>{/if}
						Delete my account forever
					</button>
					<button
						type="button"
						class="btn btn-ghost"
						onclick={() => {
							confirmingDelete = false;
							deleteConfirmText = '';
						}}
					>
						Cancel
					</button>
				</div>
			</form>
		{/if}
	</section>
</div>

<Toasts />

<style>
	.settings {
		gap: 14px;
		max-width: 640px;
	}

	/* Danger zone — same treatment as the admin instance-reset card. */
	.danger-zone {
		margin-top: 24px;
		border-color: rgba(232, 90, 90, 0.4);
	}

	.danger-title {
		color: var(--error);
	}

	.danger-btn {
		color: var(--error);
		border-color: rgba(232, 90, 90, 0.4);
	}

	.danger-btn:hover:not(:disabled) {
		background: var(--error-muted);
		border-color: var(--error);
	}

	.delete-confirm {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.delete-row {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	.delete-row .input {
		max-width: 160px;
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

	/* Persistent recovery warning — dismissible only by completing setup. */
	.recovery-banner {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		max-width: 640px;
		margin-bottom: 14px;
		padding: 14px 16px;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border-strong);
		border-radius: var(--radius-card);
	}

	.rb-icon {
		display: flex;
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.rb-body {
		flex: 1;
		min-width: 0;
	}

	.rb-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.rb-text {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		margin-top: 3px;
	}

	.rb-text strong {
		color: var(--text);
		font-weight: 600;
	}

	.rb-cta {
		flex-shrink: 0;
		align-self: center;
	}

	.hint strong {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.rec-status {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.rec-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg);
	}

	.rec-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.rec-icon.on {
		background: var(--success-muted);
		color: var(--success);
	}

	.rec-meta {
		flex: 1;
		min-width: 0;
	}

	.rec-name {
		font-size: 13.5px;
		font-weight: 500;
	}

	.rec-sub {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 1px;
	}

	.rec-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.rec-warn {
		margin: 0;
	}

	@media (max-width: 560px) {
		.recovery-banner {
			flex-wrap: wrap;
		}

		.rb-cta {
			align-self: stretch;
			width: 100%;
		}
	}
</style>
