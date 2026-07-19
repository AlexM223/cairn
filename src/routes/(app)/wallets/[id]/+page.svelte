<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, goto, invalidate, replaceState } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import { confirmationsFor } from '$lib/confirmations';
	import { tipHeight as liveTip } from '$lib/live/tipHeight.svelte';
	import { onWalletEvent, debounced } from '$lib/live/walletEvents';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import TxStatusBadge from '$lib/components/TxStatusBadge.svelte';
	import ConsolidationCard from './_components/ConsolidationCard.svelte';
	import ReceivePanel from './_components/ReceivePanel.svelte';
	import MiningRewards from '$lib/components/MiningRewards.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import { canOfferSpeedUp } from '$lib/shared/speedUp';
	import { shouldShowNetworkFee } from '$lib/shared/txRow';
	import WalletStepChart from './_components/WalletStepChart.svelte';
	import BalanceHorizons from '$lib/components/portfolio/BalanceHorizons.svelte';
	import { formatFeeRate, gatedFiatPrice, timeAgo, truncateMiddle } from '$lib/format';
	import { buildHorizonRows, changesFromHorizonSeries, historyFromTxDeltas } from '$lib/horizonDelta';
	import { SCRIPT_TYPE_LABELS, WALLET_DEVICE_LABELS, walletTypeLabel } from '../labels';
	import {
		OFFICIAL_SUPPORT_URLS,
		REFERRAL_DEVICE_LABELS,
		referralDeviceId
	} from '$lib/referrals';
	// Layout/styling shared with the multisig detail page (namespaced under the
	// root's .wallet-detail class); this page's style block keeps only what differs.
	import '$lib/styles/wallet-detail.css';

	let { data, form } = $props();

	// With the explorer feature flag off, /explorer/** 403s server-side for
	// chain-browsing routes (address/block/mempool) — those links below degrade
	// to a non-interactive summary. Tx links are exempt from this flag
	// (cairn-5yz3.3 — /explorer/tx/[txid] is tx detail, not browsing, and the
	// only tx-detail surface in the app) so they're always live links now.
	const explorerEnabled = $derived(data.flags?.explorer !== false);

	// Stale-while-revalidate (cairn-2zxt): the scan/receive/tip/speed-up bundle now
	// comes from a persisted snapshot read synchronously in load() — instant, no
	// Electrum on navigation. `refresh()` (below) POSTs to the /refresh endpoint to
	// re-scan in the background and, on success, re-invalidates the loader to pick
	// up the fresh snapshot. `data.chainData` is already resolved (not a promise).
	const chainData = $derived(data.chainData);
	const scan = $derived(chainData.scan);
	const coinbaseUtxos = $derived(chainData.coinbaseUtxos);
	const tipHeight = $derived(chainData.tipHeight);
	const speedUp = $derived(chainData.speedUp);
	// cairn-oae1.3: Electrum's `confirmed` counts an immature coinbase output as
	// spendable — `maturingTotal` is that slice, so the headline can show what's
	// actually available separately from what's still cooling down.
	const maturingTotal = $derived(chainData.maturingTotal ?? 0);
	// 0 when there's no scan yet — only ever rendered inside `{#if scan}` below.
	const available = $derived(scan ? scan.confirmed - maturingTotal : 0);
	// Inbound payments double-spent / RBF'd away before confirming (cairn-a2p1) —
	// the live scan drops them from the balance, so these amber rows reconcile the
	// vanished amount the user briefly saw "on its way".
	const cancelledTxs = $derived(data.cancelledTxs ?? []);

	// First-deposit confidence (cairn-gt05.6, F17): the pre-first-funds "is this
	// really mine" and first-deposit-pending states drive compulsive
	// block-explorer checking. Both are answered with a mechanism-fact, not
	// reassurance — see docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md §B.
	const neverFunded = $derived(
		!!scan && available === 0 && scan.txs.length === 0 && scan.unconfirmed === 0
	);
	const hasIncomingPending = $derived(!!scan && scan.unconfirmed > 0);

	// --- lazy fiat snapshot (cairn-d326, R6 / F1) ---------------------------
	// The hero used to fall through to Amount's default `price` prop, which
	// subscribes to the shared $btcUsd store and live-ticks every 60s — every
	// tick is a fresh loss-aversion evaluation event even without color or
	// motion (DESIGN-MANIFESTO.md motion MUST). Mirrors Home's own pattern
	// exactly: privacy-gated (off unless the user opted into `cairn.fiat`),
	// fetched once per mount/navigation, then held steady for the rest of the
	// visit — no interval. Passed explicitly to the hero Amount so it stops
	// resolving through the live store.
	let showFiat = $state(false);
	let usdPrice = $state<number | null>(null);
	let priceTried = $state(false);
	onMount(() => {
		showFiat = localStorage.getItem('cairn.fiat') === 'on';
	});
	async function fetchPrice() {
		priceTried = true;
		try {
			const res = await fetch('/api/price');
			const body = res.ok ? await res.json() : null;
			usdPrice = body?.usd ?? null;
		} catch {
			usdPrice = null;
		}
	}
	$effect(() => {
		if (showFiat && !priceTried) void fetchPrice();
	});
	const heroPrice = $derived(gatedFiatPrice(showFiat, usdPrice));

	// --- multi-horizon balance delta (cairn-d326, R6) ------------------------
	// This page has no balance_snapshots history wired to its loader, but the
	// scan already carries every confirmed tx delta — the same data
	// WalletStepChart reconstructs its line from. historyFromTxDeltas rebuilds
	// an honest point-in-time series from that (returns null if the deltas
	// can't be trusted to reconcile with the scanned balance, in which case no
	// horizons render rather than show a number that could contradict it).
	const horizonRows = $derived.by(() => {
		if (!scan || scan.confirmed === 0) return null;
		const history = historyFromTxDeltas(scan.txs, scan.confirmed);
		if (history === null) return null;
		const change = changesFromHorizonSeries(history, scan.confirmed);
		return buildHorizonRows(change, scan.confirmed);
	});

	let syncing = $state(false);
	// A refresh failure while we have NOTHING cached surfaces as the scan-error
	// state; a failure with cached data showing is swallowed (we keep the stale
	// snapshot visible, per the SWR contract).
	let refreshError = $state<string | null>(null);
	const hasData = $derived(scan !== null);
	// Skeleton only on a true cold first load (never synced, refresh in flight).
	const loading = $derived(!hasData && data.lastSyncedAt === null && refreshError === null);
	const scanError = $derived(!hasData ? refreshError : null);

	/** Kick a background re-scan, then re-read the fresh snapshot on success. Never
	 *  throws; a failure just leaves the cached data (and its stale timestamp) up. */
	async function refresh() {
		if (syncing) return;
		syncing = true;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/refresh`, { method: 'POST' });
			if (!res.ok) {
				refreshError = 'Could not reach the wallet scanner';
				return;
			}
			refreshError = null;
			await invalidate(`cairn:wallet:${data.wallet.id}`);
		} catch {
			refreshError = 'Could not reach the wallet scanner';
		} finally {
			syncing = false;
		}
	}

	// Refresh once on mount, then on every new block (tip/coinbase-maturity/speed-up
	// change) via the existing SSE channel — never a poll. The first SSE delivery
	// is a replay of the current tip on connect, already covered by the mount
	// refresh, so it's skipped.
	let lastSeenHeight: number | null = null;
	onMount(() => {
		void refresh();
	});
	onMount(() =>
		onNewBlock((height) => {
			if (lastSeenHeight !== null && height <= lastSeenHeight) return;
			const first = lastSeenHeight === null;
			lastSeenHeight = height;
			if (first) return;
			void refresh();
		})
	);

	// Live wallet frames (Wave 2, LIVE-UPDATES-DESIGN.md §4.2/§5): a payment
	// received/confirmed/replaced on THIS wallet triggers a debounced re-scan so
	// balance, tx list and badges update live — no poll. Debounced ~800ms so a
	// block touching many of this wallet's addresses collapses to one refresh.
	// Filtered to this wallet's (kind, id); frames for the user's other wallets
	// are ignored here.
	onMount(() => {
		const kick = debounced(() => void refresh());
		const off = onWalletEvent((e) => {
			if (e.walletKind === 'wallet' && e.walletId === data.wallet.id) kick();
		});
		return () => {
			kick.cancel();
			off();
		};
	});

	// How the wallet describes itself: "Trezor wallet" when a device is on
	// record, otherwise just "Wallet" — never "watch-only", since it can always
	// sign (a device signs directly, an unassociated key signs via a file/PSBT).
	const walletKind = $derived(walletTypeLabel(data.wallet.deviceType));

	// Which vendor's OFFICIAL troubleshooting resource fits this wallet's device
	// (null for file/QR/unset). Deliberately independent of the referral_links
	// flag: this is help, not promotion, so it is always shown when known.
	const helpDevice = $derived(referralDeviceId(data.wallet.deviceType));

	let bannerDismissed = $state(false);

	// The ?imported=1 flag is one-shot: strip it from the URL so a reload
	// doesn't resurrect the welcome banner minutes or days later. Deferred a
	// tick because the router rejects replaceState mid-hydration; the native
	// fallback covers any remaining timing edge.
	afterNavigate(() => {
		setTimeout(() => {
			const url = new URL(window.location.href);
			if (!url.searchParams.has('imported')) return;
			url.searchParams.delete('imported');
			try {
				replaceState(url, {});
			} catch {
				history.replaceState(history.state, '', url);
			}
		}, 0);
	});

	// The explorer tx-detail page's "Speed this up" CTA (cairn-cqch) links here
	// with ?speedup=<txid> instead of duplicating the RBF/CPFP forms on the
	// explorer surface. Switch to the Saved tab (where those controls live) and
	// open the same flow a click on "Bump fee"/"Speed up" would — openSpeedUp
	// re-checks speedUpByTxid itself, so a tx that's confirmed or no longer
	// eligible by the time this loads is a silent no-op, not a broken button.
	// One-shot like ?imported=1 above.
	afterNavigate(() => {
		setTimeout(() => {
			const url = new URL(window.location.href);
			const txid = url.searchParams.get('speedup');
			if (!txid) return;
			tab = 'activity';
			void openSpeedUp(txid);
			url.searchParams.delete('speedup');
			try {
				replaceState(url, {});
			} catch {
				history.replaceState(history.state, '', url);
			}
		}, 0);
	});
	// Two tabs only (gt05.2, spec §2.2): Activity | Receive. The old
	// "Addresses · N" tab lives on the /wallets/[id]/settings subpage now; the
	// old "Sending" tab's draft management renders inside Activity below the
	// transaction rows. Rotate/copy state lives inside ReceivePanel.
	let tab = $state<'activity' | 'receive'>('activity');

	// The collapsed "Wallet details ›" Tier-1 expander (spec §2.2): type,
	// signing model, full xpub, and the balance-history chart — everything
	// cryptographic is invisible until asked for.
	let detailsOpen = $state(false);
	function openDetailsFromChip() {
		detailsOpen = true;
		// The chip points AT the expander — bring it into view once rendered.
		setTimeout(() => {
			document.getElementById('wallet-details')?.scrollIntoView({ block: 'nearest' });
		}, 0);
	}

	// --- saved transactions (draft → awaiting-signature → broadcast) ---
	// Rows removed optimistically on delete; a failed DELETE restores the id.
	let deletedTxIds = $state<number[]>([]);
	const savedTxs = $derived(data.transactions.filter((t) => !deletedTxIds.includes(t.id)));
	// "Payments you're working on" (gt05.2 two-tab collapse): the old Sending
	// tab's rows that still NEED something — drafts / awaiting-signature (with
	// Resume, Download PSBT, Discard) plus our own broadcast-but-unconfirmed
	// rows (Bump fee). Confirmed history is the Activity rows' job; superseded
	// rows are done. Rendered inside the Activity tab so nothing is lost.
	const workingTxs = $derived(
		savedTxs.filter(
			(t) =>
				t.status !== 'superseded' &&
				(t.status !== 'completed' || plausiblyUnconfirmed(t.txid))
		)
	);
	let confirmTxId = $state<number | null>(null);
	let deletingTxId = $state<number | null>(null);

	// --- fee bumping (RBF) ---
	let bumpTxId = $state<number | null>(null);
	let bumpRate = $state('');
	let bumping = $state(false);
	let bumpError = $state<string | null>(null);

	// "Plausibly unconfirmed": the wallet scan still reports this txid as
	// pending (height <= 0). The server re-checks against the chain anyway —
	// this only decides whether to offer the button.
	function plausiblyUnconfirmed(txid: string | null): boolean {
		if (!txid || !scan) return false;
		const seen = scan.txs.find((t) => t.txid === txid);
		return seen ? seen.height <= 0 : false;
	}

	async function openBump(tx: { id: number; feeRate: number }) {
		bumpTxId = tx.id;
		bumpError = null;
		// Fallback seed: just above the original's rate. Replaced by the live
		// fast tier when the fee oracle is reachable and actually higher.
		bumpRate = String(Math.max(2, Math.ceil(tx.feeRate) + 1));
		try {
			const res = await fetch('/api/mempool/fees');
			if (res.ok) {
				const fees = (await res.json()) as { fastest?: number };
				if (typeof fees.fastest === 'number' && fees.fastest > tx.feeRate) {
					bumpRate = String(fees.fastest);
				}
			}
		} catch {
			// keep the fallback seed
		}
	}

	async function submitBump(id: number) {
		if (bumping) return;
		bumping = true;
		bumpError = null;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/transactions/${id}/bump`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ feeRate: Number(bumpRate) })
			});
			const body = await res.json();
			if (!res.ok) {
				const reason = typeof body?.error === 'string' ? body.error : 'Something unexpected happened.';
				bumpError = `Couldn't speed this up — ${reason} Your original transaction is unchanged and still valid.`;
				return;
			}
			// The send flow resumes drafts at Review with the full
			// sign-and-broadcast machinery.
			await goto(`/wallets/${data.wallet.id}/send?tx=${body.id}`);
		} catch {
			bumpError =
				"Couldn't speed this up — network hiccup, check your connection and try again. Your original transaction is unchanged and still valid.";
		} finally {
			bumping = false;
		}
	}

	// --- speed up (RBF-vs-CPFP routing, cairn-u9ob.4) ---
	// Detection (server) resolves each unconfirmed inflow to an action: 'rbf' when
	// we originated the tx and it still signals replaceability (replace it more
	// cheaply), or 'cpfp' otherwise (received funds, or our own tx that no longer
	// signals RBF — attach a high-fee child instead). See docs/CPFP-UNCONFIRMED-PLAN.md §4.
	const speedUpByTxid = $derived<Record<string, NonNullable<typeof speedUp>[number]>>(
		Object.fromEntries((speedUp ?? []).map((s) => [s.txid, s]))
	);
	let cpfpTxid = $state<string | null>(null);
	let cpfpRate = $state('');
	let cpfping = $state(false);
	let cpfpError = $state<string | null>(null);

	/** Seed a fee input just above the parent's rate, upgraded to the live fast
	 *  tier when the oracle is reachable. Shared by RBF and CPFP entry points. */
	async function fastRateSeed(floorRate: number): Promise<string> {
		let seed = String(Math.max(2, Math.ceil(floorRate) + 1));
		try {
			const res = await fetch('/api/mempool/fees');
			if (res.ok) {
				const fees = (await res.json()) as { fastest?: number };
				if (typeof fees.fastest === 'number' && fees.fastest > floorRate) {
					seed = String(fees.fastest);
				}
			}
		} catch {
			/* keep the fallback seed */
		}
		return seed;
	}

	/** Route a "Speed up" click per the detection verdict: reuse the RBF bump form
	 *  for our own replaceable tx, or open the CPFP form otherwise. */
	async function openSpeedUp(txid: string) {
		const inflow = speedUpByTxid[txid];
		// cairn-iare: a CPFP-only inflow whose parent fee can't be resolved is
		// deterministically unbumpable from here — re-checked so a stale deep
		// link (?speedup=) or a race with the next background sync is a silent
		// no-op, not a form that opens straight into its own error.
		if (!inflow || !canOfferSpeedUp(inflow)) return;
		if (inflow.action === 'rbf') {
			// RBF replaces the whole tx — find its saved (broadcast) row and reuse the
			// existing bump form, which resumes the send flow at Review.
			const saved = data.transactions.find(
				(t) => t.txid === txid && (t.status === 'completed' || t.status === 'superseded')
			);
			if (saved) {
				cpfpTxid = null;
				await openBump(saved);
				return;
			}
			// No saved row (shouldn't happen — 'ours' implies one) → fall back to CPFP.
		}
		bumpTxId = null;
		cpfpError = null;
		cpfpTxid = txid;
		// The server prices against the parent's real rate and refuses if the target
		// is already met; seed from the live fast tier (floor 1).
		cpfpRate = await fastRateSeed(1);
	}

	/** Build a CPFP child on the stuck parent and hand off to the send flow. */
	async function submitCpfp(parentTxid: string) {
		if (cpfping) return;
		cpfping = true;
		cpfpError = null;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/transactions/cpfp`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parentTxid, feeRate: Number(cpfpRate) })
			});
			const body = await res.json();
			if (!res.ok) {
				cpfpError = typeof body?.error === 'string' ? body.error : 'Speed up failed.';
				return;
			}
			// The CPFP child is a fresh draft — resume it for signing + broadcast.
			await goto(`/wallets/${data.wallet.id}/send?tx=${body.id}`);
		} catch {
			cpfpError = 'Speed up failed — check your connection and try again.';
		} finally {
			cpfping = false;
		}
	}

	// createdAt is an ISO string; timeAgo wants unix seconds.
	function isoToUnix(iso: string): number {
		return Math.floor(Date.parse(iso) / 1000);
	}

	async function deleteSavedTx(id: number) {
		if (deletingTxId !== null) return;
		deletingTxId = id;
		const prev = deletedTxIds;
		deletedTxIds = [...deletedTxIds, id];
		confirmTxId = null;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/transactions/${id}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch {
			// Restore the row so the user can retry.
			deletedTxIds = prev;
			confirmTxId = id;
		} finally {
			deletingTxId = null;
		}
	}

	const receive = $derived(form?.receive ?? chainData.receive ?? null);

	/** Confirmation depth for the burial-rings glyph. Unknown tip (scan hiccup)
	 *  still shows a confirmed tx as sealed rather than lying "no rings yet". */
	function confirmationsOf(height: number): number {
		if (height <= 0) return 0;
		// Prefer whichever tip is further along: the load-time snapshot tip
		// (chainData.tipHeight, refreshed by refresh() on the block SSE) or the live
		// tip rune, which climbs immediately on a new block without waiting for the
		// re-scan (cairn-wmty.1). Route through the single confirmationsFor() source.
		const bestTip = Math.max(tipHeight, liveTip.height);
		if (bestTip > 0) return Math.max(1, confirmationsFor(height, bestTip));
		// Unknown tip (scan hiccup) still shows a confirmed tx as sealed rather than
		// lying "no rings yet".
		return 6;
	}

	// Backup status: source of truth is the server-tracked wallet_backups table
	// (data.backedUp) — the same value the creation wizard and the persistent
	// banner use. The download buttons themselves live on the settings subpage.
	const backupDone = $derived(data.backedUp);

	// --- tx labels ---
	// Server-loaded labels plus optimistic local edits layered on top; an
	// override of '' hides a label that was just cleared.
	const LABEL_PRIVACY_NOTE =
		'Labels are private to this wallet and stored only on your Heartwood instance.';
	let labelOverrides = $state<Record<string, string>>({});
	const labels = $derived<Record<string, string>>({ ...data.labels, ...labelOverrides });
	let editingTxid = $state<string | null>(null);
	let editValue = $state('');
	let savingLabel = $state(false);
	let labelError = $state<string | null>(null);

	function startLabelEdit(txid: string) {
		editingTxid = txid;
		editValue = labels[txid] ?? '';
		labelError = null;
	}

	function cancelLabelEdit() {
		editingTxid = null;
		labelError = null;
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	async function saveLabel() {
		if (editingTxid === null || savingLabel) return;
		const txid = editingTxid;
		const next = editValue.trim().slice(0, 120);
		const prev = labels[txid] ?? '';
		if (next === prev) {
			cancelLabelEdit();
			return;
		}

		// Optimistic: show the new label immediately, revert if the PUT fails.
		labelOverrides = { ...labelOverrides, [txid]: next };
		editingTxid = null;
		savingLabel = true;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/labels`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ txid, label: next })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			labelError = null;
		} catch {
			labelOverrides = { ...labelOverrides, [txid]: prev };
			editingTxid = txid;
			editValue = next;
			labelError = "Couldn't save the label — try again.";
		} finally {
			savingLabel = false;
		}
	}
	// Address labels + the full address list moved to /wallets/[id]/settings
	// (gt05.2 — the "Addresses · N" tab is gone from this surface).

