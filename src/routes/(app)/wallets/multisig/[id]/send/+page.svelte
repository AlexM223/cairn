<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { invalidate, replaceState } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import QuorumArc from '$lib/components/heartwood/QuorumArc.svelte';
	import BurialRings from '$lib/components/heartwood/BurialRings.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import AtTipPill from '$lib/components/heartwood/AtTipPill.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import { scrollToTop } from '$lib/scrollToTop';
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
	// Multisig has no address book, but the destination field's scan/paste
	// affordances (QR-SCAN-DESIGN.md Wave 3) are identical — reuse the
	// single-sig send flow's combobox with an empty saved list, which makes it
	// behave as a plain text input (see its own doc comment) plus scan/paste.
	import RecipientCombobox from '../../../[id]/send/_components/RecipientCombobox.svelte';
	import MultisigFileSigner from './_components/MultisigFileSigner.svelte';
	import TrezorSigner from '$lib/components/signing/TrezorSigner.svelte';
	import LedgerSigner from '$lib/components/signing/LedgerSigner.svelte';
	import BitboxSigner from '$lib/components/signing/BitboxSigner.svelte';
	import JadeUsbSigner from '$lib/components/signing/JadeUsbSigner.svelte';
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

	// The fee/utxo/tip slice is STREAMED from the server (cairn-vknb.4): the send
	// shell — and any resumed step — paints instantly, then this fills in when
	// Electrum answers. On invalidate the previous snapshot stays visible until
	// the fresh one resolves, so there's no skeleton flash on a block refresh.
	type SendChain = Awaited<(typeof data)['chain']>;
	let chain = $state<SendChain | null>(null);
	const chainLoading = $derived(chain === null);
	$effect(() => {
		const promise = data.chain;
		let stale = false;
		void promise.then((snap) => {
			if (!stale) chain = snap;
		});
		return () => {
			stale = true;
		};
	});

	// Live new-block updates refresh only the streamed fee/tip snapshot via the
	// existing SSE channel — never a poll. The coin/utxo scan rides along in the
	// same invalidate, which is fine: coins change on new blocks too.
	onMount(() =>
		onNewBlock(() => {
			void invalidate(`cairn:multisig-send:${multisigId}`);
		})
	);
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
	// Fees stream in, so the custom-rate starting value is seeded reactively (see
	// the effect below) rather than at load; '5' is the pre-estimate fallback.
	let customFee = $state('5');
	// Seed the custom-fee input from the streamed half-hour estimate until the
	// user actually switches to the custom rate — after that it's theirs to edit.
	$effect(() => {
		if (feeChoice === 'custom') return;
		const h = chain?.fees?.halfHour;
		if (h != null) customFee = String(h);
	});

	const feeRate = $derived.by(() => {
		const fallback = Number(customFee) || 1;
		if (feeChoice === 'fast') return chain?.fees?.fastest ?? fallback;
		if (feeChoice === 'normal') return chain?.fees?.halfHour ?? fallback;
		if (feeChoice === 'economy') return chain?.fees?.economy ?? fallback;
		return Math.max(1, fallback);
	});

	// Plain-language confirmation ETA per fee tier (send-affordances-progress.md
	// Part 2 — was "next ring ≈ N min", brand/ring jargon a first-time sender
	// wouldn't recognize as a time estimate).
	const feeEta = $derived.by(() => {
		if (feeChoice === 'fast') return '~10 min to confirm';
		if (feeChoice === 'normal') return '~30 min to confirm';
		if (feeChoice === 'economy') return '~1 hr or more to confirm';
		return 'custom rate — timing depends on the mempool';
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

	// Non-blocking warning when a draft spends an unconfirmed coin whose mempool
	// chain is near the network limit (cairn-u9ob.5). Shown on Review; never blocks.
	let chainDepthWarning = $state<{ message: string } | null>(null);
	// Non-blocking warning when manual coin control deliberately selected a coin
	// another in-flight draft of this multisig also references (cairn QA R7 B4).
	let reservationWarning = $state<{ message: string } | null>(null);

	// Manual coin control (optional): selected "txid:vout" keys, empty = automatic.
	let selectedCoins = $state<string[]>([]);

	async function build() {
		if (!canBuild || building) return;
		building = true;
		buildError = null;
		chainDepthWarning = null;
		reservationWarning = null;
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
			chainDepthWarning = body.chainDepthWarning ?? null;
			reservationWarning = body.reservationWarning ?? null;
			progress = (body.progress as MultisigSigningProgress) ?? null;
			activeKeyId = null;
			syncTxParam(draft.id);
			step = 'review';
		} catch {
			buildError = 'Could not reach Heartwood to build the transaction.';
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
				toast.success(
					`${who ? `Signature from ${who}` : 'Signature'} added — ${more} more ${
						more === 1 ? 'signature' : 'signatures'
					} needed.`
				);
				activeKeyId = null; // advance to the next unsigned key
				signerEpoch += 1;
			} else {
				signError =
					'That PSBT was read, but it added no new signature — it may already be counted, or the wrong device signed. Pick the next key and sign the freshly downloaded file.';
			}
		} catch {
			signError = 'Could not reach Heartwood to attach the signed transaction.';
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
	// The irreversible-act modal ("Once it's broadcast, there is no undo.") —
	// broadcast() only runs from its confirm.
	let confirmOpen = $state(false);
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let sentTxid = $state<string | null>(resumeTx?.txid ?? null);
	// Set only when this broadcast turned out to duplicate another draft's
	// already-sent, byte-identical transaction (cairn QA R7 B4 sub-case 1).
	let duplicateBroadcastNote = $state<string | null>(null);

	async function broadcast() {
		if (broadcasting || !draft) return;
		broadcasting = true;
		broadcastError = null;
		duplicateBroadcastNote = null;
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
			if (body.duplicate) duplicateBroadcastNote = body.message ?? null;
			step = 'sent';
		} catch {
			broadcastError = 'Could not reach Heartwood to broadcast.';
		} finally {
			broadcasting = false;
		}
	}

	// -------------------------------------------------------------- navigation
	// Every step change moves focus to the new step's section (screen readers /
	// keyboard users) and scrolls back to the top (#26) — a long step otherwise
	// leaves the next step's top scrolled out of view.
	let pageEl = $state<HTMLElement | null>(null);
	let initialStepRendered = false;
	$effect(() => {
		void step;
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
	const stepAriaLabel = $derived(
		`Step ${stepIndex + 1} of ${STEPS.length}: ${STEPS[stepIndex]?.label ?? ''}`
	);

	const explorerUrl = $derived(sentTxid ? `/explorer/tx/${sentTxid}` : '#');
	const quorum = quorumLabel(required, keys.length);

	// The eyebrow's current descriptor tracks the step; Create carries the
	// quorum shape (`SEND · 2-OF-3`).
	const crumbCurrent = $derived.by(() => {
		if (step === 'create') return `Send · ${quorum}`;
		if (step === 'review') return 'Send · review';
		if (step === 'sign') return 'Send · sign';
		if (step === 'confirm') return 'Send · broadcast';
		return 'Sent';
	});
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
	<title>Send · {data.multisig.name} · Heartwood</title>
</svelte:head>

<div class="send-page hw-owns-header" bind:this={pageEl}>
	<GroveField volume={step === 'sent' ? 'grove' : 'present'} />

	<div class="page-content">
	<!-- Mobile flow header (8b/8c): back circle + centered eyebrow + spacer.
	     The Sign step carries the quorum arc in the eyebrow (8c); the Sent
	     moment (8k) drops the back circle. -->
	<header class="flow-header">
		{#if step === 'sent'}
			<span class="flow-spacer"></span>
		{:else}
			<BackCircle href={`/wallets/multisig/${multisigId}`} />
		{/if}
		<span class="flow-eyebrow">
			{#if step === 'sign'}
				Sign
				<QuorumArc total={required} {collected} active={!quorumMet} size={18} />
				{collected} of {required}
			{:else if step === 'sent'}
				Sent
			{:else}
				Send · {data.multisig.name}
			{/if}
		</span>
		<span class="flow-spacer"></span>
	</header>

	<div class="eyebrow-row">
		<EyebrowBreadcrumb path={[data.multisig.name]} current={crumbCurrent} />
		{#if chain}
			<AtTipPill height={chain.tipHeight} />
		{:else}
			<span class="skeleton tip-skeleton" aria-hidden="true">at tip · 000,000</span>
		{/if}
	</div>

	<!-- ============================================================ CREATE -->
	{#if step === 'create'}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="recipient-blocks">
				{#each rows as row, i (row.key)}
					<div class="recipient-block">
						{#if rows.length > 1}
							<div class="row recipient-block-head">
								<span class="sec-label">Recipient {i + 1}</span>
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
								<label class="sec-label" for={`recipient-${row.key}`}>To</label>
							{/if}
							<RecipientCombobox
								id={`recipient-${row.key}`}
								bind:value={row.address}
								saved={[]}
								invalid={row.address.length > 0 && !looksLikeAddress(row.address)}
								ondelete={() => {}}
								ariaLabel={rows.length > 1 ? `Recipient ${i + 1} address` : undefined}
								currentAmountText={row.amountBtc}
								onamount={(sats) => {
									if (isMax) return;
									row.amountBtc = formatBtc(sats, { trim: true });
								}}
							/>
							{#if row.address.length > 0 && !looksLikeAddress(row.address)}
								<p class="field-line attention">That doesn't look like a Bitcoin address yet.</p>
							{:else if looksLikeAddress(row.address)}
								<p class="field-line sage">
									<Icon name="check" size={12} strokeWidth={2.5} /> Valid Bitcoin address
								</p>
							{/if}
						</div>

						<div class="field">
							<div class="row amount-head">
								<span class="sec-label" id={`amount-label-${row.key}`}>Amount</span>
								{#if rows.length === 1}
									<div class="mode-toggles" role="group" aria-label="Amount mode">
										<button
											type="button"
											class="txt-toggle"
											class:active={amountMode === 'btc'}
											onclick={() => (amountMode = 'btc')}>Amount</button
										>
										<button
											type="button"
											class="txt-toggle"
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
										class="amount-field tabular"
										inputmode="decimal"
										placeholder="0.00000000"
										bind:value={row.amountBtc}
										aria-labelledby={`amount-label-${row.key}`}
									/>
									<span class="unit-inline">BTC</span>
								</div>
								{#if Number(row.amountBtc) > 0}
									<p class="field-line tabular muted">
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
			</div>

			<div class="row batch-row">
				<button type="button" class="btn btn-ghost btn-sm" onclick={addRow}>
					<Icon name="plus" size={14} /> Add another recipient
				</button>
			</div>

			<!-- FEE: text toggles, not a dropdown. Label left, live rate + "next
			     ring" ETA right (5a). -->
			<div class="fee-section">
				<div class="fee-head">
					<span class="sec-label">Fee</span>
					<span class="fee-caption">{formatFeeRate(feeRate)} · {feeEta}</span>
				</div>
				<div class="fee-toggles" role="group" aria-label="Fee rate">
					{#each [{ k: 'economy', label: 'Low', rate: chain?.fees?.economy }, { k: 'normal', label: 'Medium', rate: chain?.fees?.halfHour }, { k: 'fast', label: 'High', rate: chain?.fees?.fastest }] as opt (opt.k)}
						<button
							type="button"
							class="txt-toggle"
							class:active={feeChoice === opt.k}
							onclick={() => (feeChoice = opt.k as FeeChoice)}
						>
							{opt.label}{#if opt.rate != null}<span class="toggle-rate tabular"
									>&nbsp;· {opt.rate < 10 ? Number(opt.rate.toFixed(1)) : Math.round(opt.rate)}</span
								>{:else if chainLoading}<span class="toggle-rate skeleton skeleton-rate" aria-hidden="true"
									>&nbsp;· 00</span
								>{/if}
						</button>
					{/each}
					<button
						type="button"
						class="txt-toggle"
						class:active={feeChoice === 'custom'}
						onclick={() => (feeChoice = 'custom')}
					>
						Custom
					</button>
				</div>
				{#if feeChoice === 'custom'}
					<div class="custom-fee">
						<input
							class="custom-fee-input tabular"
							inputmode="decimal"
							bind:value={customFee}
							aria-label="Custom fee rate in sat/vB"
						/>
						<span class="unit-sm">sat/vB</span>
					</div>
				{/if}
				{#if chainLoading}
					<p class="fee-caption">Fetching live fee estimates…</p>
				{:else if !chain?.fees}
					<p class="fee-caption">Live fee estimates are unavailable — set a custom sat/vB rate.</p>
				{/if}
				<p class="fee-caption">
					Multisig inputs are larger than single-signature ones ({quorum} needs {required}
					signatures per coin), so the same fee rate costs a little more in total fees.
				</p>
			</div>

			{#if chain && chain.utxos.length > 0}
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
							utxos={chain.utxos}
							bind:selected={selectedCoins}
							tipHeight={chain.tipHeight}
							massEndpoint={`/api/wallets/multisig/${multisigId}/utxo-mass`}
						/>
					</div>
				{/if}
			{/if}

			<HowItWorks id="multisig-send-psbt">
				<p>
					Heartwood builds an <Term
						tip="A Partially Signed Bitcoin Transaction — an unsigned proposal each of your signing devices reviews and signs in turn. Private keys never touch Heartwood's server."
						>unsigned transaction (a PSBT)</Term
					> describing exactly what will be sent. Because this wallet is {quorum} multisig, no single
					device can authorize it — you'll walk the same PSBT through {required} of your keys, one at
					a time, and Heartwood merges the signatures.
				</p>
				<p>
					<strong>That's the point of a multisig wallet:</strong> a thief (or a bug) with one key gets nothing.
					Verify the destination and amount on each device's own screen as you go.
				</p>
			</HowItWorks>

			{#if buildError}
				<div class="form-error" role="alert">{buildError}</div>
			{/if}

			<div class="row step-actions" style="justify-content: flex-end">
				<a class="btn btn-ghost" href={`/wallets/multisig/${multisigId}`}>Cancel</a>
				<button class="btn btn-primary pill-lg" onclick={build} disabled={!canBuild || building}>
					{#if building}<span class="spinner"></span> Building…{:else}Review send<Icon
							name="arrow-right"
							size={15}
						/>{/if}
				</button>
			</div>
			<p class="quorum-note">
				{required} of {keys.length} devices will sign — collect signatures over days if you like.
			</p>
		</section>

	<!-- ============================================================ REVIEW -->
	{:else if step === 'review' && review}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="review-hero">
				<span class="hero-amount">{formatBtc(review.amount)} <em>BTC</em></span>
				{#if review.recipients.length === 1}
					<span class="hero-sub tabular">{formatSats(review.amount)} sats</span>
					<span class="recipient mono">{review.recipient}</span>
				{:else}
					<span class="hero-sub tabular"
						>{formatSats(review.amount)} sats · {review.recipients.length} recipients</span
					>
					<div class="review-recipients">
						{#each review.recipients as r, i (i)}
							<div class="review-recipient-row">
								<span class="tabular batch-amt">{formatBtc(r.amount)} BTC</span>
								<span class="recipient mono">{r.address}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<p class="step-lead">
				Check every detail now — after this, {required} devices will each confirm this exact
				transaction, and once broadcast it <strong>cannot be reversed.</strong>
			</p>

			{#if chainDepthWarning}
				<div class="attention-panel" role="status">
					<Icon name="alert-triangle" size={16} />
					<span>{chainDepthWarning.message}</span>
				</div>
			{/if}

			{#if reservationWarning}
				<div class="attention-panel" role="status">
					<Icon name="alert-triangle" size={16} />
					<span>{reservationWarning.message}</span>
				</div>
			{/if}

			<div class="detail-list">
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
				<button class="btn btn-primary pill-lg" onclick={() => (step = 'sign')}>
					Looks good — collect signatures <Icon name="arrow-right" size={15} />
				</button>
			</div>
		</section>

	<!-- ====================================================== SIGN (5b/8c) -->
	{:else if step === 'sign'}
		<section class="step-body sign-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			{#if review}
				<div class="sign-hero">
					<span class="hero-amount">{formatBtc(review.amount)} <em>BTC</em></span>
					<p class="sign-sub">
						to
						{#if review.recipients.length === 1}
							<span class="mono sub-addr">{truncateMiddle(review.recipient, 9, 4)}</span>
						{:else}
							{review.recipients.length} recipients
						{/if}
						· fee {formatFeeRate(review.feeRate)} · draft saved on your node
					</p>
				</div>
			{/if}

			<div class="sign-grid">
				<div class="sign-col">
					<!-- Live quorum progress, straight from the server's PSBT inspection.
					     role="status" + explicit aria-live: screen-reader users collecting
					     signatures over time must HEAR each quorum change, and the implicit
					     politeness of role="status" alone is inconsistently honored. -->
					<div class="sig-head" role="status" aria-live="polite">
						<h2 class="section-title">Signatures</h2>
						<QuorumArc total={required} {collected} active={!quorumMet} size={26} />
						<span class="sig-count">
							{collected} of {required} collected{#if remainingNeeded > 0}&nbsp;· {remainingNeeded}
								more needed{/if}
						</span>
					</div>

					{#if signingMass}
						{@render massPanel(signingMass)}
					{/if}

					{#if roster}
						<!-- Shared-wallet signer roster: who has contributed a signature and
						     who is still owed one, by person (the key rows below show it by
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

					<!-- Per-key hairline rows (5b): signed / active / queued / spare.
					     Unsigned rows are buttons — clicking one makes it the active key
					     ("use this key instead", the signer-cursor reorder). -->
					<div class="key-rows">
						{#each keys as key (key.id)}
							{@const signed = isSigned(key)}
							{@const active = !quorumMet && activeKey?.id === key.id}
							{@const spare = !signed && !active && !quorumMet && isSpare(key)}
							{#if signed}
								<div class="key-row">
									<span class="key-icon" aria-hidden="true">
										<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"></rect><circle cx="10" cy="7" r="2"></circle><path d="M10 9 V12" stroke-linecap="round"></path></svg>
									</span>
									<span class="key-main">
										<span class="key-name">{key.name}</span>
										<span class="key-meta">{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span></span>
									</span>
									<span class="key-state signed"
										><Icon name="check" size={13} strokeWidth={2.5} /> Signed</span
									>
								</div>
							{:else if quorumMet}
								<!-- Quorum met, but this key's attribution is unknown (a
								     finalized PSBT strips per-input data) — a neutral row,
								     never a false "signed" or a next-signer CTA. -->
								<div class="key-row dim">
									<span class="key-icon" aria-hidden="true">
										<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"></rect><circle cx="10" cy="7" r="2"></circle><path d="M10 9 V12" stroke-linecap="round"></path></svg>
									</span>
									<span class="key-main">
										<span class="key-name">{key.name}</span>
										<span class="key-meta">{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span></span>
									</span>
									<span class="key-state muted">Not needed — quorum met</span>
								</div>
							{:else}
								{@const chipEstimate = deviceEstimate(key)}
								<button
									type="button"
									class="key-row selectable"
									class:active
									class:dim={spare}
									onclick={() => chooseKey(key.id)}
									title={active ? 'Currently signing with this key' : 'Sign with this key instead'}
								>
									<span class="key-icon" aria-hidden="true">
										<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"></rect><circle cx="10" cy="7" r="2"></circle><path d="M10 9 V12" stroke-linecap="round"></path></svg>
									</span>
									<span class="key-main">
										<span class="key-name">{key.name}</span>
										<span class="key-meta">
											{KEY_CATEGORY_LABELS[key.category]} · <span class="mono">{key.fingerprint}</span>{#if chipEstimate}<span
													class="key-est tabular"
													title="Estimated signing time on this device — it never changes the network fee."
													>&nbsp;· {chipEstimate}</span
												>{/if}
										</span>
									</span>
									{#if active}
										<span class="key-state pending">Sign below</span>
									{:else if spare}
										<span class="key-state muted">Not needed</span>
									{:else}
										<span class="key-cta">Sign now</span>
									{/if}
								</button>
							{/if}
						{/each}
					</div>
					{#if hasUnattributableKey}
						<p class="never-line">
							Keys that share both a master fingerprint and a derivation path can't be individually
							ticked off — the signature count above is still exact, straight from the transaction
							itself.
						</p>
					{/if}

					<p class="never-line">
						Approval happens on the device's own screen. Heartwood never sees a key — it only
						carries the PSBT between signers.
					</p>

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
						<TrezorSigner
							unsignedPsbt={draft.psbt}
							context={signerContext}
							multisig={{
								keyName: activeKey.name,
								multisigName: data.multisig.name,
								threshold: required,
								totalKeys: keys.length,
								scriptType: data.multisig.scriptType,
								keys: signKeys
							}}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'ledger'}
						<LedgerSigner
							unsignedPsbt={draft.psbt}
							context={signerContext}
							multisig={{
								keyName: activeKey.name,
								keyFingerprint: activeKey.fingerprint,
								multisigName: data.multisig.name,
								threshold: required,
								totalKeys: keys.length,
								scriptType: data.multisig.scriptType,
								keys: signKeys,
								multisigId
							}}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'bitbox02'}
						<BitboxSigner
							unsignedPsbt={draft.psbt}
							context={signerContext}
							multisig={{
								keyName: activeKey.name,
								ourKeyIndex: activeKeyIndex,
								multisigName: data.multisig.name,
								threshold: required,
								totalKeys: keys.length,
								scriptType: data.multisig.scriptType,
								keys: signKeys
							}}
							onsigned={handleSigned}
							onusefile={overrideToFile}
						/>
					{:else if effectiveDevice === 'jade'}
						<JadeUsbSigner
							unsignedPsbt={draft.psbt}
							context={signerContext}
							multisig={{
								keyName: activeKey.name,
								ourKeyIndex: activeKeyIndex,
								multisigName: data.multisig.name,
								threshold: required,
								totalKeys: keys.length,
								scriptType: data.multisig.scriptType,
								keys: signKeys
							}}
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
				<Banner variant="error">
					{signError}
					{#snippet actions()}
						<button class="btn btn-secondary btn-sm" onclick={() => (signerEpoch += 1)}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					{/snippet}
				</Banner>
			{/if}
				</div>

				<!-- 5b right column: what the device screens must show. -->
				<aside class="verify-col">
					{#if review}
						<h2 class="section-title">Verify on device</h2>
						<div class="verify-list">
							<div class="verify-row">
								<span class="verify-key">To</span>
								<span class="verify-val mono">
									{#if review.recipients.length === 1}
										{truncateMiddle(review.recipient, 12, 10)}
									{:else}
										{review.recipients.length} recipients
									{/if}
								</span>
							</div>
							<div class="verify-row">
								<span class="verify-key">Amount</span>
								<span class="verify-val tabular">{formatBtc(review.amount)} BTC</span>
							</div>
							<div class="verify-row">
								<span class="verify-key">Fee</span>
								<span class="verify-val tabular"
									>{formatSats(review.fee)} sats · {formatFeeRate(review.feeRate)}</span
								>
							</div>
							{#if review.change}
								<div class="verify-row">
									<span class="verify-key">Change</span>
									<span class="verify-val tabular">
										{formatSats(review.change.value)} sats
										<span class="back-badge">Back to you</span>
									</span>
								</div>
							{/if}
						</div>
						<p class="verify-note">
							Every device screen is the truth — each signer approves only if it shows exactly this.
						</p>
					{/if}
					<div class="verify-actions">
						<a class="btn btn-secondary" href={currentPsbtUrl} download>
							<Icon name="arrow-down-left" size={14} /> Export PSBT
						</a>
						<a class="btn btn-ghost" href={`/wallets/multisig/${multisigId}`}>Finish later</a>
					</div>
					<p class="verify-note">
						Signatures are saved on your node — leave anytime and this page resumes where you left
						off.
					</p>
				</aside>
			</div>

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'review')}>
					<Icon name="chevron-left" size={15} /> Back to review
				</button>
				{#if quorumMet}
					<button class="btn btn-primary pill-lg" onclick={() => (step = 'confirm')}>
						Continue to broadcast <Icon name="arrow-right" size={15} />
					</button>
				{/if}
			</div>
		</section>

	<!-- =========================================================== CONFIRM -->
	{:else if step === 'confirm' && review}
		<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
			<div class="review-hero">
				<span class="hero-amount sm">{formatBtc(review.amount)} <em>BTC</em></span>
				<span class="hero-sub">
					{collected >= required ? `${required} of ${required}` : quorum} signatures collected — fully
					authorized and ready to broadcast
				</span>
			</div>

			<div class="detail-list">
				{#if review.recipients.length === 1}
					<div class="detail-row">
						<span class="text-secondary">To</span>
						<span class="mono confirm-recipient">{review.recipient}</span>
					</div>
				{:else}
					<div class="detail-row confirm-batch">
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
				<div class="detail-row">
					<span class="text-secondary">Fee</span>
					<span class="detail-val tabular"
						>{formatSats(review.fee)} sats · {formatFeeRate(review.feeRate)}</span
					>
				</div>
				<div class="detail-row">
					<span class="text-secondary">Authorized by</span>
					<span class="detail-val">{quorum} keys</span>
				</div>
			</div>

			<p class="step-lead">
				Broadcasting hands this transaction to the network. Once it's broadcast, there is no undo.
			</p>

			{#if broadcastError}
				<Banner variant="error">
					{broadcastError}
					{#snippet actions()}
						<a class="btn btn-secondary btn-sm" href={currentPsbtUrl} download>
							<Icon name="arrow-down-left" size={14} /> Download PSBT
						</a>
						<button class="btn btn-ghost btn-sm" onclick={() => (step = 'sign')}> Re-sign </button>
					{/snippet}
				</Banner>
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'sign')} disabled={broadcasting}>
					<Icon name="chevron-left" size={15} /> Back
				</button>
				<button
					class="btn btn-primary pill-lg"
					onclick={() => (confirmOpen = true)}
					disabled={broadcasting}
				>
					{#if broadcasting}<span class="spinner"></span> Broadcasting…{:else}Broadcast
						transaction{/if}
				</button>
			</div>
		</section>

	<!-- ============================================================== SENT -->
	{:else if step === 'sent'}
		<section class="step-body fade-in sent-body" tabindex="-1" aria-label={stepAriaLabel}>
			<!-- One-off send-stepper moment (4a): flow name left, steps right,
			     Broadcast lit. Desktop only — 8k keeps just the SENT eyebrow. -->
			<div class="sent-topline" aria-hidden="true">
				<span class="sent-flow-name">Send bitcoin</span>
				<span class="sent-steps">
					<span class="sent-step">Amount</span><span class="sent-dot">·</span>
					<span class="sent-step">Review</span><span class="sent-dot">·</span>
					<span class="sent-step">Sign</span><span class="sent-dot">·</span>
					<span class="sent-step lit">Broadcast</span>
				</span>
			</div>

			<!-- The ring-sweep moment: two cream sweeps (once), a dashed mempool
			     ring pulsing underneath — the transaction waiting for its first ring. -->
			<div class="sweep-stage">
				<span class="sweep s1"></span>
				<span class="sweep s2"></span>
				<BurialRings confirmations={0} direction="out" size={64} />
			</div>

			{#if review}
				<h2 class="sent-title">{formatBtc(review.amount)} BTC is on its way</h2>
			{:else}
				<h2 class="sent-title">Your bitcoin is on its way</h2>
			{/if}
			<p class="sent-sub">
				From {data.multisig.name} · authorized by {quorum} keys · in the mempool, waiting for its
				first ring{#if review}
					· {formatFeeRate(review.feeRate)}{/if}
			</p>

			{#if sentTxid}
				<div class="txid-pill">
					<span class="mono">{truncateMiddle(sentTxid, 12, 12)}</span>
					<CopyText value={sentTxid} display="Copy" mono={false} />
				</div>
			{/if}

			{#if duplicateBroadcastNote}
				<Banner variant="info">{duplicateBroadcastNote}</Banner>
			{/if}

			<div class="row step-actions" style="justify-content: center">
				<a class="btn btn-primary pill-lg" href={explorerUrl}>Watch it get buried</a>
				<a class="btn btn-secondary" href={`/wallets/multisig/${multisigId}`}>Done</a>
			</div>
			<p class="sent-caption">We'll nudge you at the first ring — and at six.</p>
			<a class="sent-again" href={`/wallets/multisig/${multisigId}/send`} data-sveltekit-reload
				>Send another</a
			>
		</section>
	{/if}
	</div>
</div>

<Modal
	bind:open={confirmOpen}
	title="Broadcast this transaction?"
	message="Once it's broadcast, there is no undo."
	confirmLabel="Broadcast"
	onConfirm={() => void broadcast()}
/>

<Toasts />

<style>
	.send-page {
		position: relative;
		/* Bleed the grove field across the shell's content padding so the
		   atmosphere isn't a visible 940px box. */
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: 100%;
	}

	.page-content {
		position: relative;
		z-index: 1;
		max-width: 680px;
		margin: 0 auto;
	}

	.eyebrow-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		margin-bottom: 26px;
	}

	/* Placeholder for the AtTipPill while the streamed tip is in flight — same
	   footprint as the pill so the eyebrow row doesn't reflow when it resolves. */
	.tip-skeleton {
		display: inline-flex;
		align-items: center;
		padding: 5px 12px;
		font-family: var(--font-ui);
		font-size: 11.5px;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}

	/* Fee-rate placeholder inside a toggle while estimates stream in. */
	.skeleton-rate {
		display: inline-block;
		border-radius: var(--radius-badge);
	}

	/* Mobile flow header (8b/8c/8k) — this page composes its own back circle +
	   centered eyebrow + spacer, so the shell's bare fallback is suppressed. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.flow-eyebrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--eyebrow);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.flow-spacer {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
	}

	.step-body {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	/* Step sections receive programmatic focus on every step change (so screen
	   readers announce the new step) — no ring for that, only when the global
	   :focus-visible convention applies (keyboard). */
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
	}

	.pill-lg {
		padding: 13px 26px;
		font-size: 15px;
		border-radius: var(--radius-pill);
	}

	/* Tracked-caps section labels — the eyebrow grammar inside the page. */
	.sec-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	/* The toggle grammar: active bright copper on a copper tint, radius 14. */
	.txt-toggle {
		background: transparent;
		border: none;
		border-radius: 14px;
		padding: 6px 13px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		color: var(--eyebrow-path);
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.txt-toggle:hover {
		color: var(--text-secondary);
	}

	.txt-toggle.active {
		background: rgba(232, 147, 90, 0.1);
		color: var(--accent-bright);
	}

	.toggle-rate {
		font-weight: 400;
	}

	/* ---- Create: per-recipient hairline blocks (multisig never gets the
	     single-recipient hero amount input — every row, including the sole
	     one, is the same hairline block per §5a's multisig note). ---- */
	.recipient-blocks {
		display: flex;
		flex-direction: column;
	}

	.recipient-block {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.recipient-block:first-child {
		padding-top: 0;
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
		border-radius: var(--radius-badge);
		color: var(--text-muted);
		cursor: pointer;
	}

	.row-remove:hover {
		color: var(--text);
		background: var(--bg-input);
	}

	.batch-row {
		justify-content: space-between;
		gap: 10px;
	}

	.amount-head {
		justify-content: space-between;
	}

	.mode-toggles {
		display: flex;
		gap: 4px;
	}

	.field-line {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.field-line.attention {
		color: var(--attention);
	}

	.field-line.sage {
		color: var(--sage);
	}

	.field-line.muted {
		color: var(--text-muted);
	}

	/* The per-row amount: a hairline-bottom serif field, same idiom as the
	   single-sig batch rows — just always shown (multisig has no single-hero
	   layout). */
	.amount-input {
		display: flex;
		align-items: baseline;
		gap: 8px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 6px;
	}

	.amount-field {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 22px;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.amount-field::placeholder {
		color: var(--text-faint);
	}

	.unit-inline {
		background: none;
		border: none;
		padding: 2px 4px;
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
	}

	.unit-inline:hover {
		color: var(--accent);
	}

	.max-note {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-icon-btn);
		padding: 10px 12px;
		font-size: 13px;
	}

	/* ---- Create: fee text toggles ---- */
	.fee-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.fee-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.fee-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.custom-fee {
		display: flex;
		align-items: baseline;
		gap: 8px;
		max-width: 180px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 4px;
	}

	.custom-fee-input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 17px;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.unit-sm {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.fee-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
	}

	.quorum-note {
		font-size: 12px;
		color: var(--text-muted);
		text-align: center;
	}

	/* Attention (never red) panels: chain-depth notes. */
	.attention-panel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
	}

	.attention-panel :global(svg) {
		color: var(--attention);
		flex-shrink: 0;
		margin-top: 1px;
	}

	/* ---- Review ---- */
	.review-hero {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hero-amount {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 64px;
		line-height: 0.96;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
	}

	.hero-amount.sm {
		font-size: 44px;
	}

	.hero-amount em {
		font-style: normal;
		font-size: 0.42em;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	/* 5b sub-line: "to bc1q… · fee 12 sat/vB · draft saved on your node". */
	.sign-sub {
		margin-top: 14px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.sub-addr {
		font-size: 13.5px;
		color: var(--on-accent-ghost);
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
		gap: 4px;
	}

	.batch-amt {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.recipient {
		font-size: 14px;
		word-break: break-all;
		max-width: 100%;
		color: var(--text-rows);
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
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.detail-val {
		color: var(--text-rows);
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
		padding: 12px 0 0;
		cursor: pointer;
	}

	.utxo-toggle:hover {
		color: var(--accent);
	}

	.utxo-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 8px;
	}

	.utxo-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 10px;
		font-size: 12.5px;
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.utxo-row:last-child {
		border-bottom: none;
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
		border-radius: var(--radius-badge);
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
		border-radius: var(--radius-icon-btn);
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
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
	}

	.mass-panel.amber :global(svg) {
		color: var(--attention);
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

	/* ---- Sign ---- */
	.sign-hero {
		display: flex;
		flex-direction: column;
	}

	.sign-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 36px;
	}

	@media (min-width: 900px) {
		.sign-grid {
			grid-template-columns: 1.35fr 1fr;
			gap: 48px;
			align-items: start;
		}
	}

	.sign-col {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}

	.sig-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.sig-count {
		font-size: 13px;
		color: var(--text-secondary);
	}

	/* Shared-wallet signer roster (person view). */
	.signer-roster {
		list-style: none;
		margin: 0;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
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
		color: var(--sage);
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
		color: var(--sage);
	}

	/* Per-key hairline rows (5b): signed / active / queued / spare. The list
	   wrapper carries the top hairline so adjacent rows don't double it. */
	.key-rows {
		display: flex;
		flex-direction: column;
	}

	.key-rows > :first-child {
		border-top: 1px solid var(--hairline);
	}

	.key-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
	}

	button.key-row.selectable {
		width: 100%;
		background: none;
		border: none;
		border-bottom: 1px solid var(--hairline);
		text-align: left;
		font-family: var(--font-ui);
		cursor: pointer;
		transition: background-color 120ms var(--ease);
	}

	button.key-row.selectable:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.key-row.dim {
		opacity: 0.6;
	}

	.key-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-icon-btn);
		background: var(--surface-elevated);
		/* Decorative (the name + meta line identify the key) — faint is allowed. */
		color: var(--text-faint);
	}

	.key-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.key-name {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.key-meta {
		font-size: 12px;
		color: var(--text-muted);
	}

	.key-est {
		color: var(--text-muted);
	}

	.key-state {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 500;
		flex-shrink: 0;
	}

	/* Spec 5b: a collected signature reads bright copper, not sage. */
	.key-state.signed {
		color: var(--accent-bright);
	}

	.key-state.pending {
		color: var(--accent-bright);
	}

	.key-state.muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	.key-cta {
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		flex-shrink: 0;
	}

	.never-line {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.quorum-done {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--success-muted);
		border-radius: var(--radius-icon-btn);
		padding: 14px 16px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text);
	}

	.quorum-done :global(svg) {
		color: var(--sage);
		flex-shrink: 0;
		margin-top: 2px;
	}

	/* ---- registration callout (QR variant; the ColdCard one lives in
	       MultisigFileSigner). Warning-toned: registration is a hard
	       prerequisite — the device refuses to sign without it. ---- */
	.register-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
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
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
	}

	/* ---- Sign: verify-on-device panel ---- */
	.verify-col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.verify-list {
		display: flex;
		flex-direction: column;
	}

	.verify-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.verify-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.verify-key {
		color: var(--text-secondary);
	}

	.verify-val {
		color: var(--text-rows);
		font-weight: 500;
		text-align: right;
		word-break: break-all;
	}

	.back-badge {
		display: inline-block;
		margin-left: 6px;
		padding: 2px 7px;
		border-radius: var(--radius-badge);
		background: var(--sage-muted);
		color: var(--sage);
		font-family: var(--font-ui);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.verify-note {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
	}

	.verify-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* ---- Confirm ---- */
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

	/* ---- Sent: the grove moment ---- */
	.sent-body {
		align-items: center;
		text-align: center;
		padding-top: 8px;
		gap: 16px;
	}

	/* 4a topline: flow name left, quiet stepper right, Broadcast lit. */
	.sent-topline {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
	}

	.sent-flow-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.sent-steps {
		display: inline-flex;
		align-items: baseline;
		gap: 9px;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-faint);
	}

	.sent-step.lit {
		color: var(--accent-bright);
	}

	.sweep-stage {
		position: relative;
		width: 180px;
		height: 180px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 4px 0;
	}

	/* Two cream ring sweeps — hwSweepOnce plays ONCE (no infinite), staggered.
	   Base opacity 0 keeps them invisible during their delay and after. */
	.sweep {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1.5px solid var(--accent-glow-strong);
		opacity: 0;
		transform: scale(0.18);
		animation: hwSweepOnce 2.4s ease-out forwards;
		pointer-events: none;
	}

	.sweep.s1 {
		animation-delay: 0.2s;
	}

	.sweep.s2 {
		animation-delay: 1s;
	}

	.sent-title {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 40px;
		line-height: 1.1;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
	}

	.sent-sub {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.txid-pill {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
		padding: 9px 16px;
		background: rgba(255, 255, 255, 0.025);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-status-pill);
		color: var(--text-rows);
	}

	.sent-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
	}

	.sent-again {
		font-size: 12.5px;
	}

	/* ---- Mobile (≤900px): flow-page composition ---- */
	@media (max-width: 900px) {
		.send-page {
			margin: -20px -18px -48px;
			padding: 16px 18px 48px;
		}

		/* Flow-page header: back circle + centered eyebrow + spacer (8b/8c/8k);
		   the desktop eyebrow/at-tip row retires. */
		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 24px;
		}

		.eyebrow-row {
			display: none;
		}

		.review-hero {
			align-items: center;
			text-align: center;
		}

		.hero-amount {
			font-size: 38px;
		}

		.hero-amount.sm {
			font-size: 32px;
		}

		.sign-hero {
			align-items: center;
			text-align: center;
		}

		.sign-sub {
			margin-top: 8px;
			font-size: 11.5px;
		}

		.sub-addr {
			font-size: 10.5px;
		}

		.sig-head {
			justify-content: center;
		}

		/* 8k keeps only the SENT eyebrow — no stepper. */
		.sent-topline {
			display: none;
		}

		.sent-title {
			font-size: 28px;
		}

		.step-actions {
			flex-direction: column-reverse;
			align-items: stretch;
		}

		.step-actions :global(.btn) {
			width: 100%;
			min-height: 46px;
		}
	}

	/* Touch targets: text toggles and selectable key rows are tap targets —
	   give them the full ≥44px hit area on touch screens and narrow viewports. */
	@media (max-width: 520px), (pointer: coarse) {
		.txt-toggle {
			min-height: 44px;
			padding: 10px 16px;
		}

		button.key-row.selectable {
			min-height: 44px;
		}
	}
</style>
