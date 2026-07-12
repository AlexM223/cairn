<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate, goto, invalidate, replaceState } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import SyncIndicator from '$lib/components/heartwood/SyncIndicator.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import Term from '$lib/components/Term.svelte';
	import TxStatusBadge from '$lib/components/TxStatusBadge.svelte';
	import ConsolidationCard from './_components/ConsolidationCard.svelte';
	import MiningRewards from '$lib/components/MiningRewards.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import WalletStepChart from './_components/WalletStepChart.svelte';
	import { copyToClipboard } from '$lib/clipboard';
	import { formatBtc, formatFeeRate, formatSats, timeAgo, truncateMiddle } from '$lib/format';
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
	let confirmDelete = $state(false);
	let deleting = $state(false);
	let generating = $state(false);
	// Rotate can legitimately take 30-40s when a fresh gap-limit scan is needed
	// (cairn-2ic5): after a few seconds, reassure the user rather than leaving a
	// silent spinner that reads as a hung button.
	let rotateSlow = $state(false);
	let rotateSlowTimer: ReturnType<typeof setTimeout> | null = null;
	const ROTATE_SLOW_MS = 6000;
	let tab = $state<'transactions' | 'addresses' | 'saved'>('transactions');
	let addrFilter = $state<'used' | 'unused' | 'change'>('used');

	// --- saved transactions (draft → awaiting-signature → broadcast) ---
	// Rows removed optimistically on delete; a failed DELETE restores the id.
	let deletedTxIds = $state<number[]>([]);
	const savedTxs = $derived(data.transactions.filter((t) => !deletedTxIds.includes(t.id)));
	// Unfinished drafts surface in an always-visible card so a transaction
	// parked mid-signing is never lost behind a tab. Superseded rows are done
	// (replaced by a fee bump), not in progress.
	const inProgress = $derived(
		savedTxs.filter((t) => t.status !== 'completed' && t.status !== 'superseded')
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
		if (!inflow) return;
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

	// Copy button on the receive panel (spec 5c: Copy + Rotate pills).
	let addrCopied = $state(false);
	async function copyAddress() {
		if (!receive) return;
		if (await copyToClipboard(receive.address)) {
			addrCopied = true;
			setTimeout(() => (addrCopied = false), 1500);
		}
	}

	/** Confirmation depth for the burial-rings glyph. Unknown tip (scan hiccup)
	 *  still shows a confirmed tx as sealed rather than lying "no rings yet". */
	function confirmationsOf(height: number): number {
		if (height <= 0) return 0;
		if (tipHeight > 0) return Math.max(1, tipHeight - height + 1);
		return 6;
	}

	// Backup status: source of truth is the server-tracked wallet_backups table
	// (data.backedUp) — the same value the creation wizard and the persistent
	// banner use, so a download from anywhere (wizard, another browser) reflects
	// here. The local flag is a purely-optimistic overlay for instant feedback on
	// this page's own download buttons.
	let downloadedNow = $state(false);
	const backupDone = $derived(data.backedUp || downloadedNow);
	function markBackupDownloaded() {
		downloadedNow = true;
	}

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
	// --- address labels (cairn-nbsx) ---
	// Same optimistic-override idiom as tx labels, keyed by address instead of txid.
	let addrLabelOverrides = $state<Record<string, string>>({});
	const addressLabels = $derived<Record<string, string>>({
		...data.addressLabels,
		...addrLabelOverrides
	});
	let editingAddr = $state<string | null>(null);
	let addrEditValue = $state('');
	let savingAddrLabel = $state(false);
	let addrLabelError = $state<string | null>(null);

	function startAddrLabelEdit(address: string) {
		editingAddr = address;
		addrEditValue = addressLabels[address] ?? '';
		addrLabelError = null;
	}

	function cancelAddrLabelEdit() {
		editingAddr = null;
		addrLabelError = null;
	}

	async function saveAddrLabel() {
		if (editingAddr === null || savingAddrLabel) return;
		const address = editingAddr;
		const next = addrEditValue.trim().slice(0, 120);
		const prev = addressLabels[address] ?? '';
		if (next === prev) {
			cancelAddrLabelEdit();
			return;
		}
		addrLabelOverrides = { ...addrLabelOverrides, [address]: next };
		editingAddr = null;
		savingAddrLabel = true;
		try {
			const res = await fetch(`/api/wallets/${data.wallet.id}/address-labels`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address, label: next })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addrLabelError = null;
		} catch {
			addrLabelOverrides = { ...addrLabelOverrides, [address]: prev };
			editingAddr = address;
			addrEditValue = next;
			addrLabelError = "Couldn't save the label — try again.";
		} finally {
			savingAddrLabel = false;
		}
	}

	const usedAddrs = $derived((scan?.addresses ?? []).filter((a) => a.used));
	// Unused = the forward gap window on BOTH chains — used-change addresses
	// already show under Used, so hiding unused-change here left a slice of the
	// wallet's addresses invisible in every view. Receive first: those are the
	// ones you hand out.
	const unusedAddrs = $derived(
		(scan?.addresses ?? [])
			.filter((a) => !a.used)
			.toSorted((a, b) => Number(a.change) - Number(b.change))
	);
	// Change = the whole internal chain (m/1/*), used and upcoming — so you can
	// verify where change went AND where the next spend's change will go
	// (cairn-teyh).
	const changeAddrs = $derived(
		(scan?.addresses ?? []).filter((a) => a.change).toSorted((a, b) => a.index - b.index)
	);
	const shownAddrs = $derived(
		addrFilter === 'used' ? usedAddrs : addrFilter === 'unused' ? unusedAddrs : changeAddrs
	);

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

		<!-- ------------------------------------------- eyebrow + hero -->
		<header class="hw-head">
			<div class="hw-eyebrow">
				<EyebrowBreadcrumb
					path={['Wallets', data.wallet.name]}
					current={SCRIPT_TYPE_LABELS[data.wallet.scriptType]}
				/>
			</div>

			{#if scan}
				<div class="hw-hero">
					<span class="hero-number hw-hero-btc" title="{formatSats(scan.confirmed)} sats"
						>{formatBtc(scan.confirmed)}</span
					>
					<span class="hw-hero-unit">BTC</span>
				</div>
				<p class="hw-hero-sub">
					<span class="tabular">{formatSats(scan.confirmed)} sats</span>
					{#if scan.unconfirmed !== 0}
						<span class="hw-pending">
							· {scan.unconfirmed > 0 ? '+' : ''}{formatBtc(scan.unconfirmed)} BTC on its way
						</span>
					{/if}
				</p>
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
				<a href="#receive" class="btn btn-secondary hw-pill">
					<Icon name="arrow-down-left" size={15} />
					Receive
				</a>
			</div>

			<p class="hw-sign-note">
				<Term
					tip="This wallet tracks your bitcoin using your public key. To send, you'll sign the transaction on your hardware device — your private key never leaves the device."
				>
					<Icon name="shield" size={12} />
					{#if data.wallet.deviceType && data.wallet.deviceType !== 'file'}
						Signs with your {WALLET_DEVICE_LABELS[data.wallet.deviceType]}
					{:else}
						Signs on your device
					{/if}
				</Term>
				· {walletKind} · <span class="mono">{truncateMiddle(data.wallet.xpub, 10, 8)}</span>
			</p>

			<div class="hw-sync-row">
				<SyncIndicator lastSyncedAt={data.lastSyncedAt} {syncing} />
			</div>
		</header>

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
			<!-- ------------------------------------------- stepped balance chart -->
			{#if scan.txs.some((t) => t.height > 0)}
				<div class="hw-chart">
					<WalletStepChart txs={scan.txs} confirmed={scan.confirmed} height={148} />
					<p class="hw-caption">balance over time · each step is a transaction</p>
				</div>
			{/if}

			{#if inProgress.length > 0}
				<!-- ------------------------------ transactions in progress -->
				<section class="hw-section" aria-label="Transactions in progress">
					<h2 class="hw-section-title">In progress</h2>
					<ul class="progress-list">
						{#each inProgress as tx (tx.id)}
							<li class="progress-row">
								<TxStatusBadge status={tx.status} />
								<span class="mono text-muted">{truncateMiddle(tx.recipient, 8, 6)}</span>
								<span class="tabular grow" title="{formatSats(tx.amount)} sats">
									{formatBtc(tx.amount)} BTC
								</span>
								<span class="hint">{timeAgo(isoToUnix(tx.createdAt))}</span>
								<a href="/wallets/{data.wallet.id}/send?tx={tx.id}" class="btn btn-secondary btn-sm">
									Resume
									<Icon name="arrow-right" size={13} />
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<!-- Consolidation suggestion: appears only when the wallet holds coins
			     from huge batch payouts (slow to sign on hardware wallets). Fetches
			     its own data lazily and renders nothing when there's nothing to say. -->
			<ConsolidationCard
				walletId={data.wallet.id}
				scriptType={data.wallet.scriptType}
				receiveAddress={receive?.address ?? null}
			/>

			<!-- ------------------------------------------- receive (spec 5c/8d) -->
			{#if receive}
				<section class="hw-section hw-receive" id="receive">
					<div class="hw-receive-grid">
						<div class="hw-qr-wrap">
							<img
								class="hw-qr"
								src={receive.qr}
								alt="QR code for {receive.address}"
								width="300"
								height="300"
							/>
						</div>
						<div class="hw-receive-meta">
							<h2 class="hw-receive-headline">A fresh address, every time.</h2>
							<div class="hw-addr-row">
								<span class="mono hw-addr">{receive.address}</span>
								<span class="hw-addr-path mono">{receive.path}</span>
							</div>
							{#if form?.receiveError}
								<div class="form-error" role="alert">{form.receiveError}</div>
							{/if}
							<div class="hw-receive-actions">
								<button type="button" class="btn btn-secondary hw-pill" onclick={copyAddress}>
									<Icon name={addrCopied ? 'check' : 'copy'} size={14} />
									{addrCopied ? 'Copied' : 'Copy'}
								</button>
								<form
									method="POST"
									action="?/receive"
									use:enhance={() => {
										generating = true;
										rotateSlow = false;
										if (rotateSlowTimer) clearTimeout(rotateSlowTimer);
										rotateSlowTimer = setTimeout(() => (rotateSlow = true), ROTATE_SLOW_MS);
										return async ({ update }) => {
											if (rotateSlowTimer) clearTimeout(rotateSlowTimer);
											rotateSlowTimer = null;
											generating = false;
											rotateSlow = false;
											await update({ reset: false });
										};
									}}
								>
									<input type="hidden" name="current" value={receive.index} />
									<button class="btn btn-secondary hw-pill" disabled={generating}>
										{#if generating}<span class="spinner"></span>{:else}<Icon
												name="refresh"
												size={14}
											/>{/if}
										{generating ? (rotateSlow ? 'Still working…' : 'Rotating…') : 'Rotate'}
									</button>
								</form>
							</div>
							{#if generating && rotateSlow}
								<p class="hw-rotate-status" role="status" aria-live="polite">
									Still finding your next unused address — checking the chain can take a moment on a
									busy node. Hang tight.
								</p>
							{/if}
							<p class="hw-caption">
								A new address for every payment keeps your history private. Old addresses keep
								working forever — rotating never breaks anything.
							</p>
						</div>
					</div>
				</section>
			{/if}

			<!-- ------------------------------------------- mining rewards -->
			<!-- Coinbase (mining reward) UTXOs only — empty for a normal wallet, so
			     the whole section is absent unless the wallet actually mined. -->
			{#if coinbaseUtxos.length > 0}
				<MiningRewards utxos={coinbaseUtxos} {tipHeight} />
			{/if}

			<!-- ------------------------------------------- tabs -->
			<div class="hw-toggles" role="tablist">
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'transactions'}
					aria-selected={tab === 'transactions'}
					onclick={() => (tab = 'transactions')}
				>
					Transactions · {scan.txs.length}
				</button>
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'addresses'}
					aria-selected={tab === 'addresses'}
					onclick={() => (tab = 'addresses')}
				>
					Addresses · {scan.addresses.length}
				</button>
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'saved'}
					aria-selected={tab === 'saved'}
					onclick={() => (tab = 'saved')}
				>
					Sending{savedTxs.length > 0 ? ` · ${savedTxs.length}` : ''}
				</button>
			</div>

			{#if tab === 'transactions'}
				<!-- Hairline tx rows with burial-ring confirmation glyphs (5d). -->
				<section class="hw-txs" aria-label="Transactions">
					{#if scan.txs.length === 0}
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
										{burialRingsLabel(conf)}
										· <a href="/explorer/tx/{tx.txid}" class="mono hw-tx-link">{truncateMiddle(tx.txid, 8, 8)}</a>
										{#if tx.fee != null}
											· fee {formatSats(tx.fee)} sats
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
									{#if tx.height <= 0 && speedUpByTxid[tx.txid]}
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
									<span
										class="hw-tx-amount tabular"
										class:in={tx.delta >= 0}
										title="{formatSats(tx.delta)} sats"
									>
										{tx.delta > 0 ? '+' : ''}{formatBtc(tx.delta)}
									</span>
									<span class="hw-tx-when">
										{tx.height <= 0 ? 'in the mempool' : timeAgo(tx.time)}
									</span>
								</div>
							</div>
						{/each}
					{/if}
				</section>
			{:else if tab === 'addresses'}
				<section class="hw-table-section">
					<div class="chips">
						<button
							type="button"
							class="chip"
							class:active={addrFilter === 'used'}
							onclick={() => (addrFilter = 'used')}
						>
							Used {usedAddrs.length}
						</button>
						<button
							type="button"
							class="chip"
							class:active={addrFilter === 'unused'}
							onclick={() => (addrFilter = 'unused')}
						>
							Unused {unusedAddrs.length}
						</button>
						<button
							type="button"
							class="chip"
							class:active={addrFilter === 'change'}
							onclick={() => (addrFilter = 'change')}
						>
							Change {changeAddrs.length}
						</button>
					</div>
					{#if shownAddrs.length === 0}
						<div class="empty-state">
							<span class="empty-title">
								{addrFilter === 'used'
									? 'No used addresses yet'
									: addrFilter === 'unused'
										? 'No unused addresses in the window'
										: 'No change addresses in the window'}
							</span>
						</div>
					{:else}
						<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Path</th>
										<th>Address</th>
										<th>Label</th>
										<th class="num">Balance</th>
										<th class="num">Txs</th>
									</tr>
								</thead>
								<tbody>
									{#each shownAddrs as addr (addr.address)}
										<tr>
											<td class="mono text-muted"
												>{addr.derivationPath}{#if addr.change}<span
														class="chg-chip"
														title="An internal address — leftovers from your own spends land here."
														>change</span
													>{/if}</td
											>
											<td class="addr-cell">
												<CopyText value={addr.address} truncate={12} />
											</td>
											<td class="addr-label-cell">
												{#if editingAddr === addr.address}
													<input
														class="input addr-label-input"
														bind:value={addrEditValue}
														maxlength="120"
														placeholder="e.g. exchange deposit"
														use:focusInput
														onkeydown={(e) => {
															if (e.key === 'Enter') saveAddrLabel();
															else if (e.key === 'Escape') cancelAddrLabelEdit();
														}}
														onblur={saveAddrLabel}
													/>
												{:else if addressLabels[addr.address]}
													<button
														type="button"
														class="addr-label-btn has-label"
														onclick={() => startAddrLabelEdit(addr.address)}
														title="Edit label"
													>
														{addressLabels[addr.address]}
													</button>
												{:else}
													<button
														type="button"
														class="addr-label-btn add-label"
														onclick={() => startAddrLabelEdit(addr.address)}
													>
														+ Add label
													</button>
												{/if}
											</td>
											<td class="num" title="{formatSats(addr.balance)} sats">
												{#if addr.balance !== 0}
													{formatBtc(addr.balance)}
												{:else}
													<span class="text-muted">0</span>
												{/if}
											</td>
											<td class="num text-muted">{addr.txCount}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if addrLabelError}
							<div class="form-error" role="alert" style="margin: 8px 14px">{addrLabelError}</div>
						{/if}
						{#if shownAddrs.some((a) => a.change)}
							<p class="change-note">
								<Icon name="info" size={13} />
								<span>
									Rows marked <span class="chg-chip">change</span> are this wallet's internal
									addresses. When you spend, whatever isn't sent to the recipient comes back to one
									of these — same keys, just a separate branch so payments you receive stay apart
									from your own leftovers. Seeing them here is normal; that money never left the
									wallet.
								</span>
							</p>
						{/if}
					{/if}
				</section>
			{:else}
				<div class="saved-head">
					<div class="saved-head-text">
						<span class="hint">
							Transactions you're building live here — a <strong>draft</strong> PSBT, one
							<strong>awaiting signature</strong> on your hardware wallet, then
							<strong>broadcast</strong> once sent.
						</span>
					</div>
					<a href="/wallets/{data.wallet.id}/send" class="btn btn-primary btn-sm">
						<Icon name="plus" size={14} />
						New transaction
					</a>
				</div>

				{#if savedTxs.length === 0}
					<section class="hw-txs">
						<div class="empty-state">
							<Icon name="arrow-up-right" size={22} />
							<span class="empty-title">Nothing in progress</span>
							<span>
								This is where transactions you're building and signing live. Heartwood builds an
								unsigned transaction (a PSBT) that you sign on your hardware wallet — your keys
								never touch this server.
							</span>
							<a
								href="/wallets/{data.wallet.id}/send"
								class="btn btn-primary btn-sm"
								style="margin-top: 4px"
							>
								<Icon name="plus" size={14} />
								New transaction
							</a>
						</div>
					</section>
				{:else}
					<div class="saved-list">
						{#each savedTxs as tx (tx.id)}
							<section class="saved-row">
								<div class="saved-row-top">
									<TxStatusBadge status={tx.status} />
									<span class="hint saved-time">{timeAgo(isoToUnix(tx.createdAt))}</span>
								</div>

								<div class="saved-grid">
									<div class="saved-field">
										<span class="saved-label">To</span>
										<a href="/explorer/address/{tx.recipient}" class="mono saved-recipient">
											{truncateMiddle(tx.recipient, 10, 8)}
										</a>
									</div>
									<div class="saved-field">
										<span class="saved-label">Amount</span>
										<span class="tabular" title="{formatSats(tx.amount)} sats">
											{formatBtc(tx.amount)} BTC
										</span>
									</div>
									<div class="saved-field">
										<span class="saved-label">Fee</span>
										<span class="tabular" title="{formatSats(tx.fee)} sats">
											{formatSats(tx.fee)} sats · {formatFeeRate(tx.feeRate)}
										</span>
									</div>
								</div>

								{#if (tx.status === 'completed' || tx.status === 'superseded') && tx.txid}
									<div class="saved-field">
										<span class="saved-label">Transaction</span>
										<a href="/explorer/tx/{tx.txid}" class="mono">
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
														min="1"
														step="any"
														bind:value={bumpRate}
														disabled={bumping}
													/>
													<span class="hint">sat/vB</span>
													<button class="btn btn-primary btn-sm" type="submit" disabled={bumping}>
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
				{/if}
			{/if}

			<!-- ------------------------------------------- export config -->
			<section class="hw-section" id="backup">
				<div class="hw-section-head">
					<h2 class="hw-section-title">Export config <span class="optional-tag">optional</span></h2>
					{#if backupDone}
						<span class="badge badge-success" title="A copy of this wallet's config has been downloaded">
							<Icon name="check" size={11} />
							downloaded
						</span>
					{/if}
				</div>
				<p class="backup-copy">
					You don't need to back this up — a single-key wallet always rebuilds from your
					hardware device (just re-import its key). If you'd like a copy anyway, the config
					describes the wallet (public key and settings) for importing into Sparrow, Electrum,
					or back into Heartwood. It <strong>can't spend</strong>.
				</p>
				<div class="row" style="gap: 8px; flex-wrap: wrap">
					<a
						href="/api/wallets/{data.wallet.id}/config"
						class="btn btn-secondary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Wallet config (JSON)
					</a>
					<a
						href="/api/wallets/{data.wallet.id}/descriptor"
						class="btn btn-ghost btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Descriptor (.txt)
					</a>
					{#if data.flags?.csv_export !== false}
						<a
							href="/api/wallets/{data.wallet.id}/history.csv"
							class="btn btn-ghost btn-sm"
							download
							title="Download this wallet's transaction history as a CSV file"
						>
							History (CSV)
						</a>
					{:else}
						<FeatureDisabled message="CSV export has been disabled by your administrator." />
					{/if}
				</div>
				<p class="hw-caption">
					Wallet config — re-import the key into Heartwood, Sparrow or Electrum. Descriptor — the
					raw text form, for Bitcoin Core and power users.
				</p>
			</section>
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

		<!-- ------------------------------------------- delete (quiet footer) -->
		<div class="hw-danger">
			{#if !confirmDelete}
				<button type="button" class="hw-danger-trigger" onclick={() => (confirmDelete = true)}>
					Remove this wallet from Heartwood…
				</button>
			{:else}
				<form
					method="POST"
					action="?/delete"
					class="delete-confirm"
					use:enhance={() => {
						deleting = true;
						return async ({ update }) => {
							deleting = false;
							await update();
						};
					}}
				>
					<p class="delete-backup-warning">
						<Icon name="alert-triangle" size={16} />
						<span>
							This removes the wallet from Heartwood. Make sure you have your backup and your
							signing device — Heartwood can't recover it for you.
						</span>
					</p>
					<div class="row" style="gap: 8px">
						<span class="confirm-text">Really delete?</span>
						<button class="btn btn-danger btn-sm" disabled={deleting}>
							{#if deleting}<span class="spinner"></span>{/if}
							Delete wallet
						</button>
						<button
							type="button"
							class="btn btn-ghost btn-sm"
							onclick={() => (confirmDelete = false)}
							disabled={deleting}
						>
							Cancel
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
</div>

<style>
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

	.hw-hero-unit {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: clamp(20px, 3vw, 30px);
		color: var(--text-secondary);
	}

	.hw-hero-sub {
		margin-top: 14px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hw-pending {
		color: var(--attention);
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

	.hw-sign-note {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-wrap: wrap;
		margin: 18px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	.hw-sync-row {
		margin-top: 10px;
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

	/* --- unboxed stepped chart --- */

	.hw-chart {
		margin-top: 40px;
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

	.hw-section-head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
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

	/* --- receive panel (5c/8d) --- */

	.hw-receive-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 44px;
		align-items: center;
	}

	.hw-qr-wrap {
		padding: 10px;
	}

	.hw-qr {
		display: block;
		width: 300px;
		height: 300px;
		image-rendering: pixelated;
	}

	.hw-receive-meta {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.hw-receive-headline {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
	}

	.hw-addr-row {
		border-bottom: 1px solid var(--hairline);
		padding-bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	.hw-addr {
		font-size: 15px;
		color: var(--text-rows);
		word-break: break-all;
		line-height: 1.5;
	}

	.hw-addr-path {
		font-size: 11px;
		color: var(--text-faint);
	}

	.hw-receive-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.hw-rotate-status {
		margin: 10px 0 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-faint);
	}

	@media (max-width: 860px) {
		.hw-receive-grid {
			grid-template-columns: 1fr;
			gap: 22px;
			justify-items: center;
			text-align: center;
		}

		.hw-receive-meta {
			align-items: center;
			width: 100%;
		}

		.hw-addr-row {
			align-items: center;
			width: 100%;
		}

		.hw-qr {
			width: 228px;
			height: 228px;
		}
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

	.hw-tx-amount {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 16px;
		font-variant-numeric: tabular-nums;
		color: var(--text-value, #cbbfb3);
	}

	.hw-tx-amount.in {
		color: var(--sage);
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

	/* --- transactions in progress --- */

	.progress-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.progress-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 13px;
		padding: 12px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.progress-row:last-child {
		border-bottom: none;
	}

	/* --- addresses tab keeps the shared table; give it breathing room --- */

	.hw-table-section {
		display: flex;
		flex-direction: column;
	}

	.hw-table-section .chips {
		padding: 14px 0 10px;
	}

	/* --- saved transactions --- */

	.saved-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin: 16px 0 4px;
		flex-wrap: wrap;
	}

	.saved-head-text {
		flex: 1;
		min-width: 220px;
	}

	.saved-head-text strong {
		font-weight: 600;
		color: var(--text-secondary);
	}

	.saved-head .btn {
		flex-shrink: 0;
	}

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

	/* --- export config --- */

	.optional-tag {
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge);
		padding: 1px 6px;
		margin-left: 6px;
		vertical-align: middle;
	}

	.backup-copy {
		margin: 0;
		max-width: 640px;
	}

	/* --- delete (quiet footer) --- */

	.hw-danger {
		margin-top: 48px;
		padding-top: 16px;
		border-top: 1px solid var(--hairline);
	}

	.hw-danger-trigger {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--text-faint);
		cursor: pointer;
	}

	.hw-danger-trigger:hover {
		color: var(--error);
	}

	.confirm-text {
		white-space: nowrap;
	}

	.delete-confirm {
		align-items: flex-start;
	}

	.delete-backup-warning {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		max-width: 420px;
		margin: 0;
		padding: 8px 12px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--warning);
		background: var(--warning-muted);
		border: 1px solid var(--warning);
		border-radius: var(--radius-control);
	}

	.delete-backup-warning :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
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

		.hw-sign-note {
			justify-content: center;
		}

		.hw-chart {
			margin-top: 30px;
		}

		.hw-tx-title {
			font-size: 13px;
		}

		.hw-tx-amount {
			font-size: 14px;
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
