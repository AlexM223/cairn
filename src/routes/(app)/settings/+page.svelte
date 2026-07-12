<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import { addPasskey, browserSupportsWebAuthn } from '$lib/passkey';
	import type { CredentialInfo } from '$lib/types';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';

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

	// SAFE mitigation for desktop passkey failures: registering a passkey on
	// an origin that doesn't match the server's expected WebAuthn origin
	// (data.passkeyOriginOk, see $lib/server/passkeyOrigin.ts) would create a
	// passkey that fails to verify on EVERY origin (e.g. the raw HTTPS
	// listener when CAIRN_ORIGIN pins the proxy's plain-HTTP origin). Hide
	// "Add passkey" there and explain where it does work instead.
	let canAddPasskey = $state(false);
	let showAddPasskeyOriginHint = $state(false);

	onMount(() => {
		const supported = browserSupportsWebAuthn() && window.isSecureContext;
		canAddPasskey = supported && data.passkeyOriginOk;
		showAddPasskeyOriginHint = supported && !data.passkeyOriginOk;
	});

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

	// Removal goes through the shared irreversible-action Modal instead of
	// window.confirm — same network logic as before once confirmed.
	let removeTarget = $state<{ id: number; label: string } | null>(null);
	let removeOpen = $state(false);

	function askRemove(id: number, label: string) {
		removeTarget = { id, label };
		removeOpen = true;
	}

	async function onRemoveConfirmed() {
		if (!removeTarget) return;
		const { id } = removeTarget;
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
			removeTarget = null;
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

	// --- Display unit preference (Heartwood 5h Units toggle) -----------------
	// Client-side preference persisted to localStorage under `hw.unit` so the
	// balance-rendering lanes can read the same key. Defaults to BTC.
	let unit = $state<'btc' | 'sats'>('btc');
	$effect(() => {
		if (localStorage.getItem('hw.unit') === 'sats') unit = 'sats';
	});
	function setUnit(u: 'btc' | 'sats') {
		unit = u;
		localStorage.setItem('hw.unit', u);
	}

	// Which hairline rows are expanded inline (account / passkeys / recovery /
	// contacts-gate / about). Everything the old card layout held still lives
	// here — it just opens beneath its row now.
	let open = $state<Record<string, boolean>>({});
	function toggleRow(key: string) {
		open[key] = !open[key];
	}

	const avatarInitial = $derived((user?.displayName || user?.email || '?').trim().charAt(0).toUpperCase());
</script>

<svelte:head>
	<title>Settings — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer (8i). -->
	<header class="flow-header">
		<BackCircle />
		<span class="flow-eyebrow">SETTINGS</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow (5h). -->
	<div class="page-eyebrow">SETTINGS</div>

	{#if !recovery.complete}
		<div class="recovery-banner" role="status">
			<span class="rb-icon"><Icon name="alert-triangle" size={17} /></span>
			<div class="rb-body">
				<div class="rb-title">Finish setting up account recovery</div>
				<p class="rb-text">
					If you lose all your passkeys, a recovery phrase or code is the only way back into
					Heartwood. This recovers your <strong>login only</strong> — it never touches your bitcoin,
					which stays on your hardware wallet.
				</p>
			</div>
			<a class="btn btn-primary btn-sm rb-cta" href="/recovery-setup">Set up recovery</a>
		</div>
	{/if}

	<!-- Profile row -->
	<div class="profile-row">
		<div class="avatar" aria-hidden="true">{avatarInitial}</div>
		<div class="profile-meta">
			<div class="profile-name">{user.displayName}</div>
			<div class="profile-sub">{user.email}{#if user.isAdmin}&nbsp;· admin{/if}</div>
		</div>
		<button
			type="button"
			class="btn btn-secondary edit-pill"
			aria-expanded={!!open.account}
			onclick={() => toggleRow('account')}>{open.account ? 'Close' : 'Edit'}</button
		>
	</div>

	{#if open.account}
		<div class="row-panel fade-in">
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

			<div class="panel-sub-title">Password</div>
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
		</div>
	{/if}

	<!-- Units -->
	<div class="hw-row static">
		<span class="row-title">Units</span>
		<div class="unit-toggle" role="group" aria-label="Display unit">
			<button
				type="button"
				class="unit"
				class:active={unit === 'btc'}
				aria-pressed={unit === 'btc'}
				onclick={() => setUnit('btc')}>BTC</button
			>
			<button
				type="button"
				class="unit"
				class:active={unit === 'sats'}
				aria-pressed={unit === 'sats'}
				onclick={() => setUnit('sats')}>sats</button
			>
		</div>
	</div>

	<!-- Fiat display: no per-user currency setting exists yet — shown, not editable. -->
	<div class="hw-row static">
		<span class="row-title">Fiat display</span>
		<span class="row-meta">USD · shown</span>
	</div>

	<!-- Notifications -->
	<a class="hw-row" href="/settings/notifications">
		<span class="row-title">Notifications</span>
		<span class="row-meta">in-app + your channels</span>
		<span class="chev"><Icon name="chevron-right" size={14} /></span>
	</a>

	<!-- Passkeys (expands: full management, add/rename/remove) -->
	<button type="button" class="hw-row" aria-expanded={!!open.passkeys} onclick={() => toggleRow('passkeys')}>
		<span class="row-title">Passkeys</span>
		<span class="row-meta">{passkeys.length} active</span>
		<span class="chev" class:down={open.passkeys}><Icon name="chevron-right" size={14} /></span>
	</button>

	{#if open.passkeys}
		<div class="row-panel fade-in">
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
						{#if editingId === pk.id}
							<div class="rename">
								<input class="input" bind:value={editName} placeholder="Passkey name" maxlength="64" />
								<button class="btn btn-primary btn-sm" onclick={() => saveRename(pk.id)} disabled={busy}
									>Save</button
								>
								<button class="btn btn-ghost btn-sm" onclick={() => (editingId = null)}>Cancel</button>
							</div>
						{:else}
							<div class="pk-body">
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
							</div>
							<div class="pk-actions">
								<button class="btn btn-ghost btn-sm" onclick={() => startRename(pk)} disabled={busy}
									>Rename</button
								>
								<button
									class="btn btn-ghost btn-sm danger"
									onclick={() => askRemove(pk.id, pk.name || 'Unnamed passkey')}
									disabled={busy}>Remove</button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			<div>
				{#if canAddPasskey}
					<button class="btn btn-secondary btn-sm" onclick={onAdd} disabled={busy}>
						{#if busy}<span class="spinner"></span>{:else}<Icon name="plus" size={14} />{/if}
						Add passkey
					</button>
				{:else if showAddPasskeyOriginHint}
					<p class="hint">
						Passkeys are available at {data.passkeyExpectedOrigin} — open Settings from that address
						to add one.
					</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Recovery -->
	<button type="button" class="hw-row" aria-expanded={!!open.recovery} onclick={() => toggleRow('recovery')}>
		<span class="row-title">Recovery</span>
		{#if recovery.complete}
			<span class="row-meta sage">
				<Icon name="check" size={13} strokeWidth={2.25} />
				phrase + {recovery.codesRemaining} codes
			</span>
		{:else}
			<span class="row-meta attn">not set up</span>
		{/if}
		<span class="chev" class:down={open.recovery}><Icon name="chevron-right" size={14} /></span>
	</button>

	{#if open.recovery}
		<div class="row-panel fade-in">
			<p class="hint">
				A way back into Heartwood if you lose every passkey. This recovers your
				<strong>login only</strong> — a recovery phrase or code can never move or access your bitcoin.
				Your bitcoin keys live on your hardware wallet regardless. Store your recovery secrets
				separately from your hardware-wallet backup; they protect different things.
			</p>

			<ul class="rec-status">
				<li class="rec-row">
					<span class="rec-icon" class:on={recovery.phrase}>
						<Icon name={recovery.phrase ? 'check' : 'x'} size={13} strokeWidth={2.25} />
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
						<Icon name={recovery.codesRemaining > 0 ? 'check' : 'x'} size={13} strokeWidth={2.25} />
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
		</div>
	{/if}

	<!-- Contacts -->
	{#if page.data.instanceMode === 'team'}
		<a class="hw-row" href="/settings/contacts">
			<span class="row-title">Contacts</span>
			<span class="row-meta">shared-wallet co-signers</span>
			<span class="chev"><Icon name="chevron-right" size={14} /></span>
		</a>
	{:else}
		<button type="button" class="hw-row" aria-expanded={!!open.contacts} onclick={() => toggleRow('contacts')}>
			<span class="row-title">Contacts</span>
			<span class="row-meta">team features off</span>
			<span class="chev" class:down={open.contacts}><Icon name="chevron-right" size={14} /></span>
		</button>
		{#if open.contacts}
			<div class="row-panel fade-in">
				<p class="hint">
					Want to share a multisig wallet with a co-signer? {#if user?.isAdmin}
						<a href="/admin/settings">Turn on team features</a>
					{:else}
						Ask your admin to turn on team features
					{/if} to unlock contacts and wallet sharing.
				</p>
			</div>
		{/if}
	{/if}

	<!-- Devices & sessions -->
	<a class="hw-row" href="/settings/devices">
		<span class="row-title">Devices &amp; sessions</span>
		<span class="row-meta">where you're signed in</span>
		<span class="chev"><Icon name="chevron-right" size={14} /></span>
	</a>

	<!-- API tokens -->
	<a class="hw-row" href="/settings/tokens">
		<span class="row-title">API tokens</span>
		<span class="row-meta">script against your instance</span>
		<span class="chev"><Icon name="chevron-right" size={14} /></span>
	</a>

	<!-- Data export -->
	<a class="hw-row" href="/api/account/export" download>
		<span class="row-title">Download my data</span>
		<span class="row-meta">everything stored here — never keys</span>
		<span class="chev"><Icon name="arrow-down-left" size={14} /></span>
	</a>

	<!-- Theme (single theme for now — the toggle lights up in a future release) -->
	<div class="hw-row static">
		<span class="row-title">Theme</span>
		<span class="row-meta">Heartwood (dark) · light coming soon</span>
	</div>

	<!-- About -->
	<button type="button" class="hw-row" aria-expanded={!!open.about} onclick={() => toggleRow('about')}>
		<span class="row-title">About</span>
		<span class="row-meta">not a custodian</span>
		<span class="chev" class:down={open.about}><Icon name="chevron-right" size={14} /></span>
	</button>

	{#if open.about}
		<div class="row-panel fade-in">
			<p class="hint">
				Review the agreement you accepted for this instance, along with Heartwood's software
				disclaimer and privacy model — what's stored here and what leaves this server.
			</p>
			<div class="about-links">
				<a class="btn btn-secondary btn-sm" href="/agreement">
					<Icon name="shield" size={14} /> Review the agreement
				</a>
				<a class="btn btn-ghost btn-sm" href="/terms">
					<Icon name="info" size={14} /> Terms &amp; privacy
				</a>
			</div>
		</div>
	{/if}

	<!-- Danger zone -->
	<section class="danger-zone">
		<span class="danger-title">Danger zone</span>
		<p class="hint">
			Delete your account and everything it stores on this server: your wallets and their
			configuration, labels, address book, notification settings, and activity.
		</p>
		<ul class="hint danger-list">
			<li>Wallets someone else shared with you are safe — you're just removed, the owner keeps everything.</li>
			<li>
				Shared vaults you own are not: if you've shared a multisig wallet with cosigners or
				viewers, deleting your account deletes it for all of them too, immediately and without
				warning them, and discards any sends they had in progress.
			</li>
			<li>
				Your bitcoin itself is never touched — this server never holds your keys, so coins backed
				by hardware or other wallets stay exactly where they are. What's lost is this app's wallet
				setup and history, which can be hard to rebuild without a backup.
			</li>
			<li>
				If you own a shared wallet, use its <strong>Export config</strong> option or hand off ownership
				to a cosigner before you delete your account.
			</li>
		</ul>

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

<Modal
	bind:open={removeOpen}
	title="Remove this passkey?"
	message={`“${removeTarget?.label ?? ''}” will no longer sign you in. Once it's removed, there is no undo — you'd have to enroll the device again from scratch.`}
	confirmLabel="Remove passkey"
	onConfirm={onRemoveConfirmed}
	onCancel={() => (removeTarget = null)}
/>

<Toasts />

<style>
	/* The grove field bleeds to the viewport behind the content column; content
	   stacks above it. Rail/top-bar have opaque backgrounds and higher z-index. */
	.grove-bleed {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.hw-page {
		position: relative;
		z-index: 1;
		max-width: 660px;
		margin: 0 auto;
	}

	/* This page composes its own mobile flow header (back circle + centered
	   eyebrow + spacer, screen 8i), so the shell's bare-back-circle fallback
	   is suppressed while it's mounted. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.page-eyebrow,
	.flow-eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.page-eyebrow {
		margin-bottom: 8px;
	}

	@media (max-width: 900px) {
		.page-eyebrow {
			display: none;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 6px;
		}

		.flow-eyebrow {
			font-size: 10px;
			letter-spacing: 0.2em;
			text-align: center;
		}

		.flow-spacer {
			width: 32px;
			height: 32px;
			flex-shrink: 0;
		}
	}

	/* ---------- Profile row (5h/8i) ---------- */

	.profile-row {
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 26px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.avatar {
		width: 56px;
		height: 56px;
		flex-shrink: 0;
		border-radius: 50%;
		background: linear-gradient(135deg, #b5673a, var(--accent));
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 22px;
		font-weight: 600;
		color: var(--on-accent);
	}

	.profile-meta {
		flex: 1;
		min-width: 0;
	}

	.profile-name {
		font-size: 18px;
		font-weight: 600;
		color: var(--text);
	}

	.profile-sub {
		font-size: 13px;
		color: var(--text-faint);
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.edit-pill {
		flex-shrink: 0;
	}

	@media (max-width: 900px) {
		.profile-row {
			gap: 13px;
			padding: 20px 0;
		}

		.avatar {
			width: 44px;
			height: 44px;
			font-size: 17px;
		}

		.profile-name {
			font-size: 14.5px;
		}

		.profile-sub {
			font-size: 11px;
		}
	}

	/* ---------- Hairline rows (the 5h grammar: rows, not boxes) ---------- */

	.hw-row {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		padding: 17px 0;
		border: none;
		border-bottom: 1px solid var(--hairline);
		background: none;
		text-align: left;
		cursor: pointer;
		color: inherit;
		font-family: inherit;
		text-decoration: none;
		transition: background 100ms var(--ease);
	}

	.hw-row:hover:not(.static) {
		background: rgba(255, 255, 255, 0.015);
	}

	.hw-row.static {
		cursor: default;
	}

	.row-title {
		flex: 1;
		min-width: 0;
		font-size: 15px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.row-meta {
		font-size: 13.5px;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row-meta.sage {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
		font-size: 13px;
		color: var(--sage);
	}

	.row-meta.attn {
		color: var(--attention);
	}

	.chev {
		display: flex;
		color: var(--text-faint);
		flex-shrink: 0;
		transition: transform 120ms var(--ease);
	}

	.chev.down {
		transform: rotate(90deg);
	}

	@media (max-width: 900px) {
		.hw-row {
			padding: 14px 0;
			gap: 12px;
		}

		.row-title {
			font-size: 13.5px;
		}

		.row-meta {
			font-size: 12px;
		}

		.row-meta.sage {
			font-size: 12px;
		}
	}

	/* Units toggle — text-toggle grammar. */
	.unit-toggle {
		display: flex;
		gap: 2px;
	}

	.unit {
		border: none;
		background: none;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-faint);
		padding: 4px 12px;
		border-radius: 14px;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.unit.active {
		font-weight: 600;
		color: var(--accent-bright);
		background: rgba(232, 147, 90, 0.1);
	}

	@media (max-width: 900px) {
		.unit {
			font-size: 11.5px;
			padding: 4px 11px;
			border-radius: 13px;
		}
	}

	/* ---------- Inline expanded panels ---------- */

	.row-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 6px 0 22px;
		border-bottom: 1px solid var(--hairline);
	}

	.panel-sub-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-top: 8px;
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
		color: var(--attention);
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-strip);
		padding: 10px 12px;
		line-height: 1.5;
	}

	/* Passkey sub-rows: hairline splits, no boxes. */
	.pk-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.pk {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.pk:last-child {
		border-bottom: none;
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
		color: var(--text-rows);
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
		flex: 1;
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
		margin: 18px 0 4px;
		padding: 14px 16px;
		background: var(--attention-muted);
		border: 1px solid var(--warning-border-strong);
		border-radius: var(--radius-strip);
	}

	.rb-icon {
		display: flex;
		color: var(--attention);
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

	@media (max-width: 560px) {
		.recovery-banner {
			flex-wrap: wrap;
		}

		.rb-cta {
			align-self: stretch;
			width: 100%;
		}
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
	}

	.rec-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.rec-row:last-child {
		border-bottom: none;
	}

	.rec-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		flex-shrink: 0;
		border-radius: 50%;
		border: 1px solid var(--border-control);
		color: var(--text-faint);
	}

	.rec-icon.on {
		border-color: transparent;
		background: var(--sage-muted);
		color: var(--sage);
	}

	.rec-meta {
		flex: 1;
		min-width: 0;
	}

	.rec-name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-rows);
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

	.about-links {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	/* ---------- Danger zone ---------- */

	.danger-zone {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 44px;
		padding-top: 18px;
		border-top: 1px solid var(--hairline);
	}

	.danger-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--error);
	}

	.danger-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding-left: 18px;
	}

	.danger-list li {
		list-style: disc;
	}

	.danger-btn {
		color: var(--error);
		border-color: rgba(224, 96, 76, 0.4);
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
</style>
