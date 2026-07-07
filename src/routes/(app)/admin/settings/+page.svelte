<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatNumber } from '$lib/format';

	let { data, form } = $props();

	// svelte-ignore state_referenced_locally — intentionally seeds local UI state
	let connectionMode = $state(data.settings.connectionMode);
	let saving = $state(false);
	let testing = $state<'electrum' | 'esplora' | null>(null);

	type TestResult = { ok: boolean; tipHeight?: number; error?: string } | null;

	// Test results are copied into local state as they arrive: the two test
	// actions share one ActionData slot, so rendering `form` directly would
	// let each result wipe the other's badge.
	let electrumResult = $state<TestResult>(null);
	let esploraResult = $state<TestResult>(null);

	// User agreement editor (its own form/action, independent of chain settings).
	// svelte-ignore state_referenced_locally — seeds the editable fields
	let agreementText = $state(data.agreement.text);
	// svelte-ignore state_referenced_locally
	let operatorName = $state(data.agreement.operator);
	let savingAgreement = $state(false);
	let togglingTeamMode = $state(false);

	// Danger zone: the destructive submit stays disabled until the admin has
	// opened the inline confirm AND typed the word RESET.
	let confirmingReset = $state(false);
	let resetConfirmText = $state('');
	let resetting = $state(false);

	$effect(() => {
		if (form?.electrumTest) electrumResult = form.electrumTest as TestResult;
	});
	$effect(() => {
		if (form?.esploraTest) esploraResult = form.esploraTest as TestResult;
	});
</script>

<svelte:head>
	<title>Settings — Admin — Heartwood</title>
</svelte:head>

<form
	method="POST"
	action="?/save"
	class="stack settings-form fade-in"
	use:enhance={({ action }) => {
		// Pending state is set HERE, on the actual submit, never in the buttons'
		// click handlers: disabling a submit button from its own click handler
		// cancels the browser's default submission before it starts, so the
		// request never fires and the spinner sticks forever (cairn-unp).
		const which = action.search.includes('testElectrum')
			? ('electrum' as const)
			: action.search.includes('testEsplora')
				? ('esplora' as const)
				: null;
		if (which) testing = which;
		else saving = true;

		// Safety net: the server-side tests carry their own ~8s timeouts, but if
		// the response itself never arrives the UI must not hang with a disabled
		// button — surface a timeout error and re-enable after 20s.
		const watchdog = setTimeout(() => {
			if (which && testing === which) {
				const timedOut = { ok: false, error: 'Timed out — no response from the server.' };
				if (which === 'electrum') electrumResult = timedOut;
				else esploraResult = timedOut;
			}
			testing = null;
			saving = false;
		}, 20_000);

		return async ({ update }) => {
			clearTimeout(watchdog);
			saving = false;
			testing = null;
			await update({ reset: false });
		};
	}}
