<script lang="ts">
	import { enhance, applyAction, deserialize } from '$app/forms';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onDestroy, onMount, tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import DevicePicker from '$lib/components/DevicePicker.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import Term from '$lib/components/Term.svelte';
	import type { ScriptType, WalletDeviceType } from '$lib/types';
	import { SCRIPT_TYPE_LABELS, WALLET_DEVICE_LABELS } from '../labels';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import { bitbox02SupportsScriptType } from '$lib/hw/bitbox02';
	import { scrollToTop } from '$lib/scrollToTop';
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
	import { detectMultisigConfig } from './_components/multisigDetect';
	import {
		WIZARD_PROGRESS_KEY,
		parseSavedProgress,
		hasMeaningfulProgress
	} from './_components/wizardProgress';
	import { safeAction } from '$lib/safeAction';

	// Three steps (cairn-l2pn): pasting a key you already have shouldn't take
	// six screens. Key = pick a source and read/paste the key; Verify = check
	// the derived addresses; Finish = name it and import. The old standalone
	// Type step is a hand-off link on the Key step (multisig goes to its own
	// wizard), and the old Device step is gone — a device-read key confirms
	// its device inline on Finish, a pasted key picks a signer at send time.
	// The name/device separation lesson from cairn-0py6 still holds: the full
	// device picker never sits next to the name field uninvited.
	const STEPS = ['Key', 'Verify', 'Finish'];

	// Both entry links ("Add a wallet" and "Restore from a backup", ?restore=1)
	// land on the Key step, where the restore box is immediately visible —
	// cairn-rfuc's indistinguishable-entries complaint is solved structurally.
	let step = $state(0);
	let xpubInput = $state('');
	let showHelp = $state(false);
	let validating = $state(false);
	// Restore-from-backup (cairn-lun6): the hidden file input on the Key step, plus
	// the feedback shown under it after a file is read.
	let restoreFileInput = $state<HTMLInputElement | null>(null);
	let restoreError = $state<string | null>(null);
	let restoreNote = $state<string | null>(null);
	// Detected-multisig hand-off (multisig-import UX): set when an uploaded
	// file looks like a multisig config, whichever surface it was read from
	// (the Key-step restore box, or a device's file import e.g. ColdCard).
	const PENDING_MULTISIG_IMPORT_KEY = 'cairn.pending-multisig-import.v1';
	let multisigDetected = $state<{ text: string; m?: number; n?: number } | null>(null);
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
	// Every dot checks off once the wallet exists — the Finish pane swaps to
	// the Done view in place rather than adding a step for it.
	const indicatorStep = $derived(createdId !== null ? STEPS.length : step);

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
		if (savedProgress && hasMeaningfulProgress(savedProgress)) {
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
		}
	});

	// Persist on every change; once the wallet exists (Done view) the snapshot
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
			if (createdId !== null) sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
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

	// ---------------------------------------------------- browser back-button (cairn-aiyw)
	//
	// Steps live in the `step` state, not the URL (it stays /wallets/new throughout).
	// Step transitions are plain state updates with no history writes at all, so the
	// browser's history stack is never touched by the wizard — Back always leaves the
	// wizard for whatever page preceded it, instead of walking back through steps.

	/** Advance to a later step. */
	function advanceStep(next: number) {
		step = next;
	}

	/** In-app Back button: retreat one step in place (not a history operation). */
	function stepBack() {
		step = Math.max(0, step - 1);
	}

	// Every step change — forward, back, or a "Start over" reset — scrolls back
	// to the top (#26): advancing from a long step (e.g. a device's Verify
	// addresses list) otherwise leaves the new step's top scrolled out of view,
	// especially on mobile. Watching `step` in one effect covers every path
	// that changes it, not just advanceStep/stepBack.
	let initialStepRendered = false; // don't steal scroll position on page load / resume
	$effect(() => {
		void step; // the only dependency — rerun on every step change
		if (!initialStepRendered) {
			initialStepRendered = true;
			return;
		}
		scrollToTop();
	});

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
		const res = await safeAction<{
			preview: { address: string; path: string }[];
			scriptType: ScriptType;
			xpub: string;
			fingerprint: string | null;
			path: string | null;
		}>({ deserialize, applyAction }, 'preview', body, 'That key could not be read.');
		if (!res.ok) {
			deviceError = res.error;
			return;
		}
		const d = res.data;
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
		advanceStep(1);
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
		multisigDetected = null;
		deviceBusy = true;
		const text = await file.text();
		try {
			const key = parseColdcardSingleSigExport(text, deviceScriptType);
			await acceptReadKey(key.xpub, 'coldcard', {
				fingerprint: key.fingerprint,
				path: key.path
			});
		} catch (err) {
			const det = detectMultisigConfig(text);
			if (det.isMultisig) {
				multisigDetected = { text, m: det.m, n: det.n };
				deviceError = null;
			} else {
				deviceError = err instanceof Error ? err.message : 'Could not read that file.';
			}
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

	// Hand a detected-multisig file off to the multisig wizard: stash the raw
	// text in sessionStorage (survives the navigation, not a reload-resume
	// snapshot) and jump straight there — the wizard picks it up in onMount.
	function handoffToMultisig(text: string) {
		try {
			sessionStorage.setItem(PENDING_MULTISIG_IMPORT_KEY, text);
		} catch {
			// sessionStorage unavailable (private browsing, etc.) — the wizard's
			// own import UI still works, just not the auto hand-off.
		}
		goto('/wallets/multisig/new', { replaceState: true });
	}

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
		multisigDetected = null;

		const raw = await file.text();

		// A multisig / Caravan / descriptor / policy-text file — hand those off
		// to the multisig wizard, which fills in the keys (multisig-import UX).
		const det = detectMultisigConfig(raw);
		if (det.isMultisig) {
			multisigDetected = { text: raw, m: det.m, n: det.n };
			restoreError = null;
			return;
		}

		let config: unknown;
		try {
			config = JSON.parse(raw);
		} catch {
			restoreError = "That file isn't valid JSON. Pick a Heartwood wallet-config backup (.json).";
			return;
		}

		if (!config || typeof config !== 'object') {
			restoreError = "That file doesn't look like a wallet backup.";
			return;
		}
		const c = config as Record<string, unknown>;

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

		restoreError = "That file isn't a Heartwood single-key wallet backup.";
	}
