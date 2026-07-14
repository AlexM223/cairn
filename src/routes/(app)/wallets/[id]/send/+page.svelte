<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { replaceState, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { toast } from '$lib/components/toast.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import QuorumArc from '$lib/components/heartwood/QuorumArc.svelte';
	import BurialRings from '$lib/components/heartwood/BurialRings.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import AtTipPill from '$lib/components/heartwood/AtTipPill.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import { classifyRecipientAddress, looksLikeAddress } from './addressShape';
	import Amount from '$lib/components/Amount.svelte';
	import AmountEntry from '$lib/components/send/AmountEntry.svelte';
	import FeeSpeedPicker from '$lib/components/send/FeeSpeedPicker.svelte';
	import SendReviewCard from '$lib/components/send/SendReviewCard.svelte';
	import { sendCtaLabel } from '$lib/components/send/sendMoney';
	import { arrivalWords, type FeeChoiceKey } from '$lib/components/send/sendCopy';
	import { btcUsd } from '$lib/price';
	import { scrollToTop } from '$lib/scrollToTop';
	import type { ScriptType, FeeEstimates } from '$lib/types';
	import type { ConstructedPsbt } from '$lib/server/bitcoin/psbt';
	import type { SavedTransaction } from '$lib/server/transactions';
	import type { SavedAddress } from '$lib/server/addressBook';
	import CoinControl from './_components/CoinControl.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import DeviceCard from './_components/DeviceCard.svelte';
	import RecipientCombobox from './_components/RecipientCombobox.svelte';
	import ColdCardSigner from './_components/ColdCardSigner.svelte';
	import LedgerSigner from '$lib/components/signing/LedgerSigner.svelte';
	import QrSigner from './_components/QrSigner.svelte';
	import TrezorSigner from '$lib/components/signing/TrezorSigner.svelte';
	import BitboxSigner from '$lib/components/signing/BitboxSigner.svelte';
	import JadeUsbSigner from '$lib/components/signing/JadeUsbSigner.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import JadeQrSigner from './_components/JadeQrSigner.svelte';
	import type { SignerContext } from './_components/signerContract';
	import { deviceSignMethods, type DeviceSignMethodKey } from './_components/signMethods';
	import {
		formatSigningRange,
		perDeviceLine,
		MASS_WHY_TIP,
		type SigningMass
	} from '../_components/signingMass';
	import { WALLET_DEVICE_LABELS } from '../../labels';
	import type { WalletDeviceType } from '$lib/types';

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
	const walletId = data.wallet.id;

	// The saved row load guarantees resume.transaction is non-null (it 404s
	// otherwise), but its inferred type still admits null — pin it here. Load
	// data is a per-navigation snapshot; a resume re-runs this component.
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeTx: SavedTransaction | null = data.resume?.transaction ?? null;

	// Contract note: summarizePsbt (src/lib/server/bitcoin/psbt.ts) is being
	// extended to carry input/change detail on resume summaries. Typed to that
	// contract here so a resumed Review renders the same coins a fresh build
	// does; `value` is null when the PSBT doesn't carry the prevout amount.
	type ResumeSummaryDetail = {
		complete: boolean;
		inputs?: { txid: string; vout: number; value: number | null }[];
		change?: { vout: number; value: number } | null;
		/** Signing-mass summary — optional/absent = unknown, show nothing. */
		signingMass?: SigningMass;
	};
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeSummary = (data.resume?.summary ?? null) as ResumeSummaryDetail | null;
	const resumeComplete = resumeSummary?.complete ?? false;

	// --- resume: derive the starting step from the saved row's lifecycle ------
	function initialStep(): StepKey {
		if (!resumeTx) return 'create';
		if (resumeTx.status === 'completed') return 'sent';
		if (resumeTx.status === 'awaiting_signature') {
			// Signed enough to broadcast? jump to Confirm, else stay on Sign.
			return resumeComplete ? 'confirm' : 'sign';
		}
		return 'review'; // draft
	}

	// svelte-ignore state_referenced_locally — intentional per-load seed
	let step = $state<StepKey>(initialStep());

	// The in-flight draft: the server row is the source of truth. `draft` holds
	// the saved transaction row; `details` holds the rich ConstructedPsbt from
	// the build response (only present when built this session — on resume we
	// reconstruct a display shape from the saved row + summary).
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let draft = $state<SavedTransaction | null>(resumeTx);
	let details = $state<ConstructedPsbt | null>(null);
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let signedComplete = $state<boolean>(resumeComplete);

	// What the Review/Confirm/Sent steps render. A fresh build supplies the full
	// ConstructedPsbt; a resume reconstructs the same shape from the saved row +
	// PSBT summary, whose inputs may lack a prevout amount (value: null).
	type ReviewDisplay = Omit<ConstructedPsbt, 'inputs' | 'change'> & {
		inputs: { txid: string; vout: number; value: number | null }[];
		change: { value: number } | null;
	};

	// Rebuild a review shape when resuming without a fresh build. The saved row
	// carries recipient(s)/amount/fee/feeRate; the PSBT summary carries the
	// coins being spent and the change output, so Review renders identically —
	// including every output of a batch draft (rows always materialize a full
	// recipients array, single sends as a length-1 one).
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

	// Keep ?tx= in the URL in sync so a reload resumes the same draft.
	function syncTxParam(id: number) {
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.get('tx') === String(id)) return;
			url.searchParams.set('tx', String(id));
			replaceState(url, {});
		} catch {
			/* pre-hydration or blocked — the in-memory draft still drives the flow */
		}
	}

	// ----------------------------------------------------------- address book
	// The saved-recipient list seeds the combobox; mutations (inline delete,
	// save-from-Sent) update it locally so the dropdown reflects them at once.
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let savedAddresses = $state<SavedAddress[]>(data.savedAddresses);

	async function deleteSavedAddress(entry: SavedAddress) {
		savedAddresses = savedAddresses.filter((a) => a.id !== entry.id);
		try {
			await fetch(`/api/address-book/${entry.id}`, { method: 'DELETE' });
		} catch {
			/* best-effort — a failed delete resurfaces on the next page load */
		}
	}

	// Fire-and-forget: sending to a saved recipient bumps its last_used_at so
	// frequent payees float to the top of the dropdown.
	function touchSavedAddress(address: string) {
		if (!savedAddresses.some((a) => a.address === address)) return;
		void fetch('/api/address-book', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ address })
		}).catch(() => {});
	}

	// ------------------------------------------------------------- CREATE step
	// Basic client-side shape check — the server does authoritative validation.
	// looksLikeAddress stays mainnet-only (unchanged contract); classify also
	// recognises test-network shapes so we can say so instead of calling a valid
	// testnet/regtest address "garbage" (cairn-a8n7).

	// --------------------------------------------------- consolidation handoff
	// The wallet detail page's "Consolidate now" button lands here with
	// ?consolidate=txid:vout,txid:vout[&to=address]: the listed coins are
	// preselected in coin control, the amount is set to Max (sweep exactly those
	// coins), and the recipient is prefilled with the wallet's own next receive
	// address. Advisory seeding only — everything stays editable, nothing is
	// blocked, and unknown/spent coins are silently dropped. Ignored on resume
	// (?tx= wins: the draft already fixed its inputs).
	// The spendable set is STREAMED (see below), so the coin keys can't be
	// validated synchronously here — this reads only the URL params. The coins
	// are matched against the real UTXO set once it resolves (in the stream
	// effect), keeping the page paintable before the scan returns.
	function readConsolidateParams(): { coinKeys: string[]; to: string | null } | null {
		if (resumeTx) return null;
		const raw = page.url.searchParams.get('consolidate');
		if (!raw) return null;
		const coinKeys = [...new Set(raw.split(',').map((s) => s.trim()))].filter(
			(k) => k.length > 0
		);
		if (coinKeys.length === 0) return null;
		const to = page.url.searchParams.get('to')?.trim() ?? null;
		return { coinKeys, to: to && looksLikeAddress(to) ? to : null };
	}
	// svelte-ignore state_referenced_locally — per-navigation constant
	const consolidateParams = readConsolidateParams();

	// --- streamed network data (cairn-vknb.3) -------------------------------
	// The Electrum/Core RPC-dependent half of the load STREAMS in (see
	// +page.server.ts's `live` field): the page shell paints immediately from the
	// cheap synchronous fields, and these fill in when the node answers. Each is
	// seeded to a safe empty/zero default and updated once `data.live` resolves.
	type SendLive = Awaited<(typeof data)['live']>;
	type SendUtxo = SendLive['utxos'][number];
	let confirmed = $state<number | null>(null);
	let scanError = $state<string | null>(null);
	let fees = $state<FeeEstimates | null>(null);
	let utxos = $state<SendUtxo[]>([]);
	// True once `data.live` has settled (resolved or degraded) — lets the UI tell
	// "still streaming" apart from "loaded, but the node was down / had nothing".
	let liveLoaded = $state(false);
	// One-shot guards so the stream-resolve effect seeds derived values exactly
	// once and never clobbers a user edit made while the data was in flight.
	let consolidateSeeded = false;

	// One row per output. A single row is the classic send; adding rows makes
	// a batch payment — one transaction, several recipients, one fee. The amount
	// is stored as canonical `sats` (0 = empty/invalid); AmountEntry owns all
	// unit display/entry, so the page never thinks about BTC/sats/fiat units.
	type RecipientRow = { key: number; address: string; sats: number };
	let rowKey = 0;
	function seedRows(): RecipientRow[] {
		if (resumeTx && resumeTx.recipients.length > 0) {
			return resumeTx.recipients.map((r) => ({
				key: rowKey++,
				address: r.address,
				sats: r.amount > 0 ? r.amount : 0
			}));
		}
		if (consolidateParams?.to) {
			return [{ key: rowKey++, address: consolidateParams.to, sats: 0 }];
		}
		return [{ key: rowKey++, address: '', sats: 0 }];
	}
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let rows = $state<RecipientRow[]>(seedRows());
	// Consolidation is a self-sweep of the selected coins — Max is the point.
	let amountMode = $state<'btc' | 'max'>(consolidateParams ? 'max' : 'btc');

	function addRow() {
		rows = [...rows, { key: rowKey++, address: '', sats: 0 }];
		amountMode = 'btc'; // send-max is single-recipient-only
	}

	function removeRow(key: number) {
		if (rows.length <= 1) return; // a send needs at least one recipient
		rows = rows.filter((r) => r.key !== key);
	}

	// ----------------------------------------------------- manual coin control
	// Keys are "txid:vout". Empty = automatic selection (the default flow).
	// Coin selection starts empty; a consolidation handoff's coins are validated
	// against the streamed spendable set and seeded once it resolves (below).
	let selectedCoins = $state<string[]>([]);

	// Live block tip. Seeded to 0 and filled from the streamed load, then kept
	// fresh by onNewBlock (below). Coin control maturity-checks coinbase (mining
	// reward) coins against it, so an immature reward becomes selectable the
	// moment its 100th block arrives.
	let tipHeight = $state<number>(0);

	// Fee tier + effective rate are owned by FeeSpeedPicker now; the page keeps
	// only the bound values it needs — `feeRate` for build()/canBuild, `feeChoice`
	// for the Review card's arrival words.
	let feeChoice = $state<FeeChoiceKey>('standard');
	let feeRate = $state(1);

	// Fill the streamed fields in when the server's Electrum round-trips settle.
	// A new-block invalidate (onMount) creates a fresh `data.live`, re-running
	// this effect so fees/tip/balance refresh — prior values stay on screen until
	// the new snapshot resolves, so there's no skeleton flash on refresh.
	$effect(() => {
		const promise = data.live;
		let stale = false;
		void promise
			.then((live) => {
				if (stale) return;
				confirmed = live.confirmed;
				scanError = live.scanError;
				fees = live.fees;
				utxos = live.utxos;
				// onNewBlock may have already advanced the tip past this snapshot.
				if (live.tipHeight > tipHeight) tipHeight = live.tipHeight;
				// Validate the consolidation handoff's coins against the now-known
				// spendable set — exactly once, and never over a live user selection.
				if (consolidateParams && !resumeTx && !consolidateSeeded) {
					const valid = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
					selectedCoins = consolidateParams.coinKeys.filter((k) => valid.has(k));
					consolidateSeeded = true;
				}
				liveLoaded = true;
			})
			.catch(() => {
				if (stale) return;
				// The streamed scan rejected (an unexpected, non-degraded error) —
				// surface the same graceful "couldn't reach your node" state the
				// server's inline degrade paths use, never a broken page.
				scanError = scanError ?? 'Could not reach your node to load spendable coins.';
				liveLoaded = true;
			});
		return () => {
			stale = true;
		};
	});

	const isMax = $derived(amountMode === 'max' && rows.length === 1);
	const rowsValid = $derived(
		rows.every((r) => {
			if (r.address.trim().length === 0 || !looksLikeAddress(r.address)) return false;
			if (isMax) return true;
			return r.sats > 0;
		})
	);

	// Inline amount validation — the same treatment the address field gets: a
	// non-empty invalid amount explains itself right under the input instead of
	// silently disabling the Review button. Client-side pre-check only; the
	// server stays authoritative (and its errors surface via buildError without
	// touching what the user typed).
	function amountError(r: RecipientRow): string | null {
		if (isMax || r.sats <= 0) return null;
		if (confirmed != null && r.sats > confirmed) return "That's more than this wallet holds.";
		return null;
	}

	// Running total across rows — shown on batch sends so the sum is visible
	// before Review.
	const createTotalSats = $derived(rows.reduce((s, r) => s + r.sats, 0));

	// The send as a whole can't exceed the confirmed balance either (a batch's
	// rows may each pass alone but overshoot together). Fee-exclusive on
	// purpose — the server's coin selection has the final word; this only
	// catches the obviously-impossible case before a build is attempted.
	const exceedsBalance = $derived(
		!isMax && confirmed != null && createTotalSats > confirmed
	);
	const canBuild = $derived(rowsValid && feeRate >= 1 && !exceedsBalance);

	let building = $state(false);
	let buildError = $state<string | null>(null);

	// A non-blocking warning when the draft spends an unconfirmed coin whose
	// mempool chain is near the network's ancestor/descendant limit (cairn-u9ob.5).
	// Shown on the Review step; never prevents signing/broadcast.
	let chainDepthWarning = $state<{ message: string } | null>(null);
	// A non-blocking warning when manual coin control deliberately selected a
	// coin another in-flight draft of this wallet also references (cairn QA
	// R7 B4) — RBF/respend stays possible, this just flags the collision.
	let reservationWarning = $state<{ message: string } | null>(null);

	async function build() {
		if (!canBuild || building) return;
		building = true;
		buildError = null;
		chainDepthWarning = null;
		reservationWarning = null;
		const recipients = rows.map((r) => ({
			address: r.address.trim(),
			amount: (isMax ? 'max' : r.sats) as number | 'max'
		}));
		// Manual coin control rides along only when coins are actually selected.
		const onlyUtxos = selectedCoins.map((k) => {
			const [txid, vout] = k.split(':');
			return { txid, vout: Number(vout) };
		});
		try {
			const res = await fetch(`/api/wallets/${walletId}/psbt`, {
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
				// The wallet's own errors come back as { error }, but a requireFeature
				// gate throws SvelteKit's error(403, …) which serializes as { message }
				// — read both so a "disabled by your administrator" reason surfaces
				// instead of the generic fallback (cairn-1x3w).
				buildError = body.error ?? body.message ?? 'Could not build the transaction.';
				return;
			}
			draft = body.draft as SavedTransaction;
			details = body.details as ConstructedPsbt;
			chainDepthWarning = body.chainDepthWarning ?? null;
			reservationWarning = body.reservationWarning ?? null;
			signedComplete = false;
			for (const r of recipients) touchSavedAddress(r.address);
			syncTxParam(draft.id);
			step = 'review';
		} catch {
			buildError = 'Could not reach Heartwood to build the transaction.';
		} finally {
			building = false;
		}
	}

	// ------------------------------------------------------------- REVIEW step
	// The saved-address label for the (single) recipient, when the sent-to
	// address is one the user has saved — passed to SendReviewCard.
	const reviewRecipientLabel = $derived(
		review && review.recipients.length === 1
			? (savedAddresses.find((a) => a.address === review.recipient)?.label ?? null)
			: null
	);

	// Signing-mass summary for the Review panel: a fresh build carries it on
	// the build response; a resume may carry it on the PSBT summary. Absent =
	// unknown = no panel. Mass affects signing time ONLY — never the fee — so
	// this panel is advisory and never blocks the flow.
	const signingMass = $derived<SigningMass | null>(
		details?.signingMass ?? resumeSummary?.signingMass ?? null
	);

	// Panel tone. The server's warnLevel drives it (amber = >10 min total,
	// red = >30 min or device-timeout risk); a medium-tier build below the
	// amber threshold still gets a quiet informational panel. Defensive
	// fallback: an older response without warnLevel maps high tier → amber.
	const massLevel = $derived.by<'none' | 'info' | 'amber' | 'red'>(() => {
		if (!signingMass) return 'none';
		const lvl = signingMass.warnLevel ?? (signingMass.tier === 'high' ? 'amber' : 'none');
		if (lvl === 'amber' || lvl === 'red') return lvl;
		return signingMass.tier === 'medium' ? 'info' : 'none';
	});

	// ------------------------------------------------------------- SIGN step
	let signedPsbtText = $state('');
	let attaching = $state(false);
	let signError = $state<string | null>(null);

	async function readFileAsBase64(file: File): Promise<string> {
		const buf = new Uint8Array(await file.arrayBuffer());
		// A raw binary .psbt file starts with the magic bytes "psbt\xff"
		// (0x70 0x73 0x62 0x74 0xff). Base64-encode those. Anything else is
		// treated as text (the base64/hex a user exported and saved).
		const isBinary =
			buf[0] === 0x70 && buf[1] === 0x73 && buf[2] === 0x62 && buf[3] === 0x74 && buf[4] === 0xff;
		if (isBinary) {
			let bin = '';
			for (const b of buf) bin += String.fromCharCode(b);
			return btoa(bin);
		}
		return new TextDecoder().decode(buf).trim();
	}

	async function onSignedFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			signedPsbtText = await readFileAsBase64(file);
			await attachSigned();
		} catch {
			signError = 'Could not read that file.';
		}
	}

	// Central attach path: EVERY signing method — the generic file card and each
	// device signer — funnels its signed PSBT through this PATCH, where the
	// server-side substitution guard verifies the signatures commit to the same
	// transaction the user reviewed before the flow may advance to Confirm.
	async function attachSignedPsbt(psbt: string) {
		if (!psbt || attaching || !draft) return;
		attaching = true;
		signError = null;
		try {
			const patch = await fetch(`/api/wallets/${walletId}/transactions/${draft.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ psbt })
			});
			const patchBody = await patch.json();
			if (!patch.ok) {
				signError = patchBody.error ?? 'That PSBT could not be attached.';
				return;
			}
			draft = patchBody.transaction as SavedTransaction;

			// Confirm signatures are actually present before letting Confirm open —
			// the PATCH response summarizes the PSBT it just stored.
			const complete = Boolean(patchBody?.summary?.complete);
			signedComplete = complete;
			if (complete) {
				step = 'confirm';
			} else {
				signError =
					'This PSBT was attached but still is not fully signed. Sign it with your wallet and upload it again.';
			}
		} catch {
			signError = 'Could not reach Heartwood to attach the signed transaction.';
		} finally {
			attaching = false;
		}
	}

	async function attachSigned() {
		await attachSignedPsbt(signedPsbtText.trim());
	}

	// ------------------------------------------------------------ CONFIRM step
	let broadcasting = $state(false);
	let broadcastError = $state<string | null>(null);
	let broadcastRejected = $state(false);
	// cairn-5yz3.1: broadcast() used to run only from a follow-up Modal
	// ("Broadcast this transaction? Once it's broadcast, there is no undo.")
	// — a second are-you-sure on top of the Confirm step's own full
	// SendReviewCard (amount/recipients/fee already visible right above the
	// button). That was a genuine double-confirm, not two different checks:
	// the modal's copy repeated the step's own irreversibility warning
	// without adding any new information. The Confirm step's primary button
	// IS the one are-you-sure now — it broadcasts directly — so the review
	// stays exactly as visible as before and only the redundant second
	// dialog is gone.
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let sentTxid = $state<string | null>(resumeTx?.txid ?? null);
	// Set only when this broadcast turned out to duplicate another draft's
	// already-sent, byte-identical transaction (cairn QA R7 B4 sub-case 1) —
	// no new payment went out; shown as an informational note on Sent.
	let duplicateBroadcastNote = $state<string | null>(null);

	async function broadcast() {
		if (broadcasting || !draft) return;
		broadcasting = true; // disabled immediately — no double-broadcast
		broadcastError = null;
		broadcastRejected = false;
		duplicateBroadcastNote = null;
		try {
			const res = await fetch(`/api/wallets/${walletId}/transactions/${draft.id}/broadcast`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const body = await res.json();
			if (res.status === 409) {
				// Already sent — recover the txid if we can and jump to Sent.
				sentTxid = body?.transaction?.txid ?? sentTxid;
				step = 'sent';
				return;
			}
			if (!res.ok) {
				// { error } from the wallet, { message } from a requireFeature 403.
				broadcastError = body.error ?? body.message ?? 'Broadcast failed.';
				broadcastRejected = body.code === 'rejected';
				return;
			}
			sentTxid = body.txid as string;
			draft = body.transaction as SavedTransaction;
			if (body.duplicate) duplicateBroadcastNote = body.message ?? null;
			step = 'sent';
		} catch {
			broadcastError = 'Could not reach Heartwood to broadcast.';
		} finally {
			broadcasting = false;
		}
	}

	// -------------------------------------------------------------- navigation
	// Every step change — button, back, or programmatic (attach → Confirm,
	// broadcast → Sent) — moves focus to the new step's section so screen
	// readers announce the step and keyboard users aren't stranded on a button
	// that just unmounted. Watching `step` in one effect covers all paths.
	// Also scrolls back to the top (#26) — a long step (e.g. Review with coin
	// control expanded) otherwise leaves the next step's top out of view.
	let pageEl = $state<HTMLElement | null>(null);
	let initialStepRendered = false; // don't steal focus/scroll on page load / resume
	$effect(() => {
		void step; // the only dependency — rerun on every step change
		if (!initialStepRendered) {
			initialStepRendered = true;
			return;
		}
		scrollToTop();
		// The new step's DOM doesn't exist until after this flush.
		void tick().then(() => {
			pageEl?.querySelector<HTMLElement>('.step-body')?.focus();
		});
	});

	const stepIndex = $derived(STEPS.findIndex((s) => s.key === step));
	const stepAriaLabel = $derived(
		`Step ${stepIndex + 1} of ${STEPS.length}: ${STEPS[stepIndex]?.label ?? ''}`
	);

	// The eyebrow's current descriptor tracks the step; on Create it carries
	// the spendable balance (`SEND · 2.6180 AVAILABLE`).
	const crumbCurrent = $derived.by(() => {
		if (step === 'create')
			return confirmed != null ? `Send · ${formatBtc(confirmed)} available` : 'Send';
		if (step === 'review') return 'Send · review';
		if (step === 'sign') return 'Send · sign';
		if (step === 'confirm') return 'Send · broadcast';
		return 'Sent';
	});

	// Forward navigation is gated: you can only move to a step whose prereq is
	// met. Backward navigation to Create (to edit) is always allowed while the
	// draft is unsigned/unsent.
	function goCreate() {
		if (step === 'sent') return;
		step = 'create';
	}

	// ------------------------------------------- Sent: save-address affordance
	// After a broadcast, offer to remember an unsaved recipient. Dismissible
	// and entirely off the critical path — the transaction is already sent.
	let saveLabel = $state('');
	let savingAddress = $state(false);
	let saveAddressError = $state<string | null>(null);
	let saveDismissed = $state(false);
	let addressJustSaved = $state(false);

	const sentRecipient = $derived(review?.recipient ?? null);
	const showSaveOffer = $derived(
		step === 'sent' &&
			!saveDismissed &&
			!addressJustSaved &&
			sentRecipient !== null &&
			!savedAddresses.some((a) => a.address === sentRecipient)
	);

	async function saveRecipient() {
		const label = saveLabel.trim();
		if (!sentRecipient || !label || savingAddress) return;
		savingAddress = true;
		saveAddressError = null;
		try {
			const res = await fetch('/api/address-book', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address: sentRecipient, label })
			});
			const body = await res.json();
			if (!res.ok) {
				saveAddressError = body.error ?? 'Could not save the address.';
				return;
			}
			savedAddresses = [body.address as SavedAddress, ...savedAddresses];
			addressJustSaved = true;
			toast.success('Saved to your address book.');
		} catch {
			saveAddressError = 'Could not reach Heartwood to save the address.';
		} finally {
			savingAddress = false;
		}
	}

	const fileUrl = $derived(
		draft ? `/api/wallets/${walletId}/transactions/${draft.id}/file` : '#'
	);
	const explorerUrl = $derived(sentTxid ? `/explorer/tx/${sentTxid}` : '#');

	// ---------------------------------------------------- Sign: method selection
	// One signing method is active (expanded) at a time; the rest collapse to
	// selectable tiles. `null` = nothing chosen yet (pure method selection).
	// The SignMethod set is exactly WalletDeviceType, so the device on record
	// (if any) both pre-selects a method and drives the "Sign with your <device>"
	// heading — a single-key wallet lands on one signing screen, not a menu.
	type SignMethod = 'file' | DeviceSignMethodKey;

	// The wallet's script type — the BitBox02 tile is greyed out for legacy
	// (p2pkh) wallets it can't sign (the device firmware has no legacy config).
	// svelte-ignore state_referenced_locally
	const walletScriptType = data.wallet.scriptType as ScriptType;

	// The device associated with this wallet, tracked locally so associating one
	// mid-send (below) updates the heading immediately.
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let walletDevice = $state<WalletDeviceType | null>(data.wallet.deviceType);
	// Pre-select the known device (file included) so Sign opens straight on it.
	// SignMethod === WalletDeviceType, so the device on record IS the method:
	// a BitBox02/Jade wallet now opens straight on its dedicated USB signer (a
	// p2pkh BitBox02 wallet lands on the signer's own "can't sign here" state,
	// which offers the file method — clearer than never pre-selecting).
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let activeMethod = $state<SignMethod | null>(data.wallet.deviceType);
	// Bumped to remount the active signer from scratch — a clean retry after the
	// server-side guard rejects what a device returned.
	let signerEpoch = $state(0);

	// The device signer heading: names the wallet's device once one is known.
	const signHeading = $derived(
		walletDevice && walletDevice !== 'file'
			? `Sign with your ${WALLET_DEVICE_LABELS[walletDevice]}`
			: 'Sign this transaction with your wallet'
	);

	// The Sign step's single key row: name the device when one is on record.
	const keyRowName = $derived(
		walletDevice && walletDevice !== 'file' ? WALLET_DEVICE_LABELS[walletDevice] : 'Your key'
	);

	// Persist which device the user signs with the first time they pick one, so
	// future sends skip straight to it. Fire-and-forget: a failed save just means
	// they'll pick again next time. 'file' is generic and never recorded; picking
	// it (or skipping) leaves the wallet on the universal fallback.
	async function rememberDevice(m: SignMethod) {
		if (m === 'file' || m === walletDevice) return;
		walletDevice = m;
		toast.success(
			`Saved — future sends from this wallet will go straight to your ${WALLET_DEVICE_LABELS[m]}.`
		);
		try {
			await fetch(`/api/wallets/${walletId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceType: m })
			});
		} catch {
			/* best-effort — the send itself is unaffected */
		}
	}

	// Availability is probed client-side only (navigator.* does not exist during
	// SSR) — start pessimistic and re-check after mount, like the signers do.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
		// Keep the block tip live so coinbase-maturity in coin control updates as
		// blocks arrive (an immature reward becomes selectable on its 100th block),
		// and refresh the streamed fee estimates + tip on each new block by
		// invalidating this page's load tag — reactive, never a poll. onNewBlock is
		// SSR-safe and self-throttling; unsubscribe on destroy.
		let lastSeen = tipHeight;
		const unsubscribe = onNewBlock((height) => {
			if (height <= lastSeen) return;
			lastSeen = height;
			// Optimistic tip bump so AtTipPill/coin-control react immediately…
			if (height > tipHeight) tipHeight = height;
			// …then re-run the streamed load so fees + tip refresh from the node.
			void invalidate(`cairn:send:${walletId}`);
		});
		return unsubscribe;
	});

	// The device signer methods, gated per the DeviceMethod contract. The list
	// and its capability gating live in _components/signMethods.ts (pure,
	// unit-tested — cairn-34nl); the generic file card is handled separately (it
	// is always available and hosts its own upload/paste UI).
	const deviceMethods = deviceSignMethods(walletScriptType);

	// Only one Svelte component per method key — the {#each} below picks from here.
	const SIGNER_COMPONENTS = {
		trezor: TrezorSigner,
		ledger: LedgerSigner,
		coldcard: ColdCardSigner,
		bitbox02: BitboxSigner,
		jade: JadeUsbSigner,
		'jade-qr': JadeQrSigner,
		qr: QrSigner
	} as const;

	function selectMethod(m: SignMethod) {
		activeMethod = m;
		signError = null;
		signerEpoch += 1;
		// First send from a wallet with no device on record: remember the choice.
		void rememberDevice(m);
	}

	function collapseMethod() {
		activeMethod = null;
		signError = null;
	}

	// Every signer hands its result here → same substitution-guard PATCH as the
	// generic file method, then the flow advances identically.
	function handleDeviceSigned(signedPsbtBase64: string) {
		void attachSignedPsbt(signedPsbtBase64.trim());
	}

	// The PSBT the signers consume: the server row is the source of truth (it is
	// refreshed by every successful attach), with the build response as fallback.
	const unsignedPsbt = $derived(draft?.psbt ?? details?.psbtBase64 ?? '');

	// Human-readable context so each signer can tell the user what to verify on
	// the device screen. Null until a draft + review exist (i.e. before build).
	// Batch sends: SignerContext carries a single destination/amount pair (the
	// device components consuming it cannot be changed here), so we pass an
	// aggregate — the FIRST recipient's address annotated with how many more
	// there are, and the TOTAL amount across recipients. The device screen
	// itself lists every output, which is what the user actually verifies.
	const signerContext = $derived.by<SignerContext | null>(() => {
		if (!draft || !review) return null;
		const extra = review.recipients.length - 1;
		return {
			walletId,
			draftId: draft.id,
			scriptType: data.wallet.scriptType,
			destinationAddress:
				extra > 0
					? `${review.recipients[0].address} (+${extra} more recipient${extra === 1 ? '' : 's'})`
					: review.recipient,
			amountSats: review.amount,
			feeSats: review.fee,
			changeSats: review.change?.value ?? 0
		};
	});
