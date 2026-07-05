<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { deserialize } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import type { VaultDeviceType, VaultKeyCategory, VaultScriptType } from '$lib/server/vaults';
	import KeyCategoryIcon from '../_components/KeyCategoryIcon.svelte';
	import { KEY_CATEGORY_LABELS, DEVICE_LABELS, VAULT_SCRIPT_LABELS } from '../labels';
	import { readKeyFromTrezor, readKeyFromLedger, DeviceReadUnavailable } from './_components/deviceRead';
	import { parseColdcardExport } from './_components/coldcardImport';

	let { data } = $props();

	type StepKey = 'why' | 'keys' | 'review' | 'confirm' | 'done';

	const STEPS: { key: StepKey; label: string }[] = [
		{ key: 'why', label: 'Protection' },
		{ key: 'keys', label: 'Add keys' },
		{ key: 'review', label: 'Review' },
		{ key: 'confirm', label: 'Confirm' },
		{ key: 'done', label: 'Done' }
	];

	let step = $state<StepKey>('why');

	// ------------------------------------------------------------ step 1: quorum
	type Preset = '2of3' | '3of5' | 'custom';
	let preset = $state<Preset>('2of3');
	let customM = $state(2);
	let customN = $state(3);
	let scriptType = $state<VaultScriptType>('p2wsh');
	let showAdvanced = $state(false);
	let showImport = $state(false);
	let importText = $state('');
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let importedNote = $state<string | null>(null);
	let importFileInput = $state<HTMLInputElement | null>(null);

	const threshold = $derived(preset === '2of3' ? 2 : preset === '3of5' ? 3 : Number(customM));
	const totalKeys = $derived(preset === '2of3' ? 3 : preset === '3of5' ? 5 : Number(customN));
	const quorumValid = $derived(
		Number.isInteger(threshold) &&
			Number.isInteger(totalKeys) &&
			threshold >= 1 &&
			totalKeys >= threshold &&
			totalKeys <= 15
	);

	// -------------------------------------------------------------- step 2: keys
	interface WizardKey {
		name: string;
		category: VaultKeyCategory;
		deviceType: VaultDeviceType;
		xpub: string;
		fingerprint: string;
		path: string;
	}

	let keys = $state<WizardKey[]>([]);

	// Five first-class ways a key arrives — none of them "advanced".
	type Method = 'trezor' | 'ledger' | 'coldcard' | 'qr' | 'paste';
	let method = $state<Method | null>(null);
	let keyName = $state('');
	let keyCategory = $state<VaultKeyCategory>('hardware');
	let keyDevice = $state<VaultDeviceType>('file');
	let pasteValue = $state('');
	let fpValue = $state('');
	let pathValue = $state('');
	let showWhereFind = $state(false);
	let adding = $state(false);
	let deviceBusy = $state(false);
	let addError = $state<string | null>(null);
	let lastAdded = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	const METHOD_CARDS: { key: Method; title: string; desc: string }[] = [
		{ key: 'trezor', title: 'Trezor', desc: 'Plug it in and connect with one click.' },
		{ key: 'ledger', title: 'Ledger', desc: 'Plug it in and connect with one click.' },
		{ key: 'coldcard', title: 'ColdCard', desc: "Import the file from its microSD card." },
		{ key: 'qr', title: 'Air-gapped QR', desc: "Scan the key's QR code off the device screen." },
		{ key: 'paste', title: 'Paste public key', desc: 'From any wallet app, or a key someone sent you.' }
	];

	function pickMethod(m: Method) {
		method = m;
		addError = null;
		if (m === 'paste') {
			keyCategory = 'hardware';
			keyDevice = 'file'; // pasted keys sign via the file-based PSBT method
			if (keyName.startsWith('My ')) keyName = '';
		} else {
			keyCategory = 'hardware';
			keyDevice = m;
			if (!keyName.trim()) {
				keyName =
					m === 'coldcard'
						? 'My ColdCard'
						: m === 'ledger'
							? 'My Ledger'
							: m === 'qr'
								? 'My air-gapped signer'
								: 'My Trezor';
			}
		}
	}

	function resetKeyForm() {
		stopQrScan();
		method = null;
		keyName = '';
		keyCategory = 'hardware';
		keyDevice = 'file';
		pasteValue = '';
		fpValue = '';
		pathValue = '';
		showWhereFind = false;
		addError = null;
	}

	// --- paste format detection (inform, never block — except private keys) ---
	const cleanPaste = $derived(pasteValue.replace(/\s+/g, ''));
	const pasteIsPrivate = $derived(/[xyztuv]prv/i.test(cleanPaste));
	const pasteHasOrigin = $derived(cleanPaste.startsWith('['));

	const pasteFormat = $derived.by<{ label: string; desc: string } | null>(() => {
		if (!cleanPaste || pasteIsPrivate) return null;
		const m = cleanPaste.match(/^(?:\[[^\]]*\])?(xpub|ypub|zpub|tpub|Ypub|Zpub)/);
		if (!m) return null;
		const prefix = m[1];
		const vaultLabel = VAULT_SCRIPT_LABELS[scriptType];
		const governs = `the vault's ${vaultLabel} setting governs the addresses either way — the prefix is just a labeling convention`;
		switch (prefix) {
			case 'xpub':
				return {
					label: 'xpub',
					desc: `a standard extended public key. Works for any address type; ${governs}.`
				};
			case 'Zpub':
				return {
					label: 'Zpub',
					desc:
						scriptType === 'p2wsh'
							? 'a key labeled for Native SegWit multisig (SLIP-132) — matches this vault.'
							: `a key labeled for Native SegWit multisig (SLIP-132); this vault uses ${vaultLabel}, which is fine — ${governs}.`
				};
			case 'Ypub':
				return {
					label: 'Ypub',
					desc:
						scriptType === 'p2sh-p2wsh'
							? 'a key labeled for Nested SegWit multisig (SLIP-132) — matches this vault.'
							: `a key labeled for Nested SegWit multisig (SLIP-132); this vault uses ${vaultLabel}, which is fine — ${governs}.`
				};
			case 'zpub':
				return {
					label: 'zpub',
					desc: `a key usually labeled for single-key Native SegWit wallets; usable here — ${governs}.`
				};
			case 'ypub':
				return {
					label: 'ypub',
					desc: `a key usually labeled for single-key Nested SegWit wallets; usable here — ${governs}.`
				};
			case 'tpub':
				return {
					label: 'tpub',
					desc: 'a TESTNET key. This vault tracks real (mainnet) bitcoin, so this key will be rejected.'
				};
			default:
				return null;
		}
	});

	// Programmatic form-action calls (the wizard adds keys one at a time, so
	// static use:enhance forms don't fit).
	async function callAction<T>(
		action: string,
		fields: Record<string, string>
	): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		try {
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body
			});
			const result = deserialize(await res.text());
			if (result.type === 'success' && result.data) return { ok: true, data: result.data as T };
			if (result.type === 'failure') {
				return {
					ok: false,
					error:
						(result.data as { error?: string } | undefined)?.error ??
						'Something went wrong — try again.'
				};
			}
			return { ok: false, error: 'Something went wrong — try again.' };
		} catch {
			return { ok: false, error: 'Network hiccup — check your connection and try again.' };
		}
	}

	async function submitKey(): Promise<boolean> {
		if (adding) return false;
		adding = true;
		addError = null;
		try {
			const res = await callAction<{ key: WizardKey }>('key', {
				name: keyName.trim() || `Key ${keys.length + 1}`,
				category: keyCategory,
				deviceType: keyDevice ?? '',
				xpub: pasteValue,
				fingerprint: fpValue,
				path: pathValue
			});
			if (!res.ok) {
				addError = res.error;
				return false;
			}
			const key = res.data.key;
			const dup = keys.find((k) => k.xpub === key.xpub);
			if (dup) {
				addError = `That's the same key as "${dup.name}" — every key must come from a different device or seed. Two copies of one key don't protect you twice.`;
				return false;
			}
			keys = [...keys, key];
			lastAdded = `${key.name} added${key.fingerprint !== '00000000' ? ` · fingerprint ${key.fingerprint}` : ''}`;
			resetKeyForm();
			return true;
		} finally {
			adding = false;
		}
	}

	async function connectDevice(kind: 'trezor' | 'ledger') {
		if (deviceBusy) return;
		deviceBusy = true;
		addError = null;
		try {
			const key = kind === 'trezor' ? await readKeyFromTrezor() : await readKeyFromLedger();
			pasteValue = key.xpub;
			fpValue = key.fingerprint;
			pathValue = key.path;
			await submitKey();
		} catch (e) {
			if (e instanceof DeviceReadUnavailable) {
				addError = `Direct ${kind === 'trezor' ? 'Trezor' : 'Ledger'} connection isn't available in this browser — paste the key instead. "Where do I find this key?" below has the steps.`;
				method = 'paste';
				keyDevice = kind;
				showWhereFind = true;
			} else {
				addError = e instanceof Error ? e.message : 'Could not read the key from the device.';
			}
		} finally {
			deviceBusy = false;
		}
	}

	async function handleColdcardFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		addError = null;
		try {
			const key = parseColdcardExport(await file.text(), scriptType);
			pasteValue = key.xpub;
			fpValue = key.fingerprint;
			pathValue = key.path;
			await submitKey();
		} catch (err) {
			addError = err instanceof Error ? err.message : 'Could not read that file.';
		} finally {
			input.value = '';
		}
	}

	// --- air-gapped QR scanning ---
	let cameraAvailable = $state(false);
	$effect(() => {
		cameraAvailable = isCameraScanAvailable();
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
		addError = null;
		scanning = true;
		await tick(); // mount the <video> first
		if (!videoEl) {
			scanning = false;
			return;
		}
		try {
			scanHandle = await startScan(videoEl, (text) => void handleQrText(text), {
				onError: (err) => {
					addError = err.message;
					stopQrScan();
				}
			});
		} catch (e) {
			addError = e instanceof Error ? e.message : 'Could not start the camera.';
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
		pasteValue = cleaned;
		const ok = await submitKey();
		if (!ok) qrBusy = false;
	}

	onDestroy(stopQrScan);

	function removeKey(i: number) {
		keys = keys.filter((_, idx) => idx !== i);
		lastAdded = null;
	}

	// --- import an existing vault (descriptor or Caravan/Unchained JSON) ---
	interface ImportedVault {
		name: string;
		scriptType: VaultScriptType | null;
		threshold: number;
		totalKeys: number;
		keys: { name: string; xpub: string; fingerprint: string; path: string }[];
	}

	async function handleImport() {
		if (importing) return;
		importing = true;
		importError = null;
		try {
			const res = await callAction<{ imported: ImportedVault }>('import', {
				source: importText
			});
			if (!res.ok) {
				importError = res.error;
				return;
			}
			const { imported } = res.data;
			preset = 'custom';
			customM = imported.threshold;
			customN = imported.totalKeys;
			if (imported.scriptType) scriptType = imported.scriptType;
			if (imported.name && !vaultName.trim()) vaultName = imported.name;
			keys = imported.keys.map((k) => ({
				category: 'hardware' as VaultKeyCategory,
				deviceType: 'file' as VaultDeviceType,
				...k
			}));
			importedNote = `Read an existing ${imported.threshold}-of-${imported.totalKeys} vault${imported.name ? ` ("${imported.name}")` : ''} — its keys are filled in on the next step.`;
			showImport = false;
			importText = '';
		} finally {
			importing = false;
		}
	}

	async function handleImportFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importText = await file.text();
		input.value = '';
		await handleImport();
	}

	// ------------------------------------------------------------ step 3: review
	let previewAddresses = $state<string[]>([]);
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);

	async function loadPreview() {
		previewLoading = true;
		previewError = null;
		previewAddresses = [];
		const res = await callAction<{ addresses: string[] }>('preview', {
			config: JSON.stringify({
				threshold,
				keys: keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
			})
		});
		previewLoading = false;
		if (res.ok) previewAddresses = res.data.addresses;
		else previewError = res.error;
	}

	// ----------------------------------------------------------- step 4: confirm
	let vaultName = $state('');
	let verified = $state(false);
	let creating = $state(false);
	let createError = $state<string | null>(null);
	let createdId = $state<number | null>(null);

	async function createVaultNow() {
		if (creating || !verified) return;
		creating = true;
		createError = null;
		try {
			const res = await callAction<{ vaultId: number }>('create', {
				name: vaultName.trim(),
				threshold: String(threshold),
				scriptType,
				keys: JSON.stringify(keys)
			});
			if (!res.ok) {
				createError = res.error;
				return;
			}
			createdId = res.data.vaultId;
			step = 'done';
		} finally {
			creating = false;
		}
	}

	// -------------------------------------------------------------- step 5: done
	function markBackupDownloaded() {
		if (createdId !== null) {
			localStorage.setItem(`cairn.vault.backup.${createdId}`, 'done');
		}
	}

	const hasColdcardKey = $derived(keys.some((k) => k.deviceType === 'coldcard'));
	const hasQrKey = $derived(keys.some((k) => k.deviceType === 'qr'));

	// -------------------------------------------------------------- navigation
	function goToReview() {
		step = 'review';
		void loadPreview();
	}

	// Every step change — button, back, or programmatic — moves focus to the
	// new step's section so screen readers announce the step and keyboard users
	// aren't stranded on a button that just unmounted. (Same pattern as the
	// send flow.)
	let pageEl = $state<HTMLElement | null>(null);
	let initialStepRendered = false; // don't steal focus on page load
	$effect(() => {
		void step; // the only dependency — rerun on every step change
		if (!initialStepRendered) {
			initialStepRendered = true;
			return;
		}
		void tick().then(() => {
			pageEl?.querySelector<HTMLElement>('.step-body')?.focus();
		});
	});

	const stepIndex = $derived(STEPS.findIndex((s) => s.key === step));
	const stepAriaLabel = $derived(
		`Step ${stepIndex + 1} of ${STEPS.length}: ${STEPS[stepIndex]?.label ?? ''}`
	);