</script>

<svelte:head>
	<title>{data.wallet.name} — Heartwood</title>
</svelte:head>

<div class="wallet-detail hw-page fade-in">
	<GroveField volume="present" />
	<div class="hw-content">
		{#if data.imported && !bannerDismissed}
			<div class="imported-banner" role="status">
				<Icon name="check" size={15} />
				<span class="grow">
					Wallet imported — {scan
						? `found ${scan.txs.length === 50 ? '50+' : scan.txs.length} transaction${scan.txs.length === 1 ? '' : 's'} across ${scan.addresses.filter((a) => a.used).length} used address${scan.addresses.filter((a) => a.used).length === 1 ? '' : 'es'}.`
						: loading
							? 'scanning the chain for its history…'
							: 'history will appear once the wallet can be scanned.'}
				</span>
				<button
					type="button"
					class="banner-dismiss"
					aria-label="Dismiss"
					onclick={() => (bannerDismissed = true)}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		{/if}

		<!-- Desktop (>=1160px): reading-measure balance hero + a quiet rail
		     (type, address, backup status) per docs/DESKTOP-LAYOUT-DESIGN.md §4
		     Wallet detail. Below that the rail is display:none and the hero stacks
		     exactly as today (mobile untouched). -->
		<div class="wallet-top">
		<!-- ------------------------------------------- eyebrow + hero -->
		<header class="hw-head">
			<!-- gt05.2 / spec §2.2: no raw "Native SegWit" tag on the surface — a
			     plain "Single-key" chip opens the Wallet details expander, where
			     the real term survives one tap down. -->
			<div class="hw-eyebrow">
				<EyebrowBreadcrumb path={['Wallets']} current={data.wallet.name} />
				<button
					type="button"
					class="type-chip"
					aria-expanded={detailsOpen}
					aria-controls="wallet-details"
					onclick={openDetailsFromChip}
				>
					Single-key
					<Icon name="chevron-down" size={12} />
				</button>
			</div>

			{#if scan}
				<div class="hw-hero">
					<Amount sats={available} size="hero" price={heroPrice} />
				</div>
				<!-- One balance, once (spec §2.2): the hero above is the only
				     rendering — no duplicate sats line beneath it. -->
				{#if scan.unconfirmed !== 0}
					<p class="hw-hero-sub">
						<span class="hw-pending">
							<Amount sats={scan.unconfirmed} size="inline" sign direction="in" /> on its way
						</span>
					</p>
				{/if}
				{#if maturingTotal > 0}
					<p class="hw-hero-sub hw-maturing">
						· <Amount sats={maturingTotal} size="inline" /> maturing —
						<a href="#mining-rewards">mining rewards not yet spendable</a>
					</p>
				{/if}
				{#if hasIncomingPending}
					<!-- Self-updating pending note (cairn-gt05.6, F17): answers "did it
					     arrive" once, from the node's own data — removes the reason to
					     leave for a third-party explorer. Auto-clears via the /api/live
					     re-scan the moment scan.unconfirmed returns to 0. -->
					<div class="hw-pending-note">
						<strong>Your payment is on its way in.</strong>
						<p>
							Your node has seen it — <Amount
								sats={scan.unconfirmed}
								size="inline"
								sign
								direction="in"
							/> arriving. It'll be spendable once the network confirms it, usually within an hour.
							You don't need to do anything: this page updates itself, and it'll appear in your
							activity as soon as it confirms — no need to check anywhere else, this is your own
							node telling you.
						</p>
					</div>
				{/if}
				{#if horizonRows}
					<div class="hw-hero-horizons">
						<BalanceHorizons rows={horizonRows} />
					</div>
				{/if}
			{:else if loading}
				<div class="hw-hero">
					<span class="hero-number hw-hero-btc hw-skeleton hw-skeleton-hero" aria-hidden="true"
					></span>
				</div>
				<p class="hw-hero-sub">
					<span class="hw-skeleton hw-skeleton-line" aria-hidden="true"></span>
					<span class="sr-only">Loading balance…</span>
				</p>
			{:else}
				<div class="hw-hero">
					<span class="hero-number hw-hero-btc hw-hero-muted">—</span>
				</div>
			{/if}

			<div class="hw-pills">
				{#if data.flags?.send === false}
					<button
						type="button"
						class="btn btn-primary hw-pill"
						disabled
						title="Sending has been disabled by your administrator."
					>
						<Icon name="arrow-up-right" size={15} />
						Send
					</button>
				{:else}
					<a href="/wallets/{data.wallet.id}/send" class="btn btn-primary hw-pill">
						<Icon name="arrow-up-right" size={15} />
						Send
					</a>
				{/if}
				<!-- gt05.2 / spec §2.4: Receive routes to the canonical subpage. -->
				<a href="/wallets/{data.wallet.id}/receive" class="btn btn-secondary hw-pill">
					<Icon name="arrow-down-left" size={15} />
					Receive
				</a>
			</div>

			<!-- The xpub fragment, type tag and "synced Ns ago" line are gone from
			     the surface (spec §2.2): type/signing-model/xpub live in the
			     Wallet details expander below; sync state belongs to Health. -->
		</header>

		<aside class="wallet-rail quiet-rail" aria-label="Wallet summary">
			<!-- The rail whispers plain facts only (spec §2.2 + desktop rule 2):
			     the raw xpub and address-type jargon live in the Wallet details
			     expander, not here. -->
			<div class="rail-block">
				<span class="rail-eyebrow">Type</span>
				<span class="rail-value-sm">Single-key</span>
				<span class="rail-sub">{walletKind}</span>
			</div>
			<div class="rail-block">
				<span class="rail-eyebrow">Signs with</span>
				<span class="rail-value-sm">
					{#if data.wallet.deviceType && data.wallet.deviceType !== 'file'}
						{WALLET_DEVICE_LABELS[data.wallet.deviceType]}
					{:else}
						Your device
					{/if}
				</span>
			</div>
			{#if receive}
				<div class="rail-block">
					<span class="rail-eyebrow">Receive address</span>
					<span class="rail-value-sm mono rail-addr">{truncateMiddle(receive.address, 12, 10)}</span>
					<a href="/wallets/{data.wallet.id}/receive" class="rail-link-inline">Show QR →</a>
				</div>
			{/if}
			<div class="rail-block">
				<span class="rail-eyebrow">Backup</span>
				{#if backupDone}
					<span class="rail-value-sm rail-ok">Backed up</span>
				{:else}
					<span class="rail-value-sm rail-warn">Not backed up</span>
					<a href="/wallets/{data.wallet.id}/settings#backup" class="rail-link-inline"
						>Download backup file →</a
					>
				{/if}
			</div>
		</aside>
		</div>

		{#if helpDevice}
			<!-- Official device help (cairn-4161): a quiet expandable near the device
			     note. Always shown for a known device — never gated by the referral
			     flag, because troubleshooting help isn't promotion. -->
			<details class="device-help">
				<summary>Need help with your {REFERRAL_DEVICE_LABELS[helpDevice]}?</summary>
				<p>
					Connection trouble, firmware updates, or the device acting up — the
					<a href={OFFICIAL_SUPPORT_URLS[helpDevice]} target="_blank" rel="noopener"
						>official {REFERRAL_DEVICE_LABELS[helpDevice]} support site</a
					>
					is the best place to sort it out. Your bitcoin is safe on the blockchain either way —
					a misbehaving device never puts funds at risk as long as you have its seed backup.
				</p>
			</details>
		{/if}

		{#if scanError}
			<!-- ------------------------------------------- scan failed -->
			<div class="scan-error hw-scan-error">
				<Icon name="alert-triangle" size={18} />
				<div class="grow">
					<div style="font-weight: 500">Can't reach the wallet scanner</div>
					<div class="hint">{scanError}</div>
				</div>
				<button type="button" class="btn btn-secondary btn-sm" onclick={refresh} disabled={syncing}>
					{#if syncing}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
					Retry
				</button>
			</div>
		{:else if scan}
			{#if scan.scanTruncated}
				<!-- cairn-kxhv: the gap-limit scan stopped at its safety cap while this
				     wallet still had activity right up against that boundary — some
				     older addresses (and any funds sent to them) may not be shown. -->
				<Banner variant="warning">
					This wallet has more address activity than we scan by default, so some
					older addresses may not be shown here yet. Nothing is lost — any coins
					on them are still safely on the blockchain. Contact support if you're
					missing funds you expect to see.
				</Banner>
			{/if}
			<!-- The stepped balance chart moved into the Wallet details expander
			     (spec §2.2) — the surface keeps one hero number and air. -->

			<!-- Consolidation suggestion: appears only when the wallet holds coins
			     from huge batch payouts (slow to sign on hardware wallets). Fetches
			     its own data lazily and renders nothing when there's nothing to say. -->
			<ConsolidationCard
				walletId={data.wallet.id}
				scriptType={data.wallet.scriptType}
				receiveAddress={receive?.address ?? null}
			/>

			<!-- The Receive panel lives in the Receive tab below (and canonically
			     at /wallets/[id]/receive) — same ReceivePanel component both
			     places, per spec §2.4. -->

			<!-- ------------------------------------------- mining rewards -->
			<!-- Coinbase (mining reward) UTXOs only — empty for a normal wallet, so
			     the whole section is absent unless the wallet actually mined. -->
			{#if coinbaseUtxos.length > 0}
				<MiningRewards utxos={coinbaseUtxos} {tipHeight} />
			{/if}

			<!-- ------------------- tabs: Activity | Receive (spec §2.2, two only) -->
			<div class="hw-toggles" role="tablist" aria-label="Wallet views">
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'activity'}
					aria-selected={tab === 'activity'}
					onclick={() => (tab = 'activity')}
				>
					Activity · {scan.txs.length}
				</button>
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'receive'}
					aria-selected={tab === 'receive'}
					onclick={() => (tab = 'receive')}
				>
					Receive
				</button>
			</div>

			{#if tab === 'activity'}
				<!-- Hairline tx rows with burial-ring confirmation glyphs (5d). -->
				<section class="hw-txs" aria-label="Transactions">
					{#if cancelledTxs.length > 0}
						{#each cancelledTxs as ctx (ctx.txid)}
							<div class="hw-tx-row cancelled-row">
								<span class="cancel-glyph" aria-hidden="true">
									<Icon name="x" size={15} />
								</span>
								<div class="hw-tx-main">
									<span class="hw-tx-title">
										Payment cancelled
										<span class="cancel-badge">Cancelled</span>
									</span>
									<span class="hw-tx-meta">
										This incoming payment was cancelled by the sender before it confirmed
										· <span class="mono">{truncateMiddle(ctx.txid, 8, 8)}</span>
									</span>
								</div>
								<div class="hw-tx-right">
									<Amount sats={ctx.amountSats} size="row" />
									<span class="hw-tx-when">no longer on its way</span>
								</div>
							</div>
						{/each}
					{/if}
					{#if scan.txs.length === 0 && cancelledTxs.length === 0}
						<div class="empty-state">
							<Icon name="activity" size={22} />
							<span class="empty-title">No transactions yet</span>
							<span>Send some sats to a receive address and they'll show up here.</span>
						</div>
					{:else}
						{#each scan.txs as tx (tx.txid)}
							{@const conf = confirmationsOf(tx.height)}
							<div class="hw-tx-row">
								<BurialRings confirmations={conf} direction={tx.delta >= 0 ? 'in' : 'out'} size={30} />
								<div class="hw-tx-main">
									<span class="hw-tx-title">
										{tx.delta >= 0 ? 'Received' : 'Sent'}
										{#if labels[tx.txid] && editingTxid !== tx.txid}
											<button
												type="button"
												class="tx-label"
												title="{LABEL_PRIVACY_NOTE} Click to edit."
												onclick={() => startLabelEdit(tx.txid)}
											>
												{labels[tx.txid]}
											</button>
										{/if}
									</span>
									<span class="hw-tx-meta">
										{conf === 0 && tx.delta >= 0 ? 'confirming now' : burialRingsLabel(conf)}
										· <a href={`/explorer/tx/${tx.txid}`} class="mono hw-tx-link"
											>{truncateMiddle(tx.txid, 8, 8)}</a
										>
										{#if shouldShowNetworkFee(tx)}
											<!-- cairn-jcwb: the fee is the WHOLE tx's network fee (every
											     input/output, not just ours — see gapLimitScanner's
											     txDeltaFromRaw). For an outgoing tx it's genuinely part of
											     what left this wallet, worth breaking out. For an incoming
											     (received) tx it's the SENDER's cost, unrelated to what this
											     wallet got — showing it here just put a second, unlabeled
											     amount next to "Received" that competed with the real
											     figure on the right (tx.delta). -->
											· network fee <Amount sats={tx.fee ?? 0} size="inline" />
										{/if}
										{#if !labels[tx.txid] && editingTxid !== tx.txid}
											<button
												type="button"
												class="label-add"
												title={LABEL_PRIVACY_NOTE}
												onclick={() => startLabelEdit(tx.txid)}
											>
												<Icon name="plus" size={11} />
												label
											</button>
										{/if}
									</span>
									{#if editingTxid === tx.txid}
										<form
											class="label-editor"
											onsubmit={(e) => {
												e.preventDefault();
												saveLabel();
											}}
										>
											<input
												class="input label-input"
												type="text"
												maxlength={120}
												placeholder="e.g. rent, invoice #4021"
												title={LABEL_PRIVACY_NOTE}
												bind:value={editValue}
												use:focusInput
												disabled={savingLabel}
												onkeydown={(e) => {
													if (e.key === 'Escape') {
														e.preventDefault();
														cancelLabelEdit();
													}
												}}
											/>
											<button
												class="btn btn-ghost btn-sm label-editor-btn"
												type="submit"
												disabled={savingLabel}
												aria-label="Save label"
											>
												<Icon name="check" size={13} />
											</button>
											<button
												class="btn btn-ghost btn-sm label-editor-btn"
												type="button"
												disabled={savingLabel}
												aria-label="Cancel"
												onclick={cancelLabelEdit}
											>
												<Icon name="x" size={13} />
											</button>
											{#if labelError}
												<span class="form-error" role="alert">{labelError}</span>
											{/if}
										</form>
									{/if}
									{#if tx.height <= 0 && speedUpByTxid[tx.txid] && canOfferSpeedUp(speedUpByTxid[tx.txid])}
										{#if cpfpTxid === tx.txid}
											<form
												class="bump-form"
												onsubmit={(e) => {
													e.preventDefault();
													submitCpfp(tx.txid);
												}}
											>
												<label class="hint" for="cpfp-rate-{tx.txid}">Target rate</label>
												<input
													id="cpfp-rate-{tx.txid}"
													class="input bump-input"
													type="number"
													min="1"
													step="any"
													bind:value={cpfpRate}
													disabled={cpfping}
												/>
												<span class="hint">sat/vB</span>
												<button class="btn btn-primary btn-sm" type="submit" disabled={cpfping}>
													{#if cpfping}<span class="spinner"></span>{/if}
													Speed up
												</button>
												<button
													type="button"
													class="btn btn-ghost btn-sm"
													disabled={cpfping}
													onclick={() => (cpfpTxid = null)}
												>
													Cancel
												</button>
											</form>
											{#if cpfpError}
												<div class="form-error bump-error" role="alert">{cpfpError}</div>
											{/if}
										{:else}
											<button
												type="button"
												class="btn btn-ghost btn-sm speed-up-btn"
												onclick={() => openSpeedUp(tx.txid)}
												title={speedUpByTxid[tx.txid].action === 'rbf'
													? 'Replace this transaction with a higher-fee version (RBF).'
													: 'Add a higher-fee child transaction so miners confirm them together (CPFP).'}
											>
												<Icon name="zap" size={13} />
												Speed up
											</button>
										{/if}
									{/if}
								</div>
								<div class="hw-tx-right">
									<Amount
										sats={tx.delta}
										size="row"
										sign
										direction={tx.delta >= 0 ? 'in' : 'out'}
									/>
									<span class="hw-tx-when">
										{tx.height <= 0 ? 'in the mempool' : timeAgo(tx.time)}
									</span>
								</div>
							</div>
						{/each}
					{/if}
				</section>
				{#if workingTxs.length > 0}
					<!-- Payments you're working on (the old Sending tab, folded into
					     Activity per the two-tab collapse): drafts to resume, download
					     or discard, plus our own broadcast-but-unconfirmed sends that
					     can still be fee-bumped. Confirmed history is the rows above. -->
					<section class="hw-section" aria-label="Payments in progress">
						<h2 class="hw-section-title">In progress</h2>
						<div class="saved-list">
							{#each workingTxs as tx (tx.id)}
							<section class="saved-row">
								<div class="saved-row-top">
									<TxStatusBadge status={tx.status} />
									<span class="hint saved-time">{timeAgo(isoToUnix(tx.createdAt))}</span>
								</div>

								<div class="saved-grid">
									<div class="saved-field">
										<span class="saved-label">To</span>
										<svelte:element
											this={explorerEnabled ? 'a' : 'span'}
											href={explorerEnabled ? `/explorer/address/${tx.recipient}` : undefined}
											class="mono saved-recipient"
										>
											{truncateMiddle(tx.recipient, 10, 8)}
										</svelte:element>
									</div>
									<div class="saved-field">
										<span class="saved-label">Amount</span>
										<Amount sats={tx.amount} size="inline" />
									</div>
									<div class="saved-field">
										<span class="saved-label">Network fee</span>
										<span class="tabular">
											<Amount sats={tx.fee} size="inline" />
											· {formatFeeRate(tx.feeRate)}
										</span>
									</div>
								</div>

								{#if (tx.status === 'completed' || tx.status === 'superseded') && tx.txid}
									<div class="saved-field">
										<span class="saved-label">Transaction</span>
										<a href={`/explorer/tx/${tx.txid}`} class="mono">
											{truncateMiddle(tx.txid, 10, 8)}
										</a>
									</div>
									{#if tx.status === 'superseded'}
										<span class="hint">Replaced by a fee-bumped transaction.</span>
									{:else if plausiblyUnconfirmed(tx.txid)}
										<div class="saved-actions">
											{#if bumpTxId === tx.id}
												<form
													class="bump-form"
													onsubmit={(e) => {
														e.preventDefault();
														submitBump(tx.id);
													}}
												>
													<label class="hint" for="bump-rate-{tx.id}">New rate</label>
													<input
														id="bump-rate-{tx.id}"
														class="input bump-input"
														type="number"
														min={Math.max(1, tx.feeRate)}
														step="any"
														bind:value={bumpRate}
														disabled={bumping}
													/>
													<span class="hint">sat/vB</span>
													<button
														class="btn btn-primary btn-sm"
														type="submit"
														disabled={bumping || !(Number(bumpRate) > tx.feeRate)}
													>
														{#if bumping}<span class="spinner"></span>{/if}
														Bump
													</button>
													<button
														type="button"
														class="btn btn-ghost btn-sm"
														disabled={bumping}
														onclick={() => (bumpTxId = null)}
													>
														Cancel
													</button>
													{#if bumpRate !== '' && !(Number(bumpRate) > tx.feeRate)}
														<span class="hint bump-floor-hint">
															Must be above {formatFeeRate(tx.feeRate)} — the original's rate — for
															the network to accept the replacement.
														</span>
													{/if}
												</form>
											{:else}
												<button
													type="button"
													class="btn btn-secondary btn-sm"
													onclick={() => openBump(tx)}
												>
													<Icon name="zap" size={14} />
													Bump fee
												</button>
												<span class="hint">Stuck? Replace it with a higher-fee version (RBF).</span>
											{/if}
											{#if bumpTxId === tx.id && bumpError}
												<div class="form-error bump-error" role="alert">{bumpError}</div>
											{/if}
										</div>
									{/if}
								{:else}
									<div class="saved-actions">
										<a
											href="/wallets/{data.wallet.id}/send?tx={tx.id}"
											class="btn btn-secondary btn-sm"
										>
											<Icon name="arrow-right" size={14} />
											Continue
										</a>
										<a
											href="/api/wallets/{data.wallet.id}/transactions/{tx.id}/file"
											class="btn btn-ghost btn-sm"
											download="heartwood-tx-{tx.id}.psbt"
										>
											<Icon name="arrow-down-left" size={14} />
											Download PSBT
										</a>
										<span class="grow"></span>
										{#if confirmTxId === tx.id}
											<button
												type="button"
												class="btn btn-danger btn-sm"
												disabled={deletingTxId === tx.id}
												onclick={() => deleteSavedTx(tx.id)}
											>
												{#if deletingTxId === tx.id}<span class="spinner"></span>{/if}
												Delete
											</button>
											<button
												type="button"
												class="btn btn-ghost btn-sm"
												disabled={deletingTxId === tx.id}
												onclick={() => (confirmTxId = null)}
											>
												Cancel
											</button>
										{:else}
											<button
												type="button"
												class="btn btn-ghost btn-sm delete-tx"
												aria-label="Discard transaction"
												onclick={() => (confirmTxId = tx.id)}
											>
												<Icon name="trash" size={14} />
											</button>
										{/if}
									</div>
								{/if}
								</section>
							{/each}
						</div>
					</section>
				{/if}
			{:else}
				<!-- Receive tab: the same canonical ReceivePanel the
				     /wallets/[id]/receive subpage renders (spec §2.4). -->
				<section class="hw-section hw-receive" id="receive">
					<ReceivePanel {receive} serverError={form?.receiveError ?? null} {neverFunded} />
				</section>
			{/if}

			<!-- --------------------- Wallet details › (Tier-1 expander, spec §2.2) -->
			<!-- Everything cryptographic — type, signing model, the FULL copyable
			     xpub, and the balance-history chart — lives here, collapsed. The
			     "Single-key" chip up top opens this same expander. -->
			<section class="hw-section wallet-details-section">
				<button
					type="button"
					class="details-toggle"
					aria-expanded={detailsOpen}
					aria-controls="wallet-details"
					onclick={() => (detailsOpen = !detailsOpen)}
				>
					Wallet details
					<Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
				</button>
				{#if detailsOpen}
					<div class="details-body fade-in" id="wallet-details">
						<div class="details-row">
							<span class="details-label">Type</span>
							<span class="details-value">
								Single-key wallet ·
								<Term
									tip="The technical address format this wallet uses. Native SegWit (bech32) addresses start with bc1q and pay the lowest fees."
									>Address type: {SCRIPT_TYPE_LABELS[data.wallet.scriptType]}</Term
								>
							</span>
						</div>
						<div class="details-row">
							<span class="details-label">How this wallet signs</span>
							<span class="details-value">
								Signs on your device. Heartwood holds only your public key; you approve each
								payment on your hardware wallet.
							</span>
						</div>
						<div class="details-row">
							<span class="details-label">Public key (xpub)</span>
							<span class="details-value details-xpub">
								<span class="mono xpub-full">{data.wallet.xpub}</span>
								<CopyText value={data.wallet.xpub} display="Copy" mono={false} />
							</span>
						</div>
						{#if scan && scan.txs.some((t) => t.height > 0)}
							<div class="details-chart">
								<WalletStepChart txs={scan.txs} confirmed={scan.confirmed} height={148} />
								<p class="hw-caption">balance over time · each step is a transaction</p>
							</div>
						{/if}
					</div>
				{/if}
			</section>

			<!-- ------------------- Wallet settings › (Tier-2 subpage, spec §2.2) -->
			<a class="settings-link" href="/wallets/{data.wallet.id}/settings">
				Wallet settings
				<Icon name="chevron-right" size={14} />
			</a>
		{:else if loading}
			<!-- ------------------------------------------- streaming skeleton -->
			<!-- The shell has painted from the cheap local fields; the scan, receive
			     panel and transaction list stream in behind these placeholders. -->
			<div class="hw-loading" aria-live="polite" aria-busy="true">
				<span class="sr-only">Loading this wallet's balance and history…</span>
				<div class="hw-skeleton hw-skeleton-chart" aria-hidden="true"></div>
				<div class="hw-skeleton-rows" aria-hidden="true">
					{#each Array(4) as _, i (i)}
						<div class="hw-skeleton-row">
							<div class="hw-skeleton hw-skeleton-glyph"></div>
							<div class="hw-skeleton hw-skeleton-flex"></div>
							<div class="hw-skeleton hw-skeleton-amount"></div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Remove-wallet moved to /wallets/[id]/settings — a confirmation-gated
		     Danger block on its own URL (spec §2.2), never in scroll flow here. -->
	</div>
</div>

<style>
	/* Double-spent / RBF'd-away inbound payment (cairn-a2p1): amber, never red —
	   the house "attention" tone (same token .hw-pending uses), so a cancellation
	   reads as a heads-up rather than an error. */
	.cancel-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 50%;
		color: var(--attention);
		background: rgba(217, 180, 126, 0.1);
	}

	.cancel-badge {
		margin-left: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--attention);
		background: rgba(217, 180, 126, 0.12);
		padding: 2px 7px;
		border-radius: var(--radius-badge, 4px);
		vertical-align: middle;
	}

	/* The Heartwood grove field needs a positioned ancestor; content rides
	   above it at z-index 1. */
	.hw-page {
		position: relative;
	}

	.hw-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
	}

	/* Desktop (>=1160px): balance hero (reading measure) + quiet detail rail.
	   Below that the rail is display:none and the hero column stacks as today. */
	.wallet-rail {
		display: none;
	}

	@media (min-width: 1160px) {
		.wallet-top {
			display: grid;
			grid-template-columns: minmax(0, var(--measure-reading)) var(--rail-w);
			gap: var(--lane-gutter);
			align-items: start;
		}

		.wallet-rail {
			display: flex;
			flex-direction: column;
			gap: 20px;
			padding-top: 44px;
			min-width: 0;
		}

		.wallet-rail .rail-block {
			display: flex;
			flex-direction: column;
			gap: 3px;
			padding-bottom: 18px;
			border-bottom: 1px solid var(--hairline);
			min-width: 0;
		}

		.wallet-rail .rail-block:last-child {
			border-bottom: none;
			padding-bottom: 0;
		}

		.wallet-rail .rail-eyebrow {
			font-size: 10.5px;
			font-weight: 600;
			letter-spacing: 0.12em;
			text-transform: uppercase;
			color: var(--eyebrow-path);
		}

		.wallet-rail .rail-value-sm {
			font-size: 14px;
			color: var(--text-value);
		}

		.wallet-rail .rail-sub {
			font-size: 12px;
			color: var(--text-muted);
		}

		.wallet-rail .rail-addr {
			word-break: break-all;
		}

		.wallet-rail .rail-ok {
			color: var(--sage);
		}

		.wallet-rail .rail-warn {
			color: var(--warning);
		}

		.wallet-rail .rail-link-inline {
			font-size: 12.5px;
			font-weight: 500;
			color: var(--accent);
		}
	}

	.banner-dismiss:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	/* --- eyebrow + hero --- */

	.hw-head {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}

	.hw-eyebrow {
		margin-bottom: 18px;
		max-width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		align-self: stretch;
	}

	.hw-hero {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
		max-width: 100%;
	}

	.hw-hero-btc {
		font-size: clamp(44px, 7vw, 72px);
		line-height: 0.95;
		color: var(--text-hero);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hw-hero-muted {
		color: var(--text-muted);
	}

	.hw-hero-sub {
		margin-top: 14px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hw-pending {
		color: var(--attention);
	}

	.hw-hero-sub.hw-maturing {
		margin-top: 4px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.hw-hero-sub.hw-maturing a {
		color: inherit;
		text-decoration: underline;
	}

	/* Self-updating first-deposit-pending note (cairn-gt05.6) — surface-neutral,
	   no new color/token; calm status, never a modal or a spinner-wall. */
	.hw-pending-note {
		margin-top: 16px;
		max-width: 620px;
		padding: 14px 16px;
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.hw-pending-note strong {
		display: block;
		margin-bottom: 4px;
		color: var(--text);
	}

	.hw-pending-note p {
		margin: 0;
	}

	/* Multi-horizon delta row (cairn-d326, R6) — quiet, beneath the hero's
	   sub-lines. Never a lone delta (DESIGN-MANIFESTO.md MUST). */
	.hw-hero-horizons {
		margin-top: 18px;
	}

	.hw-pills {
		display: flex;
		gap: 12px;
		margin-top: 28px;
		align-self: stretch;
	}

	.hw-pill {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
		border-radius: var(--radius-pill);
	}

	/* The "Single-key ⌵" chip beside the eyebrow — opens Wallet details. */
	.type-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 4px 12px;
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.type-chip:hover {
		color: var(--text);
		border-color: var(--border-ghost);
	}

	.type-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Official device-help expandable near the hero (quiet <details> idiom). */
	.device-help {
		border-top: 1px solid var(--hairline);
		padding: 10px 0 2px;
		margin-top: 20px;
		max-width: 620px;
	}

	.device-help summary {
		cursor: pointer;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.device-help summary:hover {
		color: var(--text);
	}

	.device-help p {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.6;
		margin: 8px 0 4px;
	}

	.device-help a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.hw-caption {
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--eyebrow-path);
		line-height: 1.6;
	}

	/* --- hairline sections (no cards) --- */

	.hw-section {
		border-top: 1px solid var(--hairline);
		margin-top: 40px;
		padding-top: 22px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.hw-section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
	}

	.hw-scan-error {
		margin-top: 36px;
		padding: 16px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
	}

	/* --- streaming skeletons (cairn-vknb.1) --- */

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

	.hw-skeleton {
		display: block;
		border-radius: var(--radius-control, 6px);
		background: linear-gradient(
			90deg,
			var(--hairline) 25%,
			var(--accent-muted) 37%,
			var(--hairline) 63%
		);
		background-size: 400% 100%;
		animation: hw-shimmer 1.4s ease infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.hw-skeleton {
			animation: none;
		}
	}

	@keyframes hw-shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: 0 0;
		}
	}

	/* Hero balance placeholder — sized to the clamp() balance figure. */
	.hw-skeleton-hero {
		width: min(320px, 70%);
		height: clamp(44px, 7vw, 72px);
		border-radius: 8px;
	}

	.hw-skeleton-line {
		width: 180px;
		height: 14px;
		margin-top: 4px;
	}

	.hw-loading {
		margin-top: 40px;
	}

	.hw-skeleton-chart {
		width: 100%;
		height: 148px;
		border-radius: 10px;
	}

	.hw-skeleton-rows {
		display: flex;
		flex-direction: column;
		margin-top: 28px;
	}

	.hw-skeleton-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.hw-skeleton-glyph {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.hw-skeleton-flex {
		flex: 1;
		height: 14px;
	}

	.hw-skeleton-amount {
		width: 84px;
		height: 16px;
		flex-shrink: 0;
	}

	/* --- Wallet details expander (Tier-1) + settings link (Tier-2) --- */

	.details-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.details-toggle:hover {
		color: var(--text);
	}

	.details-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.details-body {
		display: flex;
		flex-direction: column;
	}

	.details-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.details-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.details-value {
		font-size: 13.5px;
		color: var(--text-rows);
		line-height: 1.6;
	}

	.details-xpub {
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-start;
	}

	.xpub-full {
		word-break: break-all;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.details-chart {
		margin-top: 16px;
	}

	.settings-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		margin-top: 18px;
		font-size: 14px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.settings-link:hover {
		color: var(--accent);
	}

	.settings-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	/* --- text-toggle tab row (Heartwood toggle grammar) --- */

	.hw-toggles {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 44px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--hairline);
	}

	.hw-toggle {
		background: none;
		border: none;
		border-radius: var(--radius-toggle);
		padding: 6px 13px;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--eyebrow-path);
		cursor: pointer;
		font-variant-numeric: tabular-nums;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.hw-toggle:hover {
		color: var(--text-secondary);
	}

	.hw-toggle.active {
		color: var(--accent-bright);
		background: var(--accent-muted);
	}

	/* --- hairline tx rows with burial rings --- */

	.hw-txs {
		display: flex;
		flex-direction: column;
	}

	.hw-tx-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
		min-width: 0;
	}

	.hw-tx-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.hw-tx-title {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.hw-tx-meta {
		font-size: 12px;
		color: var(--text-muted);
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		flex-wrap: wrap;
	}

	.hw-tx-link {
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.hw-tx-link:hover {
		color: var(--accent);
	}

	.hw-tx-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex-shrink: 0;
	}

	.hw-tx-when {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	/* --- tx labels --- */

	.tx-label {
		display: inline-block;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12px;
		font-style: italic;
		color: var(--text-muted);
		cursor: pointer;
		text-align: left;
	}

	.tx-label:hover {
		color: var(--text-secondary);
		text-decoration: underline;
		text-decoration-style: dotted;
	}

	.label-add {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms var(--ease);
	}

	.hw-tx-row:hover .label-add,
	.label-add:focus-visible {
		opacity: 0.8;
	}

	.label-add:hover {
		opacity: 1;
		color: var(--accent);
	}

	.label-editor {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
		flex-wrap: wrap;
	}

	.label-input {
		font-size: 12px;
		padding: 3px 8px;
		width: 200px;
	}

	.label-editor-btn {
		padding: 3px 6px;
	}

	.label-editor .form-error {
		font-size: 11.5px;
	}

	/* --- payments in progress (saved rows, inside Activity) --- */

	.saved-list {
		display: flex;
		flex-direction: column;
	}

	.saved-row {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.saved-row-top {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.saved-time {
		margin-left: auto;
	}

	.saved-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 28px;
	}

	.saved-field {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.saved-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.saved-recipient {
		font-size: 13px;
	}

	.saved-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		border-top: 1px solid var(--hairline);
		padding-top: 12px;
	}

	.delete-tx:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	/* --- fee bump (RBF) --- */

	.bump-form {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.bump-input {
		width: 90px;
		font-size: 12.5px;
		padding: 4px 8px;
	}

	.speed-up-btn {
		gap: 4px;
		align-self: flex-start;
		margin-top: 4px;
	}

	.bump-error {
		flex-basis: 100%;
		font-size: 12.5px;
	}

	/* --- mobile (≤900px per Heartwood responsive rules) --- */

	@media (max-width: 900px) {
		.hw-head {
			align-items: center;
			text-align: center;
		}

		.hw-eyebrow {
			align-self: center;
		}

		.hw-hero-btc {
			font-size: clamp(38px, 11vw, 48px);
		}

		.hw-pills {
			flex-direction: column;
		}

		.hw-pill {
			width: 100%;
			height: 48px;
		}

		.hw-tx-title {
			font-size: 13px;
		}

		/* Touch-target batch (cairn-uxdev batch 2, item 3): raise the tab row's
		   hit area to the ~44px guideline on mobile without changing the visual
		   chip size — extra vertical padding lands in the same border-bottom
		   strip these already sit against. */
		.hw-toggle {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
			padding-top: 12px;
			padding-bottom: 12px;
		}
	}

	@media (max-width: 480px) {
		.saved-time {
			margin-left: 0;
		}

		.saved-actions .grow {
			display: none;
		}
	}
</style>
