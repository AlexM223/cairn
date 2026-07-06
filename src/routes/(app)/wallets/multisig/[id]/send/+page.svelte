<script lang="ts">
	import { tick } from 'svelte';
	import { replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import type { ConstructedMultisigPsbt, MultisigSigningProgress } from '$lib/server/bitcoin/multisigPsbt';
	// Signing-mass estimator: the pure constants + math live in the shared
	// (environment-neutral) module so this page runs the SAME arithmetic the
	// server does — no restated device profiles or tier thresholds.
	import { tierForVsize, quorumSecondsRange } from '$lib/shared/signingMass';
	import type { MassTier, SigningMass } from '$lib/shared/signingMass';
	import type { SavedMultisigTransaction } from '$lib/server/multisigTransactions';
	import { KEY_CATEGORY_LABELS, quorumLabel } from '../../labels';
	// The QR signer is a props-driven pass-through (the DEVICE does the
	// multisig math), so the wallets flow's component is reused as-is.
	import QrSigner from '../../../[id]/send/_components/QrSigner.svelte';
	import type { SignerContext } from '../../../[id]/send/_components/signerContract';
	import MultisigFileSigner from './_components/MultisigFileSigner.svelte';
	import MultisigTrezorSigner from './_components/MultisigTrezorSigner.svelte';
	import MultisigLedgerSigner from './_components/MultisigLedgerSigner.svelte';
	import MultisigBitboxSigner from './_components/MultisigBitboxSigner.svelte';
	import MultisigJadeUsbSigner from './_components/MultisigJadeUsbSigner.svelte';
	import CoinControl from '../../../[id]/send/_components/CoinControl.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';

	let { data } = $props();

	type StepKey = 'create' | 'review' | 'sign' | 'confirm' | 'sent';

	const STEPS: { key: StepKey; label: string }[] = [
		{ key: 'create', label: 'Create' },
		{ key: 'review', label: 'Review' },
		{ key: 'sign', label: 'Sign' },
		{ key: 'confirm', label: 'Confirm' },
		{ key: 'sent', label: 'Sent' }
	];

	const SATS_PER_BTC = 100_000_000;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const multisigId = data.multisig.id;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const required = data.multisig.threshold;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const keys = data.multisig.keys;

	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeTx: SavedMultisigTransaction | null = data.resume?.transaction ?? null;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeSummary = data.resume?.summary ?? null;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeProgress: MultisigSigningProgress | null = data.resume?.progress ?? null;
	// Per-person signing roster for a SHARED wallet ("Alice signed, Bob waiting"),
	// or null for a solo wallet. Read-only snapshot from the loader's reconcile.
	// svelte-ignore state_referenced_locally — per-navigation constant
	const roster = data.resume?.roster ?? null;

	function initialStep(): StepKey {
		if (!resumeTx) return 'create';
		if (resumeTx.status === 'completed') return 'sent';
		if (resumeTx.status === 'awaiting_signature') {
			return resumeProgress?.complete ? 'confirm' : 'sign';
		}
		return 'review';
	}

	// svelte-ignore state_referenced_locally — intentional per-load seed
	let step = $state<StepKey>(initialStep());
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let draft = $state<SavedMultisigTransaction | null>(resumeTx);
	let details = $state<ConstructedMultisigPsbt | null>(null);
	// The server's quorum progress object — refreshed by every build/attach
	// response, THE authority the per-key stepper renders from.
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let progress = $state<MultisigSigningProgress | null>(resumeProgress);

	// What Review/Confirm/Sent render — fresh build or reconstructed on resume.
	type ReviewDisplay = Omit<ConstructedMultisigPsbt, 'inputs' | 'change'> & {
		inputs: { txid: string; vout: number; value: number | null }[];
		change: { value: number } | null;
	};
	const review = $derived.by<ReviewDisplay | null>(() => {
		if (details) return details;
		if (!draft) return null;
		return {
			psbtBase64: draft.psbt,
			fee: draft.fee,
			feeRate: draft.feeRate,
			vsize: draft.fee && draft.feeRate ? Math.round(draft.fee / draft.feeRate) : 0,
			amount: draft.amount,
			recipient: draft.recipient,
			recipients: draft.recipients,
			change: resumeSummary?.change ?? null,
			inputs: resumeSummary?.inputs ?? []
		};
	});

	function syncTxParam(id: number) {
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.get('tx') === String(id)) return;
			url.searchParams.set('tx', String(id));
			replaceState(url, {});
		} catch {
			/* pre-hydration — the in-memory draft still drives the flow */
		}
	}

	// ------------------------------------------------------------- CREATE step
	type RecipientRow = { key: number; address: string; amountBtc: string };
	let rowKey = 0;
	function seedRows(): RecipientRow[] {
		if (resumeTx && resumeTx.recipients.length > 0) {
			return resumeTx.recipients.map((r) => ({
				key: rowKey++,
				address: r.address,
				amountBtc: r.amount > 0 ? formatBtc(r.amount, { trim: true }) : ''
			}));
		}
		return [{ key: rowKey++, address: '', amountBtc: '' }];
	}
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let rows = $state<RecipientRow[]>(seedRows());
	let amountMode = $state<'btc' | 'max'>('btc');

	function addRow() {
		rows = [...rows, { key: rowKey++, address: '', amountBtc: '' }];
		amountMode = 'btc';
	}

	function removeRow(key: number) {
		if (rows.length <= 1) return;
		rows = rows.filter((r) => r.key !== key);
	}

	type FeeChoice = 'fast' | 'normal' | 'economy' | 'custom';
	let feeChoice = $state<FeeChoice>('normal');
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let customFee = $state(String(data.fees?.halfHour ?? 5));

	const feeRate = $derived.by(() => {
		const fallback = Number(customFee) || 1;
		if (feeChoice === 'fast') return data.fees?.fastest ?? fallback;
		if (feeChoice === 'normal') return data.fees?.halfHour ?? fallback;
		if (feeChoice === 'economy') return data.fees?.economy ?? fallback;
		return Math.max(1, fallback);
	});

	const looksLikeAddress = (a: string) => /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{6,90}$/.test(a.trim());
	const isMax = $derived(amountMode === 'max' && rows.length === 1);
	const rowsValid = $derived(
		rows.every((r) => {
			if (r.address.trim().length === 0 || !looksLikeAddress(r.address)) return false;
			if (isMax) return true;
			return Number(r.amountBtc) > 0 && Number.isFinite(Number(r.amountBtc));
		})
	);
	const canBuild = $derived(rowsValid && feeRate >= 1);

	let building = $state(false);
	let buildError = $state<string | null>(null);

	// Manual coin control (optional): selected "txid:vout" keys, empty = automatic.
	let selectedCoins = $state<string[]>([]);

	async function build() {
		if (!canBuild || building) return;
		building = true;
		buildError = null;
		const recipients = rows.map((r) => ({
			address: r.address.trim(),
			amount: (isMax ? 'max' : Math.round(Number(r.amountBtc) * SATS_PER_BTC)) as number | 'max'
		}));
		// Restrict selection to the chosen coins only when some are actually picked.
		const onlyUtxos = selectedCoins.map((k) => {
			const [txid, vout] = k.split(':');
			return { txid, vout: Number(vout) };
		});
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/psbt`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					recipients,
					feeRate,
					...(onlyUtxos.length > 0 ? { onlyUtxos } : {})
				})
			});
			const body = await res.json();
			if (!res.ok) {
				// { error } from the wallet; { message } from a requireFeature 403.
				buildError = body.error ?? body.message ?? 'Could not build the transaction.';
				return;
			}
			draft = body.draft as SavedMultisigTransaction;
			details = body.details as ConstructedMultisigPsbt;
			progress = (body.progress as MultisigSigningProgress) ?? null;
			activeKeyId = null;
			signFlash = null;
			syncTxParam(draft.id);
			step = 'review';
		} catch {
			buildError = 'Could not reach Cairn to build the transaction.';
		} finally {
			building = false;
		}
	}

	// ------------------------------------------------------------- REVIEW step
	let inputsOpen = $state(false);
	const feePctOfAmount = $derived.by(() => {
		if (!review || review.amount <= 0) return null;
		return (review.fee / review.amount) * 100;
	});

	// --------------------------------------------- signing-mass ceremony copy
	//
	// The build response's signingMass block (see signingMass.ts) drives every
	// time estimate here. One copy rule everywhere: signing time is DEVICE
	// VERIFICATION time — it never changes the network fee.

	const signingMass = $derived<SigningMass | null>(details?.signingMass ?? null);

	/** Humane duration range: minutes once the top clears 90 s, else seconds. */
	function signingRange(lo: number, hi: number, style: 'short' | 'long' = 'short'): string {
		const l = Math.max(0, lo);
		const h = Math.max(l, hi);
		if (h > 90) {
			const lm = Math.max(1, Math.round(l / 60));
			const hm = Math.max(lm, Math.round(h / 60));
			const unit = style === 'long' ? (hm === 1 ? 'minute' : 'minutes') : 'min';
			return lm === hm ? `${lm} ${unit}` : `${lm}–${hm} ${unit}`;
		}
		const round5 = (s: number) => Math.max(5, Math.round(s / 5) * 5);
		const ls = round5(l);
		const hs = Math.max(ls, round5(h));
		const unit = style === 'long' ? 'seconds' : 'sec';
		return ls === hs ? `${ls} ${unit}` : `${ls}–${hs} ${unit}`;
	}

	/** Per-signer bracket across device kinds: fastest lo … slowest hi. */
	function perSignerBracket(mass: SigningMass): { lo: number; hi: number } {
		let lo = Infinity;
		let hi = 0;
		for (const d of mass.perDevice) {
			lo = Math.min(lo, d.secondsLo);
			hi = Math.max(hi, d.secondsHi);
		}
		return { lo: lo === Infinity ? 0 : lo, hi };
	}

	/** Chip estimate for a pending key: perDevice matched on the key's device
	 *  routing. file/qr keys could be ANY device, so they honestly get none. */
	function deviceEstimate(key: MultisigKey): string | null {
		if (!signingMass) return null;
		const d = signingMass.perDevice.find((p) => p.device === key.deviceType);
		return d ? `~${signingRange(d.secondsLo, d.secondsHi)}` : null;
	}

	// ------------------------- per-coin masses (lazy, one fetch, client math)
	//
	// The Review step's "Coins being spent" list is this flow's input display
	// (the multisig Create step has no coin control), so the mass disclosure
	// attaches there: opening the list fetches /api/wallets/multisig/:id/utxo-mass ONCE,
	// then everything below is client-side arithmetic — no per-toggle round
	// trips.

	type UtxoMassRow = { txid: string; vout: number; parentVsize: number; tier: MassTier };
	let utxoMasses = $state<Map<string, UtxoMassRow> | null>(null);
	let massFetch: 'idle' | 'loading' | 'done' | 'failed' = 'idle';

	async function ensureUtxoMasses() {
		if (massFetch !== 'idle') return;
		massFetch = 'loading';
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/utxo-mass`);
			if (!res.ok) {
				massFetch = 'failed';
				return;
			}
			const body = (await res.json()) as { masses?: UtxoMassRow[] };
			const map = new Map<string, UtxoMassRow>();
			for (const m of body.masses ?? []) map.set(`${m.txid}:${m.vout}`, m);
			utxoMasses = map;
			massFetch = 'done';
		} catch {
			massFetch = 'failed';
		}
	}

	function toggleInputs() {
		inputsOpen = !inputsOpen;
		if (inputsOpen) void ensureUtxoMasses();
	}

	function coinMass(txid: string, vout: number): UtxoMassRow | undefined {
		return utxoMasses?.get(`${txid}:${vout}`);
	}

	const MASS_TIER_LABELS: Record<MassTier, string> = {
		low: 'fast to sign',
		medium: 'slower to sign',
		high: 'slow to sign'
	};

	// Per-signer (m = 1) or whole-ceremony (m = quorum threshold) estimate,
	// bracketed across the shared device profiles. Delegates to the shared
	// quorumSecondsRange so the page and server never drift.
	function massBracket(
		totalParentVsize: number,
		inputCount: number,
		m: number
	): { lo: number; hi: number } {
		return quorumSecondsRange({
			totalParentVsize,
			inputCount,
			threshold: m,
			totalKeys: keys.length
		});
	}

	/**
	 * The coin-list mass summary, recomputed locally from the fetched per-coin
	 * masses (unique parents only, matching computeSigningMass). Degrade rule:
	 * if any spent coin's mass is unknown, fall back to the server's
	 * signingMass block; if that's absent too, show nothing.
	 */
	const coinMassLine = $derived.by<{
		tier: MassTier;
		perSigner: { lo: number; hi: number };
		total: { lo: number; hi: number };
	} | null>(() => {
		if (!review || review.inputs.length === 0) return null;
		if (utxoMasses) {
			const seen = new Set<string>();
			let totalParentVsize = 0;
			let complete = true;
			for (const inp of review.inputs) {
				const m = coinMass(inp.txid, inp.vout);
				if (!m) {
					complete = false;
					break;
				}
				if (seen.has(m.txid)) continue;
				seen.add(m.txid);
				totalParentVsize += m.parentVsize;
			}
			if (complete) {
				return {
					tier: tierForVsize(totalParentVsize),
					perSigner: massBracket(totalParentVsize, review.inputs.length, 1),
					total: massBracket(totalParentVsize, review.inputs.length, required)
				};
			}
		}
		if (signingMass) {
			return {
				tier: signingMass.tier,
				perSigner: perSignerBracket(signingMass),
				total: signingMass.totalSeconds
			};
		}
		return null;
	});

	// -------------------------------------------------- SIGN: per-key stepper
	//
	// The server's progress object is the only authority: `collected` (min
	// signatures across inputs), `complete`, and per-key attribution in
	// `progress.keys` — each entry a (fingerprint, account path) key origin
	// whose own derived PUBKEY was matched against the PSBT's partial
	// signatures. The client maps those identities onto the multisig's key
	// roster to paint chips, pick the next key, and let the user reorder ("use
	// this key instead" — the signer-cursor pattern). NEVER match by
	// fingerprint alone: two keys derived from the same seed at different
	// BIP-48 accounts share one fingerprint, and fingerprint matching used to
	// mark them ALL signed after a single signature — hiding the next-signer
	// panel and wedging the spend entirely (cairn-x54). A key whose
	// (fingerprint, path) identity is duplicated in the roster can never be
	// individually attributed; the counts stay right regardless because they
	// come from the PSBT, not the chips.

	type MultisigKey = (typeof keys)[number];

	// Per-key routing override: Trezor/Ledger keys can fall back to the
	// generic file method until their drivers land (part 2).
	let fileOverride = $state<Record<number, boolean>>({});
	let activeKeyId = $state<number | null>(null);
	// Bumped to remount the active signer from scratch (clean retry / next key).
	let signerEpoch = $state(0);
	let signFlash = $state<string | null>(null);

	/** Roster path → the canonical form progress.keys carries ("m/48'/0'/0'/2'"). */
	function normalizePath(p: string): string {
		const s = p
			.trim()
			.replace(/^m\/?/i, '')
			.replace(/[hH’]/g, "'");
		return s === '' ? 'm' : `m/${s}`;
	}
	function keyIdentity(fingerprint: string, path: string): string {
		return `${fingerprint.toLowerCase()}|${normalizePath(path)}`;
	}
	// Duplicate identities (same fingerprint AND same account path — e.g. two
	// origin-less keys both recorded as 00000000/m) are indistinguishable:
	// never tick either off a single signature.
	const identityCounts = new Map<string, number>();
	for (const k of keys) {
		const id = keyIdentity(k.fingerprint, k.path);
		identityCounts.set(id, (identityCounts.get(id) ?? 0) + 1);
	}
	const hasUnattributableKey = keys.some(
		(k) => (identityCounts.get(keyIdentity(k.fingerprint, k.path)) ?? 0) > 1
	);

	const signedIdentities = $derived(
		new Set(
			(progress?.keys ?? [])
				.filter((k) => k.signed)
				.map((k) => keyIdentity(k.fingerprint, k.path))
		)
	);
	const collected = $derived(progress?.collected ?? 0);
	const remainingNeeded = $derived(Math.max(0, required - collected));
	// Once the PSBT is finalizable, per-key attribution may be unknowable
	// (finalization strips per-input data) — the Sign step then shows the
	// quorum-met state instead of claiming any particular key signed or not.
	const quorumMet = $derived(progress?.complete ?? false);

	function isSigned(key: MultisigKey): boolean {
		const id = keyIdentity(key.fingerprint, key.path);
		return identityCounts.get(id) === 1 && signedIdentities.has(id);
	}

	const unsignedKeys = $derived(keys.filter((k) => !isSigned(k)));
	const activeKey = $derived(
		unsignedKeys.find((k) => k.id === activeKeyId) ?? unsignedKeys[0] ?? null
	);
	// Signing order: the chosen key first, then the rest in position order.
	// A key whose place in that queue falls beyond the signatures still needed
	// is a spare — shown, marked "not needed", still selectable.
	const signingQueue = $derived(
		activeKey
			? [activeKey, ...unsignedKeys.filter((k) => k.id !== activeKey.id)]
			: unsignedKeys
	);
	function isSpare(key: MultisigKey): boolean {
		const idx = signingQueue.findIndex((k) => k.id === key.id);
		return idx >= 0 && idx >= remainingNeeded;
	}

	function chooseKey(id: number) {
		activeKeyId = id;
		signError = null;
		signFlash = null;
		signerEpoch += 1;
	}

	// Trezor/Ledger keys can't sign over USB until part 2 — the user can route
	// them through the generic file method (and back) per key.
	function overrideToFile() {
		if (!activeKey) return;
		fileOverride = { ...fileOverride, [activeKey.id]: true };
		signerEpoch += 1;
	}

	function clearOverride() {
		if (!activeKey) return;
		const next = { ...fileOverride };
		delete next[activeKey.id];
		fileOverride = next;
		signerEpoch += 1;
	}

	const effectiveDevice = $derived.by(() => {
		if (!activeKey) return null;
		if (fileOverride[activeKey.id]) return 'file';
		return activeKey.deviceType;
	});

	// The cosigner roster in the shape the USB drivers take (MultisigSignKey) —
	// position order, public key material only. Device availability probing
	// happens inside each signer component, client-side (like the wallets flow).
	const signKeys = keys.map((k) => ({
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path
	}));

	// The active key's position in the roster — the BitBox02 driver's ourXpubIndex
	// (which cosigner in the ordered set is the connected device). -1 when no key
	// is active; the signer only mounts when activeKey exists, so it never sees -1.
	const activeKeyIndex = $derived(activeKey ? keys.findIndex((k) => k.id === activeKey.id) : -1);

	let attaching = $state(false);
	let signError = $state<string | null>(null);

	// Central attach path: EVERY signing method funnels its signed PSBT through
	// this PATCH. The server merges the new signature into the stored PSBT
	// (idempotent), re-verifies it commits to the reviewed transaction, and
	// returns fresh quorum progress — which decides whether the stepper moves
	// to the next key or to Confirm.
	async function attachSignedPsbt(psbt: string) {
		if (!psbt || attaching || !draft) return;
		attaching = true;
		signError = null;
		const before = new Set(signedIdentities);
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/transactions/${draft.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ psbt })
			});
			const body = await res.json();
			if (!res.ok) {
				signError = body.error ?? body.message ?? 'That PSBT could not be attached.';
				return;
			}
			draft = body.transaction as SavedMultisigTransaction;
			const fresh = body.progress as MultisigSigningProgress | null;
			if (!fresh) {
				signError = 'The signature was stored but progress could not be read — reload the page.';
				return;
			}
			const prevCollected = progress?.collected ?? 0;
			progress = fresh;

			if (fresh.complete) {
				step = 'confirm';
				return;
			}
			if (fresh.collected > prevCollected) {
				// Attribute the new signature for the flash message when possible —
				// by (fingerprint, path) identity, never by bare fingerprint.
				const newId = (fresh.keys ?? [])
					.filter((k) => k.signed)
					.map((k) => keyIdentity(k.fingerprint, k.path))
					.find((id) => !before.has(id));
				const who =
					newId && identityCounts.get(newId) === 1
						? keys.find((k) => keyIdentity(k.fingerprint, k.path) === newId)?.name
						: undefined;
				const more = fresh.required - fresh.collected;
				signFlash = `${who ? `Signature from ${who}` : 'Signature'} added — ${more} more ${
					more === 1 ? 'signature' : 'signatures'
				} needed.`;
				activeKeyId = null; // advance to the next unsigned key
				signerEpoch += 1;
			} else {
				signError =
					'That PSBT was read, but it added no new signature — it may already be counted, or the wrong device signed. Pick the next key and sign the freshly downloaded file.';
			}
		} catch {
			signError = 'Could not reach Cairn to attach the signed transaction.';
		} finally {
			attaching = false;
		}
	}

	function handleSigned(signedPsbtBase64: string) {
		void attachSignedPsbt(signedPsbtBase64.trim());
	}

	// The PSBT signers consume is the CURRENT combined one — each device adds
	// its signature on top of everything already collected.
	const currentPsbtUrl = $derived(
		draft ? `/api/wallets/multisig/${multisigId}/transactions/${draft.id}/file` : '#'
	);
	const registrationUrl = `/api/wallets/multisig/${multisigId}/coldcard`;

	const signerContext = $derived.by<SignerContext | null>(() => {
		if (!draft || !review) return null;
		const extra = review.recipients.length - 1;
		return {
			walletId: multisigId,
			draftId: draft.id,
			scriptType: data.multisig.scriptType,
			destinationAddress:
				extra > 0
					? `${review.recipients[0].address} (+${extra} more recipient${extra === 1 ? '' : 's'})`
					: review.recipient,
			amountSats: review.amount,
			feeSats: review.fee,
			changeSats: review.change?.value ?? 0
		};
	});

	// ------------------------------------------------------------ CONFIRM step
	let broadcasting = $state(false);
	let broadcastError = $state<string | null>(null);
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let sentTxid = $state<string | null>(resumeTx?.txid ?? null);

	async function broadcast() {
		if (broadcasting || !draft) return;
		broadcasting = true;
		broadcastError = null;
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/transactions/${draft.id}/broadcast`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const body = await res.json();
			if (res.status === 409) {
				sentTxid = body?.transaction?.txid ?? sentTxid;
				step = 'sent';
				return;
			}
			if (!res.ok) {
				broadcastError = body.error ?? body.message ?? 'Broadcast failed.';
				return;
			}
			sentTxid = body.txid as string;
			draft = body.transaction as SavedMultisigTransaction;
			step = 'sent';
		} catch {
			broadcastError = 'Could not reach Cairn to broadcast.';
		} finally {
			broadcasting = false;
		}
	}

	// -------------------------------------------------------------- navigation
	let pageEl = $state<HTMLElement | null>(null);
	let initialStepRendered = false;
	$effect(() => {
		void step;
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

	const explorerUrl = $derived(sentTxid ? `/explorer/tx/${sentTxid}` : '#');
	const quorum = quorumLabel(required, keys.length);
</script>

<!-- Signing-mass advisory panel (Review + Sign). Advisory only — it never
     blocks a step. Amber past ~10 min of total ceremony, red past ~30 min or
     on device-timeout risk; the split suggestion appears only when the mass
     is actually divisible (splitSuggested), because splitting a spend whose
     mass comes from ONE huge parent wouldn't help. -->
{#snippet massPanel(mass: SigningMass)}
	{#if mass.warnLevel === 'red'}
		<div class="mass-panel red" role="alert">
			<Icon name="alert-triangle" size={16} />
			<div>
				<strong>
					This will take approximately {signingRange(
						mass.totalSeconds.lo,
						mass.totalSeconds.hi,
						'long'
					)} across all {required} signing devices.
				</strong>
				{#if mass.splitSuggested}
					Consider sending as two separate transactions to avoid device timeouts.
				{:else}
					Keep each device connected until it finishes — this is verification time on the
					devices, not a network delay.
				{/if}
				<span class="mass-note">The network fee is not affected.</span>
			</div>
		</div>
	{:else if mass.warnLevel === 'amber'}
		<div class="mass-panel amber" role="note">
			<Icon name="alert-triangle" size={16} />
			<div>
				<strong>
					This will take approximately {signingRange(
						mass.totalSeconds.lo,
						mass.totalSeconds.hi,
						'long'
					)} across all {required} signing devices.
				</strong>
				Some coins in this spend came from large batch payouts, which each device verifies in
				full. <span class="mass-note">The network fee is not affected.</span>
			</div>
		</div>
	{/if}
{/snippet}

<svelte:head>
	<title>Send · {data.multisig.name} · Cairn</title>
</svelte:head>

<div class="send-page" bind:this={pageEl}>
	<header class="page-head">
		<a class="back" href={`/wallets/multisig/${multisigId}`}>
			<Icon name="chevron-left" size={15} />
			<span>{data.multisig.name}</span>
		</a>
		<h1 class="page-title">Send from your wallet</h1>
		<p class="quorum-line text-secondary">
			{quorum} multisig — this spend needs signatures from {required}
			{required === 1 ? 'key' : 'different keys'}.
		</p>
	</header>

	<div class="stepper-wrap card card-pad">
		<Stepper steps={STEPS} current={step} />
	</div>

	<!-- ============================================================ CREATE -->
	{#if step === 'create'}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<HowItWorks id="multisig-send-psbt">
				<p>
					Cairn builds an <Term
						tip="A Partially Signed Bitcoin Transaction — an unsigned proposal each of your signing devices reviews and signs in turn. Private keys never touch Cairn's server."
						>unsigned transaction (a PSBT)</Term
					> describing exactly what will be sent. Because this wallet is {quorum} multisig, no single
					device can authorize it — you'll walk the same PSBT through {required} of your keys, one at
					a time, and Cairn merges the signatures.
				</p>
				<p>
					<strong>That's the point of a multisig wallet:</strong> a thief (or a bug) with one key gets nothing.
					Verify the destination and amount on each device's own screen as you go.
				</p>
			</HowItWorks>

			<div class="card card-pad stack" style="gap: 18px">
				{#each rows as row, i (row.key)}
					<div class="recipient-block" class:multi={rows.length > 1}>
						{#if rows.length > 1}
							<div class="row recipient-block-head">
								<span class="label">Recipient {i + 1}</span>
								<button
									type="button"
									class="row-remove"
									aria-label={`Remove recipient ${i + 1}`}
									onclick={() => removeRow(row.key)}
								>
									<Icon name="x" size={14} />
								</button>
							</div>
						{/if}
						<div class="field">
							{#if rows.length === 1}
								<label class="label" for={`recipient-${row.key}`}>Recipient address</label>
							{/if}
							<input
								id={`recipient-${row.key}`}
								class="input mono"
								placeholder="bc1q…"
								bind:value={row.address}
								autocomplete="off"
								spellcheck="false"
							/>
							{#if row.address.length > 0 && !looksLikeAddress(row.address)}
								<p class="hint" style="color: var(--warning)">
									That doesn't look like a Bitcoin address yet.
								</p>
							{/if}
						</div>

						<div class="field">
							<div class="row amount-head">
								<span class="label" id={`amount-label-${row.key}`}>Amount</span>
								{#if rows.length === 1}
									<div class="seg" role="group" aria-label="Amount mode">
										<button
											type="button"
											class="seg-btn"
											class:active={amountMode === 'btc'}
											onclick={() => (amountMode = 'btc')}>BTC</button
										>
										<button
											type="button"
											class="seg-btn"
											class:active={amountMode === 'max'}
											onclick={() => (amountMode = 'max')}
											title="Sweep the whole spendable balance">Max</button
										>
									</div>
								{/if}
							</div>
							{#if !isMax}
								<div class="amount-input">
									<input
										class="input tabular"
										inputmode="decimal"
										placeholder="0.00000000"
										bind:value={row.amountBtc}
										aria-labelledby={`amount-label-${row.key}`}
									/>
									<span class="unit">BTC</span>
								</div>
								{#if Number(row.amountBtc) > 0}
									<p class="hint tabular">
										{formatSats(Math.round(Number(row.amountBtc) * SATS_PER_BTC))} sats
									</p>
								{/if}
							{:else}
								<div class="max-note">
									<Icon name="zap" size={15} />
									<span>Sweeps the wallet's entire spendable balance to this address, minus the fee.</span>
								</div>
							{/if}
						</div>
					</div>
				{/each}

				<div class="row batch-row">
					<button type="button" class="btn btn-ghost btn-sm" onclick={addRow}>
						<Icon name="plus" size={14} /> Add another recipient
					</button>
				</div>

				<div class="field">
					<span class="label">Fee rate</span>
					<div class="fee-grid">
						{#each [{ k: 'fast', label: 'Fast', rate: data.fees?.fastest, eta: '~10 min' }, { k: 'normal', label: 'Normal', rate: data.fees?.halfHour, eta: '~30 min' }, { k: 'economy', label: 'Economy', rate: data.fees?.economy, eta: '~1 hr+' }] as opt (opt.k)}
							<button
								type="button"
								class="fee-card"
								class:active={feeChoice === opt.k}
								onclick={() => (feeChoice = opt.k as FeeChoice)}
							>
								<span class="fee-label">{opt.label}</span>
								<span class="fee-rate tabular">
									{opt.rate != null ? formatFeeRate(opt.rate) : '—'}
								</span>
								<span class="fee-eta">{opt.eta}</span>
							</button>
						{/each}
						<button
							type="button"
							class="fee-card custom"
							class:active={feeChoice === 'custom'}
							onclick={() => (feeChoice = 'custom')}
						>
							<span class="fee-label">Custom</span>
							<div class="custom-input" role="presentation">
								<input
									class="input tabular"
									inputmode="decimal"
									bind:value={customFee}
									onfocus={() => (feeChoice = 'custom')}
									aria-label="Custom fee rate in sat/vB"
								/>
								<span class="unit-sm">sat/vB</span>
							</div>
						</button>
					</div>
					{#if !data.fees}
						<p class="hint">Live fee estimates are unavailable — set a custom sat/vB rate.</p>
					{/if}
					<p class="hint">
						Multisig inputs are larger than single-signature ones ({quorum} needs {required}
						signatures per coin), so the same fee rate costs a little more in total fees.
					</p>
				</div>

				{#if data.utxos.length > 0}
					{#if data.flags?.coin_control === false}
						<!-- Coin control disabled by an admin: explain why rather than silently
						     dropping the picker; selection stays empty so the send uses automatic
						     coin selection (parity with the single-sig flow, cairn-zcui). -->
						<FeatureDisabled
							block
							message="Choosing specific coins to spend has been disabled by your administrator."
						/>
					{:else}
						<!-- Optional manual coin control — collapsed so the default flow stays clean.
						     Same component as the single-sig send; the signing-mass chips point at
						     this multisig's own utxo-mass endpoint. -->
						<div class="field">
							<CoinControl
								walletId={multisigId}
								utxos={data.utxos}
								bind:selected={selectedCoins}
								tipHeight={data.tipHeight}
								massEndpoint={`/api/wallets/multisig/${multisigId}/utxo-mass`}
							/>
						</div>
					{/if}
				{/if}

				{#if buildError}
					<div class="form-error" role="alert">{buildError}</div>
				{/if}

				<div class="row" style="justify-content: flex-end; gap: 10px">
					<a class="btn btn-ghost" href={`/wallets/multisig/${multisigId}`}>Cancel</a>
					<button class="btn btn-primary" onclick={build} disabled={!canBuild || building}>
						{#if building}<span class="spinner"></span> Building…{:else}Review transaction<Icon
								name="arrow-right"
								size={15}
							/>{/if}
					</button>
				</div>
			</div>
		</section>

	<!-- ============================================================ REVIEW -->
	{:else if step === 'review' && review}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<p class="step-lead">
				Check every detail now — after this, {required} devices will each confirm this exact
				transaction, and once broadcast it <strong>cannot be reversed.</strong>
			</p>

			<div class="card review-hero">
				{#if review.recipients.length === 1}
					<div class="review-line">
						<span class="overline">Sending</span>
						<span class="hero-number send-amount">{formatBtc(review.amount)} <em>BTC</em></span>
						<span class="text-muted tabular">{formatSats(review.amount)} sats</span>
					</div>
					<div class="review-arrow"><Icon name="arrow-down-left" size={20} /></div>
					<div class="review-line">
						<span class="overline">To recipient</span>
						<span class="recipient mono">{review.recipient}</span>
					</div>
				{:else}
					<div class="review-line">
						<span class="overline">Sending total</span>
						<span class="hero-number send-amount">{formatBtc(review.amount)} <em>BTC</em></span>
						<span class="text-muted tabular"
							>{formatSats(review.amount)} sats · {review.recipients.length} recipients</span
						>
					</div>
					<div class="review-arrow"><Icon name="arrow-down-left" size={20} /></div>
					<div class="review-line">
						<span class="overline">To recipients</span>
						<div class="review-recipients">
							{#each review.recipients as r, i (i)}
								<div class="review-recipient-row">
									<span class="tabular batch-amt">{formatBtc(r.amount)} BTC</span>
									<span class="recipient mono">{r.address}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<div class="card card-pad detail-list">
				<div class="detail-row">
					<span class="text-secondary">Network fee</span>
					<span class="detail-val tabular">
						{formatSats(review.fee)} sats
						<span class="text-muted"
							>· {formatFeeRate(review.feeRate)}{#if feePctOfAmount != null}
								· {feePctOfAmount < 0.01 ? '<0.01' : feePctOfAmount.toFixed(2)}% of amount{/if}</span
						>
					</span>
				</div>
				{#if review.change}
					<div class="detail-row">
						<span class="text-secondary">Change back to the wallet</span>
						<span class="detail-val tabular">{formatSats(review.change.value)} sats</span>
					</div>
				{/if}
				<div class="detail-row">
					<span class="text-secondary">Signatures required</span>
					<span class="detail-val">{quorum}</span>
				</div>
				{#if signingMass}
					<!-- The IMPACT line's ceremony estimate: per-signer time × the M
					     devices that must each verify the full transaction. -->
					<div class="detail-row">
						<span class="text-secondary">
							<Term
								tip="Each signing device reads every coin's full parent transaction to verify amounts, and all {required} devices do that work independently. This is device verification time only — it never changes the network fee."
								>Total signing time</Term
							> across {required} devices
						</span>
						<span class="detail-val tabular"
							>~{signingRange(signingMass.totalSeconds.lo, signingMass.totalSeconds.hi)}</span
						>
					</div>
				{/if}
				{#if review.inputs.length > 0}
					<button
						class="utxo-toggle"
						aria-expanded={inputsOpen}
						aria-controls="review-utxo-list"
						onclick={toggleInputs}
					>
						<Icon name={inputsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
						<span
							>Coins being spent ({review.inputs.length}
							{review.inputs.length === 1 ? 'input' : 'inputs'})</span
						>
					</button>
					{#if inputsOpen}
						<div class="utxo-list fade-in" id="review-utxo-list">
							{#if coinMassLine}
								<p class="mass-line">
									Spending {review.inputs.length}
									{review.inputs.length === 1 ? 'coin' : 'coins'} · signing mass:
									<span class={`mass-tier ${coinMassLine.tier}`}>{coinMassLine.tier}</span>
									· ~{signingRange(coinMassLine.perSigner.lo, coinMassLine.perSigner.hi)} per signer
									× {required}
									{required === 1 ? 'signer' : 'signers'} = ~{signingRange(
										coinMassLine.total.lo,
										coinMassLine.total.hi
									)}
								</p>
							{/if}
							{#each review.inputs as inp (inp.txid + inp.vout)}
								{@const mass = coinMass(inp.txid, inp.vout)}
								<div class="utxo-row">
									<span class="mono text-muted">{truncateMiddle(inp.txid, 10, 8)}:{inp.vout}</span>
									<span class="utxo-row-right">
										{#if mass}
											<span
												class={`mass-tier ${mass.tier}`}
												title="How long signing devices spend verifying this coin's parent transaction — the network fee is not affected."
												>{MASS_TIER_LABELS[mass.tier]}</span
											>
										{/if}
										{#if inp.value != null}
											<span class="tabular">{formatSats(inp.value)} sats</span>
										{/if}
									</span>
								</div>
							{/each}
							{#if coinMassLine?.tier === 'high'}
								<p class="hint">
									The slowest coins here came from very large batch payouts. They're exactly as
									safe to spend as any other coin — but every signing device verifies their full
									parent transactions, so the ceremony runs long. Sending them in a separate,
									smaller transaction keeps each signing session shorter.
								</p>
							{/if}
						</div>
					{/if}
				{/if}
			</div>

			{#if signingMass}
				{@render massPanel(signingMass)}
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'create')}>
					<Icon name="chevron-left" size={15} /> Back &amp; edit
				</button>
				<button class="btn btn-primary" onclick={() => (step = 'sign')}>
					Looks good — collect signatures <Icon name="arrow-right" size={15} />
				</button>
			</div>
		</section>

	<!-- ============================================================== SIGN -->
	{:else if step === 'sign'}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="key-frame">
				<span class="badge badge-accent">Key {Math.min(collected + 1, required)} of {required}</span>
				<span class="text-secondary">
					Each signature comes from a different device — that's what makes it a multisig wallet.
				</span>
			</div>

			{#if signingMass}
				{@render massPanel(signingMass)}
			{/if}

			<!-- Live quorum progress, straight from the server's PSBT inspection.
			     role="status" + explicit aria-live: screen-reader users collecting
			     signatures over time must HEAR each quorum change, and the implicit
			     politeness of role="status" alone is inconsistently honored. -->
			<div class="card card-pad quorum-card">
				<div class="quorum-head" role="status" aria-live="polite">
					<span class="quorum-count tabular"
						>{collected} of {required} signatures collected</span
					>
					{#if remainingNeeded > 0}
						<span class="text-muted"
							>· {remainingNeeded} more {remainingNeeded === 1 ? 'signature' : 'signatures'} needed</span
						>
					{/if}
				</div>
				<div class="quorum-bar" role="progressbar" aria-valuemin={0} aria-valuemax={required} aria-valuenow={collected} aria-label="Signatures collected">
					<div class="quorum-bar-fill" style={`width:${Math.min(100, (collected / required) * 100)}%`}></div>
				</div>

				{#if roster}
					<!-- Shared-wallet signer roster: who has contributed a signature and
					     who is still owed one, by person (the key chips below show it by
					     key). Reconciled server-side against the real PSBT. -->
					<ul class="signer-roster" aria-label="Signers">
						{#each roster as member (member.userId)}
							<li class="signer-row" class:signed={member.hasSigned}>
								<span class="signer-state" aria-hidden="true">
									{#if member.hasSigned}
										<Icon name="check" size={13} strokeWidth={2.5} />
									{:else}
										<Icon name="clock" size={13} />
									{/if}
								</span>
								<span class="signer-name">
									{member.displayName}{#if member.isOwner}<span class="signer-tag">owner</span>{/if}
								</span>
								<span class="signer-status">{member.hasSigned ? 'Signed' : 'Waiting'}</span>
							</li>
						{/each}
					</ul>
				{/if}

				<!-- Per-key chips: signed / active / queued / spare. Unsigned chips are
				     buttons — clicking one makes it the active key ("use this key
				     instead", the signer-cursor reorder). -->
				<div class="key-chips">
					{#each keys as key (key.id)}
						{@const signed = isSigned(key)}
						{@const active = !quorumMet && activeKey?.id === key.id}
						{@const spare = !signed && !active && isSpare(key)}
						{#if signed}
							<div class="key-chip signed">
								<Icon name="check" size={13} strokeWidth={2.5} />
								<span class="chip-name">{key.name}</span>
								<span class="chip-meta">{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span></span>
							</div>
						{:else if quorumMet}
							<!-- Quorum met, but this key's attribution is unknown (a
							     finalized PSBT strips per-input data) — a neutral chip,
							     never a false "signed" or a next-signer CTA. -->
							<div class="key-chip">
								<span class="chip-dot" aria-hidden="true"></span>
								<span class="chip-name">{key.name}</span>
								<span class="chip-meta">{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span></span>
								<span class="chip-badge">Not needed — quorum met</span>
							</div>
						{:else}
							{@const chipEstimate = deviceEstimate(key)}
							<button
								type="button"
								class="key-chip"
								class:active
								class:spare
								onclick={() => chooseKey(key.id)}
								title={active ? 'Currently signing with this key' : 'Sign with this key instead'}
							>
								<span class="chip-dot" aria-hidden="true"></span>
								<span class="chip-name">{key.name}</span>
								<span class="chip-meta">{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span></span>
								{#if chipEstimate}
									<span
										class="chip-time"
										title="Estimated signing time on this device — it never changes the network fee."
										>{chipEstimate}</span
									>
								{/if}
								{#if spare}
									<span class="chip-badge">Not needed — {quorum} is enough</span>
								{:else if !active}
									<span class="chip-badge cta">Use this key instead</span>
								{/if}
							</button>
						{/if}
					{/each}
				</div>
				{#if hasUnattributableKey}
					<p class="hint">
						Keys that share both a master fingerprint and a derivation path can't be individually
						ticked off — the signature count above is still exact, straight from the transaction
						itself.
					</p>
				{/if}
			</div>

			{#if signFlash}
				<div class="sign-flash" role="status" aria-live="polite">
					<Icon name="check" size={15} />
					<span>{signFlash}</span>
				</div>
			{/if}

			{#if quorumMet}
				<!-- Reached via "Back" from Confirm (attach jumps there directly).
				     Never offer another signing panel on a complete transaction. -->
				<div class="quorum-done" role="status" aria-live="polite">
					<Icon name="check" size={16} strokeWidth={2.5} />
					<span>
						<strong>All {required} required signatures are in.</strong>
						The quorum is met — no more keys need to sign this transaction.
					</span>
				</div>
			{:else if activeKey && signerContext && draft}
				{#key `${activeKey.id}-${signerEpoch}`}
					{#if effectiveDevice === 'qr'}
						<!-- Hard prerequisite, not optional education: camera signers refuse
						     to sign for a multisig they have never been taught (device-side
						     security). The callout lives OUTSIDE the reused QR signer — that
						     is a wallets-flow component and stays untouched. -->
						<div class="register-callout" role="note">
							<Icon name="alert-triangle" size={15} />
							<div>
								<strong>First time signing with “{data.multisig.name}” on this device? Register the
									wallet on it first.</strong>
								SeedSigner, Passport, and Keystone <em>refuse to sign</em> for a multisig wallet
								they don't know — that's the device protecting you. Download the registration
								file and import it before scanning the transaction (SeedSigner: load it from SD
								or scan it as a QR; Passport/Keystone: import from microSD) — a one-time step per
								device. If the device warns about an unknown wallet or declines the PSBT, that's
								expected, not a bug: register the wallet and scan again.
								<div class="register-actions">
									<a
										class="btn btn-secondary btn-sm"
										href={registrationUrl}
										download
										aria-label={`Download the registration file that teaches your signing device the “${data.multisig.name}” multisig wallet — a one-time import before it will sign`}
									>
										<Icon name="arrow-down-left" size={14} /> Download registration file
									</a>
								</div>
							</div>
						</div>
						<QrSigner
							unsignedPsbt={draft.psbt}
							context={signerContext}
							onsigned={handleSigned}
							oncancel={() => (activeKeyId = null)}
						/>
					{:else if effectiveDevice === 'coldcard'}
						<MultisigFileSigner
							flavor="coldcard"
							fileUrl={currentPsbtUrl}
							{registrationUrl}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							keyName={activeKey.name}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							onsigned={handleSigned}
						/>
					{:else if effectiveDevice === 'trezor'}
						<MultisigTrezorSigner
							unsignedPsbt={draft.psbt}
							keyName={activeKey.name}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							scriptType={data.multisig.scriptType}
							multisigKeys={signKeys}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							changeSats={signerContext.changeSats}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'ledger'}
						<MultisigLedgerSigner
							{multisigId}
							unsignedPsbt={draft.psbt}
							keyName={activeKey.name}
							keyFingerprint={activeKey.fingerprint}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							scriptType={data.multisig.scriptType}
							multisigKeys={signKeys}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							changeSats={signerContext.changeSats}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'bitbox02'}
						<MultisigBitboxSigner
							unsignedPsbt={draft.psbt}
							keyName={activeKey.name}
							keyFingerprint={activeKey.fingerprint}
							ourKeyIndex={activeKeyIndex}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							scriptType={data.multisig.scriptType}
							multisigKeys={signKeys}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							changeSats={signerContext.changeSats}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'jade'}
						<MultisigJadeUsbSigner
							unsignedPsbt={draft.psbt}
							keyName={activeKey.name}
							ourKeyIndex={activeKeyIndex}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							scriptType={data.multisig.scriptType}
							multisigKeys={signKeys}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							changeSats={signerContext.changeSats}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else}
						<MultisigFileSigner
							flavor="generic"
							fileUrl={currentPsbtUrl}
							{registrationUrl}
							multisigName={data.multisig.name}
							threshold={required}
							totalKeys={keys.length}
							keyName={activeKey.name}
							destinationAddress={signerContext.destinationAddress}
							amountSats={signerContext.amountSats}
							feeSats={signerContext.feeSats}
							onsigned={handleSigned}
							oncancel={fileOverride[activeKey.id] ? clearOverride : undefined}
						/>
					{/if}
				{/key}
			{/if}

			{#if attaching}
				<div class="attach-status" role="status" aria-live="polite">
					<span class="spinner"></span> Merging the signature and re-checking it against the
					transaction you reviewed…
				</div>
			{:else if signError}
				<div class="form-error" role="alert">
					{signError}
					<div class="reject-actions">
						<button class="btn btn-secondary btn-sm" onclick={() => (signerEpoch += 1)}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</div>
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'review')}>
					<Icon name="chevron-left" size={15} /> Back to review
				</button>
				{#if quorumMet}
					<button class="btn btn-primary" onclick={() => (step = 'confirm')}>
						Continue to broadcast <Icon name="arrow-right" size={15} />
					</button>
				{:else}
					<span class="hint resume-hint">
						You can leave anytime — signatures are saved, and this page resumes where you left off.
					</span>
				{/if}
			</div>
		</section>

	<!-- =========================================================== CONFIRM -->
	{:else if step === 'confirm' && review}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="quorum-done" role="status" aria-live="polite">
				<Icon name="check" size={16} strokeWidth={2.5} />
				<span>
					<strong>{collected >= required ? `${required} of ${required}` : quorum} signatures collected.</strong>
					The quorum is met — this transaction is fully authorized and ready to broadcast.
				</span>
			</div>

			<div class="confirm-warning" role="alert">
				<Icon name="alert-triangle" size={18} />
				<div>
					<strong>You are about to broadcast this transaction.</strong>
					Broadcasting is <em>irreversible</em> — once the network accepts it, the coins are gone.
				</div>
			</div>

			<div class="card card-pad confirm-summary">
				<div class="confirm-row">
					<span class="text-secondary">Sending</span>
					<span class="detail-val tabular">{formatBtc(review.amount)} BTC</span>
				</div>
				{#if review.recipients.length === 1}
					<div class="confirm-row">
						<span class="text-secondary">To</span>
						<span class="mono confirm-recipient">{review.recipient}</span>
					</div>
				{:else}
					<div class="confirm-row confirm-batch">
						<span class="text-secondary">To {review.recipients.length} recipients</span>
						<div class="confirm-batch-list">
							{#each review.recipients as r, i (i)}
								<span class="mono confirm-recipient tabular"
									>{formatBtc(r.amount)} BTC → {truncateMiddle(r.address, 12, 10)}</span
								>
							{/each}
						</div>
					</div>
				{/if}
				<div class="confirm-row">
					<span class="text-secondary">Fee</span>
					<span class="detail-val tabular"
						>{formatSats(review.fee)} sats · {formatFeeRate(review.feeRate)}</span
					>
				</div>
				<div class="confirm-row">
					<span class="text-secondary">Authorized by</span>
					<span class="detail-val">{quorum} keys</span>
				</div>
			</div>

			{#if broadcastError}
				<div class="form-error" role="alert">
					{broadcastError}
					<div class="reject-actions">
						<a class="btn btn-secondary btn-sm" href={currentPsbtUrl} download>
							<Icon name="arrow-down-left" size={14} /> Download PSBT
						</a>
						<button class="btn btn-ghost btn-sm" onclick={() => (step = 'sign')}> Re-sign </button>
					</div>
				</div>
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'sign')} disabled={broadcasting}>
					<Icon name="chevron-left" size={15} /> Back
				</button>
				<button class="btn btn-primary" onclick={broadcast} disabled={broadcasting}>
					{#if broadcasting}<span class="spinner"></span> Broadcasting…{:else}<Icon
							name="zap"
							size={15}
						/> Broadcast transaction{/if}
				</button>
			</div>
		</section>

	<!-- ============================================================== SENT -->
	{:else if step === 'sent'}
		<section class="step-body fade-in sent-body" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="sent-check">
				<Icon name="check" size={30} strokeWidth={2.5} />
			</div>
			<h2 class="sent-title">Broadcast!</h2>
			<p class="text-secondary">
				Your {quorum} multisig transaction is on its way to the network.
			</p>

			{#if sentTxid}
				<a class="sent-txid mono" href={explorerUrl}>
					{truncateMiddle(sentTxid, 12, 12)}
					<Icon name="arrow-up-right" size={15} />
				</a>
				<div class="sent-copy">
					<CopyText value={sentTxid} display="Copy transaction ID" mono={false} />
				</div>
			{/if}

			{#if review}
				<div class="card card-pad sent-summary">
					<div class="confirm-row">
						<span class="text-secondary">Sent</span>
						<span class="detail-val tabular">{formatBtc(review.amount)} BTC</span>
					</div>
					{#if review.recipients.length === 1}
						<div class="confirm-row">
							<span class="text-secondary">To</span>
							<span class="mono confirm-recipient">{truncateMiddle(review.recipient, 14, 12)}</span>
						</div>
					{:else}
						<div class="confirm-row confirm-batch">
							<span class="text-secondary">To {review.recipients.length} recipients</span>
							<div class="confirm-batch-list">
								{#each review.recipients as r, i (i)}
									<span class="mono confirm-recipient tabular"
										>{formatBtc(r.amount)} BTC → {truncateMiddle(r.address, 12, 10)}</span
									>
								{/each}
							</div>
						</div>
					{/if}
					<div class="confirm-row">
						<span class="text-secondary">Fee</span>
						<span class="detail-val tabular">{formatSats(review.fee)} sats</span>
					</div>
				</div>
			{/if}

			<div class="row step-actions" style="justify-content: center">
				<a class="btn btn-secondary" href={`/wallets/multisig/${multisigId}`}>Back to wallet</a>
				<a class="btn btn-primary" href={`/wallets/multisig/${multisigId}/send`} data-sveltekit-reload
					>Send another</a
				>
			</div>
		</section>
	{/if}
</div>

<style>
	.send-page {
		max-width: 680px;
		margin: 0 auto;
	}

	.page-head {
		margin-bottom: 18px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 500;
		margin-bottom: 8px;
	}

	.back:hover {
		color: var(--accent);
	}

	.quorum-line {
		font-size: 13px;
		margin-top: 4px;
	}

	.stepper-wrap {
		padding: 22px 24px;
		margin-bottom: 24px;
	}

	.step-body {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.step-body:focus:not(:focus-visible) {
		outline: none;
	}

	.step-lead {
		font-size: 14px;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.step-lead strong {
		color: var(--text);
	}

	.step-actions {
		justify-content: space-between;
		gap: 10px;
		align-items: center;
	}

	.resume-hint {
		text-align: right;
		max-width: 300px;
	}

	/* ---- Create ---- */
	.recipient-block {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.recipient-block.multi {
		gap: 14px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 14px;
	}

	.recipient-block-head {
		justify-content: space-between;
	}

	.row-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		background: none;
		border: none;
		border-radius: var(--radius-chip);
		color: var(--text-muted);
		cursor: pointer;
	}

	.row-remove:hover {
		color: var(--danger, var(--text));
		background: var(--bg);
	}

	.batch-row {
		justify-content: space-between;
		gap: 10px;
	}

	.amount-head {
		justify-content: space-between;
	}

	.seg {
		display: inline-flex;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 2px;
	}

	.seg-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 12px;
		border-radius: var(--radius-chip);
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.seg-btn.active {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.amount-input {
		position: relative;
	}

	.amount-input .input {
		padding-right: 52px;
		font-size: 18px;
		font-family: var(--font-serif);
		font-variation-settings: 'opsz' 40;
	}

	.amount-input .unit {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 600;
	}

	.max-note {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 13px;
	}

	.fee-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 8px;
	}

	.fee-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		cursor: pointer;
		text-align: left;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.fee-card:hover {
		border-color: var(--text-muted);
	}

	.fee-card.active {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.fee-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.fee-rate {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.fee-eta {
		font-size: 11px;
		color: var(--text-muted);
	}

	.fee-card.custom {
		gap: 6px;
	}

	.custom-input {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.custom-input .input {
		padding: 5px 8px;
		font-size: 13px;
	}

	.unit-sm {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* ---- Review ---- */
	.review-hero {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		text-align: center;
	}

	.review-line {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		width: 100%;
		min-width: 0;
	}

	.send-amount {
		font-size: 34px;
	}

	.send-amount em {
		font-style: normal;
		font-size: 0.5em;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.review-arrow {
		color: var(--text-muted);
	}

	.review-recipients {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.review-recipient-row {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.batch-amt {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.recipient {
		font-size: 13.5px;
		word-break: break-all;
		max-width: 100%;
		color: var(--text);
		background: var(--bg);
		padding: 8px 12px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border-subtle);
	}

	.detail-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 11px 0;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		padding-top: 0;
	}

	.detail-val {
		color: var(--text);
		font-weight: 500;
		text-align: right;
	}

	.utxo-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 11px 0 0;
		cursor: pointer;
	}

	.utxo-toggle:hover {
		color: var(--accent);
	}

	.utxo-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 10px;
	}

	.utxo-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
		padding: 7px 10px;
		background: var(--bg);
		border-radius: var(--radius-chip);
	}

	.utxo-row-right {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	/* ---- signing-mass copy: coin-list summary line, tier chips, panels ---- */
	.mass-line {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.55;
	}

	.mass-tier {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border-radius: var(--radius-chip);
		padding: 1px 7px;
		white-space: nowrap;
	}

	.mass-tier.low {
		background: var(--success-muted);
		color: var(--success);
	}

	.mass-tier.medium {
		background: var(--warning-muted);
		color: var(--warning);
	}

	.mass-tier.high {
		background: var(--error-muted);
		color: var(--error);
	}

	.mass-panel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
	}

	.mass-panel :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}

	.mass-panel strong {
		display: block;
	}

	.mass-panel.amber {
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
	}

	.mass-panel.amber :global(svg) {
		color: var(--warning);
	}

	.mass-panel.red {
		background: var(--error-muted);
		border: 1px solid var(--error-border);
	}

	.mass-panel.red :global(svg) {
		color: var(--error);
	}

	.mass-note {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: var(--text-secondary);
	}

	.chip-time {
		font-size: 11px;
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border-radius: var(--radius-chip);
		padding: 2px 8px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	/* ---- Sign: quorum progress + per-key chips ---- */
	.key-frame {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
	}

	.quorum-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* Shared-wallet signer roster (person view). */
	.signer-roster {
		list-style: none;
		margin: 0;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--surface-elevated);
		border-radius: var(--radius-control);
	}

	.signer-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}

	.signer-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.signer-row.signed .signer-state {
		color: var(--success);
	}

	.signer-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.signer-tag {
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0 6px;
	}

	.signer-status {
		font-size: 12px;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.signer-row.signed .signer-status {
		color: var(--success);
	}

	.quorum-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 13.5px;
		flex-wrap: wrap;
	}

	.quorum-count {
		font-weight: 600;
		color: var(--text);
	}

	.quorum-bar {
		width: 100%;
		height: 8px;
		background: var(--surface-elevated);
		border-radius: 4px;
		overflow: hidden;
	}

	.quorum-bar-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 4px;
		transition: width 300ms var(--ease);
	}

	.key-chips {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.key-chip {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		width: 100%;
		text-align: left;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-family: var(--font-ui);
		font-size: 13px;
		color: var(--text);
	}

	button.key-chip {
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	button.key-chip:hover {
		border-color: var(--accent);
	}

	.key-chip.active {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.key-chip.signed {
		border-color: transparent;
		background: var(--success-muted);
		color: var(--success);
	}

	.key-chip.signed .chip-meta {
		color: var(--success);
		opacity: 0.8;
	}

	.key-chip.spare {
		opacity: 0.85;
	}

	.chip-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--border);
		flex-shrink: 0;
	}

	.key-chip.active .chip-dot {
		background: var(--accent);
	}

	.chip-name {
		font-weight: 600;
	}

	.chip-meta {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.chip-badge {
		margin-left: auto;
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		padding: 2px 8px;
		white-space: nowrap;
	}

	.chip-badge.cta {
		color: var(--accent);
		border-color: var(--accent-muted);
	}

	.sign-flash {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--success);
		background: var(--success-muted);
		border-radius: var(--radius-control);
		padding: 12px 14px;
		font-size: 13.5px;
		font-weight: 500;
	}

	/* ---- registration callout (QR variant; the ColdCard one lives in
	       MultisigFileSigner). Warning-toned: registration is a hard prerequisite
	       — the device refuses to sign without it. ---- */
	.register-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.register-callout :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.register-callout strong {
		display: block;
	}

	.register-actions {
		margin-top: 8px;
	}

	.attach-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 12px 14px;
	}

	.reject-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	/* ---- Confirm ---- */
	.quorum-done {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--success-muted);
		border-radius: var(--radius-card);
		padding: 14px 16px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text);
	}

	.quorum-done :global(svg) {
		color: var(--success);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.confirm-warning {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-card);
		padding: 14px 16px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text);
	}

	.confirm-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.confirm-warning strong {
		display: block;
	}

	.confirm-summary,
	.sent-summary {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.confirm-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
		font-size: 13.5px;
	}

	.confirm-recipient {
		word-break: break-all;
		text-align: right;
		max-width: 70%;
	}

	.confirm-batch {
		align-items: flex-start;
	}

	.confirm-batch-list {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}

	.confirm-batch-list .confirm-recipient {
		max-width: 100%;
	}

	/* ---- Sent ---- */
	.sent-body {
		align-items: center;
		text-align: center;
		padding-top: 12px;
	}

	.sent-check {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		background: var(--success-muted);
		color: var(--success);
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 4px;
	}

	.sent-title {
		font-family: var(--font-serif);
		font-variation-settings: 'opsz' 48;
		font-size: 26px;
		font-weight: 560;
	}

	.sent-txid {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		padding: 10px 16px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.sent-copy {
		font-size: 12.5px;
	}

	.sent-summary {
		width: 100%;
		text-align: left;
		margin-top: 8px;
	}

	@media (max-width: 520px) {
		.fee-grid {
			grid-template-columns: 1fr;
		}

		.send-amount {
			font-size: 28px;
		}

		.confirm-recipient {
			max-width: 60%;
		}

		.chip-badge {
			margin-left: 0;
		}

		.resume-hint {
			display: none;
		}
	}

	@media (max-width: 520px), (pointer: coarse) {
		.seg-btn {
			min-height: 44px;
			padding: 10px 16px;
		}

		.fee-card {
			min-height: 44px;
			padding: 12px 14px;
		}

		.key-chip {
			min-height: 44px;
		}
	}
</style>
