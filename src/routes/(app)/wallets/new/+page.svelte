<script lang="ts">
	import { enhance, applyAction, deserialize } from '$app/forms';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onDestroy, tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import DevicePicker from '$lib/components/DevicePicker.svelte';
	import Term from '$lib/components/Term.svelte';
	import type { ScriptType, WalletDeviceType } from '$lib/types';
	import { SCRIPT_TYPE_LABELS, WALLET_DEVICE_LABELS } from '../labels';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import { bitbox02SupportsScriptType } from '$lib/hw/bitbox02';
	import {
		readKeyFromTrezor,
		readKeyFromLedger,
		readKeyFromBitbox02,
		readKeyFromJade,
		DeviceReadUnavailable
	} from './_components/deviceRead';
	import { parseColdcardSingleSigExport } from './_components/coldcardImport';

	const STEPS = ['Type', 'Key', 'Preview', 'Name', 'Done'];

	// Step 1 asks the single question that splits the two flavors. "Single key"
	// stays in this wizard; "Multiple keys" hands off to the multisig builder.
	let walletType = $state<'single' | 'multisig'>('single');

	let step = $state(0);
	let xpubInput = $state('');
	let showHelp = $state(false);
	let validating = $state(false);
	// Restore-from-backup (cairn-lun6): the hidden file input on the Key step, plus
	// the feedback shown under it after a file is read.
	let restoreFileInput = $state<HTMLInputElement | null>(null);
	let restoreError = $state<string | null>(null);
	let restoreNote = $state<string | null>(null);
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

	// -------------------------------------------------- Step 2: how the key arrives
	//
	// Seven equally-valid ways a single-sig key can arrive — the same shape as the
	// multisig wizard's Keys step, scoped to reading exactly one key. Unlike the
	// multisig wizard, "paste" is not a fallback-after-failure here: it is simply
	// one more method, so its card sits alongside the rest with no special framing.
	type Method = 'trezor' | 'ledger' | 'coldcard' | 'bitbox02' | 'jade' | 'qr' | 'paste';
	let method = $state<Method | null>(null);
	// Which method actually produced the validated key. Set on a successful read
	// so Step 4 can confirm the device instead of re-asking. null until validated.
	let readMethod = $state<Method | null>(null);
	// Step 4: reveal the interactive device picker even for a device-read key, for
	// the rare case the signing device differs from what read the key (e.g. a
	// Ledger xpub read via QR because the browser lacks WebHID).
	let changeDevice = $state(false);

	const METHOD_CARDS: { key: Method; title: string; desc: string }[] = [
		{ key: 'trezor', title: 'Trezor', desc: 'Plug it in and connect with one click.' },
		{ key: 'ledger', title: 'Ledger', desc: 'Plug it in and connect with one click.' },
		{ key: 'coldcard', title: 'ColdCard', desc: 'Import the file from its microSD card.' },
		{ key: 'bitbox02', title: 'BitBox02', desc: 'Plug it in and confirm on the device.' },
		{ key: 'jade', title: 'Jade', desc: 'Plug it in and unlock it (Chrome/Edge).' },
		{ key: 'qr', title: 'Air-gapped QR', desc: "Scan the key's QR code off the device screen." },
		{ key: 'paste', title: 'Paste public key', desc: 'From any wallet app, or a key someone sent you.' }
	];

	// Device reads need a derivation path, which is chosen by address type BEFORE
	// the read (the account xpub's prefix then tells the server the type back).
	// Only the three prefixes the server recognises are offered (xpub/ypub/zpub);
	// Native SegWit is the modern default. Taproot single-sig has no distinct
	// SLIP-132 prefix, so it can't round-trip this wizard's preview — omitted here
	// deliberately rather than silently mis-detected as legacy.
	type DeviceScriptType = Extract<ScriptType, 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh'>;
	let deviceScriptType = $state<DeviceScriptType>('p2wpkh');
	const DEVICE_SCRIPT_CHOICES: { key: DeviceScriptType; label: string }[] = [
		{ key: 'p2wpkh', label: 'Native SegWit' },
		{ key: 'p2sh-p2wpkh', label: 'Nested SegWit' },
		{ key: 'p2pkh', label: 'Legacy' }
	];

	let deviceBusy = $state(false);
	let deviceError = $state<string | null>(null);
	let coldcardInput = $state<HTMLInputElement | null>(null);

	function pickMethod(m: Method) {
		method = m;
		deviceError = null;
		previewError = null;
		// The BitBox02 firmware has no legacy (BIP-44) single-sig account; if the
		// user had Legacy selected from another device, fall back to a supported one.
		if (m === 'bitbox02' && !bitbox02SupportsScriptType(deviceScriptType)) {
			deviceScriptType = 'p2wpkh';
		}
	}

	function backToMethods() {
		stopQrScan();
		method = null;
		deviceError = null;
	}

	// A device/file/QR read produced a key: validate it server-side (deriving the
	// preview + real script type from the key's own prefix) exactly like paste
	// does, and remember which method got us here so Step 4 can pre-fill the
	// device instead of re-asking.
	async function acceptReadKey(xpub: string, from: Method) {
		deviceError = null;
		previewError = null;
		const body = new FormData();
		body.set('xpub', xpub);
		try {
			const res = await fetch('?/preview', {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body
			});
			const result = deserialize(await res.text());
			if (result.type === 'success' && result.data) {
				const d = result.data as {
					preview: { address: string; path: string }[];
					scriptType: ScriptType;
					xpub: string;
				};
				preview = d.preview;
				scriptType = d.scriptType;
				validatedXpub = d.xpub;
				xpubInput = d.xpub;
				readMethod = from;
				deviceType = METHOD_DEVICE[from];
				changeDevice = false;
				step = 2;
			} else if (result.type === 'failure') {
				deviceError =
					(result.data as { error?: string } | undefined)?.error ??
					'That key could not be read.';
			} else {
				deviceError = 'That key could not be read.';
			}
		} catch {
			deviceError = 'Network hiccup — check your connection and try again.';
		}
	}

	/** Method → the device type saved on the wallet. Paste stays device-agnostic. */
	const METHOD_DEVICE: Record<Method, WalletDeviceType | null> = {
		trezor: 'trezor',
		ledger: 'ledger',
		coldcard: 'coldcard',
		bitbox02: 'bitbox02',
		jade: 'jade',
		qr: 'qr',
		paste: null
	};

	async function connectDevice(kind: 'trezor' | 'ledger' | 'bitbox02' | 'jade') {
		if (deviceBusy) return;
		deviceBusy = true;
		deviceError = null;
		try {
			const key =
				kind === 'trezor'
					? await readKeyFromTrezor(deviceScriptType)
					: kind === 'ledger'
						? await readKeyFromLedger(deviceScriptType)
						: kind === 'bitbox02'
							? await readKeyFromBitbox02(deviceScriptType)
							: await readKeyFromJade(deviceScriptType);
			await acceptReadKey(key.xpub, kind);
		} catch (e) {
			if (e instanceof DeviceReadUnavailable) {
				deviceError = `Direct ${WALLET_DEVICE_LABELS[kind]} connection isn't available in this browser — paste the key instead, or scan its QR.`;
			} else {
				deviceError = e instanceof Error ? e.message : 'Could not read the key from the device.';
			}
		} finally {
			deviceBusy = false;
		}
	}

	async function handleColdcardFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		deviceError = null;
		deviceBusy = true;
		try {
			const key = parseColdcardSingleSigExport(await file.text(), deviceScriptType);
			await acceptReadKey(key.xpub, 'coldcard');
		} catch (err) {
			deviceError = err instanceof Error ? err.message : 'Could not read that file.';
		} finally {
			deviceBusy = false;
			input.value = '';
		}
	}

	// --- air-gapped QR scanning (device-agnostic camera path) ---
	let cameraAvailable = $state(false);
	$effect(() => {
		// Camera scanning is a client-only feature (no server route), so the
		// qr_scan flag is enforced purely by suppressing the camera path here —
		// the UI falls back to "paste the key" when it's off.
		cameraAvailable = isCameraScanAvailable() && page.data.flags?.qr_scan !== false;
	});
	let scanning = $state(false);
	let videoEl = $state<HTMLVideoElement | null>(null);
	let scanHandle: ScanHandle | null = null;
	let qrBusy = false;

	function stopQrScan() {
		scanHandle?.stop();
		scanHandle = null;
		scanning = false;
		qrBusy = false;
	}

	async function startQrScan() {
		if (scanning) return;
		deviceError = null;
		scanning = true;
		await tick(); // mount the <video> first
		if (!videoEl) {
			scanning = false;
			return;
		}
		try {
			scanHandle = await startScan(videoEl, (text) => void handleQrText(text), {
				onError: (err) => {
					deviceError = err.message;
					stopQrScan();
				}
			});
		} catch (e) {
			deviceError = e instanceof Error ? e.message : 'Could not start the camera.';
			stopQrScan();
		}
	}

	async function handleQrText(text: string) {
		if (qrBusy) return;
		const cleaned = text.trim();
		// Only react to something key-shaped; a steady camera re-reads frames.
		if (!/pub/i.test(cleaned) && !cleaned.startsWith('[')) return;
		qrBusy = true;
		stopQrScan();
		await acceptReadKey(cleaned, 'qr');
		// A failed read leaves us on the QR branch — free the guard so the user can
		// re-scan. (A success has already advanced to the preview step.)
		if (deviceError) qrBusy = false;
	}

	onDestroy(stopQrScan);

	// Restore a single-sig wallet from a Cairn backup file. We only prefill the
	// xpub + name inputs — the user still walks the normal Validate → Preview →
	// Name → Backup flow, so nothing bypasses server validation.
	async function handleRestoreFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file
		if (!file) return;

		restoreError = null;
		restoreNote = null;

		let config: unknown;
		try {
			config = JSON.parse(await file.text());
		} catch {
			restoreError = "That file isn't valid JSON. Pick a Cairn wallet-config backup (.json).";
			return;
		}

		if (!config || typeof config !== 'object') {
			restoreError = "That file doesn't look like a wallet backup.";
			return;
		}
		const c = config as Record<string, unknown>;

		// A multisig / Caravan file — restore those from the multisig wizard.
		if (
			'quorum' in c ||
			'extendedPublicKeys' in c ||
			c.type === 'multisig' ||
			(typeof c.format === 'string' && c.format !== 'cairn-wallet-config')
		) {
			restoreError = 'multisig';
			return;
		}

		if (c.format === 'cairn-wallet-config' && c.type === 'single-sig' && typeof c.xpub === 'string') {
			xpubInput = c.xpub;
			previewError = null;
			deviceError = null;
			// A restored key drops the user straight onto the paste method with the
			// key filled in, ready to validate.
			method = 'paste';
			if (typeof c.name === 'string' && c.name.trim()) name = c.name.trim();
			restoreNote = `Loaded the key from your backup${
				typeof c.name === 'string' && c.name.trim() ? ` ("${c.name.trim()}")` : ''
			}. Validate it to continue.`;
			return;
		}

		restoreError = "That file isn't a Cairn single-key wallet backup.";
	}
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
			{#if page.data.flags?.multisig_create !== false}
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
			{/if}
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
			<span class="overline">Step 2 · Add your key</span>

			{#if method === null}
				<p class="step-lead">
					Where does this wallet's key live? Cairn only ever reads the
					<strong>public</strong> key — nothing that can spend.
				</p>

				<!-- Restore from a backup file (cairn-lun6): prefills the paste method below. -->
				<div class="restore-box">
					<div class="restore-lead">
						<Icon name="arrow-down-left" size={14} />
						<span>Already backed this wallet up? Restore it from the file.</span>
					</div>
					<input
						type="file"
						accept=".json,application/json"
						class="visually-hidden-file"
						bind:this={restoreFileInput}
						onchange={handleRestoreFile}
					/>
					<button
						type="button"
						class="btn btn-secondary btn-sm"
						onclick={() => restoreFileInput?.click()}
					>
						Restore from a backup file (.json)
					</button>
					{#if restoreError === 'multisig'}
						<div class="restore-msg restore-note" role="status">
							This looks like a multisig backup — <a href="/wallets/multisig/new"
								>restore it from the multisig wizard</a
							>.
						</div>
					{:else if restoreError}
						<div class="restore-msg form-error" role="alert">{restoreError}</div>
					{/if}
				</div>

				<div class="method-grid">
					{#each METHOD_CARDS as m (m.key)}
						<button type="button" class="method-card" onclick={() => pickMethod(m.key)}>
							<span class="method-title">{m.title}</span>
							<span class="method-desc">{m.desc}</span>
						</button>
					{/each}
				</div>

				<div class="pane-actions">
					<button type="button" class="btn btn-ghost" onclick={() => (step = 0)}>
						<Icon name="chevron-left" size={14} />
						Back
					</button>
					<span></span>
				</div>
			{:else}
				<div class="key-form fade-in">
					<div class="row" style="gap: 8px">
						<button type="button" class="btn btn-ghost btn-sm" onclick={backToMethods}>
							<Icon name="chevron-left" size={13} />
							Different source
						</button>
					</div>

					{#if restoreNote && method === 'paste'}
						<div class="restore-msg restore-note" role="status">
							<Icon name="check" size={13} />
							{restoreNote}
						</div>
					{/if}

					<!-- Address-type picker for direct device reads: chosen before the read
					     so the device derives the right account path. -->
					{#if method === 'trezor' || method === 'ledger' || method === 'bitbox02' || method === 'coldcard'}
						<div class="field">
							<span class="label">Address type</span>
							<div class="script-chips" role="radiogroup" aria-label="Address type">
								{#each DEVICE_SCRIPT_CHOICES as c (c.key)}
									{@const disabled = method === 'bitbox02' && !bitbox02SupportsScriptType(c.key)}
									<button
										type="button"
										class="script-chip"
										class:selected={deviceScriptType === c.key}
										role="radio"
										aria-checked={deviceScriptType === c.key}
										{disabled}
										title={disabled
											? 'The BitBox02 has no legacy (P2PKH) single-sig account.'
											: undefined}
										onclick={() => (deviceScriptType = c.key)}
									>
										{c.label}
									</button>
								{/each}
							</div>
							{#if method === 'bitbox02'}
								<span class="hint">
									The BitBox02 doesn't support legacy (Native SegWit or Nested SegWit only).
								</span>
							{:else}
								<span class="hint">Most modern wallets use Native SegWit.</span>
							{/if}
						</div>
					{/if}

					{#if method === 'trezor' || method === 'ledger'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your {method === 'trezor' ? 'Trezor' : 'Ledger'} and unlock it. Cairn
								reads the wallet's public key straight from the device — it can
								<strong>watch, never spend</strong>.
							</p>
							<button
								type="button"
								class="btn btn-primary"
								disabled={deviceBusy}
								onclick={() => connectDevice(method as 'trezor' | 'ledger')}
							>
								{#if deviceBusy}<span class="spinner"></span>{/if}
								Connect {method === 'trezor' ? 'Trezor' : 'Ledger'}
							</button>
						</div>
					{:else if method === 'bitbox02'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your BitBox02 and unlock it. Cairn reads the wallet's public key
								straight from the device — it can <strong>watch, never spend</strong>.
								<strong>Confirm on the BitBox02 when it asks.</strong>
							</p>
							<button
								type="button"
								class="btn btn-primary"
								disabled={deviceBusy}
								onclick={() => connectDevice('bitbox02')}
							>
								{#if deviceBusy}<span class="spinner"></span>{/if}
								Connect BitBox02
							</button>
						</div>
					{:else if method === 'jade'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your Jade and unlock it with your PIN. Cairn reads the wallet's
								public key straight from the device — it can
								<strong>watch, never spend</strong>. Needs Chrome, Edge or Brave.
							</p>
							<button
								type="button"
								class="btn btn-primary"
								disabled={deviceBusy}
								onclick={() => connectDevice('jade')}
							>
								{#if deviceBusy}<span class="spinner"></span>{/if}
								Connect Jade
							</button>
						</div>
					{:else if method === 'coldcard'}
						<div class="connect-box">
							<p class="connect-copy">
								On the ColdCard: <strong>Advanced/Tools → Export Wallet → Generic JSON</strong>
								(choose the single-sig / non-multisig option if asked). Move the microSD card
								to this computer, then choose the exported file.
							</p>
							<input
								type="file"
								accept=".json,.txt,application/json"
								class="visually-hidden-file"
								bind:this={coldcardInput}
								onchange={handleColdcardFile}
							/>
							<button
								type="button"
								class="btn btn-primary"
								disabled={deviceBusy}
								onclick={() => coldcardInput?.click()}
							>
								{#if deviceBusy}<span class="spinner"></span>{/if}
								Choose the exported file
							</button>
						</div>
					{:else if method === 'qr'}
						<div class="connect-box">
							<p class="connect-copy">
								On the device, find <strong>Export xpub</strong> (or "show wallet key as QR")
								and hold the code up to your camera. The key in the QR can
								<strong>watch, never spend</strong>.
							</p>
							{#if scanning}
								<!-- svelte-ignore a11y_media_has_caption — live camera feed; the sr-only status below announces it -->
								<video bind:this={videoEl} class="qr-video"></video>
								<p class="sr-only" role="status">
									Camera scanning in progress. Hold the device's QR code up to the camera —
									the key is read automatically. Use the Stop scanning button to turn the
									camera off.
								</p>
								<button type="button" class="btn btn-secondary btn-sm" onclick={stopQrScan}>
									Stop scanning
								</button>
							{:else if cameraAvailable}
								<button
									type="button"
									class="btn btn-primary"
									disabled={deviceBusy}
									onclick={startQrScan}
								>
									{#if deviceBusy}<span class="spinner"></span>{/if}
									<Icon name="qr" size={14} />
									Scan the QR code
								</button>
							{:else}
								<p class="hint">
									This browser can't scan QR codes from a camera — paste the key instead
									(choose "Paste public key").
								</p>
							{/if}
						</div>
					{:else}
						<!-- paste a public key -->
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
										readMethod = 'paste';
										deviceType = null;
										changeDevice = false;
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

							<div>
								<button class="btn btn-primary" disabled={validating || !xpubInput.trim()}>
									{#if validating}<span class="spinner"></span>{/if}
									Validate key
								</button>
							</div>
						</form>
					{/if}

					{#if deviceError}
						<div class="form-error" role="alert">{deviceError}</div>
					{/if}
				</div>
			{/if}
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
							// Move to the Done step (backup is optional for single-sig — the
							// wallet reconstructs from the hardware device).
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

				{#if readMethod && readMethod !== 'paste' && !changeDevice}
					<!-- The key came straight off a device, so we already know which one
					     will sign — confirm it rather than re-asking. -->
					<div class="field">
						<span class="label">Signing device</span>
						<div class="device-summary">
							<span class="device-summary-body">
								<Icon name="check" size={15} />
								<span>
									<strong>{deviceType ? WALLET_DEVICE_LABELS[deviceType] : 'This device'}</strong>
									— we read this key straight from it, so that's how you'll sign.
								</span>
							</span>
							<button
								type="button"
								class="device-change"
								onclick={() => (changeDevice = true)}
							>
								Change
							</button>
						</div>
					</div>
				{:else}
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
				{/if}

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
		<!-- ---------------------------------------------------------- Step 5: done -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 5 · Done</span>
			<h2 class="done-title">Your wallet is ready</h2>

			<p class="done-sub">
				Nothing to back up here — a single-key wallet can always be rebuilt from your
				hardware device. Just keep your device (and its seed backup) safe, and you can
				re-add this wallet anytime.
			</p>

			<details class="config-optional">
				<summary>Download the wallet config (optional)</summary>
				<p class="hint">
					For power users: a JSON file with this wallet's <Term
						tip="The public keys and settings needed to find your bitcoin on the blockchain. It cannot spend."
						>public keys and settings</Term
					> — handy for importing into Sparrow or Electrum. Not required.
				</p>
				<a
					class="btn btn-secondary btn-sm"
					href="/api/wallets/{createdId}/config"
					download
					onclick={() => (backedUp = true)}
				>
					<Icon name="arrow-down-left" size={15} />
					Download wallet config (JSON)
				</a>
				{#if backedUp}
					<p class="backup-done" role="status">
						<Icon name="check" size={14} /> Saved.
					</p>
				{/if}
			</details>

			<div class="pane-actions">
				<a class="btn btn-primary" href={`/wallets/${createdId}?imported=1`}>
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

	.done-sub {
		color: var(--text-secondary);
		line-height: 1.6;
		margin: 6px 0 4px;
	}

	.config-optional {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 10px 14px;
		margin: 6px 0 4px;
	}

	.config-optional summary {
		cursor: pointer;
		font-size: 13px;
		color: var(--text-secondary);
	}

	.config-optional summary:hover {
		color: var(--text);
	}

	.config-optional .btn {
		margin-top: 10px;
	}

	.backup-done {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--success);
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

	/* restore-from-backup affordance (cairn-lun6) */
	.restore-box {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		padding: 14px 16px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.restore-lead {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.restore-lead :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.restore-msg {
		font-size: 12.5px;
		line-height: 1.55;
	}

	.restore-note {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-secondary);
	}

	.restore-note :global(svg) {
		color: var(--success);
		flex-shrink: 0;
	}

	.restore-note a {
		color: var(--accent);
		text-decoration: underline;
	}

	.visually-hidden-file {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		overflow: hidden;
		pointer-events: none;
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

	/* --- step 2: method picker + per-device connect (copied verbatim from the
	   multisig wizard's Keys step so the two wizards look identical) --- */

	.step-lead {
		font-size: 13.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.step-lead strong {
		color: var(--text);
	}

	.method-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
	}

	/* Narrow screens: one full-width card per row keeps labels readable. */
	@media (max-width: 480px) {
		.method-grid {
			grid-template-columns: 1fr;
		}
	}

	.method-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		text-align: left;
		padding: 13px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.method-card:hover {
		border-color: var(--accent);
	}

	.method-title {
		font-size: 13.5px;
		font-weight: 600;
	}

	.method-desc {
		font-size: 12px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.key-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.connect-box {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: flex-start;
	}

	.connect-copy {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.connect-copy strong {
		color: var(--text);
	}

	.qr-video {
		width: 100%;
		max-width: 320px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border);
		background: #000;
	}

	/* Visually hidden but announced — same idiom as the send flow's QR signer. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* Address-type chips shown before a direct device read. */
	.script-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.script-chip {
		padding: 7px 13px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-chip);
		color: var(--text-secondary);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.script-chip:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.script-chip.selected {
		border-color: var(--accent);
		background: var(--accent-muted);
		color: var(--text);
	}

	.script-chip:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* Step 4: confirmed-device summary (shown instead of the picker for a
	   device-read key). */
	.device-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-control);
	}

	.device-summary-body {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.device-summary-body strong {
		color: var(--text);
	}

	.device-summary-body :global(svg) {
		color: var(--success);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.device-change {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.device-change:hover {
		color: var(--text);
	}
</style>
