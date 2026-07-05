<script lang="ts">
	import { enhance, applyAction } from '$app/forms';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import DevicePicker from '$lib/components/DevicePicker.svelte';
	import Term from '$lib/components/Term.svelte';
	import type { ScriptType, WalletDeviceType } from '$lib/types';
	import { SCRIPT_TYPE_LABELS } from '../labels';

	const STEPS = ['Type', 'Key', 'Preview', 'Name', 'Done'];

	// Step 1 asks the single question that splits the two flavors. "Single key"
	// stays in this wizard; "Multiple keys" hands off to the multisig builder.
	let walletType = $state<'single' | 'multisig'>('single');

	let step = $state(0);
	let xpubInput = $state('');
	let showHelp = $state(false);
	let validating = $state(false);
	let creating = $state(false);
	let previewError = $state<string | null>(null);
	let createError = $state<string | null>(null);

	// Carried across steps once the server has validated the key.
	let preview = $state<{ address: string; path: string }[]>([]);
	let scriptType = $state<ScriptType | null>(null);
	let validatedXpub = $state('');
	let name = $state('');
	// Which device holds this key. null = the user skipped it; the wallet then
	// signs via the universal file/PSBT fallback. Saved on the wallet record.
	let deviceType = $state<WalletDeviceType | null>(null);
	// After creation: the new wallet id, and whether its config backup was
	// downloaded (required before the wizard can finish — cairn-dcp).
	let createdId = $state<number | null>(null);
	let backedUp = $state(false);

	const looksLikeKey = $derived(/^[xyz]pub[1-9A-HJ-NP-Za-km-z]{20,}$/.test(xpubInput.trim()));
</script>

<svelte:head>
	<title>Import a wallet — Cairn</title>
</svelte:head>

