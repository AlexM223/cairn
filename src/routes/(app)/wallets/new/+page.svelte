<script lang="ts">
	import { enhance, applyAction, deserialize } from '$app/forms';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onDestroy, onMount, tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import DevicePicker from '$lib/components/DevicePicker.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import Term from '$lib/components/Term.svelte';
	import type { ScriptType, WalletDeviceType } from '$lib/types';
	import { SCRIPT_TYPE_LABELS, WALLET_DEVICE_LABELS } from '../labels';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import { bitbox02SupportsScriptType } from '$lib/hw/bitbox02';
	import { referralDeviceId, type ReferralBuyUrls } from '$lib/referrals';
	import {
		readKeyFromTrezor,
		readKeyFromLedger,
		readKeyFromBitbox02,
		readKeyFromJade,
		readSharedKeyFromTrezor,
		readSharedKeyFromLedger,
		supportsSharedKeyRead,
		DeviceReadUnavailable,
		type DeviceKey
	} from './_components/deviceRead';
	import { parseColdcardSingleSigExport } from './_components/coldcardImport';
	import {
		WIZARD_PROGRESS_KEY,
		parseSavedProgress,
		hasMeaningfulProgress
	} from './_components/wizardProgress';

	// Name and signing-device are deliberately SEPARATE steps (cairn-0py6): the
	// full device picker next to the name field read as "did I need to upload my
	// key again?" to first-time users.
	const STEPS = ['Type', 'Key', 'Preview', 'Name', 'Device', 'Done'];

	// Step 1 asks the single question that splits the two flavors. "Single key"
	// stays in this wizard; "Multiple keys" hands off to the multisig builder.
	let walletType = $state<'single' | 'multisig'>('single');

	// Arriving via the wallets empty-state "Restore from a backup" link (?restore=1)
	// drops the user straight onto the Key step, whose restore-box is the first
	// thing shown — otherwise the two entry links were indistinguishable, both
	// landing on the type picker (cairn-rfuc).
	let step = $state(page.url.searchParams.get('restore') !== null ? 1 : 0);
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
	// The key's origin — master fingerprint + account derivation path. This is
	// what lets Cairn put bip32Derivation into PSBTs, which every hardware
	// signer needs to find its key (cairn-alw8). Captured from the device
	// response on a direct read, from the ColdCard export file, or parsed out
	// of a pasted `[fingerprint/path]xpub` descriptor. null = unknown; the
	// wallet then signs only via the generic file/PSBT passthrough.
	let keyFingerprint = $state<string | null>(null);
	let keyPath = $state<string | null>(null);
	// Optional field on the paste form for wallets that export a bare key plus
	// a separate "master fingerprint" (XFP) label.
	let fingerprintInput = $state('');
	let name = $state('');
	// Which device holds this key. null = the user skipped it; the wallet then
	// signs via the universal file/PSBT fallback. Saved on the wallet record.
	let deviceType = $state<WalletDeviceType | null>(null);
	// After creation: the new wallet id, and whether its config backup was
	// downloaded (required before the wizard can finish — cairn-dcp).
	let createdId = $state<number | null>(null);
	let backedUp = $state(false);

	// A bare extended key, or one in key-origin/descriptor form —
	// `[73c5da0a/84'/0'/0']zpub…`, optionally wpkh(…)-wrapped with a trailing
	// derivation suffix. The server parses the origin out at validation time.
	const looksLikeKey = $derived(
		/^(?:[a-z]+\()?(?:\[[0-9a-fA-F]{8}[^\]]*\]\s*)?[xyz]pub[1-9A-HJ-NP-Za-km-z]{20,}/.test(
			xpubInput.trim()
		)
	);

	// ------------------------------------------- progress survives page reloads
	//
	// Everything above is ephemeral component state, so a full-page reload used
	// to restart the wizard from scratch — on Umbrel, app_proxy's auth layer can
	// force exactly such a reload mid-wizard, which read as "I confirmed the
	// addresses and it looped back to choosing a method". A sessionStorage
	// snapshot (tab-scoped, public-key data only) lets a remounted wizard resume
	// at the step the user actually reached. Captured at init, applied after
	// hydration (onMount) so the server-rendered markup is never contradicted.
	const savedProgress = browser
		? parseSavedProgress(safeReadProgress(), Date.now())
		: null;
	// True after a resume: shows the "picked up where you left off" note.
	let resumed = $state(false);

	function safeReadProgress(): string | null {
		try {
			return sessionStorage.getItem(WIZARD_PROGRESS_KEY);
		} catch {
			return null; // storage blocked (private mode etc.) — just start fresh
		}
	}

	onMount(() => {
		if (!savedProgress || !hasMeaningfulProgress(savedProgress)) return;
		step = savedProgress.step;
		method = savedProgress.method;
		readMethod = savedProgress.readMethod;
		deviceType = savedProgress.deviceType;
		xpubInput = savedProgress.xpubInput;
		validatedXpub = savedProgress.validatedXpub;
		preview = savedProgress.preview;
		scriptType = savedProgress.scriptType;
		keyFingerprint = savedProgress.keyFingerprint;
		keyPath = savedProgress.keyPath;
		if (savedProgress.name) name = savedProgress.name;
		resumed = true;
	});

	// Persist on every change; once the wallet exists (Done step) the snapshot
	// is cleared so a later visit starts a fresh wizard, not a stale resume.
	$effect(() => {
		const snapshot = JSON.stringify({
			step,
			method,
			readMethod,
			deviceType,
			xpubInput,
			validatedXpub,
			preview: $state.snapshot(preview),
			scriptType,
			name,
			keyFingerprint,
			keyPath,
			savedAt: Date.now()
		});
		try {
			if (step >= 5) sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
			else sessionStorage.setItem(WIZARD_PROGRESS_KEY, snapshot);
		} catch {
			// Best-effort: without storage the wizard still works, it just
			// can't survive a reload.
		}
	});

	/** The escape hatch on the resume note: forget the snapshot, start clean. */
	function startOver() {
		stopQrScan();
		resumed = false;
		step = 0;
		walletType = 'single';
		method = null;
		readMethod = null;
		deviceType = null;
		changeDevice = false;
		xpubInput = '';
		validatedXpub = '';
		preview = [];
		scriptType = null;
		keyFingerprint = null;
		keyPath = null;
		fingerprintInput = '';
		name = '';
		previewError = null;
		deviceError = null;
		createError = null;
		restoreNote = null;
		restoreError = null;
		planShared = false;
		sharedKeyNotice = null;
		try {
			sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
		} catch {
			// Already reset in memory; a stale snapshot will age out.
		}
	}

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

	// Referral buy links (cairn-dwib): present on page data only when the
	// referral_links flag is on — absent means render NO referral UI. Official
	// URLs are resolved server-side (admin override or official store).
	const buyUrls = $derived<ReferralBuyUrls | null>(page.data.referralBuyUrls ?? null);

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

	// Opt-in BIP-45 sharing-key prefetch (cairn-fdlf.1). Default OFF. When
	// checked, a successful device read is followed by a SECOND read of the
	// same connected device at m/45' (Trezor/Ledger only — Bastion's gating),
	// and that key is stashed in the known-device-keys registry so a later
	// shared-wallet setup can skip the device touch. Strictly fail-soft: the
	// single-sig wallet's own creation never depends on any of it.
	let planShared = $state(false);
	// Outcome of the prefetch, shown as a soft note on the Preview step —
	// success, an honest "skipped on this device", or a non-fatal failure.
	let sharedKeyNotice = $state<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);

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
	// device instead of re-asking. When the reader also handed us the key's
	// origin (device reads and ColdCard exports always do), it rides along and
	// takes precedence over anything parsed out of the key string — the device
	// is the authoritative source (cairn-alw8).
	async function acceptReadKey(
		xpub: string,
		from: Method,
		origin?: { fingerprint: string; path: string }
	) {
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
					fingerprint: string | null;
					path: string | null;
				};
				preview = d.preview;
				scriptType = d.scriptType;
				validatedXpub = d.xpub;
				xpubInput = d.xpub;
				// "00000000" is the placeholder some exports use for "unknown" —
				// treat it as absent rather than storing a fake origin.
				const readFp =
					origin && /^[0-9a-fA-F]{8}$/.test(origin.fingerprint) && !/^0{8}$/.test(origin.fingerprint)
						? origin.fingerprint.toLowerCase()
						: null;
				keyFingerprint = readFp ?? d.fingerprint ?? null;
				// The path is useful on its own (config/descriptor export) even
				// when the fingerprint is a placeholder, so it isn't tied to readFp.
				keyPath = origin?.path ?? d.path ?? null;
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
		sharedKeyNotice = null;
		try {
			const key =
				kind === 'trezor'
					? await readKeyFromTrezor(deviceScriptType)
					: kind === 'ledger'
						? await readKeyFromLedger(deviceScriptType)
						: kind === 'bitbox02'
							? await readKeyFromBitbox02(deviceScriptType)
							: await readKeyFromJade(deviceScriptType);

			// Opt-in sharing-key prefetch (cairn-fdlf.1): a second read of the SAME
			// still-connected device at m/45', made while the user's hands are
			// already on it. Strictly fail-soft — whatever happens here, the
			// single-sig import below proceeds untouched.
			let sharedKey: DeviceKey | null = null;
			let sharedSkip: string | null = null;
			if (planShared) {
				if (supportsSharedKeyRead(kind)) {
					try {
						sharedKey =
							kind === 'trezor' ? await readSharedKeyFromTrezor() : await readSharedKeyFromLedger();
					} catch (e) {
						sharedSkip =
							e instanceof Error ? e.message : 'The device declined the extra sharing-key read.';
					}
				} else {
					sharedSkip = `the ${WALLET_DEVICE_LABELS[kind]} doesn't support the extra sharing-key read yet. When you set up a shared wallet, just connect this device again.`;
				}
			}

			// The device response includes the key's origin — keep it, or every
			// PSBT this wallet builds is unsignable on the device (cairn-alw8).
			await acceptReadKey(key.xpub, kind, { fingerprint: key.fingerprint, path: key.path });

			// Only stash the sharing key once the primary key validated (the wizard
			// advanced past this step); the registry write is best-effort too.
			if (!deviceError && sharedKey) {
				const saved = await persistSharedKey(sharedKey, key, kind);
				sharedKeyNotice = saved
					? {
							tone: 'success',
							text: "Sharing key saved. When you set up a shared (multisig) wallet with this device, you won't need to plug it in again."
						}
					: {
							tone: 'error',
							text: "Your wallet key was read fine, but the extra sharing key couldn't be saved — you can read it again when you set up a shared wallet."
						};
			} else if (!deviceError && sharedSkip) {
				sharedKeyNotice = {
					tone: 'info',
					text: `Your wallet key was read fine, but the extra sharing key was skipped: ${sharedSkip}`
				};
			}
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

	/**
	 * Write the prefetched m/45' key (plus the primary key from the same read,
	 * best-effort) into the known-device-keys registry (cairn-fdlf.2). Returns
	 * whether the save succeeded — the caller turns that into a soft notice,
	 * never a blocker.
	 */
	async function persistSharedKey(shared: DeviceKey, primary: DeviceKey, kind: Method): Promise<boolean> {
		const body = new FormData();
		body.set('sharedXpub', shared.xpub);
		body.set('sharedFingerprint', shared.fingerprint);
		body.set('sharedPath', shared.path);
		body.set('primaryXpub', primary.xpub);
		body.set('primaryFingerprint', primary.fingerprint);
		body.set('primaryPath', primary.path);
		body.set('deviceType', METHOD_DEVICE[kind] ?? '');
		try {
			const res = await fetch('?/rememberSharedKey', {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body
			});
			const result = deserialize(await res.text());
			return (
				result.type === 'success' &&
				(result.data as { remembered?: boolean } | undefined)?.remembered === true
			);
		} catch {
			return false;
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
			await acceptReadKey(key.xpub, 'coldcard', {
				fingerprint: key.fingerprint,
				path: key.path
			});
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
			// Re-attach the key origin the backup recorded: with both pieces,
			// prefill the full `[fingerprint/path]xpub` form so the origin
			// round-trips through validation exactly like a pasted descriptor;
			// with only a fingerprint, prefill the optional field (cairn-alw8).
			const backupFp =
				typeof c.masterFingerprint === 'string' &&
				/^[0-9a-fA-F]{8}$/.test(c.masterFingerprint) &&
				!/^0{8}$/.test(c.masterFingerprint)
					? c.masterFingerprint.toLowerCase()
					: null;
			const backupPath =
				typeof c.derivationPath === 'string' && /^m(\/\d+['hH]?)+$/.test(c.derivationPath.trim())
					? c.derivationPath.trim()
					: null;
			if (backupFp && backupPath) {
				xpubInput = `[${backupFp}/${backupPath.replace(/^m\//, '')}]${c.xpub}`;
			} else {
				xpubInput = c.xpub;
				fingerprintInput = backupFp ?? '';
			}
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
	<h1 class="page-title" style="margin-bottom: 4px">Add a wallet</h1>
	<p class="hint" style="margin-bottom: 24px">
		A short guided setup — Cairn only ever sees public keys.
	</p>

	{#if resumed}
		<!-- A reload (or coming back to the tab) landed mid-wizard and we restored
		     the saved progress — say so, with a way out to a clean start. -->
		<div class="resume-note" role="status">
			<Icon name="info" size={14} />
			<span class="grow">Picked up where you left off.</span>
			<button type="button" class="resume-reset" onclick={startOver}>Start over</button>
		</div>
	{/if}

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
			{:else}
				<!-- Show the option greyed-out with the reason, so a user knows multisig
				     exists but is turned off, not simply absent (cairn-8dup). -->
				<div class="type-card type-card-off" aria-disabled="true">
					<span class="type-icon"><Icon name="shield" size={20} /></span>
					<span class="type-body">
						<span class="type-name">Multiple keys (multisig)</span>
						<FeatureDisabled message="Creating multisig wallets has been disabled by your administrator." />
					</span>
				</div>
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
						{@const buyDevice = referralDeviceId(m.key)}
						{@const buyUrl = buyDevice && buyUrls ? buyUrls[buyDevice] : null}
						<div class="method-cell">
							<!-- Explicit aria-label so each card announces its key source by name
							     ("Trezor", "Paste public key", …) instead of a generic "button"
							     to screen readers (cairn-oqri). -->
							<button
								type="button"
								class="method-card"
								aria-label={m.title}
								onclick={() => pickMethod(m.key)}
							>
								<span class="method-title">{m.title}</span>
								<span class="method-desc">{m.desc}</span>
							</button>
							{#if buyUrl}
								<!-- Referral link (flag-gated by URL presence) — outside the
								     button so it stays a real link, not a nested control. -->
								<a
									class="buy-link"
									href={buyUrl}
									target="_blank"
									rel="noopener"
									aria-label="Buy a {m.title}"
								>
									Buy one →
								</a>
							{/if}
						</div>
					{/each}
				</div>

				{#if buyUrls}
					<p class="hint no-device-hint">
						No hardware wallet yet? You can start with <strong>Paste public key</strong> from any
						wallet app today — and when you're ready for a dedicated signing device, the
						<em>Buy one</em> links above go straight to each maker's store.
					</p>
				{/if}

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

					<!-- Opt-in sharing-key prefetch (cairn-fdlf.1): asked upfront, in the
					     same device-connect step, so the extra m/45' read happens while
					     the device is already plugged in and unlocked. Default off. -->
					{#if method === 'trezor' || method === 'ledger' || method === 'bitbox02' || method === 'jade'}
						<label class="share-opt-in">
							<input type="checkbox" bind:checked={planShared} />
							<span>
								I plan to use this key in a <strong>shared (multisig) wallet</strong> later.
								{#if supportsSharedKeyRead(method)}
									Cairn will also read its sharing key now, so you won't need to plug this
									device in again when you set that up.
								{:else}
									<span class="share-opt-in-caveat">
										(The extra sharing-key read isn't supported on the
										{WALLET_DEVICE_LABELS[method]} yet — Cairn will skip it and let you know.)
									</span>
								{/if}
							</span>
						</label>
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
											fingerprint: string | null;
											path: string | null;
										};
										preview = d.preview;
										scriptType = d.scriptType;
										validatedXpub = d.xpub;
										// Origin parsed out of the pasted key (descriptor form)
										// or the optional fingerprint field (cairn-alw8).
										keyFingerprint = d.fingerprint ?? null;
										keyPath = d.path ?? null;
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
									placeholder="zpub6rFR7y4Q2Aij… or [73c5da0a/84'/0'/0']zpub6rFR7y4Q2Aij…"
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
								{:else}
									<span class="hint">
										If your wallet shows the key with a prefix in square brackets — like
										[73c5da0a/84'/0'/0'] — paste the whole thing. That prefix tells your
										signing device which key to use.
									</span>
								{/if}
							</div>

							{#if !/^\s*(?:[a-z]+\()?\[/.test(xpubInput)}
								<!-- Only for bare keys: a key pasted in [fingerprint/path]xpub form
								     already carries its origin, so don't ask twice (cairn-alw8). -->
								<div class="field">
									<label class="label" for="fingerprint">
										Master fingerprint
										<span class="optional">(optional)</span>
									</label>
									<input
										class="input mono fp-input"
										id="fingerprint"
										name="fingerprint"
										placeholder="e.g. 73c5da0a"
										maxlength="8"
										spellcheck="false"
										autocomplete="off"
										bind:value={fingerprintInput}
									/>
									<span class="hint">
										8 characters, shown in your wallet as "master fingerprint" or "XFP".
										Needed to <Term
											tip="Cairn stamps this ID into every transaction it prepares, so your signing device can recognize which of its keys to sign with."
											>sign with a hardware wallet</Term
										> — without it you'll sign by passing files through another wallet app.
									</span>
								</div>
							{/if}

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
				{#if keyFingerprint}
					<!-- The captured key origin, so a hardware-wallet user can check it
					     against the fingerprint their device shows (cairn-alw8). -->
					<span class="badge mono" title="Master fingerprint{keyPath ? ` · ${keyPath}` : ''}">
						{keyFingerprint}
					</span>
				{/if}
			</div>
			{#if sharedKeyNotice}
				<!-- Outcome of the opt-in sharing-key prefetch (cairn-fdlf.1). Always
				     soft: the wallet import itself already succeeded. -->
				<div
					class="shared-note"
					class:shared-note-success={sharedKeyNotice.tone === 'success'}
					class:shared-note-error={sharedKeyNotice.tone === 'error'}
					role="status"
				>
					<Icon name={sharedKeyNotice.tone === 'success' ? 'check' : 'info'} size={14} />
					<span>{sharedKeyNotice.text}</span>
				</div>
			{/if}
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
		<!-- Name ONLY (cairn-0py6): the device question lives on its own next
		     step, so this screen can never read as "re-add your key". Advancing
		     is pure client state — nothing is submitted from here. -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 4 · Name</span>
			<div class="field">
				<label class="label" for="name">What should we call it?</label>
				<input
					class="input"
					id="name"
					placeholder="e.g. Cold storage"
					maxlength="64"
					bind:value={name}
				/>
				<span class="hint">Just a label — you can't break anything here.</span>
			</div>

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={() => (step = 2)}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button type="button" class="btn btn-primary" onclick={() => (step = 4)}>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</div>
	{:else if step === 4}
		<!-- --------------------------------------- Step 5: signing device -->
		<!-- The actual ?/create submit happens here, at the end of the wizard's
		     questions. For a device-read key this is just a one-line
		     confirmation; the full picker only appears for pasted keys (or
		     after "Change"). -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 5 · Signing device</span>
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
							step = 5;
						} else {
							await applyAction(result);
						}
					};
				}}
			>
				<input type="hidden" name="xpub" value={validatedXpub} />
				<input type="hidden" name="name" value={name} />
				<input type="hidden" name="deviceType" value={deviceType ?? ''} />
				<!-- Key origin captured on the Key step — stored on the wallet so its
				     PSBTs carry bip32Derivation for hardware signing (cairn-alw8). -->
				<input type="hidden" name="fingerprint" value={keyFingerprint ?? ''} />
				<input type="hidden" name="derivationPath" value={keyPath ?? ''} />

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
					<button type="button" class="btn btn-ghost" onclick={() => (step = 3)}>
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
	{:else if step === 5 && createdId !== null}
		<!-- ---------------------------------------------------------- Step 6: done -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 6 · Done</span>
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

	/* --- resume note (shown after a mid-wizard reload restored progress) --- */

	.resume-note {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
		padding: 8px 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.resume-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.resume-note .grow {
		flex: 1;
	}

	.resume-reset {
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

	.resume-reset:hover {
		color: var(--text);
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

	.type-card-off {
		cursor: not-allowed;
		opacity: 0.6;
		border-style: dashed;
	}

	.type-card-off:hover {
		border-color: var(--border);
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

	/* 8 hex chars — the field doesn't need to be pastebin-wide. */
	.fp-input {
		max-width: 180px;
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

	/* Each grid cell holds the method card plus an optional buy link below it,
	   so the referral link never nests inside the card's <button>. */
	.method-cell {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.method-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
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

	/* Unobtrusive referral link: hint-sized, tucked under its device card. */
	.buy-link {
		align-self: flex-start;
		font-size: 11.5px;
		color: var(--text-muted);
		padding: 1px 2px;
	}

	.buy-link:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.no-device-hint {
		line-height: 1.6;
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

	/* Opt-in sharing-key prefetch checkbox (cairn-fdlf.1). */
	.share-opt-in {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 10px 12px;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.share-opt-in input {
		margin-top: 2px;
		flex-shrink: 0;
		accent-color: var(--accent);
	}

	.share-opt-in strong {
		color: var(--text);
	}

	.share-opt-in-caveat {
		color: var(--text-muted);
	}

	/* Preview-step outcome of the sharing-key prefetch — always a soft note. */
	.shared-note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 9px 12px;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.shared-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--accent);
	}

	.shared-note-success :global(svg) {
		color: var(--success);
	}

	.shared-note-error :global(svg) {
		color: var(--warning, var(--accent));
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
