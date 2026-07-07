<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { deserialize } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import type { MultisigDeviceType, MultisigKeyCategory, MultisigScriptType } from '$lib/server/wallets/multisig';
	import KeyCategoryIcon from '../_components/KeyCategoryIcon.svelte';
	import { KEY_CATEGORY_LABELS, DEVICE_LABELS, MULTISIG_SCRIPT_LABELS } from '../labels';
	import {
		readKeyFromTrezor,
		readKeyFromLedger,
		readKeyFromBitbox02,
		readKeyFromJade,
		readCollabKeyFromTrezor,
		readCollabKeyFromLedger,
		supportsCollaborativeRead,
		DeviceReadUnavailable
	} from './_components/deviceRead';
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
	let scriptType = $state<MultisigScriptType>('p2wsh');
	let showAdvanced = $state(false);
	let showImport = $state(false);
	let importText = $state('');
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let importedNote = $state<string | null>(null);
	// Cosigner keys that may belong to an existing contact (cairn-jaev). A
	// non-committing suggestion surfaced after import — never auto-shares.
	type CosignerMatch = { fingerprint: string; displayName: string; email: string };
	let cosignerMatches = $state<CosignerMatch[]>([]);
	// True once a config has been imported — imports skip the mandatory-backup gate
	// on the Done step (the user already has the file they uploaded).
	let configImported = $state(false);
	// Receive cursor carried from an imported config (cairn-u161); 0 for created.
	let importedStartIndex = $state(0);
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

	// --------------------------------------- quorum signing-time estimates
	//
	// GET /api/signing-time-preview compares quorums: one fetch returns the
	// standard presets (2-of-3, 3-of-5) plus the requested combo, so the
	// initial call covers both preset cards; custom M-of-N changes refetch,
	// debounced. Estimates INFORM the trade-off (bigger quorum = more devices
	// each verifying every input = longer ceremony) — they never gate the
	// step, and they are about signing time only, never network fees.

	type QuorumEstimate = { m: number; n: number; totalSecondsLo: number; totalSecondsHi: number };
	let previewBasis = $state<'your-utxos' | 'typical' | null>(null);
	let quorumEstimates = $state<Record<string, QuorumEstimate>>({});

	async function fetchSigningPreview(m: number, n: number) {
		try {
			const res = await fetch(`/api/signing-time-preview?m=${m}&n=${n}`);
			if (!res.ok) return;
			const body = (await res.json()) as { basis: 'your-utxos' | 'typical'; estimates: QuorumEstimate[] };
			previewBasis = body.basis;
			const next = { ...quorumEstimates };
			for (const e of body.estimates) next[`${e.m}/${e.n}`] = e;
			quorumEstimates = next;
		} catch {
			// Estimates enhance the cards; a failed fetch just shows none.
		}
	}

	function estimateFor(m: number, n: number): QuorumEstimate | undefined {
		return quorumEstimates[`${m}/${n}`];
	}

	/** Humane range: minutes once the top clears 90 s, else seconds (5s steps). */
	function signingRange(lo: number, hi: number): string {
		const l = Math.max(0, lo);
		const h = Math.max(l, hi);
		if (h > 90) {
			const lm = Math.max(1, Math.round(l / 60));
			const hm = Math.max(lm, Math.round(h / 60));
			return lm === hm ? `~${lm} min` : `~${lm}–${hm} min`;
		}
		const round5 = (s: number) => Math.max(5, Math.round(s / 5) * 5);
		const ls = round5(l);
		const hs = Math.max(ls, round5(h));
		return ls === hs ? `~${ls} sec` : `~${ls}–${hs} sec`;
	}

	function estimateLine(m: number, n: number): string | null {
		const e = estimateFor(m, n);
		return e ? `${signingRange(e.totalSecondsLo, e.totalSecondsHi)} total signing time` : null;
	}

	// One initial fetch (client-only via $effect) covers both preset cards.
	let previewSeeded = false;
	$effect(() => {
		if (previewSeeded) return;
		previewSeeded = true;
		void fetchSigningPreview(2, 3);
	});

	// Custom M-of-N: refetch as the values change, debounced 300 ms, skipping
	// combos already fetched (the estimate map doubles as a cache).
	let customDebounce: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (preset !== 'custom' || !quorumValid) return;
		const m = threshold;
		const n = totalKeys;
		if (quorumEstimates[`${m}/${n}`]) return;
		customDebounce = setTimeout(() => void fetchSigningPreview(m, n), 300);
		return () => clearTimeout(customDebounce);
	});

	// -------------------------------------------------------------- step 2: keys
	interface WizardKey {
		name: string;
		category: MultisigKeyCategory;
		deviceType: MultisigDeviceType;
		xpub: string;
		fingerprint: string;
		path: string;
	}

	let keys = $state<WizardKey[]>([]);

	// --- vault mode (cairn-fdlf.4/.5): shared vs personal, asked once per vault ---
	//
	// Decides which purpose every FRESH key read/paste targets: collaborative →
	// BIP-45 (m/45', no script-type field), personal → BIP-48 with the wallet's
	// script-type suffix (today's behavior). Locked once the first key is added
	// (one vault never mixes 45'- and 48'-purpose cosigners); imports skip the
	// question entirely — an imported config keeps whatever paths it has.
	type VaultMode = 'collaborative' | 'personal';
	let vaultMode = $state<VaultMode | null>(null);

	// Known-device-keys registry rows (cairn-fdlf.2) usable in this vault —
	// fetched when the mode is chosen, offered so the user can reuse a key that
	// was already read off a device instead of plugging it in again.
	type KnownKey = { fingerprint: string; xpub: string; path: string; deviceType: string | null };
	let knownKeys = $state<KnownKey[]>([]);

	const personalPathHint = $derived(
		scriptType === 'p2wsh' ? "m/48'/0'/0'/2'" : "m/48'/0'/0'/1'"
	);
	// Registry offers not already used by an added key (fingerprint is the
	// reliable identity; xpub is compared too in case a fingerprintless paste
	// duplicated one).
	const reusableKnownKeys = $derived(
		knownKeys.filter(
			(r) => !keys.some((k) => k.fingerprint === r.fingerprint || k.xpub === r.xpub)
		)
	);

	async function chooseVaultMode(mode: VaultMode) {
		vaultMode = mode;
		knownKeys = [];
		// Reuse offers enhance the step; a failed lookup just means none show.
		const res = await callAction<{ knownKeys: KnownKey[] }>(
			'knownKeys',
			{ intent: mode, scriptType },
			''
		);
		if (res.ok) knownKeys = res.data.knownKeys ?? [];
	}

	function changeVaultMode() {
		// Only offered while no keys are added — the mode is locked per vault.
		vaultMode = null;
		knownKeys = [];
		resetKeyForm();
	}

	// The first-class ways a key arrives — none of them "advanced".
	type Method = 'trezor' | 'ledger' | 'bitbox02' | 'jade' | 'coldcard' | 'qr' | 'paste';
	// Which methods read the key straight off a plugged-in device (one-click connect).
	type ConnectMethod = 'trezor' | 'ledger' | 'bitbox02' | 'jade';
	let method = $state<Method | null>(null);
	let keyName = $state('');
	let keyCategory = $state<MultisigKeyCategory>('hardware');
	let keyDevice = $state<MultisigDeviceType>('file');
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
		{ key: 'bitbox02', title: 'BitBox02', desc: 'Plug it in and connect with one click.' },
		{ key: 'jade', title: 'Jade (USB)', desc: 'Plug it in and connect with one click.' },
		{ key: 'coldcard', title: 'ColdCard', desc: "Import the file from its microSD card." },
		{ key: 'qr', title: 'Air-gapped QR', desc: "Scan the key's QR code off the device screen." },
		{ key: 'paste', title: 'Paste public key', desc: 'From any wallet app, or a key someone sent you.' }
	];

	// The BitBox02 firmware has no legacy (plain P2SH) multisig script config, so
	// it can't hold a key for a P2SH multisig wallet — grey the tile out for that
	// wallet type with copy explaining why (hardware plan §2.1), rather than
	// letting the user pick it and hit a confusing failure at connect time.
	const bitboxUnsupported = $derived(scriptType === 'p2sh');

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
							: m === 'bitbox02'
								? 'My BitBox02'
								: m === 'jade'
									? 'My Jade'
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
		const multisigLabel = MULTISIG_SCRIPT_LABELS[scriptType];
		const governs = `the wallet's ${multisigLabel} setting governs the addresses either way — the prefix is just a labeling convention`;
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
							? 'a key labeled for Native SegWit multisig (SLIP-132) — matches this wallet.'
							: `a key labeled for Native SegWit multisig (SLIP-132); this wallet uses ${multisigLabel}, which is fine — ${governs}.`
				};
			case 'Ypub':
				return {
					label: 'Ypub',
					desc:
						scriptType === 'p2sh-p2wsh'
							? 'a key labeled for Nested SegWit multisig (SLIP-132) — matches this wallet.'
							: `a key labeled for Nested SegWit multisig (SLIP-132); this wallet uses ${multisigLabel}, which is fine — ${governs}.`
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
					desc: 'a TESTNET key. This wallet tracks real (mainnet) bitcoin, so this key will be rejected.'
				};
			default:
				return null;
		}
	});

	// Programmatic form-action calls (the wizard adds keys one at a time, so
	// static use:enhance forms don't fit).
	// `fallback` is the operation-specific message shown when the server returns no
	// error text of its own (e.g. an unexpected 500). Each caller passes one so the
	// three distinct operations this helper backs — adding a key, importing a
	// config, previewing an address — no longer collapse into one vague "Something
	// went wrong", the exact flow a first-time self-hoster gets stuck in (cairn-odq1).
	async function callAction<T>(
		action: string,
		fields: Record<string, string>,
		fallback: string
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
					error: (result.data as { error?: string } | undefined)?.error ?? fallback
				};
			}
			return { ok: false, error: fallback };
		} catch {
			return { ok: false, error: 'Network hiccup — check your connection and try again.' };
		}
	}

	/** `readFrom` names the device a LIVE in-browser read came from (so the
	 *  server can cache the key in the device-keys registry); omitted for
	 *  paste/file/QR/reuse. */
	async function submitKey(readFrom?: string): Promise<boolean> {
		if (adding) return false;
		adding = true;
		addError = null;
		try {
			const res = await callAction<{ key: WizardKey }>(
				'key',
				{
					name: keyName.trim() || `Key ${keys.length + 1}`,
					category: keyCategory,
					deviceType: keyDevice ?? '',
					xpub: pasteValue,
					fingerprint: fpValue,
					path: pathValue,
					// Declared vault mode + script type: the server rejects a key that
					// contradicts the intent NOW instead of at the final create step.
					intent: vaultMode ?? '',
					scriptType,
					readFrom: readFrom ?? ''
				},
				"Couldn't add that key — double-check it and try again."
			);
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
			// Manually adding a key means this is a from-scratch build, not an
			// untouched imported config — restore the mandatory backup gate.
			configImported = false;
			resetKeyForm();
			return true;
		} finally {
			adding = false;
		}
	}

	// Display names for the one-click-connect devices (used in copy + errors).
	const CONNECT_LABELS: Record<ConnectMethod, string> = {
		trezor: 'Trezor',
		ledger: 'Ledger',
		bitbox02: 'BitBox02',
		jade: 'Jade'
	};

	async function connectDevice(kind: ConnectMethod) {
		if (deviceBusy) return;
		deviceBusy = true;
		addError = null;
		try {
			let key: { xpub: string; fingerprint: string; path: string };
			if (vaultMode === 'collaborative') {
				// Shared vault: read the BIP-45 purpose node m/45' — no script-type
				// branching, no path picker (cairn-fdlf.4). Trezor/Ledger only; the
				// template shows the paste fallback for BitBox02/Jade before this
				// can run, but guard anyway.
				if (!supportsCollaborativeRead(kind)) {
					addError = `The ${CONNECT_LABELS[kind]} can't export the shared-vault key (m/45') through the browser — paste it instead. "Where do I find this key?" below has the steps.`;
					method = 'paste';
					keyDevice = kind;
					showWhereFind = true;
					return;
				}
				key = await (kind === 'trezor' ? readCollabKeyFromTrezor() : readCollabKeyFromLedger());
			} else {
				const reader =
					kind === 'trezor'
						? readKeyFromTrezor
						: kind === 'ledger'
							? readKeyFromLedger
							: kind === 'bitbox02'
								? readKeyFromBitbox02
								: readKeyFromJade;
				key = await reader(scriptType);
			}
			pasteValue = key.xpub;
			fpValue = key.fingerprint;
			pathValue = key.path;
			await submitKey(kind);
		} catch (e) {
			if (e instanceof DeviceReadUnavailable) {
				addError = `Direct ${CONNECT_LABELS[kind]} connection isn't available in this browser — paste the key instead. "Where do I find this key?" below has the steps.`;
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

	/** Device label for a registry row ('Trezor', …), or a generic fallback. */
	function knownKeyLabel(row: KnownKey): string {
		const label = row.deviceType
			? DEVICE_LABELS[row.deviceType as Exclude<MultisigDeviceType, null>]
			: undefined;
		return label ?? 'Saved key';
	}

	/** Add a key straight from the device-keys registry — no device touch
	 *  (cairn-fdlf.4's reuse-before-fresh-read). */
	async function reuseKnownKey(row: KnownKey) {
		if (adding) return;
		addError = null;
		if (!keyName.trim() && row.deviceType) keyName = `My ${knownKeyLabel(row)}`;
		keyCategory = 'hardware';
		keyDevice = (row.deviceType ?? 'file') as MultisigDeviceType;
		pasteValue = row.xpub;
		fpValue = row.fingerprint;
		pathValue = row.path;
		await submitKey();
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
		// qr_scan is a client-only feature (no server route); suppressing the camera
		// path here is its enforcement. Falls back to paste when off.
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
		// Editing the key set means this no longer matches an imported config file,
		// so it's now a from-scratch build → its backup becomes mandatory again.
		configImported = false;
	}

	// --- same-seed detection (cairn-h4l) ---
	// Keys sharing a master fingerprint almost certainly come from the same
	// seed, which quietly defeats the point of a multisig. Warn prominently but
	// never block — one seed carrying several accounts is technically valid.
	// '00000000' is the "no fingerprint on record" placeholder, so it's exempt.
	const sharedFingerprintGroups = $derived.by(() => {
		const byFp = new Map<string, string[]>();
		for (const k of keys) {
			if (k.fingerprint === '00000000') continue;
			byFp.set(k.fingerprint, [...(byFp.get(k.fingerprint) ?? []), k.name]);
		}
		return [...byFp.entries()]
			.filter(([, names]) => names.length > 1)
			.map(([fingerprint, names]) => ({ fingerprint, names }));
	});
	const sharedFingerprints = $derived(new Set(sharedFingerprintGroups.map((g) => g.fingerprint)));

	function listNames(names: string[]): string {
		if (names.length <= 2) return names.join(' and ');
		return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	}

	// --- import an existing multisig (descriptor or Caravan/Unchained JSON) ---
	interface ImportedMultisig {
		name: string;
		scriptType: MultisigScriptType | null;
		threshold: number;
		totalKeys: number;
		keys: { name: string; xpub: string; fingerprint: string; path: string }[];
		/** Receive cursor from the imported config, restored so we don't reissue
		 *  already-used addresses (cairn-u161). */
		startingAddressIndex?: number;
	}

	async function handleImport() {
		if (importing) return;
		importing = true;
		importError = null;
		try {
			const res = await callAction<{ imported: ImportedMultisig; cosignerMatches?: CosignerMatch[] }>(
				'import',
				{ source: importText },
				"Couldn't import that configuration — paste a descriptor or a Caravan wallet JSON."
			);
			if (!res.ok) {
				importError = res.error;
				return;
			}
			const { imported } = res.data;
			cosignerMatches = res.data.cosignerMatches ?? [];
			preset = 'custom';
			customM = imported.threshold;
			customN = imported.totalKeys;
			if (imported.scriptType) scriptType = imported.scriptType;
			if (imported.name && !multisigName.trim()) {
				multisigName = imported.name;
				namePrefilledFromImport = true;
			}
			keys = imported.keys.map((k) => ({
				category: 'hardware' as MultisigKeyCategory,
				deviceType: 'file' as MultisigDeviceType,
				...k
			}));
			importedNote = `Read an existing ${imported.threshold}-of-${imported.totalKeys} multisig wallet${imported.name ? ` ("${imported.name}")` : ''} — its keys are filled in on the next step.`;
			importedStartIndex = imported.startingAddressIndex ?? 0;
			// The user already holds this config — no mandatory backup on the Done step.
			configImported = true;
			// Imports keep whatever paths they were built with — the collaborative-
			// vs-personal question only applies to keys derived fresh in this wizard
			// (cairn-fdlf.4's scope boundary), so any earlier answer is cleared.
			vaultMode = null;
			knownKeys = [];
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
		const res = await callAction<{ addresses: string[] }>(
			'preview',
			{
				config: JSON.stringify({
					threshold,
					keys: keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
				})
			},
			"Couldn't preview the addresses — go back and re-check the keys."
		);
		previewLoading = false;
		if (res.ok) previewAddresses = res.data.addresses;
		else previewError = res.error;
	}

	// ----------------------------------------------------------- step 4: confirm
	let multisigName = $state('');
	// Set when the name was pre-filled from an imported Caravan config so the first
	// focus selects the suggested text — typing then replaces it instead of
	// concatenating into "P2WSH-MMy Vault" (cairn-9g6b). Cleared after one focus.
	let namePrefilledFromImport = $state(false);
	function selectPrefilledName(e: FocusEvent) {
		if (!namePrefilledFromImport) return;
		namePrefilledFromImport = false;
		(e.currentTarget as HTMLInputElement).select();
	}
	let verified = $state(false);
	let creating = $state(false);
	let createError = $state<string | null>(null);
	let createdId = $state<number | null>(null);

	async function createMultisigNow() {
		if (creating || !verified) return;
		creating = true;
		createError = null;
		try {
			const res = await callAction<{ multisigId: number }>(
				'create',
				{
					name: multisigName.trim(),
					threshold: String(threshold),
					scriptType,
					keys: JSON.stringify(keys),
					source: configImported ? 'imported' : 'created',
					startingAddressIndex: String(configImported ? importedStartIndex : 0),
					// '' when the vault-mode question was never asked (imports).
					collaborative: vaultMode === null ? '' : String(vaultMode === 'collaborative')
				},
				"Couldn't create the wallet — your keys are still here, try again."
			);
			if (!res.ok) {
				createError = res.error;
				return;
			}
			createdId = res.data.multisigId;
			step = 'done';
		} finally {
			creating = false;
		}
	}

	// -------------------------------------------------------------- step 5: done
	// The wallet-config backup is MANDATORY for a multisig CREATED from scratch:
	// its config exists nowhere else, so the "Go to your wallet" CTA is gated on a
	// download. An IMPORTED multisig skips the gate entirely (configImported) —
	// the user already has the file they uploaded. Any download link flips this true.
	let backedUp = $state(false);
	function markBackupDownloaded() {
		backedUp = true;
		if (createdId !== null) {
			localStorage.setItem(`cairn.multisig.backup.${createdId}`, 'done');
		}
	}

	const hasColdcardKey = $derived(keys.some((k) => k.deviceType === 'coldcard'));
	const hasQrKey = $derived(keys.some((k) => k.deviceType === 'qr'));

	// -------------------------------------------------------------- navigation
	function goToReview() {
		step = 'review';
		void loadPreview();
	}

	// Entering the Keys step — first time or via any Back control — always
	// lands on the method picker with no stale device/error state left over
	// from a previous visit (e.g. a failed Ledger connect). Reuses the same
	// reset as the in-form "Different source" button; added keys are kept.
	function goToKeys() {
		resetKeyForm();
		step = 'keys';
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
	<title>New multisig wallet — Cairn</title>
</svelte:head>

<div class="wizard fade-in" bind:this={pageEl}>
	<h1 class="page-title" style="margin-bottom: 4px">Create a multisig wallet</h1>
	<p class="hint" style="margin-bottom: 20px">
		Money that needs several of your keys to move — no single point of failure.
	</p>

	<div class="stepper-wrap card card-pad">
		<Stepper steps={STEPS} current={step} />
	</div>

	<!-- Same-seed warning (cairn-h4l) — shown on the Keys step and repeated on Review. -->
	{#snippet seedWarning()}
		{#if sharedFingerprintGroups.length > 0}
			<div class="seed-warning" role="alert">
				<Icon name="alert-triangle" size={16} />
				<div class="seed-warning-body">
					{#each sharedFingerprintGroups as g (g.fingerprint)}
						<p>
							<strong>{listNames(g.names)}</strong> come from the same seed — they share the
							master fingerprint <span class="mono">{g.fingerprint}</span>. That means one
							backup controls {g.names.length === 2 ? 'both' : `all ${g.names.length}`} — you
							don't get the protection of separate keys.
						</p>
					{/each}
					<p class="seed-note">
						You can continue if this is deliberate (one seed can hold several accounts), but
						for real protection each key should come from a different device or seed.
					</p>
				</div>
			</div>
		{/if}
	{/snippet}

	{#if step === 'why'}
		<!-- ============================================= Step 1: why a multisig -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 1 · How much protection?</span>

			{#if data.hasMultisigs}
				<!-- Repeat users get the education collapsed out of the way. -->
				<HowItWorks id="multisig-why" title="Why a multisig wallet?">
					<p>
						A single key that's lost means the funds are gone. A multisig wallet
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
						<strong>A single key that's lost means funds are gone.</strong> A multisig wallet splits
						control across several keys — like a bank vault requiring two keys turned at the
						same time.
					</p>
					<p>
						<strong>Losing one key doesn't lose your funds.</strong> With a 2-of-3 multisig wallet, any
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

			{#if cosignerMatches.length > 0}
				<div class="cosigner-hint" role="status">
					<Icon name="users" size={15} />
					<div>
						<strong
							>{cosignerMatches.length === 1
								? 'A key in this wallet may belong to one of your contacts.'
								: 'Some keys in this wallet may belong to your contacts.'}</strong
						>
						<p>
							{#each cosignerMatches as m, i (m.fingerprint + m.email)}{i > 0
									? ', '
									: ''}{m.displayName}{/each}
							already {cosignerMatches.length === 1 ? 'holds' : 'hold'} a matching key. Once this vault
							is created you can share it with them from its page to set up shared custody — nothing is
							shared automatically.
						</p>
					</div>
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
					{#if estimateLine(2, 3)}
						<span class="preset-time tabular">{estimateLine(2, 3)}</span>
					{/if}
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
					{#if estimateLine(3, 5)}
						<span class="preset-time tabular">{estimateLine(3, 5)}</span>
					{/if}
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
					{#if preset === 'custom' && quorumValid && estimateLine(threshold, totalKeys)}
						<span class="preset-time tabular">{estimateLine(threshold, totalKeys)}</span>
					{/if}
				</button>
			</div>

			{#if previewBasis}
				<p class="preview-caption">
					<Term
						tip="Larger quorums are more secure but take longer to sign transactions. Each signing device must independently verify every input."
						>Signing time</Term
					>
					estimates are {previewBasis === 'your-utxos'
						? 'based on your current coins'
						: 'based on typical coins'} — they never affect the network fee.
				</p>
			{/if}

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
									Only if you must match an older multisig wallet built this way. Addresses start with 3.
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
					Already have this wallet in another app? Import it
					<span class="chev" class:open={showImport}><Icon name="chevron-down" size={14} /></span>
				</button>
				{#if showImport}
					<div class="disclosure-body fade-in">
						<p class="hint" style="margin-bottom: 8px">
							Paste the wallet's <Term
								tip="A descriptor is a single line of text that describes a multisig wallet completely — the quorum and every public key. Wallets like Sparrow export it under Settings."
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

			{#if data.multisigServices.length > 0}
				<!-- Managed-service referrals (cairn-y5l6): a quiet, non-modal aside
				     below the DIY setup. The load only hands us rows when the
				     referral_links flag is on AND at least one service is active. -->
				<aside class="services-card" aria-label="Managed multisig services">
					<p class="services-lead">Want a managed multisig service instead?</p>
					<p class="services-sub">
						These companies set up and help run a multisig for you. Setting one up here yourself is
						free and private — but if you'd rather have help, they're an option.
					</p>
					<ul class="services-list">
						{#each data.multisigServices as service (service.id)}
							<li class="service-item">
								{#if service.logoUrl}
									<img class="service-logo" src={service.logoUrl} alt="{service.name} logo" />
								{/if}
								<div class="service-body">
									<a href={service.url} target="_blank" rel="noopener" class="service-name">
										{service.name} →
									</a>
									{#if service.description}
										<span class="service-desc">{service.description}</span>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				</aside>
			{/if}

			<div class="pane-actions">
				<a href="/wallets" class="btn btn-ghost">Cancel</a>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!quorumValid}
					onclick={goToKeys}
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
								{#if key.path && key.path !== 'm'}
									<!-- The key's derivation path, as a quiet secondary detail
									     (cairn-3mhi) — it matters when cross-checking against
									     another tool or re-exporting from a device. -->
									<span class="slot-path mono" title="Derivation path">{key.path}</span>
								{/if}
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

			{@render seedWarning()}

			{#if lastAdded}
				<div class="imported-note" role="status">
					<Icon name="check" size={14} />
					{lastAdded}
				</div>
			{/if}

			{#if keys.length > totalKeys}
				<div class="form-error" role="alert">
					You've added {keys.length} keys but the wallet only holds {totalKeys} — remove
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

					{#if method === null && vaultMode === null && keys.length === 0}
						<!-- Vault-mode question (cairn-fdlf.4/.5): asked once, before any key
						     is added, because it decides which key path every device read and
						     paste must use. Locked once the first key lands. -->
						<p class="hint">
							First, one question — it decides which key Cairn reads from your devices.
							Is this wallet shared with other people, or all yours?
						</p>
						<div class="mode-grid">
							<button type="button" class="method-card" onclick={() => chooseVaultMode('personal')}>
								<span class="method-title">Just my own keys</span>
								<span class="method-desc">
									Every key is yours, on your own devices — a personal multisig. The most
									common setup.
								</span>
							</button>
							<button
								type="button"
								class="method-card"
								onclick={() => chooseVaultMode('collaborative')}
							>
								<span class="method-title">Shared with other people</span>
								<span class="method-desc">
									Family, business partners or a service each hold their own key —
									collaborative custody.
								</span>
							</button>
						</div>
						<p class="hint mode-note">
							Shared vaults use the common multisig path (<span class="mono">m/45'</span>) every
							cosigner's wallet understands; personal vaults use the standard path for this
							wallet type (<span class="mono">{personalPathHint}</span>). You can't mix the two
							in one vault.
						</p>
					{:else if method === null}
						{#if vaultMode !== null}
							<div class="mode-banner" role="status">
								<Icon name={vaultMode === 'collaborative' ? 'users' : 'shield'} size={14} />
								<span class="mode-banner-text">
									{#if vaultMode === 'collaborative'}
										Shared vault — every key uses the shared multisig path
										<span class="mono">m/45'</span>.
									{:else}
										Personal multisig — keys use the standard path
										<span class="mono">{personalPathHint}</span>.
									{/if}
								</span>
								{#if keys.length === 0}
									<button type="button" class="mode-change" onclick={changeVaultMode}>
										Change
									</button>
								{/if}
							</div>
						{/if}

						{#if reusableKnownKeys.length > 0}
							<!-- Reuse-before-fresh-read (cairn-fdlf.4): keys already read off a
							     device (e.g. the single-sig wizard's sharing prefetch) — no
							     need to plug the device in again. -->
							<div class="known-keys">
								<span class="known-title">
									<Icon name="check" size={14} />
									Keys Cairn already knows
								</span>
								<p class="hint">
									You've read these from your devices before — reuse one without plugging
									anything in.
								</p>
								{#each reusableKnownKeys as row (row.fingerprint)}
									<div class="known-row">
										<span class="known-meta">
											<span class="known-name">{knownKeyLabel(row)}</span>
											<span class="known-sub">
												<span class="mono">{row.fingerprint}</span> ·
												<span class="mono">{row.path}</span>
											</span>
										</span>
										<button
											type="button"
											class="btn btn-secondary btn-sm"
											disabled={adding}
											onclick={() => reuseKnownKey(row)}
										>
											Use this key
										</button>
									</div>
								{/each}
							</div>
						{/if}

						<p class="hint">Where does this key live?</p>
						<div class="method-grid">
							{#each METHOD_CARDS as m (m.key)}
								{#if m.key === 'bitbox02' && bitboxUnsupported}
									<!-- The BitBox02 can't do plain-P2SH multisig — greyed out here. -->
									<div class="method-card disabled" aria-disabled="true">
										<span class="method-title">{m.title}</span>
										<span class="method-desc">
											Not available for a legacy (P2SH) multisig — the BitBox02 supports only
											Native and Nested SegWit multisig.
										</span>
									</div>
								{:else}
									<button type="button" class="method-card" onclick={() => pickMethod(m.key)}>
										<span class="method-title">{m.title}</span>
										<span class="method-desc">{m.desc}</span>
									</button>
								{/if}
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

							{#if method === 'trezor' || method === 'ledger' || method === 'bitbox02' || method === 'jade'}
								<div class="connect-box">
									{#if vaultMode === 'collaborative' && !supportsCollaborativeRead(method)}
										<!-- BitBox02/Jade can't export the m/45' shared-vault key through
										     the browser (see deviceRead.ts's gate notes) — clear message +
										     the paste fallback, never a confusing failure at connect time. -->
										<p class="connect-copy">
											The {CONNECT_LABELS[method]} can't export the shared-vault key
											(<span class="mono">m/45'</span>) through the browser — that direct read
											only works for Trezor and Ledger. You can still use this device: export
											its <span class="mono">m/45'</span> key with
											<strong>Electrum</strong> (its default for this kind of multisig) or
											<strong>Sparrow</strong> (set the derivation path when adding the
											keystore), then paste it here.
										</p>
										<button
											type="button"
											class="btn btn-primary"
											onclick={() => {
												const d = keyDevice;
												method = 'paste';
												keyDevice = d;
												showWhereFind = true;
											}}
										>
											Paste the key instead
										</button>
									{:else}
										<p class="connect-copy">
											Plug in your {CONNECT_LABELS[method]} and unlock it.
											Cairn reads the multisig key straight from the device — the key it reads can
											<strong>watch, never spend</strong>.
											{#if vaultMode === 'collaborative'}
												Because this vault is shared, the key is read from the shared multisig
												path <span class="mono">m/45'</span>.
											{/if}
											{#if method === 'jade'}
												Pick the Jade from your browser's serial-port prompt.
											{:else if method === 'bitbox02'}
												On a first connection, confirm the pairing code on the BitBox02.
											{/if}
										</p>
										<button
											type="button"
											class="btn btn-primary"
											disabled={deviceBusy || adding}
											onclick={() => connectDevice(method as ConnectMethod)}
										>
											{#if deviceBusy || adding}<span class="spinner"></span>{/if}
											Connect {CONNECT_LABELS[method]}
										</button>
										{#if method === 'ledger' || method === 'jade'}
											<!-- These need WebHID/Web Serial, which plain-HTTP pages don't
											     get; Trezor's popup carries its own transport and the
											     BitBox02 can go through its bridge app. -->
											<SecureContextHelp what="{CONNECT_LABELS[method]} connections" />
										{:else if method === 'bitbox02'}
											<SecureContextHelp what="direct USB connections (no BitBoxBridge app needed)" />
										{/if}
									{/if}
								</div>
							{:else if method === 'coldcard'}
								<div class="connect-box">
									{#if vaultMode === 'collaborative'}
										<p class="connect-copy">
											Heads up: the ColdCard's Generic JSON export contains its
											personal-multisig (BIP-48) keys — not the shared-vault key
											(<span class="mono">m/45'</span>) this wallet needs. Export the
											<span class="mono">m/45'</span> key with <strong>Electrum</strong> or
											<strong>Sparrow</strong> instead and use "Enter it as text instead"
											below.
										</p>
									{/if}
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
										{#if vaultMode === 'collaborative'}
											Because this vault is shared, the QR must carry the
											<span class="mono">m/45'</span> key <em>with</em> its origin info
											(fingerprint + path) — a bare key can't be checked for a shared vault.
										{/if}
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
										<SecureContextHelp what="camera scanning" />
									{/if}
								</div>
							{:else}
								<!-- paste a public key -->
								{#if vaultMode === 'collaborative'}
									<!-- BIP-45 export instructions (cairn-fdlf.5): the user can't be
									     told to look in Trezor Suite / Ledger Live — their consumer
									     apps have no custom-path export. Electrum/Sparrow are the
									     bridging tools that can actually produce an m/45' key. -->
									<div class="collab-paste-note">
										<Icon name="info" size={15} />
										<div class="collab-paste-body">
											<p>
												<strong>This vault is shared, so the key must be exported at
												<span class="mono">m/45'</span></strong> — the common multisig path
												every cosigner's wallet understands.
											</p>
											<p>
												Where to get it: <strong>Electrum</strong> exports multisig hardware
												keys at m/45' by default (pick the "legacy" multisig type);
												in <strong>Sparrow</strong> or <strong>Specter</strong>, set the
												derivation path to <span class="mono">m/45'</span> when adding the
												keystore. Trezor Suite and Ledger Live can't export it from their own
												apps — use one of the tools above, or connect the device directly on
												the previous screen.
											</p>
											<p>
												Paste the <strong>full form</strong> —
												<span class="mono">[fingerprint/45']xpub…</span> — not just the bare
												key, so Cairn can check it belongs to this vault.
											</p>
										</div>
									</div>
								{/if}
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
										placeholder={vaultMode === 'collaborative'
											? "[a1b2c3d4/45']xpub6D…"
											: "xpub6D…, Zpub6y…, or [a1b2c3d4/48'/0'/0'/2']xpub6D…"}
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
												tip={vaultMode === 'collaborative'
													? "Where in the device's key tree this key lives. A shared vault's keys come from m/45' — required here so Cairn can check the key."
													: "Where in the device's key tree this key lives. m/48'/0'/0'/2' is the standard for native-segwit multisig — leave blank if unsure."}
												>Derivation path</Term
											>
											<span class="optional"
												>{vaultMode === 'collaborative' ? '' : '(optional)'}</span
											>
										</span>
										<input
											class="input mono"
											placeholder={vaultMode === 'collaborative' ? "m/45'" : "m/48'/0'/0'/2'"}
											bind:value={pathValue}
										/>
									</label>
								</div>
								<span class="hint">
									You'll see the wallet's shared addresses to double-check at the Review step.
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
										{#if vaultMode === 'collaborative'}
											<!-- Shared-vault (m/45') export steps — bridging tools only;
											     the vendors' own consumer apps can't do a custom-path
											     export (cairn-fdlf.5). -->
											<div class="disclosure-body fade-in where-list">
												<p>
													<strong>Trezor or Ledger</strong> — connect it directly (pick it on
													the previous screen) and Cairn reads the
													<span class="mono">m/45'</span> key itself. Their own apps (Trezor
													Suite, Ledger Live) can't export this key — use Electrum or Sparrow
													below if you can't connect directly.
												</p>
												<p>
													<strong>Electrum</strong> — create a multisig wallet with the device
													and pick the "legacy" multisig type; Electrum reads the key at
													<span class="mono">m/45'</span> by default. Copy the master public
													key it shows.
												</p>
												<p>
													<strong>Sparrow / Specter</strong> — when adding the keystore, set
													the derivation path to <span class="mono">m/45'</span> (Sparrow's own
													default is a different, personal-multisig path), then copy the xpub.
												</p>
												<p>
													<strong>Someone else's key</strong> — ask your cosigner for their
													<span class="mono">m/45'</span> export in the full
													<span class="mono">[fingerprint/45']xpub…</span> form; it's safe to
													send over any channel. Paste it exactly as received.
												</p>
											</div>
										{:else}
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
									{/if}
								</div>

								<div>
									<button
										type="button"
										class="btn btn-primary"
										disabled={adding || !pasteValue.trim() || pasteIsPrivate}
										onclick={() => submitKey()}
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
				this wallet.
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
						<span class="mono review-fp" class:review-fp-dup={sharedFingerprints.has(key.fingerprint)}>
							{key.fingerprint !== '00000000' ? key.fingerprint : '—'}
						</span>
					</div>
				{/each}
			</div>

			{@render seedWarning()}

			<div class="test-address">
				<span class="test-title">
					<Icon name="eye" size={15} />
					Check these addresses before you fund the wallet
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
					proves every key was entered correctly. Money sent to a wallet built from a mistyped
					key can be lost for good, so one minute of cross-checking is the best insurance
					there is.
				</p>
			</div>

			<div class="need-panel">
				<span class="need-title">If you lose a key</span>
				<p class="need-copy">
					Your money stays safe and spendable while you still have {threshold} of {totalKeys}.
					Replace the wallet promptly — create a new one with a fresh key and move the funds.
				</p>
			</div>

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={goToKeys}>
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
				<label class="label" for="multisig-name">Name your wallet</label>
				<input
					id="multisig-name"
					class="input"
					placeholder="e.g. Family savings"
					maxlength="60"
					bind:value={multisigName}
					onfocus={selectPrefilledName}
				/>
				<span class="hint">Just a label — you can't break anything here.</span>
			</div>

			<div class="confirm-summary">
				<div class="confirm-row">
					<span class="hint">Quorum</span>
					<span>{threshold} of {totalKeys} keys required to spend</span>
				</div>
				{#if vaultMode !== null}
					<div class="confirm-row">
						<span class="hint">Vault type</span>
						<span>
							{vaultMode === 'collaborative'
								? 'Shared with other people (collaborative custody)'
								: 'Personal — all keys are yours'}
						</span>
					</div>
				{/if}
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

			<div class="seed-warning" role="note">
				<Icon name="alert-triangle" size={16} />
				<div class="seed-warning-body">
					<p>
						A multisig wallet needs <strong>ALL</strong> of its public keys to reconstruct.
						Download your wallet backup right after creating it, and before you fund it —
						without the backup and your signing devices, recovery is much harder.
					</p>
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
					disabled={!verified || creating || !multisigName.trim()}
					onclick={createMultisigNow}
				>
					{#if creating}<span class="spinner"></span>{/if}
					<Icon name="shield" size={14} />
					Create multisig wallet
				</button>
			</div>
		</section>
	{:else if step === 'done'}
		<!-- ==================================================== Step 5: done -->
		<section class="step-body card card-pad pane done-pane" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="done-hero">
				<span class="done-icon"><Icon name="shield" size={24} /></span>
				<h2 class="done-title">Your multisig wallet is ready</h2>
				<p class="done-sub">
					{threshold} of {totalKeys} keys now guard anything you send to it.
				</p>
			</div>

			{#if !configImported}
			<div class="next-card backup-card">
				<span class="next-title">
					<Icon name="arrow-down-left" size={15} />
					First: download your backup
				</span>
				<p class="next-copy">
					Save this file somewhere safe — it's how you see and recover this wallet in another
					wallet app if this one is ever unavailable. It contains only <strong>public</strong>
					keys: it can't spend, but without it (or the original keys' details) rebuilding the
					wallet is much harder.
				</p>
				<div class="row" style="gap: 8px; flex-wrap: wrap">
					<a
						href="/api/wallets/multisig/{createdId}/caravan"
						class="btn btn-primary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Download backup (JSON)
					</a>
					<a
						href="/api/wallets/multisig/{createdId}/coldcard"
						class="btn btn-secondary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						ColdCard file
					</a>
					<a
						href="/api/wallets/multisig/{createdId}/descriptor?download=1"
						class="btn btn-ghost btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Descriptor (.txt)
					</a>
					<a
						href="/api/wallets/multisig/{createdId}/backup-pdf"
						class="btn btn-secondary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Printable backup (PDF)
					</a>
				</div>
			</div>
			{/if}

			{#if hasColdcardKey || hasQrKey}
				<div class="next-card register-card">
					<span class="next-title">
						<Icon name="alert-triangle" size={15} />
						{hasColdcardKey ? 'Register this wallet on your ColdCard' : 'Register this wallet on your air-gapped signer'}
					</span>
					<p class="next-copy">
						{#if hasColdcardKey}
							Your ColdCard <strong>only signs for multisig wallets it knows</strong> — it will refuse
							this one until you teach it, once:
						{:else}
							Air-gapped signers like SeedSigner and Passport <strong>only sign for multisig
							wallets they know</strong> — teach yours, once:
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
							href="/api/wallets/multisig/{createdId}/coldcard"
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
					Grab a receive address from the wallet page. Start with a small test amount, watch it
					arrive, and spend it once — then move real savings in.
				</p>
			</div>

			{#if !backedUp && !configImported}
				<p id="backup-gate-note" class="backup-gate-warning" role="alert">
					<Icon name="alert-triangle" size={14} />
					Download your backup above before continuing — it's the only way to reconstruct
					this multisig wallet if Cairn's data is lost.
				</p>
			{/if}

			<div class="pane-actions" style="justify-content: center">
				{#if backedUp || configImported}
					<a href="/wallets/multisig/{createdId}?created=1" class="btn btn-primary">
						Go to your multisig wallet
						<Icon name="arrow-right" size={14} />
					</a>
				{:else}
					<button
						type="button"
						class="btn btn-primary"
						disabled
						aria-describedby="backup-gate-note"
					>
						Go to your multisig wallet
						<Icon name="arrow-right" size={14} />
					</button>
				{/if}
			</div>
		</section>
	{/if}
</div>

<style>
	.wizard {
		max-width: 720px;
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

	/* Non-committing cosigner-match suggestion (cairn-jaev). */
	.cosigner-hint {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 10px;
		padding: 11px 13px;
		font-size: 13px;
		color: var(--text);
		background: var(--accent-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		line-height: 1.5;
	}

	.cosigner-hint :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.cosigner-hint p {
		margin: 3px 0 0;
		color: var(--text-secondary);
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
		border: 1px solid var(--accent-border);
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

	/* --- step 1: managed-service referrals (quiet aside, never a modal) --- */

	.services-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.services-lead {
		font-size: 12.5px;
		font-weight: 600;
	}

	.services-sub {
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.services-list {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.service-item {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}

	.service-logo {
		width: 22px;
		height: 22px;
		object-fit: contain;
		border-radius: 4px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.service-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.service-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
	}

	.service-name:hover {
		text-decoration: underline;
	}

	.service-desc {
		font-size: 12px;
		color: var(--text-secondary);
		line-height: 1.5;
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

	/* Quiet, informational — the estimate must not dominate the card. */
	.preset-time {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.preview-caption {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: -6px;
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

	/* Narrow screens: stack the M-of-N fields instead of overflowing. */
	@media (max-width: 480px) {
		.custom-inputs {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}

		.custom-of {
			padding-bottom: 0;
		}

		.custom-inputs .custom-field .input {
			width: 100%;
		}
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

	/* The key's derivation path — quiet secondary detail (cairn-3mhi). */
	.slot-path {
		font-size: 11px;
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
		width: 34px;
		height: 34px;
		flex-shrink: 0;
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

	/* Touch-target bump: ~44px on touch screens and small viewports. */
	@media (pointer: coarse), (max-width: 480px) {
		.slot-remove {
			width: 44px;
			height: 44px;
		}
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

	/* --- vault-mode question + banner (cairn-fdlf.4/.5) --- */

	.mode-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
	}

	.mode-note {
		line-height: 1.6;
	}

	.mode-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		background: var(--accent-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.mode-banner :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.mode-banner-text {
		flex: 1;
		min-width: 0;
	}

	.mode-change {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12px;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}

	/* --- known-device-keys reuse offers (cairn-fdlf.4) --- */

	.known-keys {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.known-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 600;
	}

	.known-title :global(svg) {
		color: var(--success);
	}

	.known-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.known-meta {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.known-name {
		font-size: 13px;
		font-weight: 500;
	}

	.known-sub {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	/* --- collaborative paste instructions (cairn-fdlf.5) --- */

	.collab-paste-note {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 13px;
		font-size: 12.5px;
		background: var(--accent-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		line-height: 1.6;
	}

	.collab-paste-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.collab-paste-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.collab-paste-body p {
		margin: 0;
		color: var(--text-secondary);
	}

	.collab-paste-body strong {
		color: var(--text);
	}

	/* Narrow screens: one full-width card per row keeps labels readable. */
	@media (max-width: 480px) {
		.method-grid,
		.cat-grid {
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

	/* Greyed-out tile (e.g. BitBox02 for a plain-P2SH multisig): muted with color
	   tokens, not a blanket opacity, so the explanatory copy stays readable. */
	.method-card.disabled {
		background: transparent;
		border-style: dashed;
		cursor: not-allowed;
	}

	.method-card.disabled .method-title {
		color: var(--text-secondary);
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

	/* --- same-seed warning (keys + review steps) --- */

	.seed-warning {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 14px;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border-strong);
		border-radius: var(--radius-control);
		color: var(--warning);
	}

	.seed-warning > :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.seed-warning-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.seed-warning-body p {
		margin: 0;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.seed-warning-body p strong {
		color: var(--text);
	}

	.seed-warning-body p.seed-note {
		font-size: 12px;
		color: var(--text-muted);
	}

	/* Backup gate on the Done step — the "Go to your wallet" CTA is disabled
	   until a config backup is downloaded; this explains why. */
	.backup-gate-warning {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--warning);
		text-align: left;
	}

	.backup-gate-warning > :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
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

	.review-fp-dup {
		color: var(--warning);
		font-weight: 600;
	}

	.test-address {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
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
		border-color: var(--accent-border-strong);
		background: var(--accent-muted);
	}

	.register-card {
		border-color: var(--accent-border-strong);
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
