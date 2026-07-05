<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatSats } from '$lib/format';

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

	// Per-channel busy + result state.
	let saving = $state<Record<string, boolean>>({});
	let testing = $state<Record<string, boolean>>({});
	let saveError = $state<Record<string, string | null>>({});
	let testResult = $state<Record<string, TestResult>>({});

	function payloadFor(id: ChannelId): Record<string, unknown> {
		switch (id) {
			case 'email':
				return { address: emailAddress };
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
		if (!confirm('Disconnect this channel? Its settings will be cleared.')) return;
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
		if (!confirm('Remove your PGP key? Notification emails will no longer be encrypted.')) return;
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

	// Event catalogue grouped by category. Admin rows hidden for non-admins.
	type EventDef = { type: string; label: string; desc: string; tunable?: 'threshold' | 'confirmations' };
	const GROUPS: { title: string; admin?: boolean; events: EventDef[] }[] = [
		{
			title: 'Wallet activity',
			events: [
				{ type: 'tx_received', label: 'Payment received', desc: 'An inbound transaction is first seen for a watched address.' },
				{ type: 'tx_confirmed', label: 'Transaction confirmed', desc: 'A transaction crosses a confirmation threshold.', tunable: 'confirmations' },
				{ type: 'tx_large', label: 'Large transaction', desc: 'A transaction exceeds your sats threshold.', tunable: 'threshold' },
				{ type: 'sign_session_waiting', label: 'Signature waiting', desc: 'A multisig transaction is waiting for signatures.' },
				{ type: 'key_health_due', label: 'Key health check due', desc: 'A multisig key has not been verified in ~180 days.' },
				{ type: 'backup_missing', label: 'Backup missing', desc: 'A wallet was created with no backup ever downloaded.' },
				{ type: 'backup_stale', label: 'Backup stale', desc: 'Your instance backup is older than the reminder interval.' }
			]
		},
		{
			title: 'Security',
			events: [
				{ type: 'security_failed_login', label: 'Failed sign-in attempts', desc: 'Repeated failed sign-ins against your account.' },
				{ type: 'security_new_passkey', label: 'New passkey added', desc: 'A new passkey or recovery credential was added — "was this you?"' }
			]
		},
		{
			title: 'Admin',
			admin: true,
			events: [
				{ type: 'admin_new_signup', label: 'New sign-up', desc: 'A new user account was created.' },
				{ type: 'admin_invite_used', label: 'Invite redeemed', desc: 'An invite code was redeemed.' },
				{ type: 'admin_server_health', label: 'Server health', desc: 'Node connection down, reconnect looping, or disk space low.' }
			]
		}
	];

	const visibleGroups = $derived(GROUPS.filter((g) => !g.admin || data.isAdmin));

	// Preference lookup: user rows override DEFAULT_PREFERENCES.
	type PrefRow = { eventType: string; channel: string; enabled: boolean; config: Record<string, unknown> };
	// svelte-ignore state_referenced_locally
	let prefs = $state<PrefRow[]>(data.preferences as PrefRow[]);
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

	// Which event rows are expanded to show per-channel toggles.
	let expanded = $state<Record<string, boolean>>({});
	function toggleExpanded(type: string) {
		expanded[type] = !expanded[type];
	}

	function enabledSummary(eventType: string): string {
		const on = ['inapp', ...EXTERNAL_CHANNELS.map((c) => c.id)].filter((ch) =>
			ch === 'inapp' ? true : isEnabled(eventType, ch as ChannelId)
		);
		if (on.length === 1) return 'In-app only';
		const labels = on.map((c) => (c === 'inapp' ? 'In-app' : EXTERNAL_CHANNELS.find((e) => e.id === c)?.label));
		return labels.join(', ');
	}
</script>

<svelte:head>
	<title>Notifications — Settings — Cairn</title>
</svelte:head>

<div class="head">
	<a href="/settings" class="back"><Icon name="chevron-left" size={16} /> Settings</a>
	<h1 class="page-title">Notifications</h1>
	<p class="lede">
		Choose how Cairn reaches you. In-app alerts are always on; connect any of the channels below to
		also get notified by email, push, or your own tools. Everything here is opt-in and only ever
		sends to servers you configure — Cairn adds no third-party telemetry.
	</p>
</div>

<div class="stack page fade-in">
	<!-- ============ CHANNEL CONNECTIONS ============ -->
	<section class="stack group">
		<h2 class="group-title">Channels</h2>

		<!-- Email -->
		<div class="card card-pad channel">
			<div class="ch-head">
				<span class="ch-title">Email</span>
				{#if channel('email').configured}
					<span class="badge badge-success">Connected</span>
				{:else}
					<span class="badge badge-neutral">Not connected</span>
				{/if}
			</div>
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
					<button class="btn btn-ghost btn-sm danger" onclick={() => disconnectChannel('email')} disabled={saving.email}>Disconnect</button>
				{/if}
				{@render resultBadge('email')}
			</div>

			<!-- PGP sub-section -->
			<div class="subsection">
				<div class="ch-head">
					<span class="sub-title">
						<Term tip="PGP encrypts just the notification email body — it has nothing to do with your Bitcoin keys, which never leave your hardware wallet.">PGP encryption</Term>
					</span>
					<span class="badge badge-neutral">optional</span>
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
						<button class="btn btn-ghost btn-sm danger" onclick={removePgp} disabled={pgpBusy}>Remove</button>
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

		<!-- Telegram -->
		<div class="card card-pad channel">
			<div class="ch-head">
				<span class="ch-title">Telegram</span>
				{#if channel('telegram').configured}<span class="badge badge-success">Connected</span>{:else}<span class="badge badge-neutral">Not connected</span>{/if}
			</div>
			<p class="hint">Messages from your instance's Telegram bot. Message the bot first, then paste your chat ID here.</p>
			<div class="field">
				<label class="label" for="tg-chat">Chat ID</label>
				<input class="input mono" id="tg-chat" bind:value={telegramChatId} placeholder="123456789" />
			</div>
			{#if saveError.telegram}<div class="form-error" role="alert">{saveError.telegram}</div>{/if}
			<div class="ch-actions">
				<button class="btn btn-primary btn-sm" onclick={() => saveChannel('telegram')} disabled={saving.telegram}>{#if saving.telegram}<span class="spinner"></span>{/if} Save</button>
				<button class="btn btn-secondary btn-sm" onclick={() => testChannel('telegram')} disabled={testing.telegram || !channel('telegram').configured}>{#if testing.telegram}<span class="spinner"></span>{/if} Test</button>
				{#if channel('telegram').configured}<button class="btn btn-ghost btn-sm danger" onclick={() => disconnectChannel('telegram')} disabled={saving.telegram}>Disconnect</button>{/if}
				{@render resultBadge('telegram')}
			</div>
		</div>

		<!-- ntfy -->
		<div class="card card-pad channel">
			<div class="ch-head">
				<span class="ch-title"><Term tip="ntfy is a simple, self-hostable push notification service. You pick a topic name — no account needed — and subscribe to it on your phone.">ntfy</Term> push</span>
				{#if channel('ntfy').configured}<span class="badge badge-success">Connected</span>{:else}<span class="badge badge-neutral">Not connected</span>{/if}
			</div>
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
				{#if channel('ntfy').configured}<button class="btn btn-ghost btn-sm danger" onclick={() => disconnectChannel('ntfy')} disabled={saving.ntfy}>Disconnect</button>{/if}
				{@render resultBadge('ntfy')}
			</div>
		</div>

		<!-- Nostr -->
		<div class="card card-pad channel">
			<div class="ch-head">
				<span class="ch-title">Nostr</span>
				{#if channel('nostr').configured}<span class="badge badge-success">Connected</span>{:else}<span class="badge badge-neutral">Not connected</span>{/if}
			</div>
			<p class="hint">
				Encrypted direct messages to your Nostr identity, using
				<Term tip="NIP-04 and NIP-44 are the Nostr standards for encrypted direct messages. NIP-44 is the newer, stronger scheme; NIP-04 is the older, more widely supported one.">NIP-04/NIP-44</Term>. Cairn sends from its own instance identity to the pubkey you give here.
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
				{#if channel('nostr').configured}<button class="btn btn-ghost btn-sm danger" onclick={() => disconnectChannel('nostr')} disabled={saving.nostr}>Disconnect</button>{/if}
				{@render resultBadge('nostr')}
			</div>
		</div>

		<!-- Webhook -->
		<div class="card card-pad channel">
			<div class="ch-head">
				<span class="ch-title"><Term tip="A webhook is a URL Cairn sends an HTTP POST to when an event happens, so your own scripts or tools can react to it.">Webhook</Term></span>
				{#if channel('webhook').configured}<span class="badge badge-success">Connected</span>{:else}<span class="badge badge-neutral">Not connected</span>{/if}
			</div>
			<p class="hint">Cairn POSTs a JSON payload to your URL. Set a secret to receive an <code>X-Cairn-Signature</code> HMAC header your endpoint can verify.</p>
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
				{#if channel('webhook').configured}<button class="btn btn-ghost btn-sm danger" onclick={() => disconnectChannel('webhook')} disabled={saving.webhook}>Disconnect</button>{/if}
				{@render resultBadge('webhook')}
			</div>
		</div>
	</section>

	<!-- ============ EVENT PREFERENCES ============ -->
	<section class="stack group">
		<div class="group-head">
			<h2 class="group-title">What you get notified about</h2>
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
			<div class="card card-pad cat">
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
										{#each EXTERNAL_CHANNELS as c (c.id)}
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
									{#if EXTERNAL_CHANNELS.some((c) => !channel(c.id).configured)}
										<p class="hint tiny">Greyed-out channels aren't connected yet — set them up above.</p>
									{/if}

									{#if ev.tunable === 'threshold'}
										<div class="tunable">
											<label class="label" for="thr-{ev.type}">Alert when a transaction exceeds</label>
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
											{#if largeTxSats(ev.type)}<span class="hint">≈ {formatSats(Number(largeTxSats(ev.type)))}</span>{/if}
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
</div>

{#snippet resultBadge(id: string)}
	{@const r = testResult[id]}
	{#if r}
		{#if r.ok}
			<span class="badge badge-success">Test sent</span>
		{:else}
			<span class="badge badge-error">{r.error ?? 'Failed'}</span>
		{/if}
	{/if}
{/snippet}

<style>
	.page {
		gap: 24px;
		max-width: 720px;
	}

	.head {
		max-width: 720px;
		margin-bottom: 4px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 12.5px;
		color: var(--text-secondary);
		margin-bottom: 8px;
	}

	.back:hover {
		color: var(--text);
	}

	.lede {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: 8px;
		max-width: 640px;
	}

	.group {
		gap: 12px;
	}

	.group-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.group-title {
		font-size: 15px;
		font-weight: 600;
		color: var(--text);
	}

	.channel {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ch-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.ch-title {
		font-size: 14px;
		font-weight: 600;
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
		border-top: 1px solid var(--border-subtle);
		padding-top: 14px;
		margin-top: 2px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.sub-title {
		font-size: 13px;
		font-weight: 600;
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
		padding: 11px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg);
		color: var(--success);
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

	.cat {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.cat-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		color: var(--text-secondary);
		margin-bottom: 4px;
	}

	.ev-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.ev {
		border-top: 1px solid var(--border-subtle);
	}

	.ev:first-child {
		border-top: none;
	}

	.ev-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 11px 2px;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.ev-caret {
		display: flex;
		color: var(--text-muted);
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
		padding: 4px 2px 14px 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.chan-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		padding: 6px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		background: var(--bg);
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
		color: var(--success);
		border-color: var(--success-muted);
		cursor: default;
	}

	.def {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		color: var(--text-muted);
	}

	.tunable {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
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
		padding: 6px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		cursor: pointer;
	}

	.conf-chip.on {
		border-color: var(--accent);
		color: var(--text);
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
		color: var(--success);
	}

	.tiny {
		font-size: 11.5px;
	}

	.danger:hover:not(:disabled) {
		color: var(--error);
	}

	.hint strong {
		color: var(--text-secondary);
		font-weight: 600;
	}
</style>