</script>

<svelte:head>
	<title>Import a wallet — Heartwood</title>
</svelte:head>

<div class="wizard hw-page fade-in">
	<GroveField volume="present" />
	<div class="wizard-content">
		<div class="wizard-eyebrow">
			<EyebrowBreadcrumb
				path={['Wallets']}
				current={createdId !== null ? 'New wallet · done' : `New wallet · ${STEPS[step]}`}
			/>
		</div>
		<h1 class="wizard-title">Add a wallet</h1>
		<p class="wizard-sub">
			A short guided setup — Heartwood only ever sees public keys.
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

		<!-- Step indicator — the Send flow's quiet text-step grammar (5a/4a). -->
		<ol class="steps" aria-label="Import progress">
			{#each STEPS as label, i (label)}
				<li class="step-item" class:active={i === indicatorStep} class:done={i < indicatorStep}>
					<span class="step-word">{label}</span>
					{#if i < STEPS.length - 1}<span class="step-line" aria-hidden="true"></span>{/if}
				</li>
			{/each}
		</ol>

	{#if step === 0}
		<!-- ------------------------------------------------- Step 1: key -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 1 · Add your key</span>

			{#if method === null}
				<p class="step-lead">
					Where does this wallet's key live? Heartwood only ever reads the
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
					{#if multisigDetected}
						{@const detected = multisigDetected}
						<div class="restore-msg multisig-detected" role="status">
							{#if page.data.flags?.multisig_create !== false}
								<p class="md-title">
									This looks like a multisig wallet{detected.m && detected.n
										? ` (${detected.m}-of-${detected.n})`
										: ''}.
								</p>
								<p class="md-body">
									Multisig wallets are guarded by several keys and set up in their own guided
									flow. Heartwood will carry this file over and fill in the keys for you.
								</p>
								<div class="row" style="gap: 8px">
									<button
										type="button"
										class="btn btn-primary btn-sm"
										onclick={() => handoffToMultisig(detected.text)}
									>
										Set up multisig wallet
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => (multisigDetected = null)}
									>
										This is a single-key wallet
									</button>
								</div>
							{:else}
								<p class="md-title">This looks like a multisig wallet.</p>
								<FeatureDisabled
									message="Creating multisig wallets has been disabled by your administrator."
								/>
							{/if}
						</div>
					{:else if restoreError}
						<Banner variant="error">{restoreError}</Banner>
					{/if}
				</div>

				<!-- Multisig hand-off — elevated to a first-class card at the TOP of the
				     method area (MULTISIG-UX-DESIGN 1c), same visual weight as a method
				     card but full-width and shield-marked. The wallets-page card/chooser
				     now carries primary discoverability, so this is the safety net for
				     anyone who lands on single-sig-new first — it needs to be SEEN (top,
				     not bottom), but doesn't need to dominate the single-sig flow.
				     Still visible-but-disabled when the flag is off, so the feature reads
				     as turned off, not absent (cairn-8dup). -->
				{#if page.data.flags?.multisig_create !== false}
					<a href="/wallets/multisig/new" class="multisig-handoff-card">
						<Icon name="shield" size={18} />
						<span class="multisig-handoff-body">
							<span class="multisig-handoff-title">Several keys guarding one wallet?</span>
							<span class="multisig-handoff-copy">
								Any 2 of 3, for example — set up a multisig wallet instead. We'll explain it
								step by step.
							</span>
						</span>
						<span class="multisig-handoff-cta">
							Set up multisig
							<Icon name="arrow-right" size={13} />
						</span>
					</a>
				{:else}
					<div class="multisig-handoff-card" aria-disabled="true">
						<Icon name="shield" size={18} />
						<span class="multisig-handoff-body">
							<span class="multisig-handoff-title">Several keys guarding one wallet?</span>
							<FeatureDisabled
								message="Creating multisig wallets has been disabled by your administrator."
							/>
						</span>
					</div>
				{/if}

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
			{:else}
				<div class="key-form fade-in">
					<div class="row" style="gap: 8px">
						<button type="button" class="btn btn-ghost btn-sm" onclick={backToMethods}>
							<Icon name="chevron-left" size={13} />
							Different source
						</button>
					</div>

					{#if restoreNote && method === 'paste'}
						<Banner variant="success">{restoreNote}</Banner>
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
									Heartwood will also read its sharing key now, so you won't need to plug this
									device in again when you set that up.
								{:else}
									<span class="share-opt-in-caveat">
										(The extra sharing-key read isn't supported on the
										{WALLET_DEVICE_LABELS[method]} yet — Heartwood will skip it and let you know.)
									</span>
								{/if}
							</span>
						</label>
					{/if}

					{#if method === 'trezor' || method === 'ledger'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your {method === 'trezor' ? 'Trezor' : 'Ledger'} and unlock it. Heartwood
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
							{#if method === 'ledger'}
								<!-- Ledger needs WebHID, which plain-HTTP pages don't get; the
								     Trezor popup carries its own transport, so no note there. -->
								<SecureContextHelp what="Ledger connections" />
							{/if}
						</div>
					{:else if method === 'bitbox02'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your BitBox02 and unlock it. Heartwood reads the wallet's public key
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
							<SecureContextHelp what="direct USB connections (no BitBoxBridge app needed)" />
						</div>
					{:else if method === 'jade'}
						<div class="connect-box">
							<p class="connect-copy">
								Plug in your Jade and unlock it with your PIN. Heartwood reads the wallet's
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
							<SecureContextHelp what="Jade USB connections" />
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
								<SecureContextHelp what="camera scanning" />
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
										advanceStep(1);
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
											tip="Heartwood stamps this ID into every transaction it prepares, so your signing device can recognize which of its keys to sign with."
											>sign with a hardware wallet</Term
										> — without it you'll sign by passing files through another wallet app.
									</span>
								</div>
							{/if}

							{#if previewError}
								<Banner variant="error">{previewError}</Banner>
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
											Heartwood can derive every address your wallet will ever use and see the
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

					{#if multisigDetected}
						{@const detected = multisigDetected}
						<div class="restore-msg multisig-detected" role="status">
							{#if page.data.flags?.multisig_create !== false}
								<p class="md-title">
									This looks like a multisig wallet{detected.m && detected.n
										? ` (${detected.m}-of-${detected.n})`
										: ''}.
								</p>
								<p class="md-body">
									Multisig wallets are guarded by several keys and set up in their own guided
									flow. Heartwood will carry this file over and fill in the keys for you.
								</p>
								<div class="row" style="gap: 8px">
									<button
										type="button"
										class="btn btn-primary btn-sm"
										onclick={() => handoffToMultisig(detected.text)}
									>
										Set up multisig wallet
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => (multisigDetected = null)}
									>
										This is a single-key wallet
									</button>
								</div>
							{:else}
								<p class="md-title">This looks like a multisig wallet.</p>
								<FeatureDisabled
									message="Creating multisig wallets has been disabled by your administrator."
								/>
							{/if}
						</div>
					{:else if deviceError}
						<Banner variant="error">{deviceError}</Banner>
					{/if}
				</div>
			{/if}
		</div>
	{:else if step === 1}
		<!-- ------------------------------------- Step 2: verify addresses -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 2 · Verify</span>
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
				<Banner variant={sharedKeyNotice.tone}>{sharedKeyNotice.text}</Banner>
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
				<button type="button" class="btn btn-ghost" onclick={stepBack}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => {
						if (!name && scriptType) name = `${SCRIPT_TYPE_LABELS[scriptType]} wallet`;
						advanceStep(2);
					}}
				>
					<Icon name="check" size={14} />
					These match
				</button>
			</div>
		</div>
	{:else if step === 2 && createdId === null}
		<!-- ------------------------------------- Step 3: name it, import it -->
		<!-- The ?/create submit happens here. A pasted key gets NO device
		     question at all (cairn-l2pn) — the signing method is picked at
		     send time, and any PSBT wallet works. A device-read key confirms
		     its device in one line ("Change" reveals the full picker), which
		     keeps the cairn-0py6 lesson: the picker never sits next to the
		     name field uninvited. -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Step 3 · Finish</span>
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
							// Setting createdId swaps this pane to the Done view (backup is
							// optional for single-sig — the wallet reconstructs from the
							// hardware device).
							createdId = (result.data as { id: number }).id;
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

				{#if readMethod && readMethod !== 'paste'}
					{#if !changeDevice}
						<!-- The key came straight off a device, so we already know which
						     one will sign — confirm it rather than re-asking. -->
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
									tip="Heartwood prepares an unsigned transaction; you approve it on this device. Your private key never leaves it."
									>sign when you spend</Term
								>. Not sure? Leave it — you can pick when you send, and any PSBT wallet works.
							</p>
							<DevicePicker bind:selected={deviceType} />
						</div>
					{/if}
				{/if}

				{#if createError}
					<Banner variant="error">{createError}</Banner>
				{/if}

				<div class="pane-actions">
					<button type="button" class="btn btn-ghost" onclick={stepBack}>
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
	{:else if createdId !== null}
		<!-- ------------------------------------------------------------- done -->
		<div class="card card-pad pane fade-in">
			<span class="overline">Done</span>
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
				<a
					class="btn btn-primary"
					href={`/wallets/${createdId}?imported=1`}
					data-sveltekit-replacestate
				>
					Go to your wallet
					<Icon name="arrow-right" size={14} />
				</a>
			</div>
		</div>
	{/if}
	</div>
</div>

<style>
	.wizard {
		max-width: 620px;
	}

	.hw-page {
		position: relative;
	}

	.wizard-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
	}

	.wizard-eyebrow {
		margin-bottom: 18px;
		max-width: 100%;
	}

	.wizard-title {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.01em;
		margin: 0 0 6px;
	}

	.wizard-sub {
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 24px;
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

	/* --- step indicator — quiet text-step grammar (word + connecting line,
	   no dots/circles), matching the Send flow's step language --- */

	.steps {
		display: flex;
		align-items: center;
		list-style: none;
		margin: 0 0 20px;
		padding: 0;
	}

	.step-item {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1 1 auto;
		min-width: 0;
	}

	.step-item:last-child {
		flex: 0 0 auto;
	}

	.step-word {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-muted);
		white-space: nowrap;
		transition: color 120ms var(--ease);
	}

	.step-item.active .step-word {
		color: var(--accent);
	}

	.step-item.done .step-word {
		color: var(--text-secondary);
	}

	.step-line {
		flex: 1;
		height: 1px;
		min-width: 12px;
		background: var(--border-subtle);
	}

	.step-item.done .step-line {
		background: var(--accent-muted);
	}

	@media (max-width: 560px) {
		.step-word {
			font-size: 10.5px;
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

	/* --- multisig hand-off card (elevated top-of-methods, MULTISIG-UX-DESIGN 1c) --- */

	.multisig-handoff-card {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		margin-bottom: 4px;
		color: inherit;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		transition: border-color 120ms var(--ease);
	}

	a.multisig-handoff-card:hover {
		border-color: var(--accent);
	}

	.multisig-handoff-card > :global(svg:first-child) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.multisig-handoff-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
		text-align: left;
	}

	.multisig-handoff-title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--text-hero);
	}

	.multisig-handoff-copy {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.multisig-handoff-cta {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		white-space: nowrap;
	}

	.multisig-handoff-card[aria-disabled='true'] {
		opacity: 0.7;
		cursor: not-allowed;
	}

	/* --- step 1: key --- */

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

	/* Detected-multisig hand-off card (multisig-import UX) */
	.multisig-detected {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.md-title {
		font-weight: 600;
		color: var(--text);
	}

	.md-body {
		color: var(--text-secondary);
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

		.multisig-handoff-card {
			flex-wrap: wrap;
		}

		.multisig-handoff-cta {
			width: 100%;
			justify-content: flex-start;
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