<div class="wizard fade-in">
	<a href="/wallets" class="back-link">
		<Icon name="chevron-left" size={14} />
		Wallets
	</a>
	<h1 class="page-title" style="margin-bottom: 4px">Add a wallet</h1>
	<p class="hint" style="margin-bottom: 24px">
		A short guided setup — Cairn only ever sees public keys.
	</p>

	<!-- Step indicator -->
	<ol class="steps" aria-label="Import progress">
		{#each STEPS as label, i (label)}
			<li class="step-item" class:active={i === step} class:done={i < step}>
				<span class="step-dot">
					{#if i < step}
						<Icon name="check" size={11} />
					{:else}
						{i + 1}
					{/if}
				</span>
				<span class="step-label">{label}</span>
			</li>
		{/each}
	</ol>

	{#if step === 0}
		<!-- ------------------------------------------------ Step 1: type -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 1 · What kind of wallet?</span>
			<button
				type="button"
				class="type-card"
				class:selected={walletType === 'single'}
				aria-pressed={walletType === 'single'}
				onclick={() => (walletType = 'single')}
			>
				<span class="type-icon"><Icon name="wallet" size={20} /></span>
				<span class="type-body">
					<span class="type-name">Single key</span>
					<span class="type-desc">
						A full wallet backed by one key (an xpub). Cairn tracks your balance and history from
						the extended <strong>public</strong> key, and you spend by signing on your own device —
						your private key never leaves it.
					</span>
				</span>
				<Icon name="check" size={17} />
			</button>
			<button
				type="button"
				class="type-card"
				class:selected={walletType === 'multisig'}
				aria-pressed={walletType === 'multisig'}
				onclick={() => (walletType = 'multisig')}
			>
				<span class="type-icon"><Icon name="shield" size={20} /></span>
				<span class="type-body">
					<span class="type-name">Multiple keys (multisig)</span>
					<span class="type-desc">
						Several keys guard one wallet, and spending needs a quorum — e.g. any 2 of 3. No single
						lost or stolen key can move the funds. Best for savings.
					</span>
				</span>
				<Icon name="check" size={17} />
			</button>
			<div class="pane-actions">
				<span></span>
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => (walletType === 'multisig' ? goto('/wallets/multisig/new') : (step = 1))}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</div>
	{:else if step === 1}
		<!-- ------------------------------------------------- Step 2: key -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 2 · Extended public key</span>
			<form
				method="POST"
				action="?/preview"
				class="stack"
				style="gap: 14px"
				use:enhance={() => {
					validating = true;
					previewError = null;
					return async ({ result }) => {
						validating = false;
						if (result.type === 'success' && result.data) {
							const d = result.data as {
								preview: { address: string; path: string }[];
								scriptType: ScriptType;
								xpub: string;
							};
							preview = d.preview;
							scriptType = d.scriptType;
							validatedXpub = d.xpub;
							step = 2;
						} else if (result.type === 'failure') {
							previewError =
								(result.data as { error?: string } | undefined)?.error ??
								'That key could not be read.';
						} else {
							await applyAction(result);
						}
					};
				}}
			>
				<div class="field">
					<label class="label" for="xpub">Paste your xpub, ypub or zpub</label>
					<textarea
						class="input mono xpub-input"
						id="xpub"
						name="xpub"
						rows="3"
						placeholder="zpub6rFR7y4Q2Aij…"
						spellcheck="false"
						autocomplete="off"
						bind:value={xpubInput}
						aria-invalid={previewError ? 'true' : undefined}
					></textarea>
					{#if xpubInput.trim() && !looksLikeKey}
						<span class="hint">
							Extended keys start with xpub, ypub or zpub — keep pasting, we'll verify
							properly on the next step.
						</span>
					{/if}
				</div>

				{#if previewError}
					<div class="form-error" role="alert">{previewError}</div>
				{/if}

				<div class="help-box">
					<button
						type="button"
						class="help-toggle"
						onclick={() => (showHelp = !showHelp)}
						aria-expanded={showHelp}
					>
						<Icon name="info" size={14} />
						What's an xpub?
						<span class="chev" class:open={showHelp}>
							<Icon name="chevron-down" size={14} />
						</span>
					</button>
					{#if showHelp}
						<div class="help-body fade-in">
							<p>
								An xpub is your wallet's master <strong>public</strong> key. From it,
								Cairn can derive every address your wallet will ever use and see the
								full transaction history — but it can't spend a single sat. Private
								keys and seed words never leave your wallet.
							</p>
							<p>
								Most wallets show it under something like Settings → Wallet details →
								Extended public key. Prefixes differ by address type: xpub (legacy),
								ypub (nested SegWit), zpub (native SegWit).
							</p>
						</div>
					{/if}
				</div>

				<div class="pane-actions">
					<button type="button" class="btn btn-ghost" onclick={() => (step = 0)}>
						<Icon name="chevron-left" size={14} />
						Back
					</button>
					<button class="btn btn-primary" disabled={validating || !xpubInput.trim()}>
						{#if validating}<span class="spinner"></span>{/if}
						Validate key
					</button>
				</div>
			</form>
		</div>
	{:else if step === 2}
		<!-- --------------------------------------------- Step 3: preview -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 3 · Preview</span>
			<div class="row" style="gap: 10px">
				<span class="detected">Detected:</span>
				{#if scriptType}
					<span class="badge badge-accent">{SCRIPT_TYPE_LABELS[scriptType]}</span>
				{/if}
			</div>
			<p class="hint" style="line-height: 1.6">
				These are the first five receive addresses derived from your key. Check they match
				your wallet's receive addresses before continuing.
			</p>
			<div class="preview-list">
				{#each preview as item (item.path)}
					<div class="preview-row">
						<span class="mono preview-path">{item.path}</span>
						<span class="mono preview-addr truncate" title={item.address}>{item.address}</span>
					</div>
				{/each}
			</div>
			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={() => (step = 1)}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => {
						if (!name && scriptType) name = `${SCRIPT_TYPE_LABELS[scriptType]} wallet`;
						step = 3;
					}}
				>
					<Icon name="check" size={14} />
					These match
				</button>
			</div>
		</div>
	{:else if step === 3}
		<!-- ------------------------------------------------ Step 4: name -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 4 · Name</span>
			<form
				method="POST"
				action="?/create"
				class="stack"
				style="gap: 14px"
				use:enhance={() => {
					if (creating) return;
					creating = true;
					createError = null;
					return async ({ result }) => {
						creating = false;
						if (result.type === 'failure') {
							createError =
								(result.data as { error?: string } | undefined)?.error ??
								'Could not import that wallet.';
						} else if (result.type === 'success' && result.data) {
							// Move to the mandatory backup step instead of leaving the wizard.
							createdId = (result.data as { id: number }).id;
							step = 4;
						} else {
							await applyAction(result);
						}
					};
				}}
			>
				<input type="hidden" name="xpub" value={validatedXpub} />
				<input type="hidden" name="deviceType" value={deviceType ?? ''} />
				<div class="field">
					<label class="label" for="name">What should we call it?</label>
					<input
						class="input"
						id="name"
						name="name"
						placeholder="e.g. Cold storage"
						maxlength="64"
						bind:value={name}
					/>
					<span class="hint">Just a label — you can't break anything here.</span>
				</div>

				<div class="field">
					<span class="label">
						Which device holds this key?
						<span class="optional">(optional)</span>
					</span>
					<p class="hint" style="margin-bottom: 4px">
						This is how you'll <Term
							tip="Cairn prepares an unsigned transaction; you approve it on this device. Your private key never leaves it."
							>sign when you spend</Term
						>. Not sure? Leave it — you can pick when you send, and any PSBT wallet works.
					</p>
					<DevicePicker bind:selected={deviceType} />
				</div>

				{#if createError}
					<div class="form-error" role="alert">{createError}</div>
				{/if}

				<div class="pane-actions">
					<button type="button" class="btn btn-ghost" onclick={() => (step = 2)}>
						<Icon name="chevron-left" size={14} />
						Back
					</button>
					<button class="btn btn-primary" disabled={creating}>
						{#if creating}<span class="spinner"></span>{/if}
						Import wallet
					</button>
				</div>
			</form>
		</div>
	{:else if step === 4 && createdId !== null}
		<!-- ------------------------------------------- Step 5: back up (required) -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 5 · Back up your wallet</span>
			<h2 class="done-title">Wallet imported — one important step left</h2>

			<div class="backup-warning" role="alert">
				<Icon name="alert-triangle" size={18} />
				<div>
					<strong>Download your wallet configuration now.</strong>
					This file is the only way to rebuild this wallet if Cairn's data is ever lost. It holds
					your <Term
						tip="Your wallet configuration file contains the public keys and settings needed to find your bitcoin on the blockchain. It cannot spend — but without it, restoring the wallet elsewhere is much harder."
						>public keys and settings</Term
					> — nothing that can spend — but without it you may permanently lose access to your bitcoin.
				</div>
			</div>

			<a
				class="btn btn-primary"
				href="/api/wallets/{createdId}/config"
				download
				onclick={() => (backedUp = true)}
			>
				<Icon name="arrow-down-left" size={15} />
				Download wallet config (JSON)
			</a>

			{#if backedUp}
				<p class="backup-done" role="status">
					<Icon name="check" size={14} />
					Saved. Keep it somewhere safe — with your seed backup, not on this server.
				</p>
			{/if}

			<div class="pane-actions">
				<span class="hint">
					{#if !backedUp}Download the file to continue.{/if}
				</span>
				<a
					class="btn btn-primary"
					class:disabled-link={!backedUp}
					href={backedUp ? `/wallets/${createdId}?imported=1` : undefined}
					aria-disabled={!backedUp}
					tabindex={backedUp ? undefined : -1}
				>
					Go to your wallet
					<Icon name="arrow-right" size={14} />
				</a>
			</div>
		</div>
	{/if}
</div>

<style>
	.wizard {
		max-width: 620px;
	}

	.done-title {
		font-family: var(--font-serif);
		font-size: 20px;
		font-weight: 560;
		letter-spacing: -0.01em;
	}

	.backup-warning {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-control);
		padding: 14px 16px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.backup-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.backup-warning strong {
		color: var(--text);
	}

	.backup-done {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--success);
	}

	.disabled-link {
		opacity: 0.5;
		pointer-events: none;
		cursor: not-allowed;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-secondary);
		margin-bottom: 14px;
	}

	.back-link:hover {
		color: var(--accent);
	}

	/* --- step indicator --- */

	.steps {
		display: flex;
		align-items: center;
		gap: 4px;
		list-style: none;
		margin: 0 0 18px;
		padding: 0;
	}

	.step-item {
		display: flex;
		align-items: center;
		gap: 7px;
		flex: 1;
		min-width: 0;
	}

	.step-item:not(:first-child)::before {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
		margin-right: 4px;
	}

	.step-item:first-child {
		flex: 0 0 auto;
	}

	.step-dot {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 600;
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text-muted);
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.step-item.active .step-dot {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.step-item.done .step-dot {
		background: var(--accent-muted);
		border-color: transparent;
		color: var(--accent);
	}

	.step-label {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.step-item.active .step-label {
		color: var(--text);
	}

	.step-item.done .step-label {
		color: var(--text-secondary);
	}

	@media (max-width: 560px) {
		.step-label {
			display: none;
		}

		.step-item.active .step-label {
			display: inline;
		}
	}

	/* --- panes --- */

	.pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.pane-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 4px;
	}

	/* --- step 1: type card --- */

	.type-card {
		display: flex;
		align-items: flex-start;
		gap: 14px;
		text-align: left;
		padding: 16px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.type-card:hover {
		border-color: var(--text-muted);
	}

	/* The trailing check only reads as "selected"; hide it on the resting card. */
	.type-card > :global(svg) {
		opacity: 0;
		color: var(--accent);
		margin-top: 3px;
	}

	.type-card.selected {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.type-card.selected > :global(svg) {
		opacity: 1;
	}

	.type-icon {
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.type-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}

	.type-name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 600;
	}

	.type-desc {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.55;
	}

	/* --- step 2: key --- */

	.xpub-input {
		resize: vertical;
		word-break: break-all;
		font-size: 13px;
	}

	.help-box {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.help-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 10px 12px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}

	.help-toggle:hover {
		color: var(--text);
	}

	.chev {
		margin-left: auto;
		display: inline-flex;
		transition: transform 140ms var(--ease);
	}

	.chev.open {
		transform: rotate(180deg);
	}

	.help-body {
		padding: 2px 12px 12px 34px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.help-body p {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.help-body strong {
		color: var(--text);
	}

	.optional {
		font-weight: 400;
		color: var(--text-muted);
	}

	/* --- step 3: preview --- */

	.detected {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.preview-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg);
	}

	.preview-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 9px 12px;
		font-size: 12.5px;
	}

	.preview-row + .preview-row {
		border-top: 1px solid var(--border-subtle);
	}

	.preview-path {
		color: var(--text-muted);
		flex-shrink: 0;
		width: 44px;
	}

	.preview-addr {
		min-width: 0;
	}
</style>
