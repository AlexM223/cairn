<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '$lib/components/Banner.svelte';
	import { formatNumber } from '$lib/format';

	let { data, form } = $props();

	// svelte-ignore state_referenced_locally — intentionally seeds local UI state
	let connectionMode = $state(data.settings.connectionMode);
	let saving = $state(false);
	let testing = $state<'electrum' | 'coreRpc' | null>(null);

	// Umbrel Wave B assisted-connect (cairn-ylz5 B3 / cairn-mz9p). Mirrors
	// src/lib/server/umbrelCoreProbe.ts's UMBREL_CORE_RPC_URL/UMBREL_CORE_RPC_USER
	// (docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md §9) — that module lives under
	// $lib/server and cannot be imported into this isomorphic component, so the
	// same literal constants are duplicated here. These are NEVER read from any
	// probe response (design §7) — keep in sync with umbrelCoreProbe.ts only if
	// the well-known Umbrel address itself ever changes.
	const UMBREL_CORE_RPC_URL = 'http://10.21.21.8:8332';
	const UMBREL_CORE_RPC_USER = 'umbrel';

	// The manual Core RPC url/user inputs (custom-mode subgroup, further down)
	// are bound to local state seeded from the load rather than a plain
	// value={...} read, purely so they can be re-populated after a submission
	// without a full reload.
	// svelte-ignore state_referenced_locally
	let coreRpcUrlField = $state(data.settings.coreRpcUrl ?? '');
	// svelte-ignore state_referenced_locally
	let coreRpcUserField = $state(data.settings.coreRpcUser ?? '');
	let coreRpcPassEl = $state<HTMLInputElement | undefined>();

	// Config-presence check mirrored from settings.ts's coreRpcConfigured() —
	// only a non-empty stored coreRpcUrl counts (the parenthetical field check
	// specified for this task), independent of connectionMode since Core RPC is
	// mode-independent (design §4).
	const coreRpcIsConfigured = $derived(!!data.settings.coreRpcUrl);

	// Umbrel Wave B assisted-connect (cairn-6uok follow-up cairn-3p9z). The
	// card below posts straight to `?/save` (guarded by the shared `saving`
	// state, same as the main "Save settings" button) with a
	// `coreRpcAssisted=umbrel` hidden marker — the server validates with
	// testCoreRpc() before persisting and never touches connection_mode, so
	// (unlike the old useDetectedCoreNode() workaround this replaces) it works
	// correctly regardless of which mode the operator is currently on and
	// never force-flips the radio. Local field for the password only — the
	// URL/user are the hardcoded constants above, never user-edited here.
	let assistedCoreRpcPass = $state('');

	type TestResult = { ok: boolean; tipHeight?: number; error?: string } | null;
	type CoreRpcTestResult = { ok: boolean; blockHeight?: number; chain?: string; error?: string } | null;

	// Test results are copied into local state as they arrive: the test actions
	// share one ActionData slot, so rendering `form` directly would let each
	// result wipe the others' badges.
	let electrumResult = $state<TestResult>(null);
	let coreRpcResult = $state<CoreRpcTestResult>(null);

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
		if (form?.coreRpcTest) coreRpcResult = form.coreRpcTest as CoreRpcTestResult;
	});

	// Live-ish chain-transport health next to the proxy config (cairn-hy8z): a
	// last-known signal (from the load, refreshed on navigation), so an admin can
	// see whether connections are currently succeeding or being rejected.
	const chainHealth = $derived(data.chainHealth);
	function agoLabel(atMs: number | null): string {
		if (atMs === null) return '';
		const secs = Math.max(0, Math.round((Date.now() - atMs) / 1000));
		if (secs < 60) return 'just now';
		const mins = Math.round(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		return `${Math.round(mins / 60)}h ago`;
	}
</script>

<svelte:head>
	<title>Settings — Admin — Heartwood</title>
</svelte:head>

<form
	id="settings-form"
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
			: action.search.includes('testCoreRpc')
				? ('coreRpc' as const)
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
				else coreRpcResult = timedOut;
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
		<Banner variant="error">{form.error}</Banner>
	{/if}
	{#if form?.saved}
		<Banner variant="success">Settings saved — connection updated.</Banner>
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
				<span class="radio-desc">electrum.blockstream.info (Electrum) — always mainnet</span>
			</label>
			<label class="radio-card" class:selected={connectionMode === 'custom'}>
				<input type="radio" name="connectionMode" value="custom" bind:group={connectionMode} />
				<span class="radio-label">Custom</span>
				<span class="radio-desc">Your own Electrum server and data sources</span>
			</label>
		</div>

		<!-- Provenance card (cairn-mz9p): calm, informational, no behavior change.
		     Only rendered when Wave A actually auto-connected Electrum. -->
		{#if data.settings.chainProvisionedBy === 'umbrel-env' || data.settings.chainProvisionedBy === 'umbrel-probe'}
			<div class="provenance-card fade-in" role="status">
				<span class="provenance-dot"></span>
				<div class="provenance-text">
					<span class="provenance-title">
						Connected automatically to your Umbrel's Electrum server
					</span>
					<span class="provenance-sub">
						{data.settings.chainProvisionedBy === 'umbrel-env'
							? 'Set up from your Umbrel Bitcoin Node app.'
							: 'Found automatically on your Umbrel.'} You can still point this at a different
						server below.
					</span>
				</div>
			</div>
		{/if}

		<!-- Core RPC provenance, once an assisted or env connect has actually
		     completed (cairn-6uok: core_rpc_provisioned_by is now stamped
		     'umbrel-detect' by the assisted-connect card's submit below). -->
		{#if coreRpcIsConfigured && (data.settings.coreRpcProvisionedBy === 'umbrel-env' || data.settings.coreRpcProvisionedBy === 'umbrel-detect')}
			<div class="provenance-card fade-in" role="status">
				<span class="provenance-dot"></span>
				<div class="provenance-text">
					<span class="provenance-title">Connected to your Umbrel's Bitcoin Core</span>
					<span class="provenance-sub">
						{data.settings.coreRpcProvisionedBy === 'umbrel-env'
							? 'Set up from your Umbrel Bitcoin Node app.'
							: 'Connected using the details found on your Umbrel.'}
					</span>
				</div>
			</div>
		{/if}

		<!-- Core RPC assisted-connect (cairn-ylz5 Unit B3, cairn-6uok follow-up
		     cairn-3p9z): Bitcoin Core was found on the Umbrel network but isn't
		     wired up yet. Posts directly to `?/save` with the coreRpcAssisted
		     marker — mode-independent (works whether connectionMode is public or
		     custom, and never flips it), validated server-side with testCoreRpc()
		     before anything is persisted (design doc §9 state 3). Dismiss posts
		     to `?/dismissCoreDetection`, which writes core_rpc_detected='dismissed'
		     (design doc §8's stale-marker mitigation) so the card stops rendering
		     without connecting anything. -->
		{#if data.settings.coreRpcDetected === 'umbrel' && !coreRpcIsConfigured}
			<div class="provenance-card core-detect fade-in" role="status">
				<span class="provenance-dot detect"></span>
				<div class="provenance-text">
					<span class="provenance-title">Bitcoin Core detected on your Umbrel</span>
					<span class="provenance-sub">
						Connect it for full block and transaction details in the explorer. Paste the
						RPC password (copy it from your Umbrel Bitcoin app's Connect screen) below —
						the address and username are already filled in.
					</span>
					<input type="hidden" name="coreRpcAssisted" value="umbrel" form="settings-form" />
					<input
						type="hidden"
						name="coreRpcUrl"
						value={UMBREL_CORE_RPC_URL}
						form="settings-form"
					/>
					<input
						type="hidden"
						name="coreRpcUser"
						value={UMBREL_CORE_RPC_USER}
						form="settings-form"
					/>
					<input
						class="input mono assisted-pass"
						type="password"
						autocomplete="off"
						placeholder="RPC password"
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
				<!-- Which network the custom backend is on (cairn-10ox / cairn-x6pr).
				     Only meaningful in custom mode — getChainConfig() always forces
				     'mainnet' in public mode, so this field only exists in this
				     custom-only render (mirrors the server action's validation, which
				     only reads/writes chainNetwork inside the same connectionMode ===
				     'custom' branch). -->
				<div class="subgroup">
					<span class="subgroup-title">Network</span>
					<p class="hint">
						Which Bitcoin network your server and node are actually running. Changing this
						changes which keys and addresses are valid — only switch it if your Electrum
						server and Core node are on that network too.
					</p>
					<div class="field">
						<label class="label" for="chainNetwork">Network</label>
						<select
							class="input"
							id="chainNetwork"
							name="chainNetwork"
							value={data.settings.chainNetwork}
						>
							<option value="mainnet">Mainnet</option>
							<option value="testnet">Testnet</option>
							<option value="regtest">Regtest</option>
						</select>
					</div>
				</div>

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
			</div>
		{/if}

		<!-- Bitcoin Core RPC (cairn-zoz8.8, cairn-6uok follow-up cairn-3p9z). Core
		     RPC is mode-independent (getChainConfig() returns coreRpc* in both
		     'public' and 'custom' connection modes — there is no public-mode Core
		     fallback, Core is "on" iff core_rpc_url is set) and the save action has
		     persisted it mode-independently since cairn-6uok, so this subgroup must
		     render regardless of connectionMode too — it used to be nested inside
		     the connectionMode==='custom' block above, which meant a public-mode
		     admin who wanted to hand-enter a Core RPC endpoint had no way to reach
		     these inputs without first flipping to custom mode. Core RPC is now the
		     sole source of the rich block/tx/mempool detail the Electrum protocol
		     can't provide — there is no longer any third-party HTTP explorer API in
		     the path (cairn-zoz8.16). -->
		<div class="subgroup proxy-group">
			<span class="subgroup-title">
				Bitcoin Core RPC <span class="badge badge-neutral">self-hosted</span>
			</span>
			<p class="hint">
				Point Heartwood at your own Bitcoin Core node's RPC interface for rich block and
				mempool data without relying on any third-party explorer API. Fully self-hosted —
				works on an Umbrel or other node with no public internet access, and works whether
				you're on public servers or a custom Electrum server above.
			</p>
			<div class="field">
				<label class="label" for="coreRpcUrl">RPC URL</label>
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
					<label class="label" for="coreRpcUser">RPC username</label>
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
					<label class="label" for="coreRpcPass">RPC password</label>
					<input
						class="input mono"
						id="coreRpcPass"
						name="coreRpcPass"
						type="password"
						autocomplete="off"
						placeholder={data.settings.hasCoreRpcPass
							? '•••••••• saved — leave blank to keep'
							: 'RPC password'}
						bind:this={coreRpcPassEl}
					/>
				</div>
			</div>
			{#if data.settings.hasCoreRpcPass}
				<label class="tls-check">
					<input type="checkbox" name="clearCoreRpcPass" />
					<span>Clear the saved RPC password</span>
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
			{#if chainHealth}
				<!-- Last-known transport health (cairn-hy8z): surfaces a rejecting proxy
				     or unreachable node right where the proxy is configured. -->
				<div class="health-line" class:health-bad={!chainHealth.healthy} role="status">
					{#if !chainHealth.healthy}
						<span class="health-dot bad"></span>
						<span>
							{chainHealth.proxyConfigured
								? 'Connections through the proxy are failing'
								: 'Connections to the node are failing'}{chainHealth.lastErrorAt
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

	/* Umbrel auto-connect provenance / assisted-connect cards (cairn-mz9p,
	   cairn-ylz5 B3). Calm and informational by default (sage, matches the
	   existing "connected" tone in .saved-note / .health-dot.ok); the
	   actionable Core-detected variant uses the accent color instead, since it
	   asks for a click rather than just reporting status. */
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

	/* Live-ish chain-transport health next to the proxy config (cairn-hy8z). */
	.health-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.health-line.health-bad {
		color: var(--error);
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
		background: var(--error);
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
		border: 1px solid rgba(131, 184, 146, 0.3);
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
