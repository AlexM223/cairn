<script lang="ts">
	import Banner from '$lib/components/Banner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { timeAgo } from '$lib/format';

	let { data } = $props();

	type Settings = {
		smtpHost: string;
		smtpPort: string;
		smtpUser: string;
		smtpFrom: string;
		smtpTls: 'starttls' | 'tls' | 'none';
		hasSmtpPass: boolean;
		hasTelegramBotToken: boolean;
		ntfyDefaultServer: string;
		nostrDefaultRelays: string[];
		webhookAllowPrivateTargets: boolean;
	};

	// Seed editable state from the load; the stored secrets are never sent here,
	// only presence booleans (hasSmtpPass / hasTelegramBotToken).
	// svelte-ignore state_referenced_locally
	const init = data.settings as Settings;
	// svelte-ignore state_referenced_locally
	let smtpHost = $state(init.smtpHost);
	// svelte-ignore state_referenced_locally
	let smtpPort = $state(init.smtpPort);
	// svelte-ignore state_referenced_locally
	let smtpUser = $state(init.smtpUser);
	// svelte-ignore state_referenced_locally
	let smtpFrom = $state(init.smtpFrom);
	// svelte-ignore state_referenced_locally
	let smtpTls = $state<Settings['smtpTls']>(init.smtpTls);
	let smtpPass = $state('');
	// svelte-ignore state_referenced_locally
	let hasSmtpPass = $state(init.hasSmtpPass);

	let telegramBotToken = $state('');
	// svelte-ignore state_referenced_locally
	let hasTelegramBotToken = $state(init.hasTelegramBotToken);

	// svelte-ignore state_referenced_locally
	let ntfyDefaultServer = $state(init.ntfyDefaultServer);
	// svelte-ignore state_referenced_locally
	let nostrRelays = $state((init.nostrDefaultRelays ?? []).join('\n'));
	// svelte-ignore state_referenced_locally
	let webhookAllowPrivate = $state(init.webhookAllowPrivateTargets);

	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let saved = $state(false);

	let testingSmtp = $state(false);
	let smtpTest = $state<{ ok: boolean; error?: string } | null>(null);

	function currentBody() {
		return {
			smtpHost: smtpHost.trim(),
			// smtpPort is string state, but Svelte's bind:value on <input type=number>
			// writes back a JS number once the field is edited — coerce to string
			// before trimming so save() never throws 'smtpPort.trim is not a function'
			// (cairn-vbnq).
			smtpPort: String(smtpPort).trim(),
			smtpUser: smtpUser.trim(),
			smtpFrom: smtpFrom.trim(),
			smtpTls,
			smtpPass, // blank = keep stored
			telegramBotToken, // blank = keep stored
			ntfyDefaultServer: ntfyDefaultServer.trim(),
			nostrDefaultRelays: nostrRelays.split('\n').map((r) => r.trim()).filter(Boolean),
			webhookAllowPrivateTargets: webhookAllowPrivate
		};
	}

	async function save() {
		saveError = null;
		saved = false;
		saving = true;
		try {
			const res = await fetch('/api/admin/notifications', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(currentBody())
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not save settings.');
			const s = body.settings as Settings;
			hasSmtpPass = s.hasSmtpPass;
			hasTelegramBotToken = s.hasTelegramBotToken;
			smtpPass = '';
			telegramBotToken = '';
			saved = true;
			setTimeout(() => (saved = false), 2500);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Could not save settings.';
		} finally {
			saving = false;
		}
	}

	async function testSmtp() {
		// Save first so the test reads the current form values (the plugin reads
		// stored settings, not the in-flight form).
		smtpTest = null;
		testingSmtp = true;
		try {
			await save();
			const res = await fetch('/api/admin/notifications/test-smtp', { method: 'POST' });
			const body = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
			smtpTest = body ?? { ok: false, error: 'No response from the server.' };
		} catch (e) {
			smtpTest = { ok: false, error: e instanceof Error ? e.message : 'Test failed.' };
		} finally {
			testingSmtp = false;
		}
	}

	function clearSmtpPass() {
		fetch('/api/admin/notifications', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clearSmtpPass: true })
		}).then((res) => {
			if (res.ok) hasSmtpPass = false;
		});
	}
	function clearTelegramToken() {
		fetch('/api/admin/notifications', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clearTelegramBotToken: true })
		}).then((res) => {
			if (res.ok) hasTelegramBotToken = false;
		});
	}

	function since(iso: string | null): string {
		if (!iso) return '—';
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// svelte-ignore state_referenced_locally
	const health = data.health as {
		counts: Record<string, number>;
		failures: {
			id: number;
			userId: number;
			channel: string;
			eventType: string;
			status: string;
			attempts: number;
			lastError: string | null;
			createdAt: string;
		}[];
	};
</script>

<svelte:head>
	<title>Notifications — Admin — Heartwood</title>
</svelte:head>

<div class="stack settings-form fade-in">
	{#if saveError}<Banner variant="error">{saveError}</Banner>{/if}
	{#if saved}<Banner variant="success">Settings saved.</Banner>{/if}

	<!-- SMTP -->
	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Email (SMTP)</span>
			<p class="hint">
				One SMTP relay for the whole instance. Each user picks their own destination address in
				their notification settings.
			</p>
			<p class="hint">
				This is the <strong>fallback</strong> email server, used for any user who hasn't set up
				their own in their notification settings. If a user has a personal email server saved,
				their notifications use that instead. System and admin emails (new sign-ups, invites
				redeemed, server health) sent to <strong>you</strong> also use this fallback — unless
				you've set up a personal email server for your own account.
			</p>
		</div>

		<div class="row-fields">
			<div class="field grow">
				<label class="label" for="smtpHost">Host</label>
				<input class="input mono" id="smtpHost" bind:value={smtpHost} placeholder="smtp.example.com" />
			</div>
			<div class="field port">
				<label class="label" for="smtpPort">Port</label>
				<input class="input mono" id="smtpPort" type="number" min="1" max="65535" bind:value={smtpPort} />
			</div>
		</div>

		<div class="row-fields">
			<div class="field grow">
				<label class="label" for="smtpUser">Username</label>
				<input class="input mono" id="smtpUser" bind:value={smtpUser} autocomplete="off" />
			</div>
			<div class="field grow">
				<label class="label" for="smtpPass">Password</label>
				<input
					class="input mono"
					id="smtpPass"
					type="password"
					bind:value={smtpPass}
					autocomplete="new-password"
					placeholder={hasSmtpPass ? '•••••••• (unchanged)' : ''}
				/>
				{#if hasSmtpPass}
					<span class="hint">A password is stored. Leave blank to keep it, or
						<button type="button" class="link-btn" onclick={clearSmtpPass}>clear it</button>.</span>
				{/if}
			</div>
		</div>

		<div class="row-fields">
			<div class="field grow">
				<label class="label" for="smtpFrom">From address</label>
				<input class="input mono" id="smtpFrom" type="email" bind:value={smtpFrom} placeholder="heartwood@example.com" />
			</div>
			<div class="field">
				<label class="label" for="smtpTls">Encryption</label>
				<select class="select input" id="smtpTls" bind:value={smtpTls}>
					<option value="starttls">STARTTLS</option>
					<option value="tls">TLS (implicit)</option>
					<option value="none">None</option>
				</select>
			</div>
		</div>

		<div class="test-row">
			<button class="btn btn-secondary btn-sm" onclick={testSmtp} disabled={testingSmtp || saving}>
				{#if testingSmtp}<span class="spinner"></span>{/if}
				Save &amp; send test email
			</button>
			{#if smtpTest}
				{#if smtpTest.ok}
					<span class="badge badge-success">Test email sent</span>
				{:else}
					<span class="badge badge-error">{smtpTest.error ?? 'Failed'}</span>
				{/if}
			{/if}
			<span class="hint">Sends a test to your own account email.</span>
		</div>
	</section>

	<!-- Telegram -->
	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Telegram</span>
			<p class="hint">
				One bot for the whole instance. Create a bot with <strong>@BotFather</strong> on Telegram
				and paste its API token here; each user supplies their own chat ID in their settings.
			</p>
		</div>
		<div class="field">
			<label class="label" for="tgToken">Bot token</label>
			<input
				class="input mono"
				id="tgToken"
				type="password"
				bind:value={telegramBotToken}
				autocomplete="new-password"
				placeholder={hasTelegramBotToken ? '•••••••• (unchanged)' : '123456:ABC-DEF…'}
			/>
			{#if hasTelegramBotToken}
				<span class="hint">A token is stored. Leave blank to keep it, or
					<button type="button" class="link-btn" onclick={clearTelegramToken}>clear it</button>.</span>
			{/if}
		</div>
	</section>

	<!-- ntfy + Nostr defaults -->
	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Push &amp; relay defaults</span>
			<p class="hint">Convenience defaults users see pre-filled. They can override both.</p>
		</div>
		<div class="field">
			<label class="label" for="ntfyServer">
				<Term tip="ntfy is a simple push-notification service. This default server is pre-filled for users; they can point at ntfy.sh or their own instance.">ntfy</Term> default server
			</label>
			<input class="input mono" id="ntfyServer" bind:value={ntfyDefaultServer} placeholder="https://ntfy.sh" />
		</div>
		<div class="field">
			<label class="label" for="nostrRelays">Nostr default relays <span class="hint-inline">one per line</span></label>
			<textarea class="input mono relays" id="nostrRelays" rows="4" bind:value={nostrRelays} placeholder="wss://relay.damus.io&#10;wss://nos.lol"></textarea>
		</div>
	</section>

	<!-- Webhook SSRF escape hatch -->
	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Webhook targets</span>
		</div>
		<label class="toggle-row">
			<input type="checkbox" bind:checked={webhookAllowPrivate} />
			<span class="toggle-body">
				<span class="toggle-title">Allow webhooks to private network targets</span>
				<span class="toggle-desc">
					Off by default. Heartwood normally refuses to POST webhooks to loopback, LAN, or link-local
					addresses to prevent
					<Term tip="Server-Side Request Forgery: tricking the server into making requests to internal addresses it shouldn't reach.">SSRF</Term>. Enable this only if you deliberately run a
					webhook receiver on your own LAN and understand the risk.
				</span>
			</span>
		</label>
		{#if webhookAllowPrivate}
			<div class="warn-note" role="status">
				<Icon name="alert-triangle" size={15} />
				<span>Users can now point webhooks at internal addresses on this server's network. Only leave this on if you trust every user.</span>
			</div>
		{/if}
	</section>

	<div class="save-row">
		<button class="btn btn-primary" onclick={save} disabled={saving || testingSmtp}>
			{#if saving}<span class="spinner"></span>{/if}
			Save settings
		</button>
	</div>

	<!-- Delivery health -->
	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Delivery health</span>
			<p class="hint">The outbound queue for external channels. In-app alerts don't queue.</p>
		</div>

		<div class="stat-row">
			<div class="stat">
				<span class="stat-n">{health.counts.pending ?? 0}</span>
				<span class="stat-l">Pending</span>
			</div>
			<div class="stat">
				<span class="stat-n">{health.counts.sent ?? 0}</span>
				<span class="stat-l">Sent</span>
			</div>
			<div class="stat" class:bad={(health.counts.failed ?? 0) > 0}>
				<span class="stat-n">{health.counts.failed ?? 0}</span>
				<span class="stat-l">Failed</span>
			</div>
			<div class="stat" class:bad={(health.counts.dead ?? 0) > 0}>
				<span class="stat-n">{health.counts.dead ?? 0}</span>
				<span class="stat-l">Dead</span>
			</div>
		</div>

		{#if health.failures.length === 0}
			<div class="empty">
				<Icon name="check" size={16} />
				<span>No failed deliveries. Everything's getting through.</span>
			</div>
		{:else}
			<div class="table-wrap">
				<table class="fail-table">
					<thead>
						<tr>
							<th>When</th>
							<th>Channel</th>
							<th>Event</th>
							<th>Status</th>
							<th>Tries</th>
							<th>Last error</th>
						</tr>
					</thead>
					<tbody>
						{#each health.failures as f (f.id)}
							<tr>
								<td class="nowrap">{since(f.createdAt)}</td>
								<td class="mono">{f.channel}</td>
								<td class="mono dim">{f.eventType}</td>
								<td>
									<span class="badge {f.status === 'dead' ? 'badge-error' : 'badge-neutral'}">{f.status}</span>
								</td>
								<td class="center">{f.attempts}</td>
								<td class="err">{f.lastError ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<style>
	.settings-form {
		gap: 14px;
		max-width: 760px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.section-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.row-fields {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.grow {
		flex: 1;
		min-width: 160px;
	}

	.port {
		flex: 0 0 110px;
	}

	.test-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.relays {
		resize: vertical;
		font-size: 12px;
		line-height: 1.5;
	}

	.hint-inline {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}

	.warn-note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12.5px;
		color: var(--attention);
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		line-height: 1.5;
	}

	.toggle-row {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		cursor: pointer;
	}

	.toggle-row input {
		accent-color: var(--accent);
		margin-top: 3px;
	}

	.toggle-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.toggle-title {
		font-size: 13.5px;
		font-weight: 500;
	}

	.toggle-desc {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.55;
	}

	.save-row {
		display: flex;
		justify-content: flex-end;
	}

	/* Unboxed stats: serif numbers over tracked-caps labels, hairline-split. */
	.stat-row {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px 14px;
	}

	.stat + .stat {
		border-left: 1px solid var(--hairline);
	}

	.stat:first-child {
		padding-left: 0;
	}

	.stat-n {
		font-family: var(--font-serif);
		font-size: 24px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text-rows);
	}

	.stat.bad .stat-n {
		color: var(--attention);
	}

	.stat-l {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.empty {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--sage);
		padding: 6px 2px;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.fail-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12.5px;
	}

	.fail-table th {
		text-align: left;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
		padding: 6px 10px;
		border-bottom: 1px solid var(--hairline);
		white-space: nowrap;
	}

	.fail-table td {
		padding: 8px 10px;
		border-bottom: 1px solid var(--hairline);
		vertical-align: top;
	}

	.mono {
		font-family: var(--font-mono, monospace);
	}

	.dim {
		color: var(--text-muted);
	}

	.nowrap {
		white-space: nowrap;
	}

	.center {
		text-align: center;
	}

	.err {
		color: var(--text-secondary);
		max-width: 280px;
		word-break: break-word;
	}

	.hint strong {
		color: var(--text-secondary);
		font-weight: 600;
	}
</style>
