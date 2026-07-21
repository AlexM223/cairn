<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { timeAgo } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import { addPasskey, browserSupportsWebAuthn } from '$lib/passkey';
	import { fiatPrimaryPref, setFiatPrimaryPref, fiatVisible, setFiatVisible } from '$lib/price';
	import { unitPref, setUnitPref } from '$lib/units';
	import type { CredentialInfo } from '$lib/types';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';
	import Term from '$lib/components/Term.svelte';
	import { ELECTRUM_TIP, CORE_RPC_TIP } from '$lib/termGlosses';
	import { CHAIN_DOWN, CHAIN_DOWN_PROXY } from '$lib/chainStatusCopy';
	import { formatNumber } from '$lib/format';
	import { showContactsRow } from '$lib/settingsView';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data, form } = $props();

	const user = $derived(page.data.user);
	// Admin-config groups (Node connection / Mining / Explorer / Instance) render
	// only for admins; their backing data lives under data.admin (null for
	// non-admins, so it never leaves the server for a regular user — spec §4.2).
	const admin = $derived(data.admin);
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
	// Shared `hw.unit`-backed store (`$lib/units`, cairn-nb8e) so every other
	// surface that cycles/picks BTC vs sats -- AmountEntry's unit-cycle button
	// included -- reads and writes the exact same preference this toggle does.
	const unit = $derived($unitPref);
	function setUnit(u: 'btc' | 'sats') {
		setUnitPref(u);
	}

	// --- Fiat display toggle (UX redesign Phase 1, cairn-gt05.1) -------------
	// Moved here from Home (spec §2.1 "Fiat toggle → moves to Settings →
	// Display. Home just honors the setting."). Backed by the shared
	// `fiatVisible` store (`$lib/price`, cairn-r494) rather than a
	// component-local copy of the `cairn.fiat` localStorage read: Amount.svelte
	// now enforces this setting centrally on every money readout app-wide, so
	// flipping the toggle here must update that shared store immediately —
	// not just this page's own local state — or a same-session SPA navigation
	// to another page would still see the stale pre-toggle value.
	const showFiat = $derived($fiatVisible);
	function setFiat(on: boolean) {
		setFiatVisible(on);
	}

	// --- Theme (Settings → Display "Theme" row, cairn-sdx5.7) ----------------
	// Same read-on-mount / write-on-click shape as unit/fiat above: the
	// `$effect` below has no reactive dependencies of its own, so it only
	// ever runs once (functionally an onMount), and every write happens
	// imperatively inside setTheme() rather than in a reactive effect keyed
	// off `theme` — so there is no wizardProgress-style (cairn-pwo1) clobber
	// risk of a persistence effect racing a restore. `data-theme` on <html>
	// is also flipped here, live, with no reload — the app.html inline
	// script only handles the *first paint*, before hydration.
	let theme = $state<'system' | 'dark' | 'light'>('system');
	$effect(() => {
		const saved = localStorage.getItem('hw.theme');
		if (saved === 'dark' || saved === 'light') theme = saved;
	});
	function applyTheme(t: 'system' | 'dark' | 'light') {
		if (t === 'system') document.documentElement.removeAttribute('data-theme');
		else document.documentElement.setAttribute('data-theme', t);
	}
	function setTheme(t: 'system' | 'dark' | 'light') {
		theme = t;
		if (t === 'system') localStorage.removeItem('hw.theme');
		else localStorage.setItem('hw.theme', t);
		applyTheme(t);
	}

	// --- Primary display order (cairn-6ppq) ----------------------------------
	// DESIGN-MANIFESTO.md §3 MUST rule: BTC/sats is primary everywhere by
	// default. This durable preference (default OFF/BTC-primary) is what lets
	// a user explicitly opt into fiat-primary instead; Amount.svelte reads the
	// shared `fiatPrimaryPref` store directly, so flipping it here updates
	// every Amount on the site immediately.

	// Which hairline rows/groups are expanded inline (account / passkeys /
	// recovery / about, plus the collapsed-by-default 'advanced' and 'danger'
	// GROUPS, spec §2.6c). Everything the old card layout held still lives
	// here — it just opens beneath its row now.
	let open = $state<Record<string, boolean>>({});
	function toggleRow(key: string) {
		open[key] = !open[key];
	}

	const avatarInitial = $derived((user?.displayName || user?.email || '?').trim().charAt(0).toUpperCase());

	// ======================================================================
	// Admin-config groups (spec §4.1: Node connection / Mining / Explorer /
	// Instance). Moved verbatim from the old /admin/settings page. Every value
	// here is under `admin` (= data.admin), which is null for non-admins — so
	// these derivations optional-chain through it and the markup is gated on
	// `user.isAdmin && admin`. None of this state is meaningful for a regular
	// user; it just idles.
	// ======================================================================

	// svelte-ignore state_referenced_locally — intentionally seeds local UI state
	let connectionMode = $state(admin?.settings.connectionMode ?? 'public');
	let saving = $state(false);
	let testing = $state<'electrum' | 'coreRpc' | null>(null);

	// Umbrel Wave B assisted-connect constants — mirror
	// src/lib/server/umbrelCoreProbe.ts (that module is $lib/server-only and
	// can't be imported into this isomorphic component). NEVER read from a probe
	// response — keep in sync only if the well-known Umbrel address changes.
	const UMBREL_CORE_RPC_URL = 'http://10.21.21.8:8332';
	const UMBREL_CORE_RPC_USER = 'umbrel';

	// svelte-ignore state_referenced_locally
	let coreRpcUrlField = $state(admin?.settings.coreRpcUrl ?? '');
	// svelte-ignore state_referenced_locally
	let coreRpcUserField = $state(admin?.settings.coreRpcUser ?? '');
	let coreRpcPassEl = $state<HTMLInputElement | undefined>();

	const coreRpcIsConfigured = $derived(!!admin?.settings.coreRpcUrl);
	const coreRpcAutoProvisioned = $derived(
		coreRpcIsConfigured &&
			(admin?.settings.coreRpcProvisionedBy === 'umbrel-env' ||
				admin?.settings.coreRpcProvisionedBy === 'umbrel-detect')
	);

	let assistedCoreRpcPass = $state('');

	type TestResult = { ok: boolean; tipHeight?: number; error?: string } | null;
	type CoreRpcTestResult =
		| { ok: boolean; blockHeight?: number; chain?: string; error?: string }
		| null;

	let electrumResult = $state<TestResult>(null);
	let coreRpcResult = $state<CoreRpcTestResult>(null);

	// User agreement editor (its own form/action, independent of chain settings).
	// svelte-ignore state_referenced_locally
	let agreementText = $state(admin?.agreement.text ?? '');
	// svelte-ignore state_referenced_locally
	let operatorName = $state(admin?.agreement.operator ?? '');
	let savingAgreement = $state(false);
	let savingRegistration = $state(false);
	let togglingTeamMode = $state(false);

	// Factory reset (moved into the admin Instance group, spec §4.1 / brief).
	let confirmingReset = $state(false);
	let resetConfirmText = $state('');
	let resetting = $state(false);

	$effect(() => {
		if (form?.electrumTest) electrumResult = form.electrumTest as TestResult;
	});
	$effect(() => {
		if (form?.coreRpcTest) coreRpcResult = form.coreRpcTest as CoreRpcTestResult;
	});

	const chainHealth = $derived(admin?.chainHealth ?? null);
	function agoLabel(atMs: number | null): string {
		if (atMs === null) return '';
		const secs = Math.max(0, Math.round((Date.now() - atMs) / 1000));
		if (secs < 60) return 'just now';
		const mins = Math.round(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		return `${Math.round(mins / 60)}h ago`;
	}

	// Shared enhance for the Mining/Explorer instance toggles + the team-mode and
	// agreement/registration mini-forms: reload the page data (so the toggle
	// reflects and the nav can pick up a flag flip on its next resolution) and
	// surface a toast.
	function toggleEnhance(successMsg: string, errorMsg: string): SubmitFunction {
		return () =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') toast.success(successMsg);
				else if (result.type === 'failure') toast.error(errorMsg);
			};
	}
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

	<!-- Desktop (>=1160px) sets a page-local left section nav beside the content;
	     the anchor jumps land on the existing rows (no new routes). Below that the
	     nav is display:none and the rows stack exactly as today (mobile untouched).
	     docs/DESKTOP-LAYOUT-DESIGN.md §4 Settings. -->
	<div class="settings-body">
		<nav class="settings-nav" aria-label="Settings sections">
			<a href="#set-account">Account</a>
			<a href="#set-display">Display</a>
			<a href="#set-security">Security</a>
			<a href="#set-advanced">Advanced</a>
			<a href="#set-danger">Danger zone</a>
			{#if user.isAdmin}
				<span class="settings-nav-sep">Admin</span>
				<a href="#node-connection">Node connection</a>
				<a href="#mining">Mining</a>
				<a href="#explorer">Explorer</a>
				<a href="#instance">Instance</a>
			{/if}
		</nav>

		<div class="settings-content">
	<!-- ============================== ACCOUNT (spec §2.6c, group 1 of 5) -->
	<h2 class="group-title" id="set-account">Account</h2>

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
					<input class="input" id="displayName" name="displayName" maxlength="60" required value={user.displayName} />
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

	<!-- Notifications: an account-level preference (channels + per-event
	     toggles). The spec's five groups don't name it; capability is never
	     deleted (principle 4), so it rides with Account until Phase 4 gives
	     it an account-menu entry point. -->
	<a class="hw-row" href="/settings/notifications">
		<span class="row-title">Notification settings</span>
		<span class="row-meta">in-app + your channels</span>
		<span class="chev"><Icon name="chevron-right" size={14} /></span>
	</a>

	<!-- ==================== DISPLAY (group 2: Units + Fiat + Theme merged) -->
	<h2 class="group-title" id="set-display">Display</h2>

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

	<!-- Fiat display (UX redesign Phase 1: relocated from Home's hero toggle).
	     No per-user currency setting exists yet, so this only switches the USD
	     estimate on/off — same privacy-gated fetch Home already used (no price
	     call until turned on). -->
	<div class="hw-row static">
		<span class="row-title">Fiat display</span>
		<div class="unit-toggle" role="group" aria-label="Fiat display">
			<button
				type="button"
				class="unit"
				class:active={!showFiat}
				aria-pressed={!showFiat}
				onclick={() => setFiat(false)}>Hidden</button
			>
			<button
				type="button"
				class="unit"
				class:active={showFiat}
				aria-pressed={showFiat}
				onclick={() => setFiat(true)}>USD shown</button
			>
		</div>
	</div>

	{#if showFiat}
		<!-- Primary display order (cairn-6ppq): only meaningful once fiat is
		     shown at all above. Default BTC/sats-primary per the manifesto. -->
		<div class="hw-row static">
			<span class="row-title">Primary display</span>
			<div class="unit-toggle" role="group" aria-label="Primary display">
				<button
					type="button"
					class="unit"
					class:active={!$fiatPrimaryPref}
					aria-pressed={!$fiatPrimaryPref}
					onclick={() => setFiatPrimaryPref(false)}>BTC/sats</button
				>
				<button
					type="button"
					class="unit"
					class:active={$fiatPrimaryPref}
					aria-pressed={$fiatPrimaryPref}
					onclick={() => setFiatPrimaryPref(true)}>Fiat</button
				>
			</div>
		</div>
	{/if}

	<!-- Theme (merged into Display, spec §2.6c "Theme · …" row; app-wide light
	     mode rollout, cairn-sdx5.7). System honors the OS's
	     prefers-color-scheme; Dark/Light are explicit overrides applied via
	     data-theme on <html> (src/app.css), with no page reload. -->
	<div class="hw-row static">
		<span class="row-title">Theme</span>
		<div class="unit-toggle" role="group" aria-label="Theme">
			<button
				type="button"
				class="unit"
				class:active={theme === 'system'}
				aria-pressed={theme === 'system'}
				onclick={() => setTheme('system')}>System</button
			>
			<button
				type="button"
				class="unit"
				class:active={theme === 'dark'}
				aria-pressed={theme === 'dark'}
				onclick={() => setTheme('dark')}>Dark</button
			>
			<button
				type="button"
				class="unit"
				class:active={theme === 'light'}
				aria-pressed={theme === 'light'}
				onclick={() => setTheme('light')}>Light</button
			>
		</div>
	</div>

	<!-- ============== SECURITY (group 3 — Recovery ranked FIRST: it's the
	     backup-adjacent item whose loss costs access, spec §2.6c) -->
	<h2 class="group-title" id="set-security">Security</h2>

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

	<!-- Devices & sessions -->
	<a class="hw-row" href="/settings/devices">
		<span class="row-title">Devices &amp; sessions</span>
		<span class="row-meta">where you're signed in</span>
		<span class="chev"><Icon name="chevron-right" size={14} /></span>
	</a>

	<!-- ============== ADVANCED (group 4 — collapsed by default: power
	     features a first-week user never touches, spec §2.6c) -->
	<button
		type="button"
		class="hw-row group-toggle"
		id="set-advanced"
		aria-expanded={!!open.advanced}
		aria-controls="advanced-rows"
		onclick={() => toggleRow('advanced')}
	>
		<span class="group-title inline">Advanced</span>
		<span class="chev" class:down={open.advanced}><Icon name="chevron-right" size={14} /></span>
	</button>

	{#if open.advanced}
		<div class="group-rows fade-in" id="advanced-rows">
			<!-- API tokens -->
			<a class="hw-row" href="/settings/tokens">
				<span class="row-title">API tokens</span>
				<span class="row-meta">script against your instance</span>
				<span class="chev"><Icon name="chevron-right" size={14} /></span>
			</a>

			<!-- Contacts — rendered ONLY when team mode is on ($lib/settingsView
			     showContactsRow, spec §2.6c). The old solo-mode "team features
			     off" explainer row is gone: a disabled feature no longer
			     advertises itself here. -->
			{#if showContactsRow(page.data.instanceMode)}
				<a class="hw-row" href="/settings/contacts">
					<span class="row-title">Contacts</span>
					<span class="row-meta">shared-wallet co-signers</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>
			{/if}

			<!-- Data export -->
			<a class="hw-row" href="/api/account/export" download>
				<span class="row-title">Download my data</span>
				<span class="row-meta">everything stored here — never keys</span>
				<span class="chev"><Icon name="arrow-down-left" size={14} /></span>
			</a>

			<!-- About this app -->
			<button type="button" class="hw-row" aria-expanded={!!open.about} onclick={() => toggleRow('about')}>
				<span class="row-title">About this app</span>
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
		</div>
	{/if}

	<!-- ============== DANGER ZONE (group 5 — collapsed, red, ONE plain
	     sentence + typed confirm; the 4-bullet caveat wall is gone, spec §2.6c
	     + manifesto §5 destructive-max friction / anti-caveat-wall). The
	     server-side deleteAccount action is unchanged. -->
	<section class="danger-zone" id="set-danger">
		<button
			type="button"
			class="hw-row group-toggle"
			aria-expanded={!!open.danger}
			aria-controls="danger-rows"
			onclick={() => toggleRow('danger')}
		>
			<span class="group-title danger-title inline">Danger zone</span>
			<span class="chev" class:down={open.danger}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.danger}
		<div class="group-rows fade-in" id="danger-rows">
		<p class="hint">
			Deleting your account permanently removes everything it stores on this server — your
			bitcoin itself is never touched, but shared wallets you own disappear for their cosigners
			too.
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
		</div>
		{/if}
	</section>

	{#if user.isAdmin && admin}
		<!-- ============ Admin-config groups (spec §4.1, appended for admins) ==== -->

		<!-- ===================================== NODE CONNECTION (group 6) -->
		<h2 class="group-title" id="node-connection">Node connection</h2>
		<p class="group-lead hint">
			Where Heartwood reads chain data from. Public servers work out of the box; point it at your
			own node for full sovereignty.
		</p>

		<form
			id="settings-form"
			method="POST"
			action="?/save"
			class="admin-form"
			use:enhance={({ action }) => {
				const which = action.search.includes('testElectrum')
					? ('electrum' as const)
					: action.search.includes('testCoreRpc')
						? ('coreRpc' as const)
						: null;
				if (which) testing = which;
				else saving = true;

				const watchdog = setTimeout(() => {
					if (which && testing === which) {
						const timedOut = { ok: false, error: 'Timed out — no response from the server.' };
						if (which === 'electrum') electrumResult = timedOut;
						else coreRpcResult = timedOut;
					}
					testing = null;
					saving = false;
				}, 20_000);

				return async ({ update, result }) => {
					clearTimeout(watchdog);
					const wasSaving = !which;
					saving = false;
					testing = null;
					await update({ reset: false });
					if (wasSaving) {
						if (result.type === 'failure') {
							const msg = result.data?.error;
							toast.error(typeof msg === 'string' ? msg : 'Could not save settings.');
						} else if (result.type === 'success') {
							toast.success('Saved — connection updated.');
						}
					}
				};
			}}
		>
			<div class="radio-group">
				<label class="radio-card" class:selected={connectionMode === 'public'}>
					<input type="radio" name="connectionMode" value="public" bind:group={connectionMode} />
					<span class="radio-label">Public servers <span class="badge badge-neutral">default</span></span>
					<span class="radio-desc"
						>electrum.blockstream.info (<Term tip={ELECTRUM_TIP}>Electrum</Term>) — always mainnet</span
					>
				</label>
				<label class="radio-card" class:selected={connectionMode === 'custom'}>
					<input type="radio" name="connectionMode" value="custom" bind:group={connectionMode} />
					<span class="radio-label">Your own node</span>
					<span class="radio-desc">Your own <Term tip={ELECTRUM_TIP}>Electrum</Term> server and data sources</span>
				</label>
			</div>

			{#if admin.settings.chainProvisionedBy === 'umbrel-env' || admin.settings.chainProvisionedBy === 'umbrel-probe'}
				<div class="provenance-card fade-in" role="status">
					<span class="provenance-dot"></span>
					<div class="provenance-text">
						<span class="provenance-title">
							Connected automatically to your Umbrel's Electrum server
						</span>
						<span class="provenance-sub">
							{admin.settings.chainProvisionedBy === 'umbrel-env'
								? 'Set up from your Umbrel Bitcoin Node app.'
								: 'Found automatically on your Umbrel.'} You can still point this at a different
							server below.
						</span>
					</div>
				</div>
			{/if}

			{#if coreRpcAutoProvisioned}
				<div class="provenance-card fade-in" role="status">
					<span class="provenance-dot"></span>
					<div class="provenance-text">
						<span class="provenance-title">Connected automatically to your Umbrel's Bitcoin node</span>
						<span class="provenance-sub">
							{admin.settings.coreRpcProvisionedBy === 'umbrel-env'
								? 'Set up from your Umbrel Bitcoin Node app.'
								: 'Connected using the details found on your Umbrel.'}
						</span>
						<span class="provenance-detail mono">
							{admin.settings.coreRpcUrl}{#if admin.settings.coreRpcUser}
								· user {admin.settings.coreRpcUser}{/if}
							· password {admin.settings.hasCoreRpcPass ? '••••••••' : '(none)'}
						</span>
					</div>
					<button
						type="submit"
						form="settings-form"
						formaction="?/switchCoreRpcToManual"
						class="btn btn-ghost btn-sm"
						disabled={testing !== null || saving}
					>
						Switch to manual
					</button>
				</div>
			{/if}

			{#if admin.settings.coreRpcDetected === 'umbrel' && !coreRpcIsConfigured}
				<div class="provenance-card core-detect fade-in" role="status">
					<span class="provenance-dot detect"></span>
					<div class="provenance-text">
						<span class="provenance-title">Bitcoin Core detected on your Umbrel</span>
						<span class="provenance-sub">
							Connect it for full block and transaction details in the explorer. Paste the node
							password (copy it from your Umbrel Bitcoin app's Connect screen) below — the
							address and username are already filled in.
						</span>
						<input type="hidden" name="coreRpcAssisted" value="umbrel" form="settings-form" />
						<input type="hidden" name="coreRpcUrl" value={UMBREL_CORE_RPC_URL} form="settings-form" />
						<input type="hidden" name="coreRpcUser" value={UMBREL_CORE_RPC_USER} form="settings-form" />
						<input
							class="input mono assisted-pass"
							type="password"
							autocomplete="off"
							placeholder="Node password"
							bind:value={assistedCoreRpcPass}
							name="coreRpcPass"
							form="settings-form"
						/>
						{#if form?.coreRpcTest && !form.coreRpcTest.ok}
							<span class="badge badge-error">{form.coreRpcTest.error ?? 'Failed'}</span>
						{/if}
					</div>
					<div class="assisted-connect-actions">
						<button
							type="submit"
							form="settings-form"
							formaction="?/save"
							class="btn btn-secondary btn-sm"
							disabled={testing !== null || saving}
						>
							{saving ? 'Connecting…' : 'Connect'}
						</button>
						<button
							type="submit"
							form="settings-form"
							formaction="?/dismissCoreDetection"
							class="btn btn-ghost btn-sm"
							disabled={testing !== null || saving}
						>
							Dismiss
						</button>
					</div>
				</div>
			{/if}

			{#if connectionMode === 'custom'}
				<div class="custom-fields fade-in">
					<div class="subgroup">
						<span class="subgroup-title">Network</span>
						<p class="hint">
							Which Bitcoin network your server and node are actually running. Changing this
							changes which keys and addresses are valid — only switch it if your Electrum server
							and Core node are on that network too.
						</p>
						<div class="field">
							<label class="label" for="chainNetwork">Network</label>
							<select
								class="input"
								id="chainNetwork"
								name="chainNetwork"
								value={admin.settings.chainNetwork}
							>
								<option value="mainnet">Mainnet</option>
								<option value="testnet">Testnet</option>
								<option value="regtest">Regtest</option>
							</select>
						</div>
					</div>

					<div class="subgroup">
						<span class="subgroup-title">Your node address (<Term tip={ELECTRUM_TIP}>Electrum</Term> server)</span>
						<div class="row-fields">
							<div class="field grow">
								<label class="label" for="electrumHost">Host</label>
								<input
									class="input mono"
									id="electrumHost"
									name="electrumHost"
									placeholder="umbrel.local"
									value={admin.settings.electrumHost}
								/>
							</div>
							<div class="field port">
								<label class="label" for="electrumPort">Port</label>
								<input
									class="input mono"
									id="electrumPort"
									name="electrumPort"
									type="number"
									min="1"
									max="65535"
									value={admin.settings.electrumPort}
								/>
							</div>
							<label class="tls-check">
								<input type="checkbox" name="electrumTls" checked={admin.settings.electrumTls} />
								<span>TLS</span>
							</label>
						</div>
						<label class="tls-insecure">
							<input
								type="checkbox"
								name="electrumTlsInsecure"
								checked={admin.settings.electrumTlsInsecure}
							/>
							<span>
								Allow self-signed certificate (skip TLS verification) — only for a self-hosted
								server you trust on a trusted network. Leaving this on lets a network attacker
								impersonate the server.
							</span>
						</label>
						<div class="test-row">
							<button
								type="submit"
								class="btn btn-secondary btn-sm"
								formaction="?/testElectrum"
								disabled={testing !== null || saving}
							>
								{#if testing === 'electrum'}<span class="spinner"></span>{/if}
								Test connection
							</button>
							{#if electrumResult}
								{#if electrumResult.ok}
									<span class="badge badge-success">
										Connected{electrumResult.tipHeight
											? ` — tip ${formatNumber(electrumResult.tipHeight)}`
											: ''}
									</span>
								{:else}
									<span class="badge badge-error">{electrumResult.error ?? 'Failed'}</span>
								{/if}
							{/if}
						</div>
					</div>
				</div>
			{/if}

			{#if !coreRpcAutoProvisioned}
				<div class="subgroup proxy-group">
					<span class="subgroup-title">
						Your Bitcoin node (<Term tip={CORE_RPC_TIP}>Bitcoin Core RPC</Term>)
						<span class="badge badge-neutral">self-hosted</span>
					</span>
					<p class="hint">
						Point Heartwood at your own Bitcoin Core node's RPC interface for rich block and mempool
						data without relying on any third-party explorer API. Fully self-hosted — works on an
						Umbrel or other node with no public internet access, and works whether you're on public
						servers or a custom Electrum server above.
					</p>
					<div class="field">
						<label class="label" for="coreRpcUrl">Node address</label>
						<input
							class="input mono"
							id="coreRpcUrl"
							name="coreRpcUrl"
							placeholder="http://127.0.0.1:8332"
							bind:value={coreRpcUrlField}
						/>
					</div>
					<div class="row-fields">
						<div class="field grow">
							<label class="label" for="coreRpcUser">Node username</label>
							<input
								class="input mono"
								id="coreRpcUser"
								name="coreRpcUser"
								autocomplete="off"
								placeholder="rpcuser"
								bind:value={coreRpcUserField}
							/>
						</div>
						<div class="field grow">
							<label class="label" for="coreRpcPass">Node password</label>
							<input
								class="input mono"
								id="coreRpcPass"
								name="coreRpcPass"
								type="password"
								autocomplete="off"
								placeholder={admin.settings.hasCoreRpcPass
									? '•••••••• saved — leave blank to keep'
									: 'Node password'}
								bind:this={coreRpcPassEl}
							/>
						</div>
					</div>
					{#if admin.settings.hasCoreRpcPass}
						<label class="tls-check">
							<input type="checkbox" name="clearCoreRpcPass" />
							<span>Clear the saved node password</span>
						</label>
					{/if}
					<div class="test-row">
						<button
							type="submit"
							class="btn btn-secondary btn-sm"
							formaction="?/testCoreRpc"
							disabled={testing !== null || saving}
						>
							{#if testing === 'coreRpc'}<span class="spinner"></span>{/if}
							Test connection
						</button>
						{#if coreRpcResult}
							{#if coreRpcResult.ok}
								<span class="badge badge-success">
									OK{coreRpcResult.chain ? ` — chain ${coreRpcResult.chain}` : ''}{coreRpcResult.blockHeight
										? `, tip ${formatNumber(coreRpcResult.blockHeight)}`
										: ''}
								</span>
							{:else}
								<span class="badge badge-error">{coreRpcResult.error ?? 'Failed'}</span>
							{/if}
						{/if}
					</div>
				</div>
			{/if}

			<div class="subgroup proxy-group">
				<span class="subgroup-title">Performance — simultaneous connections</span>
				<p class="hint">
					How many parallel connections Heartwood opens to the Electrum server. More connections let
					wallet balance lookups run at the same time instead of queuing, which speeds up loading
					many wallets. 1 disables pooling. Most setups are fine with the default.
				</p>
				<div class="row-fields">
					<div class="field port">
						<label class="label" for="electrumPoolSize">Connections</label>
						<input
							class="input mono"
							id="electrumPoolSize"
							name="electrumPoolSize"
							type="number"
							min="1"
							max="4"
							value={admin.settings.electrumPoolSize}
						/>
					</div>
				</div>
			</div>

			<div class="subgroup proxy-group">
				<span class="subgroup-title">
					Privacy — route through Tor (<Term tip="SOCKS5 is a proxy protocol; a Tor daemon exposes one on 127.0.0.1:9050.">SOCKS5</Term>)
					<span class="badge badge-neutral">optional</span>
				</span>
				<p class="hint">
					Route all chain traffic (Electrum + explorer) through a SOCKS5 proxy so the servers never
					see your real IP address. For Tor, run a Tor daemon and point this at its SOCKS port
					(usually 127.0.0.1:9050). Applies whether you use the public servers or your own node.
					Leave both blank to connect directly.
				</p>
				<div class="row-fields">
					<div class="field grow">
						<label class="label" for="socks5Host">Proxy host</label>
						<input
							class="input mono"
							id="socks5Host"
							name="socks5Host"
							placeholder="127.0.0.1"
							value={admin.settings.socks5Host ?? ''}
						/>
					</div>
					<div class="field port">
						<label class="label" for="socks5Port">Port</label>
						<input
							class="input mono"
							id="socks5Port"
							name="socks5Port"
							type="number"
							min="1"
							max="65535"
							placeholder="9050"
							value={admin.settings.socks5Port ?? ''}
						/>
					</div>
				</div>
				{#if chainHealth}
					<div class="health-line" class:health-bad={!chainHealth.healthy} role="status">
						{#if !chainHealth.healthy}
							<span class="health-dot bad"></span>
							<span>
								{chainHealth.proxyConfigured
									? CHAIN_DOWN_PROXY
									: CHAIN_DOWN}{chainHealth.lastErrorAt
									? ` — last failure ${agoLabel(chainHealth.lastErrorAt)}`
									: ''}{chainHealth.lastError ? ` (${chainHealth.lastError})` : ''}.
							</span>
						{:else}
							<span class="health-dot ok"></span>
							<span>
								Chain transport healthy{chainHealth.lastOkAt
									? ` — last connected ${agoLabel(chainHealth.lastOkAt)}`
									: ''}.
							</span>
						{/if}
					</div>
				{/if}
			</div>

			<div class="save-row">
				<button class="btn btn-primary" disabled={saving || testing !== null}>
					{#if saving}<span class="spinner"></span>{/if}
					Save settings
				</button>
			</div>
		</form>

		<!-- ===================================== MINING (group 7) -->
		<h2 class="group-title" id="mining">Mining</h2>
		<div class="hw-row static toggle-row">
			<div class="row-textblock">
				<span class="row-title">Mining</span>
				<span class="row-desc">Let people on this Heartwood mine to the pool.</span>
			</div>
			<div class="unit-toggle" role="group" aria-label="Mining">
				{#each [{ v: true, l: 'On' }, { v: false, l: 'Off' }] as opt (opt.l)}
					<form
						method="POST"
						action="?/toggleFlag"
						use:enhance={toggleEnhance('Mining setting saved.', 'Could not update mining.')}
					>
						<input type="hidden" name="key" value="mining" />
						<input type="hidden" name="enabled" value={String(opt.v)} />
						<button
							type="submit"
							class="unit"
							class:active={admin.miningEnabled === opt.v}
							aria-pressed={admin.miningEnabled === opt.v}>{opt.l}</button
						>
					</form>
				{/each}
			</div>
		</div>
		{#if admin.miningEnabled}
			<a class="hw-row" href="/admin/mining">
				<span class="row-title">Pool operator settings</span>
				<span class="row-meta">stratum, payouts, difficulty</span>
				<span class="chev"><Icon name="chevron-right" size={14} /></span>
			</a>
		{/if}

		<!-- ===================================== EXPLORER (group 8) -->
		<h2 class="group-title" id="explorer">Explorer</h2>
		<div class="hw-row static toggle-row">
			<div class="row-textblock">
				<span class="row-title">Block explorer</span>
				<span class="row-desc">Browse blocks, transactions and the mempool.</span>
			</div>
			<div class="unit-toggle" role="group" aria-label="Block explorer">
				{#each [{ v: true, l: 'On' }, { v: false, l: 'Off' }] as opt (opt.l)}
					<form
						method="POST"
						action="?/toggleFlag"
						use:enhance={toggleEnhance('Explorer setting saved.', 'Could not update explorer.')}
					>
						<input type="hidden" name="key" value="explorer" />
						<input type="hidden" name="enabled" value={String(opt.v)} />
						<button
							type="submit"
							class="unit"
							class:active={admin.explorerEnabled === opt.v}
							aria-pressed={admin.explorerEnabled === opt.v}>{opt.l}</button
						>
					</form>
				{/each}
			</div>
		</div>

		<!-- ===================================== INSTANCE (group 9, collapsed) -->
		<button
			type="button"
			class="hw-row group-toggle"
			id="instance"
			aria-expanded={!!open.instance}
			aria-controls="instance-rows"
			onclick={() => toggleRow('instance')}
		>
			<span class="group-title inline">Instance</span>
			<span class="chev" class:down={open.instance}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.instance}
			<div class="group-rows fade-in" id="instance-rows">
				<!-- Registration + operator name (posts to ?/save; form.has-guarded) -->
				<form
					method="POST"
					action="?/save"
					class="admin-form inner"
					use:enhance={() => {
						savingRegistration = true;
						return async ({ update, result }) => {
							savingRegistration = false;
							await update({ reset: false });
							if (result.type === 'success') toast.success('Registration saved.');
							else if (result.type === 'failure') {
								const msg = result.data?.error;
								toast.error(typeof msg === 'string' ? msg : 'Could not save.');
							}
						};
					}}
				>
					<div class="panel-sub-title">Registration</div>
					<p class="hint">Who can create an account on this instance.</p>
					<div class="radio-group">
						{#each [['open', 'Open', 'Anyone with the URL can sign up'], ['invite', 'Invite only', 'New accounts need an invite code'], ['closed', 'Closed', 'No new accounts']] as [value, label, desc] (value)}
							<label class="radio-card" class:selected={admin.settings.registrationMode === value}>
								<input
									type="radio"
									name="registrationMode"
									{value}
									checked={admin.settings.registrationMode === value}
								/>
								<span class="radio-label">{label}</span>
								<span class="radio-desc">{desc}</span>
							</label>
						{/each}
					</div>
					<div class="field" style="max-width: 420px">
						<label class="label" for="operatorName">Operator name</label>
						<input
							class="input"
							id="operatorName"
							name="operatorName"
							placeholder="e.g. Acme Bitcoin Services, or your name"
							bind:value={operatorName}
						/>
						<span class="hint">
							Shown to users as “This instance is operated by …” on the terms they accept. Changing
							it re-prompts users to accept.
						</span>
					</div>
					<div class="actions">
						<button class="btn btn-primary" disabled={savingRegistration}>
							{#if savingRegistration}<span class="spinner"></span>{/if}
							Save registration
						</button>
					</div>
				</form>

				<!-- Team features -->
				<form
					method="POST"
					action={admin.settings.instanceMode === 'team' ? '?/lockTeamMode' : '?/unlockTeamMode'}
					class="admin-form inner"
					use:enhance={toggleEnhance(
						admin.settings.instanceMode === 'team' ? 'Team features hidden.' : 'Team features unlocked.',
						'Could not update team features.'
					)}
				>
					<div class="panel-sub-title">Team features</div>
					<p class="hint">
						Multi-user features — other accounts, invites, contacts, and multisig wallet sharing —
						stay hidden until you turn this on. Nothing is deleted either way; this only shows or
						hides the nav.
					</p>
					<div class="actions" style="justify-content: flex-start">
						{#if admin.settings.instanceMode === 'team'}
							<span class="badge badge-neutral">Unlocked</span>
							<button class="btn btn-secondary btn-sm" disabled={togglingTeamMode}>
								{#if togglingTeamMode}<span class="spinner"></span>{/if}
								Hide team features again
							</button>
						{:else}
							<button class="btn btn-secondary btn-sm" disabled={togglingTeamMode}>
								{#if togglingTeamMode}<span class="spinner"></span>{/if}
								Unlock team features
							</button>
						{/if}
					</div>
				</form>

				<!-- User agreement editor -->
				<button
					type="button"
					class="hw-row"
					aria-expanded={!!open.agreement}
					onclick={() => toggleRow('agreement')}
				>
					<span class="row-title">User agreement</span>
					<span class="row-meta">version {admin.agreement.version}</span>
					<span class="chev" class:down={open.agreement}><Icon name="chevron-right" size={14} /></span>
				</button>
				{#if open.agreement}
					<div class="row-panel fade-in">
						<form
							method="POST"
							action="?/saveAgreement"
							class="stack inner"
							use:enhance={() => {
								savingAgreement = true;
								return async ({ update, result }) => {
									savingAgreement = false;
									await update({ reset: false });
									if (result.type === 'success') toast.success('Agreement saved.');
									else if (result.type === 'failure') {
										const msg = result.data?.error;
										toast.error(typeof msg === 'string' ? msg : 'Could not save the agreement.');
									}
								};
							}}
						>
							<p class="hint">
								The terms every user must accept before using this instance. Saving a change bumps
								the version, so existing users re-accept on their next visit.
								<a href="/terms" target="_blank" rel="noopener">Preview the public terms page →</a>
							</p>
							<div class="field">
								<label class="label" for="agreementText">Agreement text</label>
								<textarea
									class="input mono agreement-text"
									id="agreementText"
									name="agreementText"
									rows="14"
									bind:value={agreementText}
								></textarea>
								<span class="hint">
									Blank lines separate paragraphs. Start a paragraph with an UPPERCASE lead-in
									(e.g. “NOT A CUSTODIAN.”) and it renders bold.
								</span>
							</div>
							<div class="actions">
								<button class="btn btn-primary" disabled={savingAgreement}>
									{#if savingAgreement}<span class="spinner"></span>{/if}
									Save agreement
								</button>
							</div>
						</form>
					</div>
				{/if}

				<!-- Link rows to the surviving admin subpages (spec §4.1). -->
				<a class="hw-row" href="/admin/notifications">
					<span class="row-title">Notification delivery</span>
					<span class="row-meta">SMTP + channels</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>
				{#if showContactsRow(page.data.instanceMode)}
					<a class="hw-row" href="/admin/announcements">
						<span class="row-title">Announcements</span>
						<span class="row-meta">instance-wide banners</span>
						<span class="chev"><Icon name="chevron-right" size={14} /></span>
					</a>
				{/if}
				<a class="hw-row" href="/admin/referral-settings">
					<span class="row-title">Referrals</span>
					<span class="row-meta">invite links</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>
				<a class="hw-row" href="/admin/backup">
					<span class="row-title">Backup</span>
					<span class="row-meta">config backup &amp; restore</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>
				<a class="hw-row" href="/admin/logs">
					<span class="row-title">Logs</span>
					<span class="row-meta">system activity</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>
				{#if showContactsRow(page.data.instanceMode)}
					<a class="hw-row" href="/admin/users">
						<span class="row-title">Users &amp; invites</span>
						<span class="row-meta">manage accounts</span>
						<span class="chev"><Icon name="chevron-right" size={14} /></span>
					</a>
				{/if}
				<a class="hw-row" href="/admin">
					<span class="row-title">Instance health</span>
					<span class="row-meta">node, backups, storage</span>
					<span class="chev"><Icon name="chevron-right" size={14} /></span>
				</a>

				<!-- Factory reset — LAST, red, typed-confirm, collapsed (brief §1). -->
				<section class="danger-zone" id="factory-reset">
					<button
						type="button"
						class="hw-row group-toggle"
						aria-expanded={!!open.factoryReset}
						aria-controls="factory-reset-rows"
						onclick={() => toggleRow('factoryReset')}
					>
						<span class="group-title danger-title inline">Factory reset</span>
						<span class="chev" class:down={open.factoryReset}><Icon name="chevron-right" size={14} /></span>
					</button>

					{#if open.factoryReset}
						<div class="group-rows fade-in" id="factory-reset-rows">
							<p class="hint">
								Reset this instance: deletes all users, sessions, wallets, and invites, and returns
								Heartwood to first-run setup. Settings and node configuration are wiped too.
								Heartwood only ever holds public keys, so no funds are at risk, but nothing else
								survives.
							</p>
							{#if !confirmingReset}
								<div>
									<button
										type="button"
										class="btn btn-secondary danger-btn"
										onclick={() => {
											confirmingReset = true;
											resetConfirmText = '';
										}}
									>
										Reset this instance
									</button>
								</div>
							{:else}
								<form
									method="POST"
									action="?/resetInstance"
									class="reset-confirm"
									use:enhance={() => {
										resetting = true;
										return async ({ update }) => {
											resetting = false;
											await update();
										};
									}}
								>
									<label class="label" for="resetConfirm">
										This cannot be undone. Type <strong>RESET</strong> to confirm.
									</label>
									<div class="reset-row">
										<input
											class="input mono"
											id="resetConfirm"
											name="confirm"
											autocomplete="off"
											spellcheck="false"
											placeholder="RESET"
											bind:value={resetConfirmText}
										/>
										<button
											class="btn btn-secondary danger-btn"
											disabled={resetConfirmText !== 'RESET' || resetting}
										>
											{#if resetting}<span class="spinner"></span>{/if}
											Erase everything
										</button>
										<button
											type="button"
											class="btn btn-ghost"
											onclick={() => {
												confirmingReset = false;
												resetConfirmText = '';
											}}
										>
											Cancel
										</button>
									</div>
								</form>
							{/if}
						</div>
					{/if}
				</section>
			</div>
		{/if}
	{/if}
		</div>
	</div>
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
		max-width: var(--measure-reading);
		margin: 0 auto;
	}

	/* Section anchors: offset the jump so the sticky chrome doesn't cover the
	   landed row. */
	.settings-content :where([id^='set-']),
	.settings-content :where(#node-connection, #mining, #explorer, #instance, #factory-reset) {
		scroll-margin-top: 24px;
	}

	/* Desktop (>=1160): page-local left section nav + reading-measure content.
	   Below that the nav is hidden and the content stacks exactly as today. */
	.settings-nav {
		display: none;
	}

	@media (min-width: 1160px) {
		.settings-body {
			display: grid;
			grid-template-columns: 150px minmax(0, 1fr);
			gap: 48px;
			align-items: start;
		}

		.settings-nav {
			display: flex;
			flex-direction: column;
			gap: 2px;
			position: sticky;
			top: 24px;
		}

		.settings-nav a {
			padding: 7px 12px;
			border-radius: var(--radius-control);
			font-size: 13.5px;
			font-weight: 500;
			color: var(--text-secondary);
			transition: color 120ms var(--ease), background 120ms var(--ease);
		}

		.settings-nav a:hover {
			color: var(--text);
			background: var(--surface);
		}

		.settings-nav-sep {
			margin-top: 10px;
			padding: 0 12px 2px;
			font-size: 10.5px;
			font-weight: 600;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--text-faint);
		}

		.settings-content {
			min-width: 0;
		}
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
		background: linear-gradient(135deg, var(--accent-dim), var(--accent));
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

	/* ---------- Group headers (spec §2.6c: five named groups) ---------- */

	.group-title {
		display: block;
		margin: 40px 0 2px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.settings-content > .group-title:first-child {
		margin-top: 10px;
	}

	/* Collapsed-group headers (Advanced / Danger zone): the eyebrow itself is
	   the expander button's label, so it loses its block margins and takes the
	   row's flex slot. */
	.group-title.inline {
		flex: 1;
		min-width: 0;
		margin: 0;
	}

	.group-toggle {
		margin-top: 28px;
	}

	.group-rows {
		display: flex;
		flex-direction: column;
	}

	@media (max-width: 900px) {
		.group-title {
			margin-top: 32px;
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
		/* >=44px tap target on touch without changing the text-toggle look
		   (cairn-amyl). */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
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
		/* var() not a literal (cairn-sdx5.7) — this pill sits under the new
		   3-way theme toggle too, so it must retint on light mode instead of
		   always washing in the dark-mode accent hex. */
		background: var(--accent-muted);
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
		padding-top: 6px;
		border-top: 1px solid var(--hairline);
	}

	/* The section's own top margin already separates the group. */
	.danger-zone .group-toggle {
		margin-top: 0;
	}

	.danger-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--error);
	}

	.danger-btn {
		/* Guarantee a >=44px touch target for the account-deletion controls
		   (cairn-amyl). */
		min-height: 44px;
		color: var(--error);
		border-color: rgba(224, 102, 79, 0.4);
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

	/* ============ Admin-config groups (moved from /admin/settings) ============ */

	.group-lead {
		margin: 2px 0 14px;
		max-width: var(--measure-reading);
	}

	.admin-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 760px;
	}

	.admin-form.inner {
		gap: 12px;
		padding: 14px 0 18px;
		border-bottom: 1px solid var(--hairline);
	}

	/* Mining/Explorer toggle rows: a text block + the On/Off unit-toggle. */
	.toggle-row {
		justify-content: space-between;
	}

	.row-textblock {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.row-desc {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.toggle-row .unit-toggle form {
		display: contents;
	}

	.radio-group {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 10px;
	}

	.radio-card {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px 14px;
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-strip);
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.radio-card:hover {
		border-color: var(--border-ghost);
	}

	.radio-card.selected,
	.radio-card:has(input:checked) {
		border-color: var(--accent);
	}

	.radio-card input {
		position: absolute;
		opacity: 0;
	}

	.radio-label {
		font-size: 13.5px;
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.radio-desc {
		font-size: 12px;
		color: var(--text-muted);
	}

	.provenance-card {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-size: 12.5px;
		background: var(--sage-muted);
		border: 1px solid rgba(131, 184, 146, 0.3);
		border-radius: var(--radius-control);
		padding: 10px 12px;
	}

	.provenance-dot {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		margin-top: 4px;
		border-radius: 50%;
		background: var(--sage);
	}

	.provenance-dot.detect {
		background: var(--accent);
	}

	.provenance-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.provenance-title {
		font-weight: 500;
	}

	.provenance-sub {
		color: var(--text-muted);
	}

	.provenance-detail {
		margin-top: 2px;
		color: var(--text-muted);
		font-size: 11.5px;
		word-break: break-all;
	}

	.provenance-card.core-detect {
		background: var(--bg-input);
		border-color: var(--border-ghost);
		align-items: center;
		flex-wrap: wrap;
	}

	.assisted-pass {
		margin-top: 6px;
		max-width: 220px;
	}

	.assisted-connect-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	.custom-fields {
		display: flex;
		flex-direction: column;
		gap: 20px;
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.subgroup {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.proxy-group {
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.subgroup-title {
		font-size: 13px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.row-fields {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.port {
		flex: 0 0 110px;
	}

	.tls-check {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13.5px;
		padding: 9px 0;
		cursor: pointer;
	}

	.tls-check input {
		accent-color: var(--accent);
	}

	.tls-insecure {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-muted);
		cursor: pointer;
	}

	.tls-insecure input {
		margin-top: 2px;
		accent-color: var(--accent);
	}

	.test-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.health-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.health-line.health-bad {
		color: var(--attention);
	}

	.health-dot {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		transform: translateY(-1px);
	}

	.health-dot.ok {
		background: var(--sage);
	}

	.health-dot.bad {
		background: var(--attention);
	}

	.save-row {
		display: flex;
		justify-content: flex-end;
		padding: 6px 0 4px;
	}

	.agreement-text {
		resize: vertical;
		font-size: 12.5px;
		line-height: 1.6;
		min-height: 220px;
	}

	.reset-confirm {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.reset-row {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	.reset-row .input {
		flex: 0 1 180px;
	}
</style>
