<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { goto } from '$app/navigation';
	import { formatSats, formatBtc } from '$lib/format';
	import { btcUsd } from '$lib/price';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';
	import { page } from '$app/state';
	import { isChannelVisible, visibleChannelIds } from './notifyChannelVisibility';

	let { data } = $props();

	// ---- Types mirrored from the loader --------------------------------------
	type ChannelId = 'email' | 'telegram' | 'ntfy' | 'nostr' | 'webhook';
	type ChannelState = {
		channel: ChannelId;
		configured: boolean;
		verifiedAt: string | null;
		config: Record<string, unknown>;
	};
	type TestResult = { ok: boolean; error?: string } | null;

	// ---- Channel connection state -------------------------------------------
	// Seed local editable state from the server load; mutations update in place.
	// svelte-ignore state_referenced_locally
	let channels = $state<ChannelState[]>(data.channels as ChannelState[]);

	function channel(id: ChannelId): ChannelState {
		return channels.find((c) => c.channel === id)!;
	}

	// Per-channel form field values (kept separate from `config` so blanks for
	// secrets stay blank on screen while the stored secret is preserved server-side).
	const emailInit = channel('email').config;
	const telegramInit = channel('telegram').config;
	const ntfyInit = channel('ntfy').config;
	const nostrInit = channel('nostr').config;
	const webhookInit = channel('webhook').config;

	let emailAddress = $state((emailInit.address as string) ?? '');
	let telegramChatId = $state((telegramInit.chatId as string) ?? '');
	let ntfyServer = $state((ntfyInit.server as string) ?? '');
	let ntfyTopic = $state((ntfyInit.topic as string) ?? '');
	let ntfyToken = $state('');
	const ntfyHasToken = $derived(!!channel('ntfy').config.hasAccessToken);
	let nostrPubkey = $state((nostrInit.recipientPubkey as string) ?? '');
	let nostrRelays = $state(((nostrInit.relays as string[]) ?? []).join('\n'));
	let webhookUrl = $state((webhookInit.url as string) ?? '');
	let webhookSecret = $state('');
	const webhookHasSecret = $derived(!!channel('webhook').config.hasSecret);

	// ---- Personal SMTP (email) ----------------------------------------------
	// Optional per-user relay; when unset, email falls back to the instance relay.
	type StoredSmtp = {
		host?: string;
		port?: number;
		user?: string | null;
		from?: string;
		tls?: 'starttls' | 'tls' | 'none';
		hasPass?: boolean;
	};
	const smtpInit = (emailInit.smtp as StoredSmtp | undefined) ?? undefined;
	let useOwnSmtp = $state(!!smtpInit);
	let smtpHost = $state(smtpInit?.host ?? '');
	let smtpPort = $state<string | number>(smtpInit?.port ?? 587);
	let smtpUser = $state(smtpInit?.user ?? '');
	let smtpFrom = $state(smtpInit?.from ?? '');
	let smtpTls = $state<'starttls' | 'tls' | 'none'>(smtpInit?.tls ?? 'starttls');
	let smtpPass = $state('');
	let smtpHasPass = $state(!!smtpInit?.hasPass);
	let testingSmtp = $state(false);
	let smtpTest = $state<{ ok: boolean; error?: string } | null>(null);

	async function testSmtp() {
		smtpTest = null;
		testingSmtp = true;
		try {
			const res = await fetch('/api/notifications/channels/email/test-smtp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					host: smtpHost,
					port: Number(smtpPort),
					user: smtpUser,
					pass: smtpPass, // blank = use the stored password (if any)
					from: smtpFrom,
					tls: smtpTls
				})
			});
			const body = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
			smtpTest = body ?? { ok: false, error: 'No response from the server.' };
		} catch (e) {
			smtpTest = { ok: false, error: e instanceof Error ? e.message : 'Test failed.' };
		} finally {
			testingSmtp = false;
		}
	}

	// Per-channel busy + result state.
	let saving = $state<Record<string, boolean>>({});
	let testing = $state<Record<string, boolean>>({});
	let saveError = $state<Record<string, string | null>>({});
	let testResult = $state<Record<string, TestResult>>({});

	function payloadFor(id: ChannelId): Record<string, unknown> {
		switch (id) {
			case 'email': {
				const p: Record<string, unknown> = { address: emailAddress };
				if (useOwnSmtp) {
					// Blank smtpPass means "keep the stored password" (server convention).
					p.smtp = {
						host: smtpHost,
						port: Number(smtpPort),
						user: smtpUser,
						from: smtpFrom,
						tls: smtpTls,
						pass: smtpPass
					};
				} else {
					// Explicitly drop any saved personal relay, keeping the address.
					p.clearSmtp = true;
				}
				return p;
			}
			case 'telegram':
				return { chatId: telegramChatId };
			case 'ntfy':
				// Blank token means "keep the stored one".
				return { server: ntfyServer, topic: ntfyTopic, accessToken: ntfyToken };
			case 'nostr':
				return {
					recipientPubkey: nostrPubkey,
					relays: nostrRelays.split('\n').map((r) => r.trim()).filter(Boolean)
				};
			case 'webhook':
				return { url: webhookUrl, secret: webhookSecret };
		}
	}

	async function saveChannel(id: ChannelId) {
		saveError[id] = null;
		testResult[id] = null;
		saving[id] = true;
		try {
			const res = await fetch(`/api/notifications/channels/${id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payloadFor(id))
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not save this channel.');
			const c = channel(id);
			c.configured = true;
			c.config = body.config ?? c.config;
			// Clear the just-submitted secret inputs (server kept/updated them).
			if (id === 'ntfy') ntfyToken = '';
			if (id === 'webhook') webhookSecret = '';
			if (id === 'email') {
				smtpPass = '';
				const savedSmtp = (body.config?.smtp as { hasPass?: boolean } | undefined) ?? undefined;
				smtpHasPass = !!savedSmtp?.hasPass;
			}
		} catch (e) {
			saveError[id] = e instanceof Error ? e.message : 'Could not save this channel.';
		} finally {
			saving[id] = false;
		}
	}

	async function testChannel(id: ChannelId) {
		// Loading state is set inside this async fn, never in an onclick+formaction
		// combo — that was the bug in the Electrum test UI (cairn-unp).
		testResult[id] = null;
		testing[id] = true;
		try {
			const res = await fetch(`/api/notifications/channels/${id}/test`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as TestResult;
			testResult[id] = body ?? { ok: false, error: 'No response from the server.' };
		} catch (e) {
			testResult[id] = { ok: false, error: e instanceof Error ? e.message : 'Test failed.' };
		} finally {
			testing[id] = false;
		}
	}

	async function disconnectChannel(id: ChannelId) {
		saving[id] = true;
		saveError[id] = null;
		try {
			const res = await fetch(`/api/notifications/channels/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Could not disconnect.');
			const c = channel(id);
			c.configured = false;
			c.verifiedAt = null;
			testResult[id] = null;
		} catch (e) {
			saveError[id] = e instanceof Error ? e.message : 'Could not disconnect.';
		} finally {
			saving[id] = false;
		}
	}

	// Destructive acts confirm through the shared Modal instead of
	// window.confirm — same network logic as before once confirmed.
	let confirmTarget = $state<{ title: string; message: string; label: string; run: () => void } | null>(null);
	let confirmOpen = $state(false);

	function askDisconnect(id: ChannelId, label: string) {
		confirmTarget = {
			title: `Disconnect ${label}?`,
			message: `Its settings will be cleared. You can reconnect ${label} any time by entering them again.`,
			label: 'Disconnect',
			run: () => void disconnectChannel(id)
		};
		confirmOpen = true;
	}

	// ---- PGP -----------------------------------------------------------------
	// svelte-ignore state_referenced_locally
	let pgp = $state<{ fingerprint: string; createdAt: string } | null>(data.pgp);
	let pgpPaste = $state('');
	let pgpBusy = $state(false);
	let pgpError = $state<string | null>(null);

	async function savePgp() {
		pgpError = null;
		pgpBusy = true;
		try {
			const res = await fetch('/api/notifications/pgp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ publicKey: pgpPaste })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not save that key.');
			pgp = { fingerprint: body.key.fingerprint, createdAt: new Date().toISOString() };
			pgpPaste = '';
		} catch (e) {
			pgpError = e instanceof Error ? e.message : 'Could not save that key.';
		} finally {
			pgpBusy = false;
		}
	}

	async function removePgp() {
		pgpBusy = true;
		pgpError = null;
		try {
			const res = await fetch('/api/notifications/pgp', { method: 'DELETE' });
			if (!res.ok) throw new Error('Could not remove the key.');
			pgp = null;
		} catch (e) {
			pgpError = e instanceof Error ? e.message : 'Could not remove the key.';
		} finally {
			pgpBusy = false;
		}
	}

	function askRemovePgp() {
		confirmTarget = {
			title: 'Remove your PGP key?',
			message: 'Notification emails will no longer be encrypted. You can paste the key again later.',
			label: 'Remove key',
			run: () => void removePgp()
		};
		confirmOpen = true;
	}

	function groupFingerprint(fp: string): string {
		return (fp.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
	}

	// ---- Event preferences ---------------------------------------------------
	const EXTERNAL_CHANNELS: { id: ChannelId; label: string }[] = [
		{ id: 'email', label: 'Email' },
		{ id: 'telegram', label: 'Telegram' },
		{ id: 'ntfy', label: 'ntfy' },
		{ id: 'nostr', label: 'Nostr' },
		{ id: 'webhook', label: 'Webhook' }
	];

	// cairn-lv2t: a channel whose notify_* flag is off for this user is hidden
	// entirely — the same convention DevicePicker.svelte uses for hw_* flags —
	// rather than rendered normally with server enforcement as the only gate.
	const visibleExternalChannels = $derived(visibleChannelIds(EXTERNAL_CHANNELS, page.data.flags));
	const anyChannelVisible = $derived(visibleExternalChannels.length > 0);

	// Event catalogue grouped by category. Admin rows hidden for non-admins.
	type EventDef = { type: string; label: string; desc: string; tunable?: 'threshold' | 'confirmations' };
	const GROUPS: { title: string; admin?: boolean; events: EventDef[] }[] = [
		{
			title: 'Wallet activity',
			events: [
				{ type: 'tx_received', label: 'Payment received', desc: 'An inbound transaction is first seen for a watched address.' },
				{ type: 'tx_confirmed', label: 'Transaction confirmed', desc: 'A transaction crosses a confirmation threshold.', tunable: 'confirmations' },
				{ type: 'tx_replaced', label: 'Incoming payment cancelled', desc: 'An unconfirmed inbound payment was double-spent or replaced before it confirmed.' },
				{ type: 'tx_large', label: 'Large transaction', desc: 'A transaction is worth more than the amount you set below.', tunable: 'threshold' },
				{ type: 'sign_session_waiting', label: 'Signature waiting', desc: 'A multisig transaction is waiting for signatures.' },
				{ type: 'sign_session_complete', label: 'Ready to broadcast', desc: 'A multisig transaction has collected every signature and is ready to broadcast.' },
				{ type: 'key_health_due', label: 'Key health check due', desc: 'A multisig key has not been verified in ~180 days.' },
				{ type: 'backup_missing', label: 'Backup missing', desc: 'A wallet was created with no backup ever downloaded.' },
				{ type: 'backup_stale', label: 'Backup stale', desc: 'Your instance backup is older than the reminder interval.' },
				{ type: 'multisig_removed', label: 'Removed from a shared wallet', desc: 'A shared wallet was removed because its owner deleted their account.' },
				{ type: 'cosigner_left', label: 'A co-signer left', desc: 'A co-signer deleted their account while still holding an unsigned slot on a shared wallet.' }
			]
		},
		{
			title: 'Mining',
			events: [
				{ type: 'mining_block_found', label: 'Block found', desc: 'Your miner found a block — the full reward pays your wallet.' },
				{ type: 'mining_worker_offline', label: 'Miner offline', desc: 'One of your mining workers stopped submitting shares.' },
				{ type: 'mining_best_share', label: 'New best share', desc: 'You reached a new personal-best share difficulty.' }
			]
		},
		{
			title: 'Security',
			events: [
				{ type: 'security_failed_login', label: 'Failed sign-in attempts', desc: 'Repeated failed sign-ins against your account.' },
				{ type: 'security_new_passkey', label: 'New passkey added', desc: 'A new passkey or recovery credential was added — "was this you?"' },
				{ type: 'security_password_changed', label: 'Password changed', desc: 'Your account password was changed — "was this you?"' },
				{ type: 'security_new_device', label: 'New device sign-in', desc: 'Your account was signed in from a device we haven\'t seen before.' }
			]
		},
		{
			title: 'Admin',
			admin: true,
			events: [
				{ type: 'admin_new_signup', label: 'New sign-up', desc: 'A new user account was created.' },
				{ type: 'admin_invite_used', label: 'Invite redeemed', desc: 'An invite code was redeemed.' },
				{ type: 'admin_restore', label: 'Backup restored', desc: 'An encrypted instance backup was restored — flags any imported accounts.' },
				{ type: 'admin_server_health', label: 'Server health', desc: 'Node connection down, reconnect looping, or disk space low.' },
				{ type: 'admin_user_disabled', label: 'User disabled or re-enabled', desc: 'Another admin disabled or re-enabled a user account.' },
				{ type: 'admin_settings_changed', label: 'Instance settings changed', desc: 'A security-relevant instance setting was changed by an admin.' },
				{ type: 'admin_recovery_code_minted', label: 'Recovery code minted', desc: 'An admin minted a recovery code for a restored account.' }
			]
		}
	];

	const visibleGroups = $derived(GROUPS.filter((g) => !g.admin || data.isAdmin));

	// Preference lookup: user rows override DEFAULT_PREFERENCES.
	type PrefRow = { eventType: string; channel: string; enabled: boolean; config: Record<string, unknown> };
	// svelte-ignore state_referenced_locally
	let prefs = $state<PrefRow[]>(data.preferences as PrefRow[]);
	// svelte-ignore state_referenced_locally
	const defaults = data.defaultPreferences as Record<string, string[]>;

	function savedRow(eventType: string, ch: ChannelId): PrefRow | undefined {
		return prefs.find((p) => p.eventType === eventType && p.channel === ch);
	}

	/** Is this (event, channel) enabled? Saved row wins; else DEFAULT_PREFERENCES. */
	function isEnabled(eventType: string, ch: ChannelId): boolean {
		const row = savedRow(eventType, ch);
		if (row) return row.enabled;
		return (defaults[eventType] ?? []).includes(ch);
	}

	/** True when the current value comes from the default, not a saved row. */
	function isDefault(eventType: string, ch: ChannelId): boolean {
		return !savedRow(eventType, ch);
	}

	// Tunables: read from any saved row for the event type (shared across channels).
	function tunableConfig(eventType: string): Record<string, unknown> {
		const row = prefs.find((p) => p.eventType === eventType && p.config && Object.keys(p.config).length);
		return row?.config ?? {};
	}

	let prefSaving = $state(false);
	let prefError = $state<string | null>(null);
	let prefSaved = $state(false);
	let savedTimer: ReturnType<typeof setTimeout> | null = null;

	async function patchPrefs(updates: { eventType: string; channel: string; enabled: boolean; config?: Record<string, unknown> }[]) {
		prefError = null;
		prefSaving = true;
		try {
			const res = await fetch('/api/notifications/preferences', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ updates })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not save preferences.');
			prefs = body.preferences as PrefRow[];
			prefSaved = true;
			if (savedTimer) clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (prefSaved = false), 2000);
		} catch (e) {
			prefError = e instanceof Error ? e.message : 'Could not save preferences.';
		} finally {
			prefSaving = false;
		}
	}

	function toggle(eventType: string, ch: ChannelId) {
		const next = !isEnabled(eventType, ch);
		patchPrefs([{ eventType, channel: ch, enabled: next }]);
	}

	// Tunable editors ---------------------------------------------------------
	function largeTxSats(eventType: string): string {
		const v = tunableConfig(eventType).thresholdSats;
		return typeof v === 'number' ? String(v) : '';
	}

	async function saveThreshold(eventType: string, value: string) {
		const sats = value.trim() === '' ? null : Number(value);
		if (sats !== null && (!Number.isFinite(sats) || sats < 0)) {
			prefError = 'Enter a whole number of sats.';
			return;
		}
		// Persist the tunable onto every currently-enabled external channel row for
		// this event (config is per (event, channel); mirror it so the dispatcher
		// reads it regardless of which channel fires).
		const config = sats === null ? {} : { thresholdSats: Math.floor(sats) };
		const updates = EXTERNAL_CHANNELS.map((c) => ({
			eventType,
			channel: c.id,
			enabled: isEnabled(eventType, c.id),
			config
		}));
		await patchPrefs(updates);
	}

	// ---- Dollar-primary threshold entry (cairn-7ph8) -------------------------
	// The stored value is always sats (server shape unchanged) — this is a
	// client-only presentation layer that converts a typed dollar amount to
	// sats before calling the existing saveThreshold(). When the live price
	// (btcUsd) is unavailable, the form falls back to the raw sats input.
	let thrDraft = $state<Record<string, string>>({}); // live-typed dollar string, keyed by event type
	let thrShowSats = $state<Record<string, boolean>>({}); // "enter in bitcoin instead" toggle, per event type

	/** Dollar string -> sats, or null if blank/invalid. Accepts "$500", "500", "1,200.50". */
	function usdDraftToSats(usdStr: string, price: number): number | null {
		const trimmed = usdStr.trim();
		if (trimmed === '') return null;
		const usd = Number(trimmed.replace(/^\$/, '').replace(/,/g, ''));
		if (!Number.isFinite(usd) || usd < 0) return null;
		return Math.round((usd / price) * 1e8);
	}

	/** The dollar amount to show for a saved sats threshold, at the current price. */
	function initialUsdDraft(eventType: string, price: number): string {
		const sats = tunableConfig(eventType).thresholdSats;
		if (typeof sats !== 'number') return '';
		const usd = (sats / 1e8) * price;
		return usd >= 1 ? String(Math.round(usd)) : usd.toFixed(2);
	}

	/** What the dollar input currently shows: the user's in-progress edit, else the saved value. */
	function thrUsdDisplay(eventType: string, price: number): string {
		return thrDraft[eventType] ?? initialUsdDraft(eventType, price);
	}

	async function saveThresholdUsd(eventType: string, usdStr: string, price: number) {
		if (usdStr.trim() === '') {
			await saveThreshold(eventType, '');
			return;
		}
		const sats = usdDraftToSats(usdStr, price);
		if (sats === null) {
			prefError = 'Enter a dollar amount.';
			return;
		}
		await saveThreshold(eventType, String(sats));
	}

	const CONFIRMATION_OPTIONS = [1, 3, 6];
	function confirmations(eventType: string): number[] {
		const v = tunableConfig(eventType).confirmations;
		return Array.isArray(v) ? (v as number[]) : [1, 6];
	}
	async function toggleConfirmation(eventType: string, n: number) {
		const current = new Set(confirmations(eventType));
		if (current.has(n)) current.delete(n);
		else current.add(n);
		const list = [...current].sort((a, b) => a - b);
		const config = { confirmations: list.length ? list : [1] };
		const updates = EXTERNAL_CHANNELS.map((c) => ({
			eventType,
			channel: c.id,
			enabled: isEnabled(eventType, c.id),
			config
		}));
		await patchPrefs(updates);
	}

	// Which channel rows are expanded to show their config panel.
	let open = $state<Record<string, boolean>>({});
	function toggleRow(key: string) {
		open[key] = !open[key];
	}

	// Which event rows are expanded to show per-channel toggles.
	let expanded = $state<Record<string, boolean>>({});
	function toggleExpanded(type: string) {
		expanded[type] = !expanded[type];
	}

	function enabledSummary(eventType: string): string {
		// cairn-lv2t: a flagged-off channel is never an option here, so it never
		// appears in the summary even if a stale saved row still marks it enabled.
		const on = ['inapp', ...visibleExternalChannels.map((c) => c.id)].filter((ch) =>
			ch === 'inapp' ? true : isEnabled(eventType, ch as ChannelId)
		);
		if (on.length === 1) return 'In-app only';
		const labels = on.map((c) => (c === 'inapp' ? 'In-app' : visibleExternalChannels.find((e) => e.id === c)?.label));
		return labels.join(', ');
	}

	// ---- Quiet hours (cairn-5gpv.4) -----------------------------------------
	// A do-not-disturb window during which routine external notifications are
	// deferred to the window's end; urgent security alerts still come through when
	// the override is on. In-app alerts are never affected.
	type QuietHours = {
		enabled: boolean;
		start: string | null;
		end: string | null;
		tz: string | null;
		urgentOverride: boolean;
	};
	// svelte-ignore state_referenced_locally
	let quiet = $state<QuietHours>(data.quietHours as QuietHours);
	// svelte-ignore state_referenced_locally
	let quietStart = $state((data.quietHours as QuietHours).start ?? '22:00');
	// svelte-ignore state_referenced_locally
	let quietEnd = $state((data.quietHours as QuietHours).end ?? '07:00');
	// Pre-fill the time zone from the saved value, else the browser's own zone.
	const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
	// svelte-ignore state_referenced_locally
	let quietTz = $state((data.quietHours as QuietHours).tz ?? browserTz ?? '');
	let quietSaving = $state(false);
	let quietError = $state<string | null>(null);
	let quietSaved = $state(false);

	async function saveQuiet() {
		quietError = null;
		quietSaving = true;
		try {
			const res = await fetch('/api/notifications/quiet-hours', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enabled: quiet.enabled,
					start: quietStart,
					end: quietEnd,
					tz: quietTz,
					urgentOverride: quiet.urgentOverride
				})
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not save quiet hours.');
			quiet = body.quietHours as QuietHours;
			quietSaved = true;
			setTimeout(() => (quietSaved = false), 2000);
		} catch (e) {
			quietError = e instanceof Error ? e.message : 'Could not save quiet hours.';
		} finally {
			quietSaving = false;
		}
	}
