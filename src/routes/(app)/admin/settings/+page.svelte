<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatNumber } from '$lib/format';

	let { data, form } = $props();

	// svelte-ignore state_referenced_locally — intentionally seeds local UI state
	let connectionMode = $state(data.settings.connectionMode);
	let saving = $state(false);
	let testing = $state<'electrum' | 'esplora' | null>(null);
</script>

<svelte:head>
	<title>Settings — Admin — Cairn</title>
</svelte:head>

<form
	method="POST"
	action="?/save"
	class="stack settings-form fade-in"
	use:enhance={({ action }) => {
		const which = action.search;
		if (which.includes('save')) saving = true;
		return async ({ update }) => {
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

	<section class="card card-pad section">
		<div class="section-head">
			<span class="card-title">Registration</span>
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
	</section>

	<section class="card card-pad section">
		<div class="section-head">
			<span class="card-title">Node connection</span>
			<p class="hint">
				Where Cairn reads chain data from. Public servers work out of the box; point it at your
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
					<div class="test-row">
						<button
							class="btn btn-secondary btn-sm"
							formaction="?/testElectrum"
							onclick={() => (testing = 'electrum')}
							disabled={testing !== null}
						>
							{#if testing === 'electrum'}<span class="spinner"></span>{/if}
							Test connection
						</button>
						{#if form?.electrumTest}
							{#if form.electrumTest.ok}
								<span class="badge badge-success">
									Connected{'tipHeight' in form.electrumTest && form.electrumTest.tipHeight
										? ` — tip ${formatNumber(form.electrumTest.tipHeight)}`
										: ''}
								</span>
							{:else}
								<span class="badge badge-error">{form.electrumTest.error ?? 'Failed'}</span>
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
							class="btn btn-secondary btn-sm"
							formaction="?/testEsplora"
							onclick={() => (testing = 'esplora')}
							disabled={testing !== null}
						>
							{#if testing === 'esplora'}<span class="spinner"></span>{/if}
							Test connection
						</button>
						{#if form?.esploraTest}
							{#if form.esploraTest.ok}
								<span class="badge badge-success">
									OK{'tipHeight' in form.esploraTest && form.esploraTest.tipHeight
										? ` — tip ${formatNumber(form.esploraTest.tipHeight)}`
										: ''}
								</span>
							{:else}
								<span class="badge badge-error">{form.esploraTest.error ?? 'Failed'}</span>
							{/if}
						{/if}
					</div>
				</div>

				<div class="subgroup">
					<span class="subgroup-title">
						Bitcoin Core RPC <span class="badge badge-neutral">optional</span>
					</span>
					<p class="hint">Stored for upcoming features; not used by the explorer yet.</p>
					<div class="row-fields">
						<div class="field grow">
							<label class="label" for="coreRpcUrl">RPC URL</label>
							<input
								class="input mono"
								id="coreRpcUrl"
								name="coreRpcUrl"
								placeholder="http://127.0.0.1:8332"
								value={data.settings.coreRpcUrl ?? ''}
							/>
						</div>
						<div class="field">
							<label class="label" for="coreRpcUser">User</label>
							<input
								class="input mono"
								id="coreRpcUser"
								name="coreRpcUser"
								value={data.settings.coreRpcUser ?? ''}
							/>
						</div>
						<div class="field">
							<label class="label" for="coreRpcPass">Password</label>
							<input
								class="input mono"
								id="coreRpcPass"
								name="coreRpcPass"
								type="password"
								value={data.settings.coreRpcPass ?? ''}
							/>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</section>

	<div class="save-row">
		<button class="btn btn-primary" disabled={saving}>
			{#if saving}<span class="spinner"></span>{/if}
			Save settings
		</button>
	</div>
</form>

<style>
	.settings-form {
		gap: 14px;
		max-width: 760px;
	}

	.section {
		display: flex;
		flex-direction: column;
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

	.radio-card {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.radio-card:hover {
		border-color: var(--text-muted);
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
		border-top: 1px solid var(--border-subtle);
		padding-top: 18px;
	}

	.subgroup {
		display: flex;
		flex-direction: column;
		gap: 10px;
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
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
	}

	.save-row {
		display: flex;
		justify-content: flex-end;
	}
</style>
