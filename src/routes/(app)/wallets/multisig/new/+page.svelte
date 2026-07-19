<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { deserialize, applyAction } from '$app/forms';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { safeAction } from '$lib/safeAction';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import Term from '$lib/components/Term.svelte';
	import { DESCRIPTOR_TIP_MULTISIG } from '$lib/termGlosses';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { scrollToTop } from '$lib/scrollToTop';
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
	import {
		WIZARD_PROGRESS_KEY,
		parseSavedMultisigProgress,
		hasMeaningfulMultisigProgress,
		keysStepSubLabel
	} from './_components/wizardProgress';
	import WizardKeyCheck from './_components/WizardKeyCheck.svelte';
	import QrKeyImport from './_components/QrKeyImport.svelte';
	import { PROACTIVE_PASSPHRASE_NOTE } from '../_components/keyCheckCopy';
	import { classifyQuorum, type QuorumRisk, type QuorumTier } from './_components/quorumRisk';
	import type { WizardDraftRow } from '$lib/server/multisigWizardDrafts';

	let { data } = $props();

	// Server-side wizard draft (cairn-jy3g, Phase 2 of cairn-1u41): the id of
	// the per-user draft row this session is writing to, seeded from a
	// ?draft=N resume (+page.server.ts's load()) if that's how this page was
	// reached. null until the FIRST key is committed (see queueDraftSync) —
	// no draft row is created for the education/quorum-only phase.
	// svelte-ignore state_referenced_locally — intentional per-load seed,
	// same pattern as the send flow's `savedAddresses`.
	let draftId = $state<number | null>(data.resumeDraft?.id ?? null);

	// Hand-off from the single-sig wizard (multisig-import UX): a file it
	// detected as a multisig config, stashed here so it survives the
	// navigation without riding along in the reload-resume snapshot.
	const PENDING_MULTISIG_IMPORT_KEY = 'cairn.pending-multisig-import.v1';

	// Explain-first restructure (MULTISIG-UX-DESIGN M2): the old single 'why'
	// step mixed pure education with the quorum choice on one screen. 'learn'
	// is now a zero-input read (WHAT/WHY/WHAT-YOU-NEED, no decision) that
	// always comes first; 'quorum' (renamed from 'why', same label
	// "Protection") carries the first technical input. See wizardProgress.ts
	// for how a pre-M2 resume snapshot's legacy `step: "why"` maps forward.
	type StepKey = 'learn' | 'quorum' | 'keys' | 'review' | 'confirm' | 'done';

	const STEPS: { key: StepKey; label: string }[] = [
		{ key: 'learn', label: 'Multisig' },
		{ key: 'quorum', label: 'Protection' },
		{ key: 'keys', label: 'Add keys' },
		{ key: 'review', label: 'Review' },
		{ key: 'confirm', label: 'Confirm' },
		{ key: 'done', label: 'Done' }
	];

	let step = $state<StepKey>('learn');

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
	// The import textarea, so the promoted "Import wallet config file" entry-step
	// card can open the (unchanged) disclosure below it and focus straight in.
	let importTextareaEl = $state<HTMLTextAreaElement | null>(null);

	/** Promote-to-first-class entry point for the import disclosure: opens it and
	 *  focuses the textarea, without changing the disclosure's own mechanics. */
	async function openImportPrompt() {
		showImport = true;
		await tick();
		importTextareaEl?.focus();
		importTextareaEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	const threshold = $derived(preset === '2of3' ? 2 : preset === '3of5' ? 3 : Number(customM));
	const totalKeys = $derived(preset === '2of3' ? 3 : preset === '3of5' ? 5 : Number(customN));
	const quorumValid = $derived(
		Number.isInteger(threshold) &&
			Number.isInteger(totalKeys) &&
			threshold >= 1 &&
			totalKeys >= threshold &&
			totalKeys <= 15
	);

	// Plain-language reason a custom quorum is invalid, so an M>N choice isn't a
	// dead-end with a greyed-out Continue and no message (cairn-t3za). The common
	// case — "keys required" edited above "total keys" — gets its own explainer;
	// everything else keeps the generic range hint.
	const quorumHint = $derived(
		Number.isInteger(threshold) &&
			Number.isInteger(totalKeys) &&
			threshold >= 1 &&
			totalKeys >= 1 &&
			threshold > totalKeys
			? "Keys required can't be more than the total number of keys — lower it, or add more keys."
			: 'The required number must be between 1 and the total, and the total at most 15.'
	);

	// --------------------------------- dynamic quorum risk panel (cairn-a1y8)
	//
	// Replaces the old "you can afford to lose N keys" line with tier-based
	// theft-vs-loss risk messaging (Unchained security model). Recomputed live
	// off threshold/totalKeys — covers both presets and the custom stepper.
	const quorumRisk = $derived<QuorumRisk | null>(
		quorumValid ? classifyQuorum(threshold, totalKeys) : null
	);

	// The live region announces risk-tier changes to screen readers, debounced
	// so holding a custom-stepper +/- button doesn't spam re-announcements.
	let announcedRisk = $state('');
	let riskAnnounceTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const risk = quorumRisk;
		clearTimeout(riskAnnounceTimer);
		if (!risk) return;
		riskAnnounceTimer = setTimeout(() => {
			announcedRisk = `${risk.label}.${risk.combos ? ` ${risk.combos}` : ''}`;
		}, 400);
		return () => clearTimeout(riskAnnounceTimer);
	});

	// Preset-card tier dots (cairn-a1y8): the two curated presets always show a
	// calm "sage = good" dot; the Custom card's dot reflects the live tier of
	// customM/customN — independent of which preset is currently selected, so
	// typing custom numbers previews their risk before switching to Custom.
	const TIER_DOT_LABEL: Record<QuorumTier, string> = {
		red: 'Risky protection level',
		salmon: 'Loose protection level',
		yellow: 'Fragile protection level',
		lightgreen: 'Solid protection level',
		green: 'Recommended protection level'
	};
	const customQuorumValid = $derived(
		Number.isInteger(Number(customM)) &&
			Number.isInteger(Number(customN)) &&
			Number(customM) >= 1 &&
			Number(customN) >= Number(customM) &&
			Number(customN) <= 15
	);
	const customTier = $derived<QuorumTier | null>(
		customQuorumValid ? classifyQuorum(Number(customM), Number(customN)).tier : null
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

	// Split out from chooseVaultMode so a sessionStorage-restored vaultMode
	// (cairn-1u41 — the mode itself is snapshotted, but the fetched offers
	// aren't) can re-fetch the reuse offers on mount too.
	async function refreshKnownKeys(mode: VaultMode) {
		knownKeys = [];
		// Reuse offers enhance the step; a failed lookup just means none show.
		const res = await callAction<{ knownKeys: KnownKey[] }>(
			'knownKeys',
			{ intent: mode, scriptType },
			''
		);
		if (res.ok) knownKeys = res.data.knownKeys ?? [];
	}

	async function chooseVaultMode(mode: VaultMode) {
		vaultMode = mode;
		await refreshKnownKeys(mode);
	}

	// Flip personal <-> collaborative in place (cairn bug report: the old
	// "Change" link dropped back to the full onboarding question — two big
	// cards plus paragraphs of explanation — which read as "restart the
	// wizard" even though no keys were lost. This swaps the mode directly, so
	// the derivation-path text next to the control updates immediately.
	// Only offered while no keys are added — the mode is locked per vault.
	async function switchVaultMode(mode: VaultMode) {
		if (vaultMode === mode) return;
		vaultMode = mode;
		resetKeyForm();
		await refreshKnownKeys(mode);
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
		// The QR method's camera (QrKeyImport -> QrScanner) stops itself on
		// unmount when this branch's {#if} condition changes — no manual stop
		// call needed here anymore.
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
		return safeAction<T>({ deserialize, applyAction }, action, body, fallback);
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
			// Server-side per-key commit (cairn-jy3g): a physical device ceremony
			// just happened — persist it now, not on exit.
			queueDraftSync();
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
	// Camera lifecycle, animated-BC-UR accumulation/progress, and the qr_scan
	// feature-flag gate (forwarded as `cameraDisabled`) now live in
	// QrKeyImport.svelte (wrapping the shared QrScanner) — see its mount in the
	// `method === 'qr'` branch below.

	function removeKey(i: number) {
		keys = keys.filter((_, idx) => idx !== i);
		lastAdded = null;
		// Editing the key set means this no longer matches an imported config file,
		// so it's now a from-scratch build → its backup becomes mandatory again.
		configImported = false;
		// Server-side per-key commit (cairn-jy3g): keep the draft's key list in
		// sync with a removal too, not just an add.
		queueDraftSync();
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
		/** Non-fatal notices about an accepted key path (cairn-acft) — e.g. a
		 *  legacy-P2SH key carrying an older path label. Safe to show verbatim. */
		warnings?: string[];
	}
	// Shown once, right after a successful import — not part of the reload-resume
	// snapshot (same treatment as importedNote/cosignerMatches: one-time import
	// affordance, not core wizard state).
	let importWarnings = $state<string[]>([]);

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
			importWarnings = imported.warnings ?? [];
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

	// Learn step's import opt-in (MULTISIG-UX-DESIGN 2b: "so an importer can
	// skip the tutorial") — same handleImport/handleImportFile the quorum
	// step's own disclosure uses, but auto-advances to Quorum on success so a
	// returning user who already has a config isn't stranded on a zero-input
	// education screen. The quorum step's copies stay exactly as they were
	// (no auto-advance) — only these two learn-step call sites add it.
	async function handleLearnImport() {
		await handleImport();
		if (!importError) advanceTo('quorum');
	}

	async function handleLearnImportFile(e: Event) {
		await handleImportFile(e);
		if (!importError) advanceTo('quorum');
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
					collaborative: vaultMode === null ? '' : String(vaultMode === 'collaborative'),
					// The `create` action deletes this draft server-side on success —
					// its job (surviving until the wallet exists) is done (cairn-jy3g).
					draftId: draftId !== null ? String(draftId) : ''
				},
				"Couldn't create the wallet — your keys are still here, try again."
			);
			if (!res.ok) {
				createError = res.error;
				return;
			}
			createdId = res.data.multisigId;
			step = 'done';
			// The server already deleted the draft row; drop the local id + URL
			// param too so a later visit never offers a resume of a finished vault.
			draftId = null;
			try {
				const url = new URL(window.location.href);
				if (url.searchParams.has('draft')) {
					url.searchParams.delete('draft');
					replaceState(url, {});
				}
			} catch {
				/* pre-hydration or blocked — harmless */
			}
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

	// ------------------------------------------- progress survives page reloads (cairn-1u41)
	//
	// Everything above is ephemeral component state, so a full-page reload used to
	// restart the wizard from scratch — on Umbrel, app_proxy's auth layer can force
	// exactly such a reload mid-wizard. That is far costlier here than in the
	// single-sig wizard (whose wizardProgress.ts this mirrors): each cosigner key
	// can cost a physical hardware-device ceremony, so losing progress after adding
	// 4 of 5 keys means redoing 4 ceremonies. A sessionStorage snapshot (tab-scoped,
	// public-key data only) lets a remounted wizard resume at the step it actually
	// reached. Captured at init, applied after hydration (onMount) so the
	// server-rendered markup is never contradicted. Phase 1 of cairn-1u41 —
	// sessionStorage only, no server-side draft persistence.
	const savedProgress = browser ? parseSavedMultisigProgress(safeReadProgress(), Date.now()) : null;
	// True after a resume: shows the "picked up where you left off" note.
	let resumed = $state(false);

	// Gate the persistence effect until onMount has run (cairn-pwo1). Svelte
	// runs user effects in source order, and the persistence $effect below is
	// declared BEFORE onMount — so on mount it would fire FIRST, while state is
	// still the pristine initial 'learn'/no-keys, and write that pristine
	// snapshot straight over the valid saved one in sessionStorage. The resume
	// only survived at all because `savedProgress` is captured into a const up
	// here before the clobber; but any re-initialization that reads storage
	// after the clobber (e.g. a second component instance during hydration, or a
	// second reload from Umbrel's app_proxy) then sees only the pristine 'learn'
	// and drops every collected cosigner key. Holding the first write until
	// after onMount restores (this flag flips true at the end of onMount) closes
	// that window entirely — the saved snapshot is never overwritten before it
	// has been read and applied.
	let hydrated = $state(false);

	function safeReadProgress(): string | null {
		try {
			return sessionStorage.getItem(WIZARD_PROGRESS_KEY);
		} catch {
			return null; // storage blocked (private mode etc.) — just start fresh
		}
	}

	// Persist on every change; once the wallet exists (Done view) the snapshot is
	// cleared so a later visit starts a fresh wizard, not a stale resume. A single
	// reactive effect (not a write-through on addKey) is enough — Svelte flushes
	// effects on a microtask after the mutation, well within the window before any
	// reload could plausibly interrupt the NEXT key's ceremony.
	$effect(() => {
		// Do not persist until onMount has restored any saved snapshot — see the
		// `hydrated` comment above. Reading `hydrated` first keeps this effect
		// subscribed to it, so the moment onMount flips it true the effect re-runs
		// and begins persisting the (restored or genuinely fresh) state.
		if (!hydrated) return;
		const snapshot = JSON.stringify({
			step,
			preset,
			customM,
			customN,
			scriptType,
			keys: $state.snapshot(keys),
			vaultMode,
			configImported,
			importedStartIndex,
			multisigName,
			savedAt: Date.now()
		});
		try {
			if (createdId !== null) sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
			else sessionStorage.setItem(WIZARD_PROGRESS_KEY, snapshot);
		} catch {
			// Best-effort: without storage the wizard still works, it just can't
			// survive a reload.
		}
	});

	// --------------------------------- server-side draft persistence (cairn-jy3g)
	//
	// Phase 2 of cairn-1u41: the sessionStorage snapshot above only survives a
	// same-tab reload within the hour. This complements it with a server-side
	// draft — one row per in-progress wizard, committed after EVERY key
	// add/remove (queueDraftSync is called from submitKey/removeKey/
	// goToReview above), resumable via ?draft=N from any tab or device. See
	// src/lib/server/multisigWizardDrafts.ts and the `draftSync` action in
	// +page.server.ts.

	/** Keeps ?draft= in the URL in sync so a reload (or sharing the link with
	 *  yourself — email, notes app) resumes the same draft. Mirrors the send
	 *  flow's syncTxParam. */
	function syncDraftParam(id: number) {
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.get('draft') === String(id)) return;
			url.searchParams.set('draft', String(id));
			replaceState(url, {});
		} catch {
			/* pre-hydration or blocked — the draft still exists server-side */
		}
	}

	/** Serializes overlapping calls (two keys added in quick succession
	 *  shouldn't race two draftSync POSTs, which could otherwise both try to
	 *  CREATE a fresh draft and end up with two rows). Each call waits for the
	 *  previous one to settle before firing — a short delay well within the
	 *  time a real device ceremony takes. */
	let draftSyncChain: Promise<void> = Promise.resolve();
	function queueDraftSync() {
		draftSyncChain = draftSyncChain.then(syncDraft, syncDraft);
	}

	async function syncDraft(): Promise<void> {
		if (!browser) return;
		// Nothing worth a server row until there's a real key to lose — the
		// education/quorum-only phase stays sessionStorage-only (cairn-jy3g:
		// "commit after each key", not on every quorum-stepper click).
		if (keys.length === 0 && draftId === null) return;
		const res = await callAction<{ draftId: number }>(
			'draftSync',
			{
				draftId: draftId !== null ? String(draftId) : '',
				name: multisigName,
				threshold: String(threshold),
				totalKeys: String(totalKeys),
				scriptType,
				vaultMode: vaultMode ?? '',
				step,
				configImported: String(configImported),
				importedStartIndex: String(importedStartIndex),
				keys: JSON.stringify($state.snapshot(keys))
			},
			''
		);
		// Best-effort: a failed background sync never blocks the wizard — the
		// sessionStorage snapshot still covers same-tab reload, and the next
		// key add/remove retries.
		if (!res.ok) return;
		draftId = res.data.draftId;
		syncDraftParam(draftId);
	}

	/** Abandons the server draft (Start over) so a later visit doesn't offer a
	 *  resume of work the user just explicitly discarded. Fire-and-forget +
	 *  owner-scoped + idempotent server-side, so it never blocks the local
	 *  reset even if the request fails. */
	function abandonDraft() {
		if (draftId === null) return;
		void callAction('draftAbandon', { draftId: String(draftId) }, '');
		draftId = null;
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.has('draft')) {
				url.searchParams.delete('draft');
				replaceState(url, {});
			}
		} catch {
			/* pre-hydration or blocked — harmless, the draft delete still went out */
		}
	}

	/** The escape hatch on the resume note: forget the snapshot, start clean. */
	function startOver() {
		resumed = false;
		step = 'learn';
		preset = '2of3';
		customM = 2;
		customN = 3;
		scriptType = 'p2wsh';
		keys = [];
		vaultMode = null;
		knownKeys = [];
		configImported = false;
		importedStartIndex = 0;
		multisigName = '';
		namePrefilledFromImport = false;
		verified = false;
		previewAddresses = [];
		previewError = null;
		createError = null;
		resetKeyForm();
		try {
			sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
		} catch {
			// Already reset in memory; a stale snapshot will age out.
		}
		abandonDraft();
	}

	/** Clears any in-flight resume snapshot before an explicit exit — the Cancel
	 *  link on the Why step (the only way out of the wizard short of finishing
	 *  it). Only meaningful once real progress exists (Cancel appears before any
	 *  keys are ever collected), but harmless either way. */
	function clearProgressOnExit() {
		try {
			sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
		} catch {
			// Best-effort — a lingering snapshot just offers a resume on the next
			// visit; it ages out on its own within the hour.
		}
	}

	// -------------------------------------------------------------- navigation
	//
	// The wizard's screen lives in `step`, not the URL — it stays
	// /wallets/multisig/new throughout. Step transitions are plain state updates
	// with no history writes at all, so the browser's history stack is never
	// touched by the wizard — Back always leaves the wizard for whatever page
	// preceded it, instead of walking back through steps.

	/** Advance to a later step. */
	function advanceTo(key: StepKey) {
		step = key;
	}

	function goToReview() {
		advanceTo('review');
		void loadPreview();
		// Persist the step advance too (cairn-jy3g) — a reload while reviewing
		// should resume ON Review, not back at the last key added. A no-op if no
		// draft exists yet (an all-imported vault can reach Review with zero
		// wizard-added keys; that resume is still fully covered by sessionStorage).
		queueDraftSync();
	}

	// Entering the Keys step — first time, via a forward move, or via the on-screen
	// Back button — always lands on the method picker with no stale device/error
	// state left over from a previous visit (e.g. a failed Ledger connect). Reuses
	// the same reset as the in-form "Different source" button; added keys are kept.
	function advanceToKeys() {
		resetKeyForm();
		advanceTo('keys');
	}

	/**
	 * Applies a server-side draft (cairn-jy3g, `?draft=N` resume) to local
	 * wizard state — the server-persisted counterpart of the sessionStorage
	 * restore branch below. A draft only ever exists once the wizard reached
	 * `threshold`/`totalKeys` (createWizardDraft always carries them, defaults
	 * 2-of-3 if a draft was somehow synced before the quorum step — can't
	 * happen via the UI, but keeps this defensive), so those reconstruct the
	 * preset the quorum step displays: an exact 2-of-3 / 3-of-5 match resumes
	 * onto that preset card, anything else onto 'custom' with the stored M/N.
	 */
	function applyResumeDraft(draft: WizardDraftRow) {
		if (draft.threshold === 2 && draft.totalKeys === 3) {
			preset = '2of3';
		} else if (draft.threshold === 3 && draft.totalKeys === 5) {
			preset = '3of5';
		} else {
			preset = 'custom';
			customM = draft.threshold;
			customN = draft.totalKeys;
		}
		scriptType = draft.scriptType;
		keys = draft.keys.map((k) => ({
			name: k.name,
			category: k.category,
			deviceType: k.deviceType,
			xpub: k.xpub,
			fingerprint: k.fingerprint,
			path: k.path
		}));
		vaultMode = draft.vaultMode;
		configImported = draft.configImported;
		importedStartIndex = draft.importedStartIndex;
		multisigName = draft.name;
		// Only resume onto a step this reconstructed state actually supports —
		// Review/Confirm need every quorum slot filled, same clamp
		// parseSavedMultisigProgress applies to a sessionStorage snapshot.
		const validSteps = STEPS.map((s) => s.key).filter((k): k is StepKey => k !== 'done');
		let resumedStep = (validSteps.includes(draft.step as StepKey) ? draft.step : 'keys') as StepKey;
		if ((resumedStep === 'review' || resumedStep === 'confirm') && keys.length !== draft.totalKeys) {
			resumedStep = 'keys';
		}
		step = resumedStep;
		resumed = true;
		if (vaultMode !== null) void refreshKnownKeys(vaultMode);
		if (step === 'review') void loadPreview();
	}

	/** In-app Back button: retreat one step in place (not a history operation).
	 *  Mirrors STEPS order; re-resets the Keys form on the way back in, same as
	 *  the forward path onto 'keys' (advanceToKeys), so both entries behave
	 *  identically. */
	function stepBack() {
		const idx = STEPS.findIndex((s) => s.key === step);
		const prevKey = STEPS[idx - 1]?.key;
		if (!prevKey || prevKey === 'done') return;
		if (prevKey === 'keys') resetKeyForm();
		step = prevKey;
	}

	onMount(() => {
		// A file dropped on the single-sig wizard that looked like a multisig
		// config (multisig-import UX) — stashed in sessionStorage, not the
		// reload-resume snapshot, so it takes priority over any in-progress
		// wizard and is consumed exactly once.
		let pending: string | null = null;
		try {
			pending = sessionStorage.getItem(PENDING_MULTISIG_IMPORT_KEY);
		} catch {
			// sessionStorage unavailable — fall through to the normal resume path.
		}
		if (pending) {
			try {
				sessionStorage.removeItem(PENDING_MULTISIG_IMPORT_KEY);
			} catch {
				// best-effort cleanup
			}
			try {
				sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
			} catch {
				// best-effort cleanup
			}
			importText = pending;
			showImport = true;
			void (async () => {
				await handleImport();
				if (!importError) advanceTo('keys');
			})();
		} else if (data.resumeDraft) {
			// An explicit ?draft=N navigation (cairn-jy3g) — takes priority over
			// the sessionStorage snapshot below: the user (or a link they saved)
			// deliberately asked for THIS draft, which may be newer than, or from
			// a different tab/device than, whatever sessionStorage holds.
			applyResumeDraft(data.resumeDraft);
		} else if (savedProgress && hasMeaningfulMultisigProgress(savedProgress)) {
			step = savedProgress.step;
			preset = savedProgress.preset;
			customM = savedProgress.customM;
			customN = savedProgress.customN;
			scriptType = savedProgress.scriptType;
			keys = savedProgress.keys;
			vaultMode = savedProgress.vaultMode;
			configImported = savedProgress.configImported;
			importedStartIndex = savedProgress.importedStartIndex;
			multisigName = savedProgress.multisigName;
			resumed = true;
			// Two side effects that the normal advanceTo()-driven transitions
			// perform but a direct state restore skips (a resume doesn't replay
			// the button clicks that got the user there the first time):
			// re-fetch the known-device-key reuse offers for the restored vault
			// mode, and re-run the address preview if landing back on Review.
			if (vaultMode !== null) void refreshKnownKeys(vaultMode);
			if (step === 'review') void loadPreview();
		}
		// Any saved snapshot has now been read and applied — open the gate so the
		// persistence effect starts saving from here on (cairn-pwo1). Runs in
		// every branch (pending import, resume, or a genuinely fresh start) so
		// ongoing progress is always persisted.
		hydrated = true;
	});

	// Every step change — button, back, or programmatic — moves focus to the
	// new step's section so screen readers announce the step and keyboard users
	// aren't stranded on a button that just unmounted. (Same pattern as the
	// send flow.) Also scrolls back to the top (#26) — on mobile especially,
	// advancing from a long step (e.g. Review) otherwise leaves the new step's
	// top scrolled out of view.
	let pageEl = $state<HTMLElement | null>(null);
	let initialStepRendered = false; // don't steal focus/scroll on page load
	$effect(() => {
		void step; // the only dependency — rerun on every step change
		if (!initialStepRendered) {
			initialStepRendered = true;
			return;
		}
		scrollToTop();
		void tick().then(() => {
			pageEl?.querySelector<HTMLElement>('.step-body')?.focus();
		});
	});

	const stepIndex = $derived(STEPS.findIndex((s) => s.key === step));
	// Secondary sub-progress for the Add-keys step (cairn-hla1) — see
	// keysStepSubLabel's doc comment in wizardProgress.ts.
	const keysSubLabel = $derived(keysStepSubLabel(quorumValid, keys.length, totalKeys));
	const stepAriaLabel = $derived(
		`Step ${stepIndex + 1} of ${STEPS.length}: ${STEPS[stepIndex]?.label ?? ''}` +
			// Fold the same sub-progress the visual step-subcount badge shows into
			// the announced label — that span is aria-hidden, so screen-reader
			// users get the fraction here instead.
			(step === 'keys' && keysSubLabel ? `, key ${keys.length} of ${totalKeys} added` : '')
	);