</script>

<svelte:head>
	<title>New vault — Cairn</title>
</svelte:head>

<div class="wizard fade-in" bind:this={pageEl}>
	<a href="/vaults" class="back-link">
		<Icon name="chevron-left" size={14} />
		Vaults
	</a>
	<h1 class="page-title" style="margin-bottom: 4px">Create a vault</h1>
	<p class="hint" style="margin-bottom: 20px">
		Money that needs several of your keys to move — no single point of failure.
	</p>

	<div class="stepper-wrap card card-pad">
		<Stepper steps={STEPS} current={step} />
	</div>

	{#if step === 'why'}
		<!-- ============================================= Step 1: why a vault -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 1 · How much protection?</span>

			{#if data.hasVaults}
				<!-- Repeat users get the education collapsed out of the way. -->
				<HowItWorks id="vault-why" title="Why a vault?">
					<p>
						A single key that's lost means the funds are gone. A vault
						<strong>splits control</strong> across several keys — like a bank vault requiring
						two keys turned at the same time.
					</p>
					<p>
						<strong>Losing one key doesn't lose your funds</strong>, and a thief with one key
						gets nothing. With 2-of-3, any two keys can spend; the third is your spare.
					</p>
				</HowItWorks>
			{:else}
				<div class="why-panel">
					<p>
						<strong>A single key that's lost means funds are gone.</strong> A vault splits
						control across several keys — like a bank vault requiring two keys turned at the
						same time.
					</p>
					<p>
						<strong>Losing one key doesn't lose your funds.</strong> With a 2-of-3 vault, any
						two keys can spend, so one lost or stolen key changes nothing: a thief with one
						key gets nothing, and you still spend with the other two.
					</p>
					<p>
						Cairn only ever sees <strong>public</strong> keys — it can watch and prepare
						transactions, never spend. Your keys stay on your devices.
					</p>
				</div>
			{/if}

			{#if importedNote}
				<div class="imported-note" role="status">
					<Icon name="check" size={14} />
					{importedNote}
				</div>
			{/if}

			<div class="preset-grid">
				<button
					type="button"
					class="preset-card"
					class:selected={preset === '2of3'}
					onclick={() => (preset = '2of3')}
				>
					<span class="preset-quorum">2 of 3</span>
					<span class="preset-name">
						Standard protection
						<span class="badge badge-accent">Recommended</span>
					</span>
					<span class="preset-desc">
						Any 2 of your 3 keys can spend. Lose one key — nothing is lost. Someone steals
						one — they get nothing. The right choice for most people.
					</span>
				</button>
				<button
					type="button"
					class="preset-card"
					class:selected={preset === '3of5'}
					onclick={() => (preset = '3of5')}
				>
					<span class="preset-quorum">3 of 5</span>
					<span class="preset-name">High security</span>
					<span class="preset-desc">
						Any 3 of 5 keys spend. Two keys can fail or fall into the wrong hands before
						anything is at risk. More keys to set up and store.
					</span>
				</button>
				<button
					type="button"
					class="preset-card"
					class:selected={preset === 'custom'}
					onclick={() => (preset = 'custom')}
				>
					<span class="preset-quorum">M of N</span>
					<span class="preset-name">Custom</span>
					<span class="preset-desc">Choose your own numbers, up to 15 keys.</span>
				</button>
			</div>

			{#if preset === 'custom'}
				<div class="custom-quorum fade-in">
					<div class="custom-inputs">
						<label class="custom-field">
							<span class="label">Keys required to spend</span>
							<input class="input" type="number" min="1" max="15" bind:value={customM} />
						</label>
						<span class="custom-of">of</span>
						<label class="custom-field">
							<span class="label">Total keys</span>
							<input class="input" type="number" min="1" max="15" bind:value={customN} />
						</label>
					</div>
					{#if !quorumValid}
						<div class="form-error" role="alert">
							The required number must be between 1 and the total, and the total at most 15.
						</div>
					{:else if threshold === 1}
						<p class="quorum-note">
							Heads up: with 1-of-{totalKeys}, <strong>any single key</strong> can spend on its
							own. That's convenience — several places to spend from — not protection. Fine
							for pocket money; for savings, require at least 2.
						</p>
					{:else if threshold === totalKeys && totalKeys > 1}
						<p class="quorum-note">
							Every key is required: lose <strong>any one</strong> of the {totalKeys} and the
							money is stuck forever. Most people keep a spare — like {totalKeys - 1}-of-{totalKeys}
							— so one lost key isn't a disaster.
						</p>
					{:else}
						<p class="quorum-note">
							More required keys make theft harder but spending slower; more total keys give
							you spares. You can afford to lose {totalKeys - threshold}
							{totalKeys - threshold === 1 ? 'key' : 'keys'} and still spend.
						</p>
					{/if}
				</div>
			{/if}

			<div class="disclosure">
				<button
					type="button"
					class="disclosure-toggle"
					onclick={() => (showAdvanced = !showAdvanced)}
					aria-expanded={showAdvanced}
				>
					<Icon name="settings" size={14} />
					Advanced: address type
					<span class="chev" class:open={showAdvanced}><Icon name="chevron-down" size={14} /></span>
				</button>
				{#if showAdvanced}
					<div class="disclosure-body fade-in">
						<label class="radio-row">
							<input type="radio" name="scriptType" value="p2wsh" bind:group={scriptType} />
							<span class="radio-text">
								<span class="radio-name">
									Native SegWit (P2WSH)
									<span class="badge badge-accent">Recommended</span>
								</span>
								<span class="radio-desc">
									Lowest fees, supported by every modern wallet and device. Addresses start
									with bc1q.
								</span>
							</span>
						</label>
						<label class="radio-row">
							<input type="radio" name="scriptType" value="p2sh-p2wsh" bind:group={scriptType} />
							<span class="radio-text">
								<span class="radio-name">Nested SegWit (P2SH-P2WSH)</span>
								<span class="radio-desc">
									Only if you must match an older vault built this way. Addresses start with 3.
								</span>
							</span>
						</label>
						<label class="radio-row">
							<input type="radio" name="scriptType" value="p2sh" bind:group={scriptType} />
							<span class="radio-text">
								<span class="radio-name">Legacy (P2SH)</span>
								<span class="radio-desc">
									Highest fees; for compatibility with very old setups only.
								</span>
							</span>
						</label>
					</div>
				{/if}
			</div>

			<div class="disclosure">
				<button
					type="button"
					class="disclosure-toggle"
					onclick={() => (showImport = !showImport)}
					aria-expanded={showImport}
				>
					<Icon name="arrow-down-left" size={14} />
					Already have this vault in another app? Import it
					<span class="chev" class:open={showImport}><Icon name="chevron-down" size={14} /></span>
				</button>
				{#if showImport}
					<div class="disclosure-body fade-in">
						<p class="hint" style="margin-bottom: 8px">
							Paste the vault's <Term
								tip="A descriptor is a single line of text that describes a vault completely — the quorum and every public key. Wallets like Sparrow export it under Settings."
								>descriptor</Term
							>, or a Caravan / Unchained wallet file (JSON) — Cairn fills in the quorum and
							keys for you.
						</p>
						<textarea
							class="input mono import-input"
							rows="3"
							placeholder={'wsh(sortedmulti(2,[a1b2c3d4/48\'/0\'/0\'/2\']xpub…  or  {"name": …Caravan JSON…}'}
							spellcheck="false"
							bind:value={importText}
						></textarea>
						{#if importError}
							<div class="form-error" role="alert">{importError}</div>
						{/if}
						<div class="row" style="gap: 8px; margin-top: 8px">
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								disabled={importing || !importText.trim()}
								onclick={handleImport}
							>
								{#if importing}<span class="spinner"></span>{/if}
								Read it
							</button>
							<input
								type="file"
								accept=".json,.txt,application/json,text/plain"
								class="visually-hidden-file"
								bind:this={importFileInput}
								onchange={handleImportFile}
							/>
							<button
								type="button"
								class="btn btn-ghost btn-sm"
								disabled={importing}
								onclick={() => importFileInput?.click()}
							>
								Upload a wallet file
							</button>
						</div>
					</div>
				{/if}
			</div>

			{#if quorumValid}
				<div class="need-panel">
					<span class="need-title">What you'll need</span>
					<p class="need-copy">
						{#if threshold === 2 && totalKeys === 3}
							Three keys. Most people use two hardware wallets plus one recovery key stored
							somewhere safe. A pasted key or an air-gapped QR signer counts just the same.
						{:else}
							{totalKeys === 1 ? 'One key.' : `${totalKeys} keys.`} Hardware wallets work best
							for everyday signing; keep at least one recovery key stored somewhere safe. A
							pasted key or an air-gapped QR signer counts just the same.
						{/if}
						You'll add them one at a time on the next step.
					</p>
				</div>
			{/if}

			<div class="pane-actions">
				<a href="/vaults" class="btn btn-ghost">Cancel</a>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!quorumValid}
					onclick={() => (step = 'keys')}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'keys'}
		<!-- ================================================ Step 2: add keys -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 2 · Add your {totalKeys} keys</span>
			<p class="step-lead">
				Each <Term
					tip="A key is a device or backup that can approve spending — a hardware wallet, a phone wallet, or a seed phrase stored somewhere safe."
					>key</Term
				> should live on a different device or in a different place. Cairn only ever reads
				<strong>public</strong> keys — nothing that can spend.
			</p>

			<!-- progress slots -->
			<div class="slots" role="list" aria-label="Keys added">
				{#each Array(Math.max(totalKeys, keys.length)) as _, i (i)}
					{@const key = keys[i]}
					{#if key}
						<div class="slot filled" role="listitem">
							<span class="slot-icon"><KeyCategoryIcon category={key.category} size={16} /></span>
							<span class="slot-meta">
								<span class="slot-name truncate">{key.name}</span>
								<span class="slot-sub">
									{KEY_CATEGORY_LABELS[key.category]}{key.deviceType
										? ` · ${DEVICE_LABELS[key.deviceType]}`
										: ''}{key.fingerprint !== '00000000' ? ` · ${key.fingerprint}` : ''}
								</span>
								{#if key.fingerprint === '00000000'}
									<span class="slot-flag">
										<Icon name="info" size={11} />
										No fingerprint on record — this key will sign by downloading and
										uploading the transaction file, which works fine.
									</span>
								{/if}
							</span>
							<button
								type="button"
								class="slot-remove"
								aria-label="Remove {key.name}"
								onclick={() => removeKey(i)}
							>
								<Icon name="x" size={14} />
							</button>
						</div>
					{:else}
						<div class="slot empty" role="listitem">
							<span class="slot-num">{i + 1}</span>
							<span class="slot-empty-label">Key {i + 1}</span>
						</div>
					{/if}
				{/each}
			</div>

			{#if lastAdded}
				<div class="imported-note" role="status">
					<Icon name="check" size={14} />
					{lastAdded}
				</div>
			{/if}

			{#if keys.length > totalKeys}
				<div class="form-error" role="alert">
					You've added {keys.length} keys but the vault only holds {totalKeys} — remove
					{keys.length - totalKeys} or go back and raise the total.
				</div>
			{:else if keys.length < totalKeys}
				<!-- ------------------------------------------ add-key sub-wizard -->
				<div class="add-key">
					<span class="add-key-title">
						{keys.length === 0
							? 'Add your first key'
							: `Add key ${keys.length + 1} of ${totalKeys}`}
					</span>

					{#if method === null}
						<p class="hint">Where does this key live?</p>
						<div class="method-grid">
							{#each METHOD_CARDS as m (m.key)}
								<button type="button" class="method-card" onclick={() => pickMethod(m.key)}>
									<span class="method-title">{m.title}</span>
									<span class="method-desc">{m.desc}</span>
								</button>
							{/each}
						</div>
					{:else}
						<div class="key-form fade-in">
							<div class="row" style="gap: 8px">
								<button type="button" class="btn btn-ghost btn-sm" onclick={resetKeyForm}>
									<Icon name="chevron-left" size={13} />
									Different source
								</button>
							</div>

							<div class="field">
								<label class="label" for="key-name">
									Name this key <span class="optional">(you can change it later)</span>
								</label>
								<input
									id="key-name"
									class="input"
									placeholder={method === 'paste'
										? "e.g. Alice's cold storage key"
										: 'e.g. Trezor in the desk drawer'}
									maxlength="60"
									bind:value={keyName}
								/>
							</div>

							{#if method === 'trezor' || method === 'ledger'}
								<div class="connect-box">
									<p class="connect-copy">
										Plug in your {method === 'trezor' ? 'Trezor' : 'Ledger'} and unlock it.
										Cairn reads the vault key straight from the device — the key it reads can
										<strong>watch, never spend</strong>.
									</p>
									<button
										type="button"
										class="btn btn-primary"
										disabled={deviceBusy || adding}
										onclick={() => connectDevice(method as 'trezor' | 'ledger')}
									>
										{#if deviceBusy || adding}<span class="spinner"></span>{/if}
										Connect {method === 'trezor' ? 'Trezor' : 'Ledger'}
									</button>
								</div>
							{:else if method === 'coldcard'}
								<div class="connect-box">
									<p class="connect-copy">
										On the ColdCard: <strong>Advanced/Tools → Export Wallet → Generic JSON</strong>.
										Move the microSD card to this computer, then choose the
										<span class="mono">coldcard-export.json</span> file.
									</p>
									<input
										type="file"
										accept=".json,.txt,application/json"
										class="visually-hidden-file"
										bind:this={fileInput}
										onchange={handleColdcardFile}
									/>
									<button
										type="button"
										class="btn btn-primary"
										disabled={adding}
										onclick={() => fileInput?.click()}
									>
										{#if adding}<span class="spinner"></span>{/if}
										Choose the exported file
									</button>
								</div>
							{:else if method === 'qr'}
								<div class="connect-box">
									<p class="connect-copy">
										On the device, find <strong>Export xpub</strong> (or "show wallet key as
										QR") and hold the code up to your camera. The key in the QR can
										<strong>watch, never spend</strong>.
									</p>
									{#if scanning}
										<!-- svelte-ignore a11y_media_has_caption — live camera feed -->
										<video bind:this={videoEl} class="qr-video"></video>
										<button type="button" class="btn btn-secondary btn-sm" onclick={stopQrScan}>
											Stop scanning
										</button>
									{:else if cameraAvailable}
										<button
											type="button"
											class="btn btn-primary"
											disabled={adding}
											onclick={startQrScan}
										>
											{#if adding}<span class="spinner"></span>{/if}
											<Icon name="qr" size={14} />
											Scan the QR code
										</button>
									{:else}
										<p class="hint">
											This browser can't scan QR codes from a camera — paste the key from the
											QR instead ("Enter it as text" below).
										</p>
									{/if}
								</div>
							{:else}
								<!-- paste a public key -->
								<div class="field">
									<label class="label" for="key-xpub">
										Paste the
										<Term
											tip="An extended public key lets Cairn track this key's addresses and balances without having the private key. It's safe to share — it can't spend funds on its own."
											>extended public key</Term
										>
									</label>
									<textarea
										id="key-xpub"
										class="input mono xpub-input"
										rows="3"
										placeholder="xpub6D…, Zpub6y…, or [a1b2c3d4/48'/0'/0'/2']xpub6D…"
										spellcheck="false"
										autocomplete="off"
										bind:value={pasteValue}
									></textarea>
									{#if pasteIsPrivate}
										<div class="form-error" role="alert">
											That's a private key. Never paste it anywhere. Export the public key
											instead (look for 'xpub' in your wallet).
										</div>
									{:else if pasteFormat}
										<span class="hint detect-line">
											<Icon name="check" size={12} />
											Detected: <strong>{pasteFormat.label}</strong> — {pasteFormat.desc}
											{#if pasteHasOrigin}
												Includes fingerprint &amp; path — filled in below automatically.
											{/if}
										</span>
									{/if}
								</div>

								<div class="field">
									<span class="label">What kind of key is it?</span>
									<div class="cat-grid">
										{#each ['hardware', 'mobile', 'recovery'] as const as cat (cat)}
											<button
												type="button"
												class="cat-card"
												class:selected={keyCategory === cat}
												onclick={() => (keyCategory = cat)}
											>
												<KeyCategoryIcon category={cat} size={17} />
												<span class="cat-name">{KEY_CATEGORY_LABELS[cat]}</span>
												<span class="cat-desc">
													{cat === 'hardware'
														? 'A signing device like a Trezor, Ledger or ColdCard.'
														: cat === 'mobile'
															? 'A wallet app on your phone.'
															: "For emergencies only — you won't use this key day to day."}
												</span>
											</button>
										{/each}
									</div>
								</div>

								<div class="detail-fields">
									<label class="custom-field">
										<span class="label">
											<Term
												tip="8 characters identifying the master seed this key came from. Shown by your device and by Sparrow — it lets signing devices find the right key."
												>Fingerprint</Term
											>
											<span class="optional">(optional)</span>
										</span>
										<input
											class="input mono"
											placeholder="a1b2c3d4"
											maxlength="8"
											bind:value={fpValue}
										/>
									</label>
									<label class="custom-field grow">
										<span class="label">
											<Term
												tip="Where in the device's key tree this key lives. m/48'/0'/0'/2' is the standard for native-segwit multisig — leave blank if unsure."
												>Derivation path</Term
											>
											<span class="optional">(optional)</span>
										</span>
										<input class="input mono" placeholder="m/48'/0'/0'/2'" bind:value={pathValue} />
									</label>
								</div>
								<span class="hint">
									You'll see the vault's shared addresses to double-check at the Review step.
								</span>

								<div class="disclosure">
									<button
										type="button"
										class="disclosure-toggle"
										onclick={() => (showWhereFind = !showWhereFind)}
										aria-expanded={showWhereFind}
									>
										<Icon name="info" size={14} />
										Where do I find this key?
										<span class="chev" class:open={showWhereFind}>
											<Icon name="chevron-down" size={14} />
										</span>
									</button>
									{#if showWhereFind}
										<div class="disclosure-body fade-in where-list">
											<p>
												<strong>Trezor</strong> — connect it directly (pick Trezor on the
												previous screen), or read it with Sparrow: New Wallet → Multisig →
												Connected Hardware Wallet, then copy the xpub shown.
											</p>
											<p>
												<strong>Ledger</strong> — Ledger Live doesn't show multisig keys.
												Connect it directly here, or read it with Sparrow the same way.
											</p>
											<p>
												<strong>ColdCard</strong> — Advanced/Tools → Export Wallet → Generic
												JSON to the microSD card, then pick ColdCard on the previous screen.
											</p>
											<p>
												<strong>Sparrow / other software</strong> — look for "Export xpub" or
												"Master public key" for multisig, at the path
												<span class="mono">m/48'/0'/0'/2'</span>.
											</p>
											<p>
												<strong>Someone else's key</strong> — a cosigner can send you their
												xpub by any channel; it's safe to share. Paste it exactly as received.
											</p>
										</div>
									{/if}
								</div>

								<div>
									<button
										type="button"
										class="btn btn-primary"
										disabled={adding || !pasteValue.trim() || pasteIsPrivate}
										onclick={submitKey}
									>
										{#if adding}<span class="spinner"></span>{/if}
										<Icon name="plus" size={14} />
										Add this key
									</button>
								</div>
							{/if}

							{#if method !== 'paste'}
								<button
									type="button"
									class="manual-fallback"
									onclick={() => {
										const d = keyDevice;
										method = 'paste';
										keyDevice = d;
									}}
								>
									Enter it as text instead
								</button>
							{/if}

							{#if addError}
								<div class="form-error" role="alert">{addError}</div>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div class="all-added" role="status">
					<Icon name="check" size={15} />
					All {totalKeys} keys added — nice. Next, double-check everything.
				</div>
			{/if}

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={() => (step = 'why')}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={keys.length !== totalKeys}
					onclick={goToReview}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'review'}
		<!-- ================================================== Step 3: review -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 3 · Review</span>
			<p class="step-lead">
				<strong>{threshold} of your {totalKeys} keys</strong> will be required to spend from
				this vault.
			</p>

			<div class="review-keys">
				{#each keys as key, i (key.xpub)}
					<div class="review-key">
						<span class="slot-icon"><KeyCategoryIcon category={key.category} size={16} /></span>
						<span class="slot-meta">
							<span class="slot-name truncate">{i + 1}. {key.name}</span>
							<span class="slot-sub">
								{KEY_CATEGORY_LABELS[key.category]}{key.deviceType
									? ` · ${DEVICE_LABELS[key.deviceType]}`
									: ''}
							</span>
						</span>
						<span class="mono review-fp">
							{key.fingerprint !== '00000000' ? key.fingerprint : '—'}
						</span>
					</div>
				{/each}
			</div>

			<div class="test-address">
				<span class="test-title">
					<Icon name="eye" size={15} />
					Check these addresses before you fund the vault
				</span>
				{#if previewLoading}
					<div class="row" style="gap: 8px"><span class="spinner"></span><span class="hint">Deriving addresses…</span></div>
				{:else if previewError}
					<div class="form-error" role="alert">{previewError}</div>
					<button type="button" class="btn btn-secondary btn-sm" onclick={loadPreview}>
						<Icon name="refresh" size={13} />
						Try again
					</button>
				{:else if previewAddresses.length > 0}
					<div class="test-addr-main">
						<span class="hint">First receive address</span>
						<CopyText value={previewAddresses[0]} />
					</div>
					{#if previewAddresses.length > 1}
						<div class="test-addr-more">
							{#each previewAddresses.slice(1) as addr, i (addr)}
								<div class="test-addr-row">
									<span class="hint">#{i + 2}</span>
									<span class="mono hint truncate" title={addr}>{addr}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
				<p class="test-why">
					<strong>Why check?</strong> If another tool — Sparrow, or the display on your
					hardware device — derives these <em>exact</em> addresses from the same keys, it
					proves every key was entered correctly. Money sent to a vault built from a mistyped
					key can be lost for good, so one minute of cross-checking is the best insurance
					there is.
				</p>
			</div>

			<div class="need-panel">
				<span class="need-title">If you lose a key</span>
				<p class="need-copy">
					Your money stays safe and spendable while you still have {threshold} of {totalKeys}.
					Replace the vault promptly — create a new one with a fresh key and move the funds.
				</p>
			</div>

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={() => (step = 'keys')}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={previewAddresses.length === 0}
					onclick={() => (step = 'confirm')}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'confirm'}
		<!-- ================================================= Step 4: confirm -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 4 · Confirm</span>

			<div class="field">
				<label class="label" for="vault-name">Name your vault</label>
				<input
					id="vault-name"
					class="input"
					placeholder="e.g. Family savings"
					maxlength="60"
					bind:value={vaultName}
				/>
				<span class="hint">Just a label — you can't break anything here.</span>
			</div>

			<div class="confirm-summary">
				<div class="confirm-row">
					<span class="hint">Quorum</span>
					<span>{threshold} of {totalKeys} keys required to spend</span>
				</div>
				<div class="confirm-row">
					<span class="hint">Keys</span>
					<span>{keys.map((k) => k.name).join(' · ')}</span>
				</div>
				<div class="confirm-row">
					<span class="hint">Address type</span>
					<span>
						{scriptType === 'p2wsh'
							? 'Native SegWit (recommended)'
							: scriptType === 'p2sh-p2wsh'
								? 'Nested SegWit'
								: 'Legacy (P2SH)'}
					</span>
				</div>
			</div>

			<label class="verify-gate">
				<input type="checkbox" bind:checked={verified} />
				<span>
					I've checked that all keys are correct, and each key is
					<strong>backed up</strong> — its seed phrase written down and stored safely. Cairn
					holds no keys and cannot recover them for me.
				</span>
			</label>

			{#if createError}
				<div class="form-error" role="alert">{createError}</div>
			{/if}

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={() => (step = 'review')} disabled={creating}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!verified || creating || !vaultName.trim()}
					onclick={createVaultNow}
				>
					{#if creating}<span class="spinner"></span>{/if}
					<Icon name="shield" size={14} />
					Create vault
				</button>
			</div>
		</section>
	{:else if step === 'done'}
		<!-- ==================================================== Step 5: done -->
		<section class="step-body card card-pad pane done-pane" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="done-hero">
				<span class="done-icon"><Icon name="shield" size={24} /></span>
				<h2 class="done-title">Your vault is ready</h2>
				<p class="done-sub">
					{threshold} of {totalKeys} keys now guard anything you send to it.
				</p>
			</div>

			<div class="next-card backup-card">
				<span class="next-title">
					<Icon name="arrow-down-left" size={15} />
					First: download your backup
				</span>
				<p class="next-copy">
					Save this file somewhere safe — it's how you see and recover this vault in another
					wallet app if this one is ever unavailable. It contains only <strong>public</strong>
					keys: it can't spend, but without it (or the original keys' details) rebuilding the
					vault is much harder.
				</p>
				<div class="row" style="gap: 8px; flex-wrap: wrap">
					<a
						href="/api/vaults/{createdId}/caravan"
						class="btn btn-primary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Download backup (JSON)
					</a>
					<a
						href="/api/vaults/{createdId}/coldcard"
						class="btn btn-secondary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						ColdCard file
					</a>
					<a
						href="/api/vaults/{createdId}/descriptor?download=1"
						class="btn btn-ghost btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Descriptor (.txt)
					</a>
				</div>
			</div>

			{#if hasColdcardKey || hasQrKey}
				<div class="next-card register-card">
					<span class="next-title">
						<Icon name="alert-triangle" size={15} />
						{hasColdcardKey ? 'Register this vault on your ColdCard' : 'Register this vault on your air-gapped signer'}
					</span>
					<p class="next-copy">
						{#if hasColdcardKey}
							Your ColdCard <strong>only signs for vaults it knows</strong> — it will refuse
							this one until you teach it, once:
						{:else}
							Air-gapped signers like SeedSigner and Passport <strong>only sign for vaults
							they know</strong> — teach yours, once:
						{/if}
					</p>
					<ol class="register-steps">
						<li>Download the registration file below and copy it to the microSD card.</li>
						{#if hasColdcardKey}
							<li>On the ColdCard: <strong>Settings → Multisig Wallets → Import from SD</strong>.</li>
						{:else}
							<li>On the device, find its multisig / wallet import option and load the file.</li>
						{/if}
						<li>The device shows the {threshold}-of-{totalKeys} quorum and keys — confirm, and it's done.</li>
					</ol>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<a
							href="/api/vaults/{createdId}/coldcard"
							class="btn btn-primary btn-sm"
							download
							onclick={markBackupDownloaded}
						>
							Download registration file
						</a>
					</div>
					{#if hasColdcardKey && hasQrKey}
						<p class="hint">SeedSigner and Passport read this same file.</p>
					{:else if hasColdcardKey}
						<p class="hint">
							(SeedSigner, Passport and Keystone read this same file, if you ever add one.)
						</p>
					{/if}
				</div>
			{/if}

			<div class="next-card">
				<span class="next-title">
					<Icon name="arrow-down-left" size={15} />
					Then: fund it
				</span>
				<p class="next-copy">
					Grab a receive address from the vault page. Start with a small test amount, watch it
					arrive, and spend it once — then move real savings in.
				</p>
			</div>

			<div class="pane-actions" style="justify-content: center">
				<a href="/vaults/{createdId}?created=1" class="btn btn-primary">
					Go to your vault
					<Icon name="arrow-right" size={14} />
				</a>
			</div>
		</section>
	{/if}
</div>

<style>
	.wizard {
		max-width: 720px;
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

	.stepper-wrap {
		margin-bottom: 14px;
	}

	.pane {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.step-body:focus:not(:focus-visible) {
		outline: none;
	}

	.step-lead {
		font-size: 13.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.step-lead strong {
		color: var(--text);
	}

	.pane-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 4px;
	}

	.imported-note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 12px;
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
	}

	.optional {
		font-weight: 400;
		color: var(--text-muted);
	}

	.why-panel {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 14px 16px;
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.25);
		border-radius: var(--radius-card);
	}

	.why-panel p {
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
		margin: 0;
	}

	.why-panel strong {
		color: var(--text);
	}

	.need-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.need-title {
		font-size: 12.5px;
		font-weight: 600;
	}

	.need-copy {
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	/* --- step 1: presets --- */

	.preset-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 10px;
	}

	.preset-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		text-align: left;
		padding: 16px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: border-color 120ms var(--ease), background 120ms var(--ease);
	}

	.preset-card:hover {
		border-color: var(--accent);
	}

	.preset-card.selected {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.preset-quorum {
		font-family: var(--font-serif);
		font-size: 24px;
		font-weight: 600;
		color: var(--accent);
	}

	.preset-name {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 13.5px;
		font-weight: 600;
	}

	.preset-desc {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.55;
	}

	.custom-quorum {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.custom-inputs {
		display: flex;
		align-items: flex-end;
		gap: 12px;
	}

	.custom-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.custom-field .input {
		width: 90px;
	}

	.custom-field.grow {
		flex: 1;
	}

	.custom-field.grow .input {
		width: 100%;
	}

	.custom-of {
		padding-bottom: 9px;
		color: var(--text-muted);
		font-size: 13px;
	}

	.quorum-note {
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.quorum-note strong {
		color: var(--text);
	}

	/* --- disclosures --- */

	.disclosure {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.disclosure-toggle {
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
		text-align: left;
	}

	.disclosure-toggle:hover {
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

	.disclosure-body {
		padding: 2px 12px 12px;
	}

	.radio-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 4px;
		cursor: pointer;
	}

	.radio-row input {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.radio-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.radio-name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 500;
	}

	.radio-desc {
		font-size: 12px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.import-input {
		resize: vertical;
		word-break: break-all;
		font-size: 12.5px;
		width: 100%;
	}

	/* --- step 2: slots --- */

	.slots {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.slot {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border-subtle);
	}

	.slot.filled {
		background: var(--bg);
		border-color: var(--border);
	}

	.slot.empty {
		border-style: dashed;
		color: var(--text-muted);
	}

	.slot-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		flex-shrink: 0;
	}

	.slot-num {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: 1px dashed var(--border);
		font-size: 12px;
		flex-shrink: 0;
	}

	.slot-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.slot-name {
		font-size: 13.5px;
		font-weight: 500;
	}

	.slot-sub {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.slot-flag {
		display: inline-flex;
		align-items: flex-start;
		gap: 5px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.slot-flag :global(svg) {
		margin-top: 2px;
	}

	.slot-empty-label {
		font-size: 13px;
	}

	.slot-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: none;
		border: none;
		border-radius: var(--radius-chip);
		color: var(--text-muted);
		cursor: pointer;
	}

	.slot-remove:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	/* --- step 2: add-key --- */

	.add-key {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.add-key-title {
		font-family: var(--font-serif);
		font-size: 16.5px;
		font-weight: 600;
	}

	.method-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
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

	.visually-hidden-file {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.cat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 8px;
	}

	.cat-card {
		display: flex;
		flex-direction: column;
		gap: 5px;
		text-align: left;
		padding: 11px 12px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: var(--accent);
		font: inherit;
		cursor: pointer;
		transition: border-color 120ms var(--ease), background 120ms var(--ease);
	}

	.cat-card:hover {
		border-color: var(--accent);
	}

	.cat-card.selected {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.cat-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
	}

	.cat-desc {
		font-size: 11.5px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.xpub-input {
		resize: vertical;
		word-break: break-all;
		font-size: 13px;
	}

	.detect-line {
		display: inline-flex;
		align-items: flex-start;
		gap: 6px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.detect-line :global(svg) {
		margin-top: 2px;
		color: var(--success);
	}

	.detect-line strong {
		color: var(--text);
	}

	.where-list p {
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin: 0 0 8px;
	}

	.where-list p:last-child {
		margin-bottom: 0;
	}

	.where-list strong {
		color: var(--text);
	}

	.detail-fields {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.detail-fields .custom-field .input {
		width: 150px;
	}

	.manual-fallback {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--text-muted);
		text-decoration: underline dotted;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.manual-fallback:hover {
		color: var(--accent);
	}

	.all-added {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		font-size: 13.5px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
	}

	/* --- step 3: review --- */

	.review-keys {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.review-key {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.review-fp {
		font-size: 12px;
		color: var(--text-muted);
	}

	.test-address {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.3);
		border-radius: var(--radius-control);
	}

	.test-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--accent);
	}

	.test-addr-main {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 13.5px;
		word-break: break-all;
	}

	.test-addr-more {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.test-addr-row {
		display: flex;
		gap: 10px;
		align-items: baseline;
		min-width: 0;
	}

	.test-why {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.test-why strong {
		color: var(--text);
	}

	/* --- step 4: confirm --- */

	.confirm-summary {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.confirm-row {
		display: flex;
		gap: 14px;
		font-size: 13px;
	}

	.confirm-row .hint {
		width: 110px;
		flex-shrink: 0;
	}

	.verify-gate {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 13px 14px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.verify-gate input {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.verify-gate strong {
		color: var(--text);
	}

	/* --- step 5: done --- */

	.done-pane {
		gap: 14px;
	}

	.done-hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		text-align: center;
		padding: 10px 0 4px;
	}

	.done-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--success-muted);
		color: var(--success);
	}

	.done-title {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 600;
	}

	.done-sub {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.next-card {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 15px 16px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.backup-card {
		border-color: rgba(232, 147, 90, 0.4);
		background: var(--accent-muted);
	}

	.register-card {
		border-color: rgba(232, 147, 90, 0.5);
	}

	.register-card .next-title {
		color: var(--accent);
	}

	.register-steps {
		margin: 0;
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.register-steps strong {
		color: var(--text);
	}

	.next-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		font-weight: 600;
	}

	.next-copy {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.next-copy strong {
		color: var(--text);
	}
</style>