</script>

<svelte:head>
	<title>Send · {data.wallet.name} · Heartwood</title>
</svelte:head>

<div class="send-page hw-owns-header" bind:this={pageEl}>
	<GroveField volume={step === 'sent' ? 'grove' : 'present'} />

	<div class="page-content">
		<!-- Mobile flow header (8b/8c): back circle + centered eyebrow + spacer.
		     The Sent moment (8k) drops the back circle — there is no "back" from
		     a broadcast, only Done. -->
		<header class="flow-header">
			{#if step === 'sent'}
				<span class="flow-spacer"></span>
			{:else}
				<BackCircle href={`/wallets/${walletId}`} />
			{/if}
			<span class="flow-eyebrow">
				{#if step === 'sign'}
					Sign
					<QuorumArc total={1} collected={signedComplete ? 1 : 0} active={!signedComplete} size={18} />
					{signedComplete ? 1 : 0} of 1
				{:else if step === 'sent'}
					Sent
				{:else}
					Send · {data.wallet.name}
				{/if}
			</span>
			<span class="flow-spacer"></span>
		</header>

		<div class="eyebrow-row">
			<EyebrowBreadcrumb path={[data.wallet.name]} current={crumbCurrent} />
			<AtTipPill height={tipHeight} pulseKey={tipHeight} />
		</div>

		<!-- ============================================================ CREATE -->
		{#if step === 'create'}
			<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
				{#if scanError}
					<Banner variant="error">
						Couldn't reach your node to load spendable coins. Check that your
						node is running and reachable, then try again in a moment.
					</Banner>
				{/if}

				{#if consolidateParams}
					<div class="max-note">
						<Icon name="zap" size={15} />
						<span>
							Consolidating {consolidateParams.coinKeys.length}
							{consolidateParams.coinKeys.length === 1 ? 'coin' : 'coins'} — they're preselected under
							“Choose which coins to spend”, and Max sweeps them into one new coin (minus the
							network fee).
							{#if consolidateParams.to}The recipient is your own next receive address.{:else}Enter
								one of your own receive addresses as the recipient.{/if}
						</span>
					</div>
				{/if}

				{#if rows.length === 1}
					{@const row = rows[0]}
					<!-- The hero: the typed amount owns the page. -->
					<div class="amount-hero">
						{#if !isMax}
							<AmountEntry
								bind:sats={row.sats}
								autofocus
								spendableSats={confirmed}
								ariaLabel="Amount to send"
							/>
						{:else}
							<div class="hero-line">
								<span class="hero-max">Everything</span>
							</div>
							<p class="hero-sub">
								Sweeps the entire spendable balance to this address, minus the fee.
							</p>
						{/if}
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
					</div>

					<!-- TO: hairline field, mono, with scan + paste. -->
					<div class="to-field">
						<span class="sec-label" id="to-label">To</span>
						<RecipientCombobox
							id={`recipient-${row.key}`}
							bind:value={row.address}
							saved={savedAddresses}
							invalid={row.address.length > 0 && !looksLikeAddress(row.address)}
							ondelete={deleteSavedAddress}
							currentAmountText={row.sats > 0 ? String(row.sats) : ''}
							onamount={(sats) => {
								if (amountMode === 'max') return;
								row.sats = sats;
							}}
						/>
						{#if classifyRecipientAddress(row.address) === 'testnet'}
							<p class="field-line attention">
								That looks like a test-network address — this wallet uses regular Bitcoin
								(mainnet).
							</p>
						{:else if row.address.length > 0 && !looksLikeAddress(row.address)}
							<p class="field-line attention">That doesn't look like a Bitcoin address yet.</p>
						{:else if looksLikeAddress(row.address)}
							<p class="field-line sage">
								<Icon name="check" size={12} strokeWidth={2.5} /> Valid Bitcoin address
							</p>
						{/if}
					</div>
				{:else}
					<!-- Batch send: one hairline block per recipient. -->
					<div class="batch-blocks">
						{#each rows as row, i (row.key)}
							<div class="recipient-block">
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
								<div class="field">
									<RecipientCombobox
										id={`recipient-${row.key}`}
										bind:value={row.address}
										saved={savedAddresses}
										invalid={row.address.length > 0 && !looksLikeAddress(row.address)}
										ondelete={deleteSavedAddress}
										currentAmountText={row.sats > 0 ? String(row.sats) : ''}
										onamount={(sats) => {
											row.sats = sats;
										}}
									/>
									{#if classifyRecipientAddress(row.address) === 'testnet'}
										<p class="field-line attention">
											That looks like a test-network address — this wallet uses regular
											Bitcoin (mainnet).
										</p>
									{:else if row.address.length > 0 && !looksLikeAddress(row.address)}
										<p class="field-line attention">
											That doesn't look like a Bitcoin address yet.
										</p>
									{/if}
								</div>
								<div class="field">
									<AmountEntry
										bind:sats={row.sats}
										compact
										spendableSats={confirmed}
										ariaLabel={`Amount for recipient ${i + 1}`}
									/>
									{#if amountError(row)}
										<p class="field-line attention">{amountError(row)}</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<div class="row batch-row">
					<button type="button" class="btn btn-ghost btn-sm" onclick={addRow}>
						<Icon name="plus" size={14} /> Add another recipient
					</button>
					{#if rows.length > 1 && createTotalSats > 0}
						<span class="field-line muted batch-total">
							Total: <Amount sats={createTotalSats} size="row" />
						</span>
					{/if}
				</div>
				{#if rows.length > 1 && exceedsBalance && rows.every((r) => amountError(r) === null)}
					<!-- Each amount passes alone but the batch overshoots together — say so
					     once, by the total, instead of leaving the button silently disabled. -->
					<p class="field-line attention">
						Together these amounts are more than this wallet holds.
					</p>
				{/if}

				<FeeSpeedPicker {fees} bind:feeRate bind:choice={feeChoice} loading={!liveLoaded} />

				{#if utxos.length > 0}
					{#if data.flags?.coin_control === false}
						<!-- Coin control disabled by an admin: show WHY rather than silently
						     dropping the picker, and leave selection empty so the send uses
						     automatic coin selection (cairn-jyh7, cairn-8dup). -->
						<FeatureDisabled
							block
							message="Choosing specific coins to spend has been disabled by your administrator."
						/>
					{:else}
						<!-- Optional manual coin control — collapsed so the default flow stays clean. -->
						<div class="field">
							<CoinControl
								{walletId}
								{utxos}
								bind:selected={selectedCoins}
								{tipHeight}
								initialOpen={consolidateParams !== null}
							/>
						</div>
					{/if}
				{/if}

				<HowItWorks id="send-psbt">
					<p>
						Heartwood builds an <Term
							tip="A Partially Signed Bitcoin Transaction — an unsigned proposal your hardware wallet reviews and signs. Your private keys never touch Heartwood's server."
							>unsigned transaction (a PSBT)</Term
						> — a proposal describing exactly what will be sent. You take it to your hardware
						wallet or signing app, which reviews it and adds your signature.
					</p>
					<p>
						<strong>Heartwood never sees a key.</strong> It only holds your public key — it can
						build and broadcast, but only your device can authorize the spend.
					</p>
				</HowItWorks>

				{#if buildError}
					<div class="form-error" role="alert">{buildError}</div>
				{/if}

				<div class="row step-actions" style="justify-content: flex-end">
					<a class="btn btn-ghost" href={`/wallets/${walletId}`}>Cancel</a>
					<button class="btn btn-primary pill-lg" onclick={build} disabled={!canBuild || building}>
						{#if building}<span class="spinner"></span> Building…{:else}Review send<Icon
								name="arrow-right"
								size={15}
							/>{/if}
					</button>
				</div>
			</section>

		<!-- ============================================================ REVIEW -->
		{:else if step === 'review' && review}
			<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
				<SendReviewCard
					mode="review"
					amountSats={review.amount}
					recipients={review.recipients}
					feeSats={review.fee}
					feeRate={review.feeRate}
					changeSats={review.change?.value ?? null}
					inputs={review.inputs}
					vsize={review.vsize}
					recipientLabel={reviewRecipientLabel}
					arrivalWords={arrivalWords(feeChoice)}
					multisig={null}
				/>

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

				<!-- Signing-mass panel: advisory only, never blocks. Signing time is a
				     property of where the coins came from — the network fee is untouched. -->
				{#if signingMass && massLevel !== 'none'}
					<div
						class="mass-panel {massLevel}"
						role={massLevel === 'red' ? 'alert' : 'status'}
						aria-live={massLevel === 'red' ? 'assertive' : 'polite'}
					>
						<Icon name={massLevel === 'info' ? 'clock' : 'alert-triangle'} size={16} />
						<div class="mass-body">
							{#if massLevel === 'info'}
								<strong>
									This transaction includes coins from batch payouts. Signing may take a little
									longer than usual on your hardware wallet.
								</strong>
							{:else}
								<strong>
									This transaction includes coins from large batch payouts (mining pools). Signing
									may take several minutes on your hardware wallet.
								</strong>
							{/if}
							{#if signingMass.totalSeconds}
								<p class="mass-headline">
									Estimated signing time: {formatSigningRange(
										signingMass.totalSeconds.lo,
										signingMass.totalSeconds.hi,
										'long'
									)}
								</p>
							{/if}
							{#if signingMass.perDevice?.length}
								<p class="mass-devices tabular">{perDeviceLine(signingMass.perDevice)}</p>
							{/if}
							{#if massLevel === 'red' || signingMass.splitSuggested}
								<p class="mass-split">
									This may cause your device to time out. Consider sending as two separate
									transactions.
								</p>
							{/if}
							<p class="mass-why">
								<Term tip={MASS_WHY_TIP}>Why does this take longer?</Term>
							</p>
						</div>
					</div>
				{/if}

				<div class="row step-actions">
					<button class="btn btn-secondary" onclick={goCreate}>
						<Icon name="chevron-left" size={15} /> Back &amp; edit
					</button>
					<button class="btn btn-primary pill-lg" onclick={() => (step = 'sign')}>
						{sendCtaLabel(review.amount + review.fee, $btcUsd, 'review')}
						<Icon name="arrow-right" size={15} />
					</button>
				</div>
			</section>

		<!-- ============================================================== SIGN -->
		{:else if step === 'sign'}
			<section class="step-body sign-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
				{#if review}
					<div class="sign-hero">
						<Amount sats={review.amount} size="hero" />
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
						<div class="sig-head">
							<QuorumArc
								total={1}
								collected={signedComplete ? 1 : 0}
								active={!signedComplete}
								size={26}
							/>
							<h2 class="section-title">
								Signatures · {signedComplete ? 1 : 0} of 1 collected
							</h2>
						</div>

						<div class="key-rows">
							<div class="key-row">
								<span class="key-name">{keyRowName}</span>
								{#if signedComplete}
									<span class="key-state signed"
										><Icon name="check" size={13} strokeWidth={2.5} /> Signed</span
									>
								{:else}
									<span class="key-state pending">Sign below</span>
								{/if}
							</div>
						</div>

						<p class="never-line">Heartwood never sees a key — signing happens on your device.</p>

						<!-- Plain-HTTP page (e.g. stock Umbrel): the USB methods below are limited
						     or disabled; Heartwood's own HTTPS listener is the way to use them
						     directly. Renders nothing in a secure context. -->
						<SecureContextHelp what="plug-in USB signing" />

						<div class="method-grid">
							<!-- Generic / file method: always available, hosts its own upload UI. -->
							{#if activeMethod === 'file'}
								<div class="method-active">
									<div class="method-head">
										<span class="method-icon"><Icon name="wallet" size={18} /></span>
										<div>
											<h3 class="method-title">Generic wallet / file</h3>
											<p class="method-sub">
												Sparrow, ColdCard, Electrum, BlueWallet, or any PSBT-capable signer
											</p>
										</div>
									</div>

									<ol class="sign-steps">
										<li>
											<div class="sign-step-body">
												<span class="sign-step-title">Download the unsigned PSBT</span>
												<a class="btn btn-secondary btn-sm" href={fileUrl} download>
													<Icon name="arrow-down-left" size={14} /> Download .psbt
												</a>
											</div>
										</li>
										<li>
											<div class="sign-step-body">
												<span class="sign-step-title">Sign it in your wallet</span>
												<span class="field-line muted">
													Open the file in Sparrow / ColdCard / Electrum, verify the recipient and
													amount on the device, and export the signed PSBT.
												</span>
											</div>
										</li>
										<li>
											<div class="sign-step-body">
												<span class="sign-step-title">Bring the signed PSBT back</span>
												<label class="file-drop">
													<input
														type="file"
														accept=".psbt,.txt,text/plain,application/octet-stream"
														onchange={onSignedFile}
													/>
													<Icon name="arrow-up-right" size={15} />
													<span>Upload signed .psbt file</span>
												</label>
												<div class="or-divider"><span>or paste base64 / hex</span></div>
												<textarea
													class="input mono"
													rows="3"
													placeholder="cHNidP8BA…"
													bind:value={signedPsbtText}
												></textarea>
												{#if signError}
													<div class="form-error" role="alert">{signError}</div>
												{/if}
												<button
													class="btn btn-primary"
													onclick={attachSigned}
													disabled={attaching || signedPsbtText.trim().length === 0}
												>
													{#if attaching}<span class="spinner"></span> Checking signatures…{:else}Attach
														signed transaction{/if}
												</button>
											</div>
										</li>
									</ol>

									<div class="method-foot">
										<button type="button" class="btn btn-ghost btn-sm" onclick={collapseMethod}>
											<Icon name="x" size={14} /> Use a different method
										</button>
									</div>
								</div>
							{:else}
								<DeviceCard
									name="Generic wallet / file"
									hint="Sparrow, Electrum, BlueWallet, or any PSBT-capable signer — download, sign, upload"
									icon="wallet"
									disabled={false}
									onselect={() => selectMethod('file')}
								/>
							{/if}

							<!-- Device signers: selecting one mounts its component; the guard-side
							     attach path is shared with the file method via handleDeviceSigned. -->
							{#each deviceMethods as m (m.key)}
								{#if activeMethod === m.key && signerContext}
									{#key signerEpoch}
										{@const Signer = SIGNER_COMPONENTS[m.key]}
										<Signer
											{unsignedPsbt}
											context={signerContext}
											onsigned={handleDeviceSigned}
											oncancel={collapseMethod}
										/>
									{/key}
								{:else}
									<DeviceCard
										name={m.name}
										hint={m.blurb}
										icon={m.icon}
										disabled={!mounted || !m.available()}
										badge="Unavailable"
										reason={mounted && !m.available() ? m.unavailableReason : undefined}
										onselect={() => selectMethod(m.key)}
									/>
								{/if}
							{/each}
						</div>

						<!-- Shared attach status for device signers: the components report their
						     own device errors, but the substitution-guard verdict lives here. -->
						{#if activeMethod !== null && activeMethod !== 'file'}
							{#if attaching}
								<!-- role="status" implies polite announcements, but the pairing is
								     honored inconsistently across AT — the explicit aria-live makes
								     sure the signature-progress update is actually spoken. -->
								<div class="attach-status" role="status" aria-live="polite">
									<span class="spinner"></span> Checking signatures against the transaction you reviewed…
								</div>
							{:else if signError}
								<div class="form-error" role="alert">
									{signError}
									<div class="error-actions">
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => selectMethod(activeMethod!)}
										>
											<Icon name="refresh" size={14} /> Try again
										</button>
										<button class="btn btn-ghost btn-sm" onclick={collapseMethod}>
											Choose another method
										</button>
									</div>
								</div>
							{/if}
						{/if}

						<HowItWorks id="send-sign">
							<p>
								Signing happens <strong>on your device</strong>, never here.
								{#if walletDevice && walletDevice !== 'file'}
									Your wallet signs with a {WALLET_DEVICE_LABELS[walletDevice]} — follow its steps above,
									review the amount and address <em>on the device screen</em>, and approve. Prefer a
									different method this once? Choose “Use a different method”.
								{:else}
									Pick how your signer receives the unsigned transaction — USB, a microSD card, QR
									codes, or a plain file — then review the amount and address
									<em>on the device screen</em> and approve.
								{/if}
								Heartwood verifies that every returned signature commits to the exact transaction
								you reviewed before it can be broadcast.
							</p>
						</HowItWorks>
					</div>

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
								The device screen is the truth — approve only if it shows exactly this.
							</p>
						{/if}
						<div class="verify-actions">
							<a class="btn btn-secondary" href={fileUrl} download>
								<Icon name="arrow-down-left" size={14} /> Export PSBT
							</a>
							<a class="btn btn-ghost" href={`/wallets/${walletId}`}>Finish later</a>
						</div>
						<p class="verify-note">
							Drafts are saved — leave anytime and this page resumes where you left off.
						</p>
					</aside>
				</div>

				<div class="row step-actions">
					<button class="btn btn-secondary" onclick={() => (step = 'review')}>
						<Icon name="chevron-left" size={15} /> Back to review
					</button>
				</div>
			</section>

		<!-- =========================================================== CONFIRM -->
		{:else if step === 'confirm' && review}
			<section class="step-body fade-in" tabindex="-1" aria-label={stepAriaLabel}>
				<SendReviewCard
					mode="confirm"
					amountSats={review.amount}
					recipients={review.recipients}
					feeSats={review.fee}
					feeRate={review.feeRate}
					changeSats={review.change?.value ?? null}
					inputs={review.inputs}
					vsize={review.vsize}
					recipientLabel={reviewRecipientLabel}
					arrivalWords={arrivalWords(feeChoice)}
					multisig={null}
				/>

				{#if broadcastError}
					<Banner variant="error">
						{broadcastError}
						{#snippet actions()}
							{#if broadcastRejected || draft}
								<a class="btn btn-secondary btn-sm" href={fileUrl} download>
									<Icon name="arrow-down-left" size={14} /> Download PSBT
								</a>
								<button class="btn btn-ghost btn-sm" onclick={() => (step = 'sign')}>
									Re-sign
								</button>
							{/if}
						{/snippet}
					</Banner>
				{/if}

				<div class="row step-actions">
					<button class="btn btn-secondary" onclick={() => (step = 'sign')} disabled={broadcasting}>
						<Icon name="chevron-left" size={15} /> Back
					</button>
					<button
						class="btn btn-primary pill-lg"
						onclick={() => void broadcast()}
						disabled={broadcasting}
					>
						{#if broadcasting}<span class="spinner"></span> Broadcasting…{:else}{sendCtaLabel(
								review.amount + review.fee,
								$btcUsd,
								'confirm'
							)}{/if}
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
					<h2 class="sent-title"><Amount sats={review.amount} size="hero" /> is on its way</h2>
				{:else}
					<h2 class="sent-title">Your bitcoin is on its way</h2>
				{/if}
				<p class="sent-sub">
					From {data.wallet.name} · in the mempool, waiting for its first ring{#if review}
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

				{#if showSaveOffer && sentRecipient}
					<div class="save-offer fade-in">
						<div class="save-offer-head">
							<span class="save-offer-title">Save this address for next time?</span>
							<button
								type="button"
								class="save-dismiss"
								aria-label="Dismiss"
								onclick={() => (saveDismissed = true)}
							>
								<Icon name="x" size={14} />
							</button>
						</div>
						<p class="save-offer-addr mono">{truncateMiddle(sentRecipient, 16, 12)}</p>
						<div class="save-offer-row">
							<input
								class="input"
								placeholder="Label — e.g. Cold storage"
								maxlength={60}
								bind:value={saveLabel}
								aria-label="Label for this address"
								onkeydown={(e) => {
									if (e.key === 'Enter') void saveRecipient();
								}}
							/>
							<button
								class="btn btn-secondary"
								onclick={saveRecipient}
								disabled={savingAddress || saveLabel.trim().length === 0}
							>
								{#if savingAddress}<span class="spinner"></span> Saving…{:else}Save{/if}
							</button>
						</div>
						{#if saveAddressError}
							<div class="form-error" role="alert">{saveAddressError}</div>
						{/if}
					</div>
				{/if}

				<div class="row step-actions" style="justify-content: center">
					<!-- /explorer/tx/[txid] is exempt from the explorer flag (cairn-5yz3.3
					     — tx detail, not chain browsing), so this link is always live. -->
					<a class="btn btn-primary pill-lg" href={explorerUrl}>Watch it get buried</a>
					<a class="btn btn-secondary" href={`/wallets/${walletId}`}>Done</a>
				</div>
				<p class="sent-caption">We'll nudge you at the first ring — and at six.</p>
				<a class="sent-again" href={`/wallets/${walletId}/send`} data-sveltekit-reload
					>Send another</a
				>
			</section>
		{/if}
	</div>
</div>

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

	/* ---- Create: the amount hero ---- */
	.amount-hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.hero-line {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
	}

	/* The one number that owns the page: 86px serif on desktop (5a). */
	.hero-input {
		background: transparent;
		border: none;
		outline: none;
		padding: 0;
		max-width: 100%;
		min-width: 4ch;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 86px;
		line-height: 0.92;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.hero-input::placeholder {
		color: var(--text-faint);
	}

	/* Serif 400 · 34 in the eyebrow tone, per the 5a unit spec. */
	.hero-unit {
		font-family: var(--font-serif);
		font-weight: 400;
		font-size: 34px;
		color: var(--eyebrow);
	}

	.hero-max {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 64px;
		line-height: 1;
		letter-spacing: -0.015em;
		color: var(--text-hero);
	}

	.unit-swap {
		align-self: center;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		flex-shrink: 0;
		border: 1px solid var(--border-control);
		border-radius: 50%;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.unit-swap:hover {
		color: var(--accent);
		border-color: var(--border-ghost);
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hero-sub.attention {
		color: var(--attention);
	}

	.mode-toggles {
		display: flex;
		gap: 4px;
	}

	/* ---- Create: TO hairline field ---- */
	.to-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
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

	/* ---- Create: batch rows ---- */
	.batch-blocks {
		display: flex;
		flex-direction: column;
	}

	.recipient-block {
		display: flex;
		flex-direction: column;
		gap: 12px;
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

	.batch-total {
		text-align: right;
	}

	.amount-input {
		display: flex;
		align-items: baseline;
		gap: 8px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 6px;
	}

	.batch-amount {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 20px;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.batch-amount::placeholder {
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

	/* Attention (never red) panels: fee typos, chain-depth notes. */
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

	.attention-panel strong {
		display: block;
	}

	.error-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	/* ---- Review ---- */
	.review-hero {
		display: flex;
		flex-direction: column;
		gap: 8px;
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
		padding-top: 6px;
	}

	.utxo-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.utxo-row:last-child {
		border-bottom: none;
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
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.key-rows {
		display: flex;
		flex-direction: column;
	}

	.key-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
	}

	.key-name {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.key-state {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 500;
	}

	/* Spec 5b: a collected signature reads bright copper, not sage. */
	.key-state.signed {
		color: var(--accent-bright);
	}

	.key-state.pending {
		color: var(--accent-bright);
	}

	.never-line {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.method-grid {
		display: grid;
		grid-template-columns: 1fr;
	}

	.method-active {
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.method-head {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 16px;
	}

	.method-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-icon-btn);
		background: var(--accent-muted);
		color: var(--accent);
	}

	.method-title {
		font-size: 15px;
		font-weight: 600;
	}

	.method-sub {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.sign-steps {
		list-style: none;
		counter-reset: sign;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sign-steps li {
		counter-increment: sign;
		display: flex;
		gap: 12px;
	}

	.sign-steps li::before {
		content: counter(sign);
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sign-step-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		flex: 1;
	}

	.sign-step-title {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text);
	}

	.file-drop {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px dashed var(--border-ghost);
		border-radius: var(--radius-icon-btn);
		padding: 12px;
		color: var(--text-secondary);
		font-size: 13px;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.file-drop:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.file-drop input {
		display: none;
	}

	.or-divider {
		display: flex;
		align-items: center;
		text-align: center;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.or-divider::before,
	.or-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--hairline);
	}

	.or-divider span {
		padding: 0 10px;
	}

	.method-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
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

	/* ---- Review: signing-mass panel ----
	   info = quiet FYI, amber = attention palette, red = strong (timeout risk).
	   Red borrows the error palette for urgency but the copy stays about time,
	   never safety — the coins are fine, the wait is the issue. */
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

	.mass-panel.info {
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
	}

	.mass-panel.info :global(svg) {
		color: var(--text-secondary);
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

	.mass-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.mass-headline {
		font-weight: 500;
	}

	.mass-devices {
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.mass-split {
		font-weight: 500;
	}

	.mass-why {
		font-size: 12px;
		color: var(--text-muted);
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

	/* ---- Sent: save-address offer ---- */
	.save-offer {
		width: 100%;
		max-width: 420px;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		padding: 14px 0;
	}

	.save-offer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.save-offer-title {
		font-size: 13.5px;
		font-weight: 600;
	}

	.save-dismiss {
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

	.save-dismiss:hover {
		color: var(--text);
		background: var(--bg-input);
	}

	.save-offer-addr {
		font-size: 12.5px;
		color: var(--text-muted);
		word-break: break-all;
	}

	.save-offer-row {
		display: flex;
		gap: 8px;
	}

	.save-offer-row .input {
		flex: 1;
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

		.hero-line {
			justify-content: center;
		}

		.amount-hero {
			align-items: center;
			text-align: center;
		}

		.hero-input {
			font-size: 52px;
			line-height: 1;
			text-align: center;
		}

		.hero-max {
			font-size: 40px;
		}

		.hero-unit {
			font-size: 20px;
		}

		.mode-toggles {
			justify-content: center;
		}

		.review-hero {
			align-items: center;
			text-align: center;
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

	/* Touch targets: text toggles are tap targets — give them the full ≥44px
	   hit area on touch screens and narrow viewports. */
	@media (max-width: 520px), (pointer: coarse) {
		.txt-toggle {
			min-height: 44px;
			padding: 10px 16px;
		}
	}
</style>