>
	{#if form?.error}
		<div class="form-error" role="alert">{form.error}</div>
	{/if}
	{#if form?.saved}
		<div class="saved-note" role="status">Settings saved — connection updated.</div>
	{/if}

	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Registration</span>
			<p class="hint">Who can create an account on this instance.</p>
		</div>
		<div class="radio-group">
			{#each [['open', 'Open', 'Anyone with the URL can sign up'], ['invite', 'Invite only', 'New accounts need an invite code'], ['closed', 'Closed', 'No new accounts']] as [value, label, desc] (value)}
				<label class="radio-card" class:selected={data.settings.registrationMode === value}>
					<input
						type="radio"
						name="registrationMode"
						{value}
						checked={data.settings.registrationMode === value}
					/>
					<span class="radio-label">{label}</span>
					<span class="radio-desc">{desc}</span>
				</label>
			{/each}
		</div>

		<div class="field" style="margin-top: 16px; max-width: 420px">
			<label class="label" for="operatorName">Operator name</label>
			<input
				class="input"
				id="operatorName"
				name="operatorName"
				placeholder="e.g. Acme Bitcoin Services, or your name"
				bind:value={operatorName}
			/>
			<span class="hint">
				Shown to users as “This instance is operated by …” on the terms they accept. Saved with
				this button; changing it re-prompts users to accept.
			</span>
		</div>
	</section>

	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Node connection</span>
			<p class="hint">
				Where Heartwood reads chain data from. Public servers work out of the box; point it at your
				own node for full sovereignty.
			</p>
		</div>

		<div class="radio-group">
			<label class="radio-card" class:selected={connectionMode === 'public'}>
				<input type="radio" name="connectionMode" value="public" bind:group={connectionMode} />
				<span class="radio-label">Public servers <span class="badge badge-neutral">default</span></span>
				<span class="radio-desc">electrum.blockstream.info + mempool.space</span>
			</label>
			<label class="radio-card" class:selected={connectionMode === 'custom'}>
				<input type="radio" name="connectionMode" value="custom" bind:group={connectionMode} />
				<span class="radio-label">Custom</span>
				<span class="radio-desc">Your own Electrum server and data sources</span>
			</label>
		</div>

		{#if connectionMode === 'custom'}
			<div class="custom-fields fade-in">
				<div class="subgroup">
					<span class="subgroup-title">Electrum server</span>
					<div class="row-fields">
						<div class="field grow">
							<label class="label" for="electrumHost">Host</label>
							<input
								class="input mono"
								id="electrumHost"
								name="electrumHost"
								placeholder="umbrel.local"
								value={data.settings.electrumHost}
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
								value={data.settings.electrumPort}
							/>
						</div>
						<label class="tls-check">
							<input type="checkbox" name="electrumTls" checked={data.settings.electrumTls} />
							<span>TLS</span>
						</label>
					</div>
					<label class="tls-insecure">
						<input
							type="checkbox"
							name="electrumTlsInsecure"
							checked={data.settings.electrumTlsInsecure}
						/>
						<span>
							Allow self-signed certificate (skip TLS verification) — only for a
							self-hosted server you trust on a trusted network. Leaving this on lets a
							network attacker impersonate the server.
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

				<div class="subgroup">
					<span class="subgroup-title">Explorer data source (Esplora-compatible API)</span>
					<p class="hint">
						Used for block and mempool detail the Electrum protocol can't provide. Works with a
						self-hosted mempool instance or blockstream.info.
					</p>
					<div class="field">
						<label class="label" for="esploraUrl">Base URL</label>
						<input
							class="input mono"
							id="esploraUrl"
							name="esploraUrl"
							placeholder="https://mempool.space/api"
							value={data.settings.esploraUrl}
						/>
					</div>
					<div class="test-row">
						<button
							type="submit"
							class="btn btn-secondary btn-sm"
							formaction="?/testEsplora"
							disabled={testing !== null || saving}
						>
							{#if testing === 'esplora'}<span class="spinner"></span>{/if}
							Test connection
						</button>
						{#if esploraResult}
							{#if esploraResult.ok}
								<span class="badge badge-success">
									OK{esploraResult.tipHeight
										? ` — tip ${formatNumber(esploraResult.tipHeight)}`
										: ''}
								</span>
							{:else}
								<span class="badge badge-error">{esploraResult.error ?? 'Failed'}</span>
							{/if}
						{/if}
					</div>
				</div>

				<!-- Bitcoin Core RPC fields (coreRpcUrl/User/Pass) are intentionally hidden here --
				     they are stored but not yet consumed by anything (cairn-zoz8: the Esplora-removal
				     epic reintroduces this subgroup, functional, once ChainService actually talks to
				     Core RPC). Do not show a not-used-yet field to users in the meantime. -->
			</div>
		{/if}

		<div class="subgroup proxy-group">
			<span class="subgroup-title">Connection performance</span>
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
						value={data.settings.electrumPoolSize}
					/>
				</div>
			</div>
		</div>

		<div class="subgroup proxy-group">
			<span class="subgroup-title">
				Privacy: SOCKS5 / Tor proxy <span class="badge badge-neutral">optional</span>
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
						value={data.settings.socks5Host ?? ''}
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
						value={data.settings.socks5Port ?? ''}
					/>
				</div>
			</div>
		</div>
	</section>

	<div class="save-row">
		<button class="btn btn-primary" disabled={saving || testing !== null}>
			{#if saving}<span class="spinner"></span>{/if}
			Save settings
		</button>
	</div>
</form>

<!-- User Agreement -->
<form
	method="POST"
	action="?/saveAgreement"
	class="hw-section section fade-in agreement-form"
	use:enhance={() => {
		savingAgreement = true;
		return async ({ update }) => {
			savingAgreement = false;
			await update({ reset: false });
		};
	}}
>
	<div class="section-head">
		<span class="hw-title">User agreement</span>
		<p class="hint">
			The terms every user must accept before using this instance. Edit freely to add your own.
			Saving a change bumps the version, so existing users re-accept on their next visit.
			<a href="/terms" target="_blank" rel="noopener">Preview the public terms page →</a>
		</p>
	</div>

	{#if form?.agreementSaved}
		<div class="save-note" role="status">
			Saved — the agreement is now version {form.agreementVersion}.
		</div>
	{/if}

	<div class="field">
		<label class="label" for="agreementText">Agreement text</label>
		<textarea
			class="input mono agreement-text"
			id="agreementText"
			name="agreementText"
			rows="16"
			bind:value={agreementText}
		></textarea>
		<span class="hint">
			Blank lines separate paragraphs. Start a paragraph with an UPPERCASE lead-in (e.g. “NOT A
			CUSTODIAN.”) and it renders bold.
		</span>
	</div>

	<div class="save-row">
		<span class="hint">Current version: {data.agreement.version}</span>
		<button class="btn btn-primary" disabled={savingAgreement}>
			{#if savingAgreement}<span class="spinner"></span>{/if}
			Save agreement
		</button>
	</div>
</form>

<!-- Team features (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2) -->
<form
	method="POST"
	action={data.settings.instanceMode === 'team' ? '?/lockTeamMode' : '?/unlockTeamMode'}
	class="hw-section section fade-in"
	use:enhance={() => {
		togglingTeamMode = true;
		return async ({ update }) => {
			togglingTeamMode = false;
			await update();
		};
	}}
>
	<div class="section-head">
		<span class="hw-title">Team features</span>
		<p class="hint">
			Multi-user features — other accounts, invites, contacts, and multisig wallet sharing — stay
			hidden until you turn this on. Nothing is deleted either way; this only shows or hides the
			nav.
		</p>
	</div>

	{#if form?.instanceModeSaved}
		<div class="save-note" role="status">
			{data.settings.instanceMode === 'team' ? 'Team features unlocked.' : 'Team features hidden.'}
		</div>
	{/if}

	<div class="row" style="align-items: center; gap: 10px">
		{#if data.settings.instanceMode === 'team'}
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

<section class="hw-section section danger-zone fade-in">
	<div class="section-head">
		<span class="hw-title danger-title">Factory reset</span>
		<p class="hint">
			Reset this instance: deletes all users, sessions, wallets, and invites, and returns Heartwood to
			first-run setup. Settings and node configuration are wiped too — a full factory reset.
			Heartwood only ever holds public keys, so no funds are at risk, but nothing else survives.
		</p>
	</div>

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
</section>

<style>
	.settings-form {
		gap: 0;
		max-width: 760px;
	}

	.section {
		gap: 16px;
	}

	.section-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.radio-group {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 10px;
	}

	/* Selectable options keep a fill — they're controls, not content boxes
	   (the spec's "filled surfaces: inputs" allowance). */
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

	.test-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.saved-note {
		font-size: 13px;
		color: var(--sage);
		background: var(--sage-muted);
		border: 1px solid rgba(138, 160, 110, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
	}

	.save-row {
		display: flex;
		justify-content: flex-end;
		padding: 18px 0 26px;
	}

	.agreement-form {
		max-width: 760px;
		gap: 16px;
	}

	.agreement-form .save-row {
		justify-content: space-between;
		align-items: center;
	}

	.agreement-text {
		resize: vertical;
		font-size: 12.5px;
		line-height: 1.6;
		min-height: 260px;
	}

	.save-note {
		font-size: 12.5px;
		color: var(--sage);
		background: var(--sage-muted);
		border: 1px solid rgba(138, 160, 110, 0.3);
		border-radius: var(--radius-control);
		padding: 8px 12px;
	}

	.danger-zone {
		max-width: 760px;
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