</script>

<svelte:head>
	<title>New multisig wallet — Heartwood</title>
</svelte:head>

<div class="wizard hw-page fade-in" bind:this={pageEl}>
	<GroveField volume="present" />
	<div class="wizard-content">
		<div class="wizard-eyebrow">
			<EyebrowBreadcrumb
				path={['Wallets']}
				current={`New multisig wallet · ${STEPS[stepIndex]?.label ?? ''}`}
			/>
		</div>
		<h1 class="wizard-title">Create a multisig wallet</h1>
		<p class="wizard-sub">
			Money that needs several of your keys to move — no single point of failure.
		</p>

		{#if resumed}
			<!-- A reload (or coming back to the tab) landed mid-wizard and we restored
			     the saved progress — say so, with a way out to a clean start. Every key
			     already collected survived; only an in-progress "add one key" form
			     entry (if any) was lost (cairn-1u41). -->
			<div class="resume-note" role="status">
				<Icon name="info" size={14} />
				<span class="grow">Picked up where you left off.</span>
				<button type="button" class="resume-reset" onclick={startOver}>Start over</button>
			</div>
		{/if}

		<!-- Step indicator — the Send flow's quiet text-step grammar (5a/4a), same
		     pattern as the single-sig wizard. -->
		<ol class="steps" aria-label="Setup progress">
			{#each STEPS as s, i (s.key)}
				<li class="step-item" class:active={i === stepIndex} class:done={i < stepIndex}>
					<span class="step-word">
						{s.label}
						{#if s.key === 'keys' && keysSubLabel}
							<!-- Visible on the TOP-level indicator (not just while already on
							     Add keys) so the real effort is legible from any step. -->
							<span class="step-subcount tabular" aria-hidden="true">{keysSubLabel}</span>
						{/if}
					</span>
					{#if i < STEPS.length - 1}<span class="step-line" aria-hidden="true"></span>{/if}
				</li>
			{/each}
		</ol>

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

	<!-- Quorum risk panel icons (cairn-a1y8) — small inline feather-style SVGs,
	     kept local to this file rather than the shared Icon.svelte set (which
	     has 'shield'/'alert-triangle' but not the other three). The shield
	     outline and alert-triangle path match Icon.svelte's own glyphs so the
	     panel reads as part of the same icon family. -->
	{#snippet riskIcon(icon: 'alert-triangle' | 'lock' | 'shield-alert' | 'shield-check' | 'shield')}
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="risk-icon"
		>
			{#if icon === 'alert-triangle'}
				<path
					d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01"
				/>
			{:else if icon === 'lock'}
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
				<path d="M7 11V7a5 5 0 0 1 10 0v4" />
			{:else if icon === 'shield-alert'}
				<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
				<path d="M12 8v4" />
				<path d="M12 16h.01" />
			{:else if icon === 'shield-check'}
				<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
				<path d="m9 12 2 2 4-4" />
			{:else}
				<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
			{/if}
		</svg>
	{/snippet}

	{#if step === 'learn'}
		<!-- ================================================== Step 1: learn -->
		<!-- Explain-first (MULTISIG-UX-DESIGN M2): pure education, zero technical
		     input. WHAT it is, WHY people use one, WHAT you need, and the
		     owner/cosigner role split — all BEFORE the quorum choice on the next
		     step. Repeat users (data.hasMultisigs) get it collapsed via
		     HowItWorks, same pattern the old combined why/quorum screen used. -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 1 · What a multisig wallet is</span>

			{#if data.hasMultisigs}
				<!-- Repeat users get the education collapsed out of the way. -->
				<HowItWorks id="multisig-learn" title="What a multisig wallet is">
					<p>
						An ordinary wallet has one key — lose it, and the money is gone. A
						<strong>multisig</strong> wallet is guarded by <strong>several keys</strong>, and it
						takes a set number of them — say, any 2 of 3 — to spend. Like a vault that needs two
						keys turned at once.
					</p>
					<p>
						<strong>Losing one key doesn't lose your money.</strong> With 2-of-3, a lost or damaged
						key just means you spend with the other two, and a thief needs two of your keys —
						kept in different places — before they can touch a single sat. Heartwood only ever
						sees <strong>public</strong> keys — it can watch and prepare transactions, never spend.
					</p>
					<p>
						Sharing it with other people? <strong>One person owns the wallet</strong> — they create
						it and broadcast spends — and the others are <strong>cosigners</strong> who approve with
						their key. You can invite them from the wallet's page after it's created.
					</p>
				</HowItWorks>
			{:else}
				<div class="why-panel learn-panel">
					<div class="learn-section">
						<h3 class="learn-heading">What a multisig wallet is</h3>
						<p>
							An ordinary wallet has one key — lose it, and the money is gone. A
							<strong>multisig</strong> ("multi-signature") wallet is guarded by
							<strong>several keys</strong>, and it takes a set number of them — say,
							<strong>any 2 of 3</strong> — to spend. Like a vault that needs two keys turned at
							once.
						</p>
					</div>
					<div class="learn-section">
						<h3 class="learn-heading">Why people use one</h3>
						<ul class="learn-list">
							<li>
								<strong>Losing one key doesn't lose your money.</strong> With 2-of-3, a lost or
								damaged key just means you spend with the other two.
							</li>
							<li>
								<strong>A stolen key isn't enough.</strong> A thief needs two of your keys — kept
								in different places — before they can touch a single sat.
							</li>
							<li>
								<strong>No single point of failure.</strong> For savings you don't touch often,
								this is the safest way to hold your own bitcoin.
							</li>
							<li>
								Heartwood only ever sees <strong>public</strong> keys — it can watch and prepare
								transactions, never spend. Your keys stay on your own devices.
							</li>
						</ul>
					</div>
					<div class="learn-section">
						<h3 class="learn-heading">What you'll need before you start</h3>
						<ul class="learn-list">
							<li>
								<strong>Several keys.</strong> For the recommended 2-of-3, that's three. A key can
								be a hardware wallet (Trezor, Ledger, ColdCard, BitBox02, Jade), an air-gapped QR
								signer, or a public key someone sends you.
							</li>
							<li>
								<strong>Each key on a different device or in a different place</strong> — that
								separation is the whole point of multisig.
							</li>
							<li>
								<strong>Only the public key from each</strong> — nothing that can spend. You'll add
								them one at a time on a later step.
							</li>
						</ul>
					</div>
					<div class="learn-section">
						<h3 class="learn-heading">Sharing it with other people?</h3>
						<p>
							If this wallet is shared, you'll each contribute one key.
							<strong>One person owns the wallet</strong> — they create it and broadcast the final
							transaction — and the <strong>others are cosigners</strong> who approve spends with
							their key. You can invite them from the wallet's page <strong>after</strong> it's
							created; nothing is shared automatically.
						</p>
					</div>
				</div>
			{/if}

			<!-- Quiet import opt-in (2b): lets someone who already has this wallet
			     in another app skip the tutorial entirely — the same disclosure
			     mechanics as the quorum step's copy below, just surfaced earlier. -->
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
								tip={DESCRIPTOR_TIP_MULTISIG}
								>descriptor</Term
							>, or a Caravan / Unchained wallet file (JSON) — Heartwood fills in the quorum and
							keys for you.
						</p>
						<textarea
							class="input mono import-input"
							rows="3"
							placeholder={'wsh(sortedmulti(2,[a1b2c3d4/48\'/0\'/0\'/2\']xpub…  or  {"name": …Caravan JSON…}'}
							spellcheck="false"
							bind:this={importTextareaEl}
							bind:value={importText}
						></textarea>
						{#if importError}
							<Banner variant="error">{importError}</Banner>
						{/if}
						<div class="row" style="gap: 8px; margin-top: 8px">
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								disabled={importing || !importText.trim()}
								onclick={handleLearnImport}
							>
								{#if importing}<span class="spinner"></span>{/if}
								Read it
							</button>
							<input
								type="file"
								accept=".json,.txt,application/json,text/plain"
								class="visually-hidden-file"
								bind:this={importFileInput}
								onchange={handleLearnImportFile}
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
						<!-- Links the previously-orphaned stateless signer (cairn-hla1,
						     symptom d): for someone who wants to spend from this config
						     right now without Heartwood remembering it at all — the
						     complement to "Read it" above, which imports it INTO a saved
						     wallet. Same descriptor/JSON works on either path. -->
						<p class="hint" style="margin-top: 10px">
							Or don't save it here at all —
							<a href="/wallets/multisig/stateless">work from it directly, nothing saved</a>.
						</p>
					</div>
				{/if}
			</div>

			<div class="pane-actions">
				<a href="/wallets" class="btn btn-ghost" onclick={clearProgressOnExit}>Cancel</a>
				<button type="button" class="btn btn-primary" onclick={() => advanceTo('quorum')}>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'quorum'}
		<!-- ============================================ Step 2: pick a quorum -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 2 · How much protection?</span>

			{#if !importedNote}
				<!-- Promoted, first-class import entry point (multisig-import UX) — the
				     import affordance used to be buried in the "Already have this wallet
				     in another app?" disclosure further down; it's the same disclosure
				     (still reachable there too), just also surfaced here so it isn't
				     missed. -->
				<div class="import-promo">
					<div class="import-promo-text">
						<Icon name="arrow-down-left" size={16} />
						<div>
							<span class="import-promo-title">Import wallet config file</span>
							<p class="import-promo-desc">
								Have this wallet in Sparrow, Caravan, or another app? Import its wallet config
								file and Heartwood will fill in the keys for you.
							</p>
						</div>
					</div>
					<button type="button" class="btn btn-secondary btn-sm" onclick={openImportPrompt}>
						Import wallet config file
					</button>
				</div>
			{/if}

			{#if importedNote}
				<div class="imported-note" role="status">
					<Icon name="check" size={14} />
					{importedNote}
				</div>
			{/if}

			{#if importWarnings.length > 0}
				<!-- Non-fatal import notices (cairn-acft) — e.g. a legacy-P2SH key
				     carrying an older path label. Calm and factual: nothing to fix,
				     nothing at risk, the import is safe as-is. -->
				<div class="cosigner-hint" role="status">
					<Icon name="info" size={15} />
					<div>
						{#each importWarnings as w (w)}
							<p>{w}</p>
						{/each}
					</div>
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
					<span class="preset-quorum">
						<span
							class="preset-dot preset-dot-sage"
							aria-label="Recommended protection level"
						></span>
						2 of 3
					</span>
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
					<span class="preset-quorum">
						<span
							class="preset-dot preset-dot-sage"
							aria-label="High-security protection level"
						></span>
						3 of 5
					</span>
					<span class="preset-name">High security</span>
					<span class="preset-desc">
						Any 3 of 5 keys spend — a clear majority, so no small group can move funds alone.
						You can lose up to 2 keys and still recover. More keys to set up and store.
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
					<span class="preset-quorum">
						<span
							class="preset-dot {customTier ? `preset-dot-${customTier}` : 'preset-dot-neutral'}"
							aria-label={customTier ? TIER_DOT_LABEL[customTier] : 'Protection level not set'}
						></span>
						M of N
					</span>
					<span class="preset-name">Custom</span>
					<span class="preset-desc">Choose your own numbers, up to 15 keys.</span>
					{#if preset === 'custom' && quorumValid && estimateLine(threshold, totalKeys)}
						<span class="preset-time tabular">{estimateLine(threshold, totalKeys)}</span>
					{/if}
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
						<Banner variant="error">{quorumHint}</Banner>
					{/if}
				</div>
			{/if}

			{#if quorumRisk}
				<!-- Dynamic quorum risk panel (cairn-a1y8) — replaces the old "you can
				     afford to lose N keys" line with tier-based theft-vs-loss risk
				     messaging (Unchained security model). Shows for both presets and
				     custom, right after the selection controls. -->
				<div class="risk-panel risk-{quorumRisk.tier}">
					<div class="risk-header">
						{@render riskIcon(quorumRisk.icon)}
						<span class="risk-label">{quorumRisk.label}</span>
						{#if quorumRisk.badge}<span class="badge badge-accent">{quorumRisk.badge}</span>{/if}
					</div>
					<p class="risk-body">{quorumRisk.body}</p>
					{#if quorumRisk.combos}<p class="risk-combos">{quorumRisk.combos}</p>{/if}
				</div>
				<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
					{announcedRisk}
				</div>
			{/if}

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
						<label class="radio-row radio-row-disabled" aria-disabled="true">
							<input type="radio" name="scriptType" value="p2sh" bind:group={scriptType} disabled />
							<span class="radio-text">
								<span class="radio-name">Legacy (P2SH) — import only</span>
								<span class="radio-desc">
									Higher fees, and no longer offered for new wallets. Already have a legacy
									P2SH multisig from another tool? Use "Already have this wallet in another
									app? Import it" below instead — Heartwood still loads and spends it.
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
								tip={DESCRIPTOR_TIP_MULTISIG}
								>descriptor</Term
							>, or a Caravan / Unchained wallet file (JSON) — Heartwood fills in the quorum and
							keys for you.
						</p>
						<textarea
							class="input mono import-input"
							rows="3"
							placeholder={'wsh(sortedmulti(2,[a1b2c3d4/48\'/0\'/0\'/2\']xpub…  or  {"name": …Caravan JSON…}'}
							spellcheck="false"
							bind:this={importTextareaEl}
							bind:value={importText}
						></textarea>
						{#if importError}
							<Banner variant="error">{importError}</Banner>
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
				<button type="button" class="btn btn-ghost" onclick={stepBack}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!quorumValid}
					onclick={advanceToKeys}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'keys'}
		<!-- ================================================ Step 3: add keys -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 3 · Add your {totalKeys} keys</span>
			<p class="step-lead">
				Each <Term
					tip="A key is a device or backup that can approve spending — a hardware wallet, a phone wallet, or a seed phrase stored somewhere safe."
					>key</Term
				> should live on a different device or in a different place. Heartwood only ever reads
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
				<Banner variant="error">
					You've added {keys.length} keys but the wallet only holds {totalKeys} — remove
					{keys.length - totalKeys} or go back and raise the total.
				</Banner>
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
							First, one question — it decides which key Heartwood reads from your devices.
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
						<p class="hint mode-note">
							One reminder from step 1: <strong>you'll own this wallet</strong> — you broadcast the
							spends everyone else approves. Invite cosigners from the wallet's page once it's
							created.
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
									<div class="mode-toggle" role="group" aria-label="Vault mode">
										<button
											type="button"
											class="mode-toggle-btn"
											class:selected={vaultMode === 'personal'}
											aria-pressed={vaultMode === 'personal'}
											onclick={() => switchVaultMode('personal')}
										>
											Personal
										</button>
										<button
											type="button"
											class="mode-toggle-btn"
											class:selected={vaultMode === 'collaborative'}
											aria-pressed={vaultMode === 'collaborative'}
											onclick={() => switchVaultMode('collaborative')}
										>
											Shared
										</button>
									</div>
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
									Keys Heartwood already knows
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

							<!-- Proactive passphrase caution (MULTISIG-KEY-AUDIT-DESIGN §4): a
							     lighter nudge shown for EVERY key source, before any mismatch has
							     happened — passphrase + multisig is an anti-pattern worth keeping
							     visible up front, not only after someone locks themselves out. -->
							<p class="hint passphrase-note">
								<Icon name="info" size={12} />
								{PROACTIVE_PASSPHRASE_NOTE}
							</p>

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
											Heartwood reads the multisig key straight from the device — the key it reads can
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
										QR") and hold the code up to your camera — animated (multi-frame) BC-UR
										exports reassemble automatically, with a progress bar while it films. The
										key in the QR can <strong>watch, never spend</strong>.
										{#if vaultMode === 'collaborative'}
											Because this vault is shared, the QR must carry the
											<span class="mono">m/45'</span> key <em>with</em> its origin info
											(fingerprint + path) — a bare key can't be checked for a shared vault.
										{/if}
									</p>
									<QrKeyImport
										vaultMode={vaultMode ?? 'personal'}
										existingKeys={keys}
										cameraDisabled={page.data.flags?.qr_scan === false}
										onaccepted={(k) => {
											pasteValue = k.xpub;
											fpValue = k.fingerprint;
											pathValue = k.path;
											void submitKey();
										}}
									/>
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
												key, so Heartwood can check it belongs to this vault.
											</p>
										</div>
									</div>
								{/if}
								<div class="field">
									<label class="label" for="key-xpub">
										Paste the
										<Term
											tip="An extended public key lets Heartwood track this key's addresses and balances without having the private key. It's safe to share — it can't spend funds on its own."
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
										<Banner variant="error">
											That's a private key. Never paste it anywhere. Export the public key
											instead (look for 'xpub' in your wallet).
										</Banner>
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
													? "Where in the device's key tree this key lives. A shared vault's keys come from m/45' — required here so Heartwood can check the key."
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
													the previous screen) and Heartwood reads the
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
								<Banner variant="error">{addError}</Banner>
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
				<button type="button" class="btn btn-ghost" onclick={stepBack}>
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
		<!-- ================================================== Step 4: review -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 4 · Review</span>
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
					<Banner variant="error">
						{previewError}
						{#snippet actions()}
							<button type="button" class="btn btn-secondary btn-sm" onclick={loadPreview}>
								<Icon name="refresh" size={13} />
								Try again
							</button>
						{/snippet}
					</Banner>
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
				<button type="button" class="btn btn-ghost" onclick={stepBack}>
					<Icon name="chevron-left" size={14} />
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={previewAddresses.length === 0}
					onclick={() => advanceTo('confirm')}
				>
					Continue
					<Icon name="chevron-right" size={14} />
				</button>
			</div>
		</section>
	{:else if step === 'confirm'}
		<!-- ================================================= Step 5: confirm -->
		<section class="step-body card card-pad pane" tabindex="-1" aria-label={stepAriaLabel}>
			<span class="overline">Step 5 · Confirm</span>

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

			<!-- Wave 2 verify block (MULTISIG-KEY-AUDIT-DESIGN §3/§7): the last
			     checkpoint before the wallet exists — re-derive-and-compare each
			     cosigner key now, while nothing is funded yet, instead of only
			     discovering a wrong export or a passphrase-enabled device later. -->
			<div class="key-check-block">
				<span class="key-check-title">
					<Icon name="shield" size={15} />
					Verify your keys before creating this wallet
				</span>
				<p class="hint">
					Re-connect each device (or re-paste its key) and Heartwood proves it still has the
					exact key you added — this is the moment to catch a mistake, before any money is at
					stake.
				</p>
				<div class="key-check-rows">
					{#each keys as key (key.xpub)}
						<WizardKeyCheck keyInfo={key} {scriptType} vaultMode={vaultMode ?? 'personal'} />
					{/each}
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
					<strong>backed up</strong> — its seed phrase written down and stored safely. Heartwood
					holds no keys and cannot recover them for me.
				</span>
			</label>

			{#if createError}
				<Banner variant="error">{createError}</Banner>
			{/if}

			<div class="pane-actions">
				<button type="button" class="btn btn-ghost" onclick={stepBack} disabled={creating}>
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
		<!-- ==================================================== Step 6: done -->
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
					this multisig wallet if Heartwood's data is lost.
				</p>
			{/if}

			<div class="pane-actions" style="justify-content: center">
				{#if backedUp || configImported}
					<a
						href="/wallets/multisig/{createdId}?created=1"
						class="btn btn-primary"
						data-sveltekit-replacestate
					>
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
</div>

<style>
	.wizard {
		max-width: 720px;
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

	/* --- resume note (shown after a mid-wizard reload restored progress —
	   cairn-1u41), matching the single-sig wizard's version --- */

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
	   no dots/circles), matching the single-sig wizard and the Send flow --- */

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

	/* Secondary sub-progress fraction on the "Add keys" step (cairn-hla1) —
	   quiet, non-uppercase, tabular so "2/5" doesn't jitter as digits change. */
	.step-subcount {
		display: inline-block;
		margin-left: 4px;
		font-weight: 500;
		letter-spacing: normal;
		text-transform: none;
		color: var(--text-faint);
	}

	.step-item.active .step-subcount {
		color: var(--accent-bright);
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

	/* Promoted import entry point (multisig-import UX) — first-class sibling of
	   the why-panel education block, not buried in the disclosure below. */
	.import-promo {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.import-promo-text {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.import-promo-text :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.import-promo-title {
		display: block;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.import-promo-desc {
		margin: 2px 0 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
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

	/* --- learn step (MULTISIG-UX-DESIGN M2): stacked WHAT/WHY/NEED/sharing
	   sections inside the (reused) why-panel box, expanded for new users. --- */
	.learn-panel {
		gap: 0;
	}

	.learn-section + .learn-section {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--accent-border);
	}

	.learn-heading {
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		margin: 0 0 6px;
	}

	.learn-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding-left: 18px;
	}

	.learn-list li {
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
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
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-serif);
		font-size: 24px;
		font-weight: 600;
		color: var(--accent);
	}

	/* Tier dot (cairn-a1y8): a quiet 8px indicator before each preset's quorum
	   number. Dot only — cards are never recolored. */
	.preset-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.preset-dot-sage,
	.preset-dot-green {
		background: var(--success);
	}

	.preset-dot-lightgreen {
		background: var(--success);
		opacity: 0.65;
	}

	.preset-dot-yellow {
		background: var(--warning);
	}

	.preset-dot-red {
		background: var(--error);
	}

	.preset-dot-salmon {
		background: var(--error);
		opacity: 0.6;
	}

	.preset-dot-neutral {
		background: var(--text-faint);
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

	/* --- dynamic quorum risk panel (cairn-a1y8) ---
	   Replaces the old .quorum-note. Five tiers on the Unchained security
	   model's theft-vs-loss trade-off. Body text stays on --text-secondary /
	   --text (not the saturated tier color) for AA contrast on tinted fills —
	   same precedent as .seed-warning-body above. */
	.risk-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border-subtle);
		transition:
			background-color 180ms var(--ease),
			border-color 180ms var(--ease),
			color 180ms var(--ease);
	}

	.risk-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.risk-icon {
		flex-shrink: 0;
	}

	.risk-label {
		font-size: 13.5px;
		font-weight: 500;
	}

	.risk-body {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.risk-combos {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.risk-red {
		background: var(--error-muted);
		border-color: var(--error-border);
		border-left: 4px solid var(--error);
		color: var(--error);
	}

	.risk-red .risk-label {
		font-weight: 700;
	}

	.risk-salmon {
		background: var(--caution-muted);
		border-color: var(--caution-border);
		color: var(--caution);
	}

	.risk-yellow {
		background: var(--warning-muted);
		border-color: var(--warning-border-strong);
		color: var(--warning);
	}

	.risk-lightgreen {
		background: var(--success-muted);
		border-color: var(--success-border);
		color: var(--success);
	}

	.risk-green {
		background: var(--success-muted);
		border-color: var(--success-border-strong);
		border-left: 4px solid var(--success);
		color: var(--success);
	}

	.risk-green .risk-label {
		font-weight: 700;
	}

	/* Visually hidden but present for screen readers — the debounced live
	   region announcing risk-tier changes (distinct from .visually-hidden-file,
	   which also hides from pointer events / keeps assistive tech access to a
	   file input, not a status message). */
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

	/* Greyed-out row: legacy P2SH is import-only, no longer a creation option
	   (cairn-acft) — muted like .method-card.disabled, not hidden, so someone
	   with an existing legacy wallet is routed to import instead of concluding
	   Heartwood can't handle it. */
	.radio-row-disabled {
		cursor: not-allowed;
	}

	.radio-row-disabled .radio-name {
		color: var(--text-secondary);
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

	.mode-toggle {
		display: inline-flex;
		flex-shrink: 0;
		gap: 2px;
		padding: 2px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.mode-toggle-btn {
		background: none;
		border: none;
		padding: 3px 8px;
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: calc(var(--radius-control) - 2px);
	}

	.mode-toggle-btn.selected {
		background: var(--accent-muted);
		color: var(--text);
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

	/* Proactive passphrase caution (§4) — a quiet inline note, not a warning box. */
	.passphrase-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
	}

	.passphrase-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
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

	/* Wave 2 verify block (MULTISIG-KEY-AUDIT-DESIGN §3/§7) — the last
	   checkpoint before the wallet is created. */
	.key-check-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.key-check-title {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.key-check-rows {
		display: flex;
		flex-direction: column;
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