</script>

<svelte:head>
	<title>Notifications — Settings — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer. -->
	<header class="flow-header">
		<BackCircle href="/settings" label="Back to settings" />
		<span class="flow-eyebrow">NOTIFICATIONS</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow breadcrumb, linking back to Settings. Navigates via
	     goto(..., { replaceState: true }) rather than a plain <a> so it
	     replaces the current history entry instead of pushing a new one —
	     otherwise Back alternates between here and /settings (cairn-ojvs). -->
	<a
		class="crumb-link"
		href="/settings"
		onclick={(e) => {
			e.preventDefault();
			goto('/settings', { replaceState: true });
		}}
	>
		<EyebrowBreadcrumb path={['Settings']} current="Notifications" />
	</a>

	<h1 class="page-title">Notifications</h1>
	<p class="lede">
		Choose how Heartwood reaches you. In-app alerts are always on; connect any of the channels
		below to also get notified by email, push, or your own tools. Everything here is opt-in and
		only ever sends to servers you configure — Heartwood adds no third-party telemetry.
	</p>

	<!-- ============ CHANNEL CONNECTIONS ============ -->
	<section class="hw-section">
		<h2 class="section-title">Channels</h2>

		{#if !anyChannelVisible}
			<p class="hint">
				Your administrator has disabled every external notification channel. In-app alerts are
				still available.
			</p>
		{/if}

		<!-- Email -->
		{#if isChannelVisible('email', page.data.flags)}
		<button type="button" class="hw-row" aria-expanded={!!open.email} onclick={() => toggleRow('email')}>
			<span class="row-title">Email</span>
			{@render connMeta('email')}
			<span class="chev" class:down={open.email}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.email}
			<div class="row-panel fade-in">
				<p class="hint">Notifications to your inbox over your instance's SMTP relay.</p>
				<div class="field">
					<label class="label" for="email-address">Send to</label>
					<input class="input" id="email-address" type="email" bind:value={emailAddress} placeholder={data.defaults.emailAddress} />
					<span class="hint">Defaults to your account email if left blank.</span>
				</div>
				{#if saveError.email}<div class="form-error" role="alert">{saveError.email}</div>{/if}
				<div class="ch-actions">
					<button class="btn btn-primary btn-sm" onclick={() => saveChannel('email')} disabled={saving.email}>
						{#if saving.email}<span class="spinner"></span>{/if} Save
					</button>
					<button class="btn btn-secondary btn-sm" onclick={() => testChannel('email')} disabled={testing.email || !channel('email').configured}>
						{#if testing.email}<span class="spinner"></span>{/if} Test
					</button>
					{#if channel('email').configured}
						<button class="btn btn-ghost btn-sm" onclick={() => askDisconnect('email', 'Email')} disabled={saving.email}>Disconnect</button>
					{/if}
					{@render resultBadge('email')}
				</div>

				<!-- Personal SMTP sub-section -->
				<div class="subsection">
					<div class="sub-head">
						<span class="sub-title">Use my own email server</span>
						<span class="optional">optional</span>
					</div>
					<p class="hint">
						By default, notifications go out through the instance's shared email server (if the admin
						has set one up). Turn this on to send them through your own email provider (Gmail,
						Fastmail, etc.) instead.
					</p>
					<label class="toggle-row">
						<input type="checkbox" bind:checked={useOwnSmtp} />
						<span class="toggle-title">Send email through my own SMTP server</span>
					</label>

					{#if useOwnSmtp}
						<div class="smtp-form fade-in">
							<div class="two-col">
								<div class="field">
									<label class="label" for="smtp-host">Host</label>
									<input class="input mono" id="smtp-host" bind:value={smtpHost} placeholder="smtp.gmail.com" />
								</div>
								<div class="field">
									<label class="label" for="smtp-port">Port</label>
									<input class="input mono" id="smtp-port" type="number" min="1" max="65535" bind:value={smtpPort} />
								</div>
							</div>
							<div class="two-col">
								<div class="field">
									<label class="label" for="smtp-user">Username</label>
									<input class="input mono" id="smtp-user" bind:value={smtpUser} autocomplete="off" placeholder="you@gmail.com" />
								</div>
								<div class="field">
									<label class="label" for="smtp-pass">Password</label>
									<input
										class="input mono"
										id="smtp-pass"
										type="password"
										bind:value={smtpPass}
										autocomplete="new-password"
										placeholder={smtpHasPass ? '•••••••• (unchanged)' : ''}
									/>
									{#if smtpHasPass}<span class="hint">A password is stored. Leave blank to keep it.</span>{/if}
								</div>
							</div>
							<div class="two-col">
								<div class="field">
									<label class="label" for="smtp-from">From address</label>
									<input class="input mono" id="smtp-from" type="email" bind:value={smtpFrom} placeholder="you@gmail.com" />
								</div>
								<div class="field">
									<label class="label" for="smtp-tls">Encryption</label>
									<select class="select input" id="smtp-tls" bind:value={smtpTls}>
										<option value="starttls">STARTTLS</option>
										<option value="tls">TLS (implicit)</option>
										<option value="none">None</option>
									</select>
								</div>
							</div>
							<div class="ch-actions">
								<button class="btn btn-secondary btn-sm" onclick={testSmtp} disabled={testingSmtp}>
									{#if testingSmtp}<span class="spinner"></span>{/if} Test
								</button>
								{#if smtpTest}
									{#if smtpTest.ok}
										<span class="badge badge-success">Test email sent</span>
									{:else}
										<span class="badge badge-warning">{smtpTest.error ?? 'Failed'}</span>
									{/if}
								{/if}
								<span class="hint">Sends a test to your destination address using these values (not yet saved). Click <strong>Save</strong> above to keep them.</span>
							</div>
						</div>
					{/if}
				</div>

				<!-- PGP sub-section -->
				<div class="subsection">
					<div class="sub-head">
						<span class="sub-title">
							<Term tip="PGP encrypts just the notification email body — it has nothing to do with your Bitcoin keys, which never leave your hardware wallet.">PGP encryption</Term>
						</span>
						<span class="optional">optional</span>
					</div>
					<p class="hint">
						Paste your <strong>public</strong> key to encrypt notification email bodies. This is not
						your seed phrase and can never touch your bitcoin — it only scrambles the text of these
						emails so your mail provider can't read them.
					</p>
					{#if pgpError}<div class="form-error" role="alert">{pgpError}</div>{/if}
					{#if pgp}
						<div class="pgp-current">
							<Icon name="check" size={15} />
							<div class="pgp-body">
								<div class="pgp-label">Key on file</div>
								<code class="fp">{groupFingerprint(pgp.fingerprint)}</code>
								<div class="hint">Cross-check this fingerprint against your own keyring.</div>
							</div>
							<button class="btn btn-ghost btn-sm" onclick={askRemovePgp} disabled={pgpBusy}>Remove</button>
						</div>
					{:else}
						<div class="field">
							<label class="label" for="pgp-paste">Public key (ASCII-armored)</label>
							<textarea class="input mono pgp-paste" id="pgp-paste" rows="5" bind:value={pgpPaste} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"></textarea>
						</div>
						<div class="ch-actions">
							<button class="btn btn-secondary btn-sm" onclick={savePgp} disabled={pgpBusy || !pgpPaste.trim()}>
								{#if pgpBusy}<span class="spinner"></span>{/if} Save key
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
		{/if}

		<!-- Telegram -->
		{#if isChannelVisible('telegram', page.data.flags)}
		<button type="button" class="hw-row" aria-expanded={!!open.telegram} onclick={() => toggleRow('telegram')}>
			<span class="row-title">Telegram</span>
			{@render connMeta('telegram')}
			<span class="chev" class:down={open.telegram}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.telegram}
			<div class="row-panel fade-in">
				<p class="hint">Messages from your instance's Telegram bot. Message the bot first, then paste your chat ID here.</p>
				<div class="field">
					<label class="label" for="tg-chat">Chat ID</label>
					<input class="input mono" id="tg-chat" bind:value={telegramChatId} placeholder="123456789" />
				</div>
				{#if saveError.telegram}<div class="form-error" role="alert">{saveError.telegram}</div>{/if}
				<div class="ch-actions">
					<button class="btn btn-primary btn-sm" onclick={() => saveChannel('telegram')} disabled={saving.telegram}>{#if saving.telegram}<span class="spinner"></span>{/if} Save</button>
					<button class="btn btn-secondary btn-sm" onclick={() => testChannel('telegram')} disabled={testing.telegram || !channel('telegram').configured}>{#if testing.telegram}<span class="spinner"></span>{/if} Test</button>
					{#if channel('telegram').configured}<button class="btn btn-ghost btn-sm" onclick={() => askDisconnect('telegram', 'Telegram')} disabled={saving.telegram}>Disconnect</button>{/if}
					{@render resultBadge('telegram')}
				</div>
			</div>
		{/if}
		{/if}

		<!-- ntfy -->
		{#if isChannelVisible('ntfy', page.data.flags)}
		<button type="button" class="hw-row" aria-expanded={!!open.ntfy} onclick={() => toggleRow('ntfy')}>
			<span class="row-title"><Term tip="ntfy is a simple, self-hostable push notification service. You pick a topic name — no account needed — and subscribe to it on your phone.">ntfy</Term> push</span>
			{@render connMeta('ntfy')}
			<span class="chev" class:down={open.ntfy}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.ntfy}
			<div class="row-panel fade-in">
				<p class="hint">Push notifications via ntfy.sh or your own self-hosted ntfy server.</p>
				<div class="two-col">
					<div class="field">
						<label class="label" for="ntfy-server">Server</label>
						<input class="input mono" id="ntfy-server" bind:value={ntfyServer} placeholder={data.defaults.ntfyServer || 'https://ntfy.sh'} />
					</div>
					<div class="field">
						<label class="label" for="ntfy-topic">Topic</label>
						<input class="input mono" id="ntfy-topic" bind:value={ntfyTopic} placeholder="my-secret-topic" />
					</div>
				</div>
				<div class="field">
					<label class="label" for="ntfy-token">Access token <span class="hint-inline">optional</span></label>
					<input class="input mono" id="ntfy-token" type="password" bind:value={ntfyToken} placeholder={ntfyHasToken ? '•••••••• (unchanged)' : 'for protected topics'} autocomplete="off" />
					{#if ntfyHasToken}<span class="hint">A token is stored. Leave blank to keep it.</span>{/if}
				</div>
				{#if saveError.ntfy}<div class="form-error" role="alert">{saveError.ntfy}</div>{/if}
				<div class="ch-actions">
					<button class="btn btn-primary btn-sm" onclick={() => saveChannel('ntfy')} disabled={saving.ntfy}>{#if saving.ntfy}<span class="spinner"></span>{/if} Save</button>
					<button class="btn btn-secondary btn-sm" onclick={() => testChannel('ntfy')} disabled={testing.ntfy || !channel('ntfy').configured}>{#if testing.ntfy}<span class="spinner"></span>{/if} Test</button>
					{#if channel('ntfy').configured}<button class="btn btn-ghost btn-sm" onclick={() => askDisconnect('ntfy', 'ntfy')} disabled={saving.ntfy}>Disconnect</button>{/if}
					{@render resultBadge('ntfy')}
				</div>
			</div>
		{/if}
		{/if}

		<!-- Nostr -->
		{#if isChannelVisible('nostr', page.data.flags)}
		<button type="button" class="hw-row" aria-expanded={!!open.nostr} onclick={() => toggleRow('nostr')}>
			<span class="row-title">Nostr</span>
			{@render connMeta('nostr')}
			<span class="chev" class:down={open.nostr}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.nostr}
			<div class="row-panel fade-in">
				<p class="hint">
					Encrypted direct messages to your Nostr identity, using
					<Term tip="NIP-04 and NIP-44 are the Nostr standards for encrypted direct messages. NIP-44 is the newer, stronger scheme; NIP-04 is the older, more widely supported one.">NIP-04/NIP-44</Term>. Heartwood sends from its own instance identity to the pubkey you give here.
				</p>
				<div class="field">
					<label class="label" for="nostr-pk">Your public key (npub or hex)</label>
					<input class="input mono" id="nostr-pk" bind:value={nostrPubkey} placeholder="npub1…" />
				</div>
				<div class="field">
					<label class="label" for="nostr-relays">Relays <span class="hint-inline">optional, one per line</span></label>
					<textarea class="input mono relays" id="nostr-relays" rows="3" bind:value={nostrRelays} placeholder={(data.defaults.nostrRelays ?? []).join('\n') || 'wss://relay.damus.io'}></textarea>
					<span class="hint">Leave blank to use the instance default relays.</span>
				</div>
				{#if saveError.nostr}<div class="form-error" role="alert">{saveError.nostr}</div>{/if}
				<div class="ch-actions">
					<button class="btn btn-primary btn-sm" onclick={() => saveChannel('nostr')} disabled={saving.nostr}>{#if saving.nostr}<span class="spinner"></span>{/if} Save</button>
					<button class="btn btn-secondary btn-sm" onclick={() => testChannel('nostr')} disabled={testing.nostr || !channel('nostr').configured}>{#if testing.nostr}<span class="spinner"></span>{/if} Test</button>
					{#if channel('nostr').configured}<button class="btn btn-ghost btn-sm" onclick={() => askDisconnect('nostr', 'Nostr')} disabled={saving.nostr}>Disconnect</button>{/if}
					{@render resultBadge('nostr')}
				</div>
			</div>
		{/if}
		{/if}

		<!-- Webhook -->
		{#if isChannelVisible('webhook', page.data.flags)}
		<button type="button" class="hw-row" aria-expanded={!!open.webhook} onclick={() => toggleRow('webhook')}>
			<span class="row-title"><Term tip="A webhook is a URL Heartwood sends an HTTP POST to when an event happens, so your own scripts or tools can react to it.">Webhook</Term></span>
			{@render connMeta('webhook')}
			<span class="chev" class:down={open.webhook}><Icon name="chevron-right" size={14} /></span>
		</button>

		{#if open.webhook}
			<div class="row-panel fade-in">
				<p class="hint">Heartwood POSTs a JSON payload to your URL. Set a secret to receive an <code>X-Cairn-Signature</code> HMAC header your endpoint can verify.</p>
				<div class="field">
					<label class="label" for="wh-url">URL</label>
					<input class="input mono" id="wh-url" bind:value={webhookUrl} placeholder="https://example.com/hook" />
				</div>
				<div class="field">
					<label class="label" for="wh-secret">Signing secret <span class="hint-inline">optional</span></label>
					<input class="input mono" id="wh-secret" type="password" bind:value={webhookSecret} placeholder={webhookHasSecret ? '•••••••• (unchanged)' : 'HMAC key'} autocomplete="off" />
					{#if webhookHasSecret}<span class="hint">A secret is stored. Leave blank to keep it.</span>{/if}
				</div>
				{#if saveError.webhook}<div class="form-error" role="alert">{saveError.webhook}</div>{/if}
				<div class="ch-actions">
					<button class="btn btn-primary btn-sm" onclick={() => saveChannel('webhook')} disabled={saving.webhook}>{#if saving.webhook}<span class="spinner"></span>{/if} Save</button>
					<button class="btn btn-secondary btn-sm" onclick={() => testChannel('webhook')} disabled={testing.webhook || !channel('webhook').configured}>{#if testing.webhook}<span class="spinner"></span>{/if} Test</button>
					{#if channel('webhook').configured}<button class="btn btn-ghost btn-sm" onclick={() => askDisconnect('webhook', 'the webhook')} disabled={saving.webhook}>Disconnect</button>{/if}
					{@render resultBadge('webhook')}
				</div>
			</div>
		{/if}
		{/if}
	</section>

	<!-- ============ EVENT PREFERENCES ============ -->
	<section class="hw-section">
		<div class="section-head">
			<h2 class="section-title">What you get notified about</h2>
			<div class="pref-status">
				{#if prefSaving}<span class="spinner"></span><span class="hint">Saving…</span>
				{:else if prefSaved}<span class="saved-inline"><Icon name="check" size={13} /> Saved</span>{/if}
			</div>
		</div>
		{#if prefError}<div class="form-error" role="alert">{prefError}</div>{/if}
		<p class="hint">
			In-app alerts are always on. Expand a row to route it to your connected channels. Untouched
			rows use a sensible default.
		</p>

		{#each visibleGroups as grp (grp.title)}
			<div class="cat">
				<span class="cat-title">
					{#if grp.title === 'Security'}<Icon name="shield" size={14} />{:else if grp.title === 'Admin'}<Icon name="settings" size={14} />{:else}<Icon name="wallet" size={14} />{/if}
					{grp.title}
				</span>
				<ul class="ev-list">
					{#each grp.events as ev (ev.type)}
						<li class="ev">
							<button class="ev-row" onclick={() => toggleExpanded(ev.type)} aria-expanded={expanded[ev.type]}>
								<span class="ev-caret" class:open={expanded[ev.type]}><Icon name="chevron-right" size={14} /></span>
								<span class="ev-main">
									<span class="ev-name">{ev.label}</span>
									<span class="ev-desc">{ev.desc}</span>
								</span>
								<span class="ev-summary">{enabledSummary(ev.type)}</span>
							</button>
							{#if expanded[ev.type]}
								<div class="ev-detail fade-in">
									<div class="chan-toggles">
										<span class="toggle always-on" title="Always on">
											<Icon name="check" size={13} /> In-app
										</span>
										{#each visibleExternalChannels as c (c.id)}
											<label class="toggle" class:disabled={!channel(c.id).configured}>
												<input
													type="checkbox"
													checked={isEnabled(ev.type, c.id)}
													disabled={!channel(c.id).configured || prefSaving}
													onchange={() => toggle(ev.type, c.id)}
												/>
												<span>{c.label}</span>
												{#if isDefault(ev.type, c.id) && (defaults[ev.type] ?? []).includes(c.id)}<span class="def">default</span>{/if}
											</label>
										{/each}
									</div>
									{#if visibleExternalChannels.some((c) => !channel(c.id).configured)}
										<p class="hint tiny">Greyed-out channels aren't connected yet — set them up above.</p>
									{/if}

									{#if ev.tunable === 'threshold'}
										{@const price = $btcUsd}
										<div class="tunable">
											<label class="label" for="thr-{ev.type}">Alert me when a transaction is worth more than</label>
											{#if price && !thrShowSats[ev.type]}
												{@const draft = thrUsdDisplay(ev.type, price)}
												<div class="thr-row">
													<span class="unit unit-prefix">$</span>
													<input
														class="input mono"
														id="thr-{ev.type}"
														inputmode="decimal"
														value={draft}
														placeholder="e.g. 500"
														oninput={(e) => (thrDraft[ev.type] = e.currentTarget.value)}
														onchange={(e) => saveThresholdUsd(ev.type, e.currentTarget.value, price)}
													/>
												</div>
												{#if draft.trim() !== ''}
													{@const sats = usdDraftToSats(draft, price)}
													{#if sats !== null}
														<span class="hint">≈ {formatBtc(sats)} BTC · {formatSats(sats)} sats</span>
													{/if}
												{/if}
												{#if largeTxSats(ev.type)}
													<span class="hint">The saved amount is fixed in bitcoin terms, so its dollar value will drift as the price changes.</span>
												{/if}
												<button type="button" class="link-btn" onclick={() => (thrShowSats[ev.type] = true)}>Enter in bitcoin instead</button>
											{:else if price}
												<div class="thr-row">
													<input
														class="input mono"
														id="thr-{ev.type}"
														inputmode="numeric"
														value={largeTxSats(ev.type)}
														placeholder="e.g. 1000000"
														onchange={(e) => saveThreshold(ev.type, e.currentTarget.value)}
													/>
													<span class="unit">sats</span>
												</div>
												{#if largeTxSats(ev.type)}<span class="hint">≈ {formatBtc(Number(largeTxSats(ev.type)))} BTC</span>{/if}
												<button type="button" class="link-btn" onclick={() => (thrShowSats[ev.type] = false)}>Enter in dollars instead</button>
											{:else}
												<p class="hint">Price data isn't available right now — enter the threshold in sats.</p>
												<div class="thr-row">
													<input
														class="input mono"
														id="thr-{ev.type}"
														inputmode="numeric"
														value={largeTxSats(ev.type)}
														placeholder="e.g. 1000000"
														onchange={(e) => saveThreshold(ev.type, e.currentTarget.value)}
													/>
													<span class="unit">sats</span>
												</div>
												{#if largeTxSats(ev.type)}<span class="hint">≈ {formatBtc(Number(largeTxSats(ev.type)))} BTC</span>{/if}
											{/if}
										</div>
									{:else if ev.tunable === 'confirmations'}
										<div class="tunable">
											<span class="label">Notify at these confirmation counts</span>
											<div class="conf-row">
												{#each CONFIRMATION_OPTIONS as n (n)}
													<label class="conf-chip" class:on={confirmations(ev.type).includes(n)}>
														<input type="checkbox" checked={confirmations(ev.type).includes(n)} onchange={() => toggleConfirmation(ev.type, n)} />
														{n} conf
													</label>
												{/each}
											</div>
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</section>

	<!-- ============ QUIET HOURS ============ -->
	<section class="hw-section">
		<h2 class="section-title">Quiet hours</h2>
		<div class="quiet">
			<p class="hint">
				Pause routine notifications (like payments received and confirmations) during a nightly
				window. They're held and delivered when the window ends — nothing is lost. Urgent security
				alerts can still come through. In-app alerts are always available regardless.
			</p>
			<label class="toggle-row">
				<input type="checkbox" bind:checked={quiet.enabled} />
				<span class="toggle-title">Enable quiet hours</span>
			</label>

			{#if quiet.enabled}
				<div class="fade-in quiet-form">
					<div class="two-col">
						<div class="field">
							<label class="label" for="q-start">From</label>
							<input class="input" id="q-start" type="time" bind:value={quietStart} />
						</div>
						<div class="field">
							<label class="label" for="q-end">To</label>
							<input class="input" id="q-end" type="time" bind:value={quietEnd} />
						</div>
					</div>
					<div class="field">
						<label class="label" for="q-tz">Time zone</label>
						<input class="input mono" id="q-tz" bind:value={quietTz} placeholder="America/New_York" />
						<span class="hint">IANA name (e.g. Europe/Berlin). Leave blank to use the server's local time.</span>
					</div>
					<label class="toggle-row">
						<input type="checkbox" bind:checked={quiet.urgentOverride} />
						<span class="toggle-title">Still deliver urgent security alerts during quiet hours</span>
					</label>
				</div>
			{/if}

			{#if quietError}<div class="form-error" role="alert">{quietError}</div>{/if}
			<div class="ch-actions">
				<button class="btn btn-primary btn-sm" onclick={saveQuiet} disabled={quietSaving}>
					{#if quietSaving}<span class="spinner"></span>{/if} Save
				</button>
				{#if quietSaved}<span class="saved-inline"><Icon name="check" size={13} /> Saved</span>{/if}
			</div>
		</div>
	</section>
</div>

<Modal
	bind:open={confirmOpen}
	title={confirmTarget?.title ?? ''}
	message={confirmTarget?.message ?? ''}
	confirmLabel={confirmTarget?.label ?? 'Confirm'}
	onConfirm={() => {
		confirmTarget?.run();
		confirmTarget = null;
	}}
	onCancel={() => (confirmTarget = null)}
/>

{#snippet connMeta(id: ChannelId)}
	{#if channel(id).configured}
		<span class="row-meta sage"><Icon name="check" size={13} strokeWidth={2.25} /> connected</span>
	{:else}
		<span class="row-meta">not connected</span>
	{/if}
{/snippet}

{#snippet resultBadge(id: string)}
	{@const r = testResult[id]}
	{#if r}
		{#if r.ok}
			<span class="badge badge-success">Test sent</span>
		{:else}
			<span class="badge badge-warning">{r.error ?? 'Failed'}</span>
		{/if}
	{/if}
{/snippet}

<style>
	/* Grove field bleeds to the viewport behind the content column. */
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

	/* This page composes its own mobile flow header, so the shell's
	   bare-back-circle fallback is suppressed while it's mounted. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.flow-eyebrow {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--eyebrow);
		text-align: center;
	}

	.crumb-link {
		display: inline-block;
		margin-bottom: 12px;
		text-decoration: none;
	}

	.crumb-link:hover :global(.seg) {
		color: var(--eyebrow);
	}

	@media (max-width: 900px) {
		.crumb-link {
			display: none;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 14px;
		}

		.flow-spacer {
			width: 32px;
			height: 32px;
			flex-shrink: 0;
		}
	}

	.lede {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: 8px;
		max-width: 600px;
	}

	.hw-section {
		margin-top: 38px;
	}

	.hw-section > .hint {
		margin-top: 6px;
		max-width: 560px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	/* ---------- Channel rows (the 5h grammar: rows, not boxes) ---------- */

	.hw-row {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		padding: 16px 0;
		border: none;
		border-bottom: 1px solid var(--hairline);
		background: none;
		text-align: left;
		cursor: pointer;
		color: inherit;
		font-family: inherit;
		transition: background 100ms var(--ease);
	}

	.hw-row:hover {
		background: rgba(255, 255, 255, 0.015);
	}

	.hw-section .hw-row:first-of-type {
		margin-top: 10px;
	}

	.row-title {
		flex: 1;
		min-width: 0;
		font-size: 15px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.row-meta {
		font-size: 13px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.row-meta.sage {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
		color: var(--sage);
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

	/* Expanded config panel under a row. */
	.row-panel {
		display: flex;
		flex-direction: column;
		gap: 13px;
		padding: 8px 0 22px;
		border-bottom: 1px solid var(--hairline);
	}

	.ch-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
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

	.subsection {
		border-top: 1px solid var(--hairline);
		padding-top: 14px;
		margin-top: 2px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.sub-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.sub-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.optional {
		font-size: 11px;
		font-weight: 500;
		color: var(--text-faint);
		letter-spacing: 0.04em;
	}

	.hint-inline {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.pgp-paste {
		resize: vertical;
		font-size: 11.5px;
		line-height: 1.4;
	}

	.pgp-current {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		color: var(--sage);
	}

	.pgp-body {
		flex: 1;
		min-width: 0;
		color: var(--text);
	}

	.pgp-label {
		font-size: 13px;
		font-weight: 500;
	}

	.fp {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.5px;
		margin: 3px 0;
		color: var(--text-secondary);
		word-break: break-all;
	}

	.relays {
		resize: vertical;
		font-size: 12px;
		line-height: 1.5;
	}

	.row-panel code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--text);
	}

	/* ---------- Event preference groups ---------- */

	.cat {
		margin-top: 22px;
	}

	.cat-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
	}

	.ev-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.ev {
		border-bottom: 1px solid var(--hairline);
	}

	.ev-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 13px 0;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: inherit;
		font-family: inherit;
		transition: background 100ms var(--ease);
	}

	.ev-row:hover {
		background: rgba(255, 255, 255, 0.015);
	}

	.ev-caret {
		display: flex;
		color: var(--text-faint);
		transition: transform 120ms var(--ease);
		flex-shrink: 0;
	}

	.ev-caret.open {
		transform: rotate(90deg);
	}

	.ev-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.ev-name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.ev-desc {
		font-size: 12px;
		color: var(--text-muted);
	}

	.ev-summary {
		font-size: 11.5px;
		color: var(--text-secondary);
		flex-shrink: 0;
		white-space: nowrap;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ev-detail {
		padding: 4px 0 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.chan-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* Toggle grammar: quiet chips, copper when meaningful. */
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		padding: 6px 12px;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-toggle);
		background: transparent;
		cursor: pointer;
	}

	.toggle input {
		accent-color: var(--accent);
		margin: 0;
	}

	.toggle.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toggle.always-on {
		color: var(--sage);
		border-color: transparent;
		background: var(--sage-muted);
		cursor: default;
	}

	.def {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		color: var(--text-faint);
	}

	.tunable {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.thr-row {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 280px;
	}

	.thr-row .input {
		flex: 1;
	}

	.unit {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.unit-prefix {
		flex-shrink: 0;
	}

	.link-btn {
		align-self: flex-start;
		font-size: 12px;
		color: var(--text-muted);
		text-decoration: underline;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-family: inherit;
	}

	.link-btn:hover {
		color: var(--text-secondary);
	}

	.conf-row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.conf-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		padding: 6px 12px;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-toggle);
		cursor: pointer;
	}

	.conf-chip.on {
		border-color: transparent;
		background: var(--accent-muted);
		color: var(--accent-bright);
	}

	.conf-chip input {
		accent-color: var(--accent);
		margin: 0;
	}

	.pref-status {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.saved-inline {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--sage);
	}

	.tiny {
		font-size: 11.5px;
	}

	/* ---------- Quiet hours ---------- */

	.quiet {
		display: flex;
		flex-direction: column;
		gap: 13px;
		margin-top: 12px;
	}

	.quiet-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.toggle-row {
		display: flex;
		gap: 8px;
		align-items: center;
		cursor: pointer;
	}

	.toggle-row input {
		accent-color: var(--accent);
		margin: 0;
	}

	.toggle-title {
		font-size: 13px;
		font-weight: 500;
	}

	.smtp-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.hint strong {
		color: var(--text-secondary);
		font-weight: 600;
	}

	@media (max-width: 900px) {
		.hw-section {
			margin-top: 28px;
		}

		.section-title {
			font-size: 14.5px;
		}

		.hw-row {
			padding: 14px 0;
		}

		.row-title {
			font-size: 13.5px;
		}

		.row-meta {
			font-size: 12px;
		}

		.ev-detail {
			padding-left: 0;
		}

		.ev-summary {
			display: none;
		}
	}
</style>
