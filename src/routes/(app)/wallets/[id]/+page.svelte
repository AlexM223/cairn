<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate, goto, invalidateAll, replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import Term from '$lib/components/Term.svelte';
	import TxStatusBadge from '$lib/components/TxStatusBadge.svelte';
	import ConsolidationCard from './_components/ConsolidationCard.svelte';
	import MiningRewards from '$lib/components/MiningRewards.svelte';
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
	let retrying = $state(false);
	let tab = $state<'transactions' | 'addresses' | 'saved'>('transactions');
	let addrFilter = $state<'used' | 'unused'>('used');

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
		if (!txid || !data.scan) return false;
		const seen = data.scan.txs.find((t) => t.txid === txid);
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
				bumpError = typeof body?.error === 'string' ? body.error : 'Fee bump failed.';
				return;
			}
			// The send flow resumes drafts at Review with the full
			// sign-and-broadcast machinery.
			await goto(`/wallets/${data.wallet.id}/send?tx=${body.id}`);
		} catch {
			bumpError = 'Fee bump failed — check your connection and try again.';
		} finally {
			bumping = false;
		}
	}

	// --- speed up (RBF-vs-CPFP routing, cairn-u9ob.4) ---
	// Detection (server) resolves each unconfirmed inflow to an action: 'rbf' when
	// we originated the tx and it still signals replaceability (replace it more
	// cheaply), or 'cpfp' otherwise (received funds, or our own tx that no longer
	// signals RBF — attach a high-fee child instead). See docs/CPFP-UNCONFIRMED-PLAN.md §4.
	const speedUpByTxid = $derived<Record<string, NonNullable<typeof data.speedUp>[number]>>(
		Object.fromEntries((data.speedUp ?? []).map((s) => [s.txid, s]))
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

	const receive = $derived(form?.receive ?? data.receive);

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
		'Labels are private to this wallet and stored only on your Cairn instance.';
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

	const usedAddrs = $derived((data.scan?.addresses ?? []).filter((a) => a.used));
	// Unused = the forward gap window on BOTH chains — used-change addresses
	// already show under Used, so hiding unused-change here left a slice of the
	// wallet's addresses invisible in every view. Receive first: those are the
	// ones you hand out.
	const unusedAddrs = $derived(
		(data.scan?.addresses ?? [])
			.filter((a) => !a.used)
			.toSorted((a, b) => Number(a.change) - Number(b.change))
	);
	const shownAddrs = $derived(addrFilter === 'used' ? usedAddrs : unusedAddrs);

	async function retry() {
		retrying = true;
		try {
			await invalidateAll();
		} finally {
			retrying = false;
		}
	}
</script>

<svelte:head>
	<title>{data.wallet.name} — Cairn</title>
</svelte:head>

<div class="detail wallet-detail fade-in">
	<a href="/wallets" class="back-link">
		<Icon name="chevron-left" size={14} />
		Wallets
	</a>

	{#if data.imported && !bannerDismissed}
		<div class="imported-banner" role="status">
			<Icon name="check" size={15} />
			<span class="grow">
				Wallet imported — {data.scan
					? `found ${data.scan.txs.length === 50 ? '50+' : data.scan.txs.length} transaction${data.scan.txs.length === 1 ? '' : 's'} across ${data.scan.addresses.filter((a) => a.used).length} used address${data.scan.addresses.filter((a) => a.used).length === 1 ? '' : 'es'}.`
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

	<!-- Header -->
	<div class="head row">
		<div class="row grow head-title" style="gap: 12px; min-width: 0">
			<h1 class="page-title truncate">{data.wallet.name}</h1>
			{#if data.wallet.deviceType && data.wallet.deviceType !== 'file'}
				<span class="badge badge-neutral">{walletKind}</span>
			{/if}
			<span class="badge badge-neutral">{SCRIPT_TYPE_LABELS[data.wallet.scriptType]}</span>
		</div>
		{#if data.flags?.send === false}
			<button
				type="button"
				class="btn btn-primary btn-sm"
				disabled
				title="Sending has been disabled by your administrator."
			>
				<Icon name="arrow-up-right" size={14} />
				Send
			</button>
		{:else}
			<a href="/wallets/{data.wallet.id}/send" class="btn btn-primary btn-sm">
				<Icon name="arrow-up-right" size={14} />
				Send
			</a>
		{/if}
		{#if data.flags?.csv_export !== false}
			<a
				href="/api/wallets/{data.wallet.id}/history.csv"
				class="btn btn-ghost btn-sm"
				download
				title="Download this wallet's transaction history as a CSV file"
			>
				<Icon name="arrow-down-left" size={14} />
				Export history
			</a>
		{:else}
			<FeatureDisabled message="CSV export has been disabled by your administrator." />
		{/if}
		{#if !confirmDelete}
			<button
				type="button"
				class="btn btn-ghost btn-sm delete-trigger"
				onclick={() => (confirmDelete = true)}
			>
				<Icon name="trash" size={14} />
				Delete
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
						This removes the wallet from Cairn. Make sure you have your backup and your signing
						device — Cairn can't recover it for you.
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
	<p class="hint watch-note">
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
		· {truncateMiddle(data.wallet.xpub, 10, 8)}
	</p>

	{#if helpDevice}
		<!-- Official device help (cairn-4161): a quiet expandable near the device
		     badge. Always shown for a known device — never gated by the referral
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

	{#if inProgress.length > 0}
		<!-- ------------------------------ transactions in progress -->
		<section class="card card-pad progress-card" aria-label="Transactions in progress">
			<div class="row" style="gap: 8px">
				<Icon name="clock" size={15} />
				<span class="card-title grow">Transactions in progress</span>
			</div>
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

	{#if data.scanError}
		<!-- ------------------------------------------- scan failed -->
		<div class="card card-pad scan-error">
			<Icon name="alert-triangle" size={18} />
			<div class="grow">
				<div style="font-weight: 500">Can't reach the wallet scanner</div>
				<div class="hint">{data.scanError}</div>
			</div>
			<button type="button" class="btn btn-secondary btn-sm" onclick={retry} disabled={retrying}>
				{#if retrying}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
				Retry
			</button>
		</div>
	{:else if data.scan}
		<div class="top-grid">
			<!-- ------------------------------------------- balance hero -->
			<section class="card card-pad balance-card">
				<span class="overline">Confirmed balance</span>
				<div class="balance-line">
					<span class="hero-number balance-btc" title="{formatSats(data.scan.confirmed)} sats">
						{formatBtc(data.scan.confirmed)}
					</span>
					<span class="balance-unit">BTC</span>
				</div>
				{#if data.scan.unconfirmed !== 0}
					<span class="badge badge-warning" style="align-self: flex-start">
						<Icon name="clock" size={12} />
						{data.scan.unconfirmed > 0 ? '+' : ''}{formatBtc(data.scan.unconfirmed)} BTC pending
					</span>
				{/if}
				<span class="hint tabular">≈ {formatSats(data.scan.confirmed)} sats</span>
			</section>

			<!-- ------------------------------------------- receive -->
			<section class="card card-pad receive-card">
				<div class="row" style="gap: 8px">
					<Icon name="arrow-down-left" size={15} />
					<span class="card-title grow">Receive</span>
					{#if receive}
						<span class="hint mono">{receive.path}</span>
					{/if}
				</div>
				{#if receive}
					<div class="receive-body">
						<img class="qr" src={receive.qr} alt="QR code for {receive.address}" width="110" height="110" />
						<div class="receive-meta">
							<div class="receive-addr">
								<CopyText value={receive.address} truncate={13} />
							</div>
							<span class="hint">Unused address — a fresh one every click, within the gap limit.</span>
							{#if form?.receiveError}
								<div class="form-error" role="alert">{form.receiveError}</div>
							{/if}
							<form
								method="POST"
								action="?/receive"
								use:enhance={() => {
									generating = true;
									return async ({ update }) => {
										generating = false;
										await update({ reset: false });
									};
								}}
							>
								<input type="hidden" name="current" value={receive.index} />
								<button class="btn btn-secondary btn-sm" disabled={generating}>
									{#if generating}<span class="spinner"></span>{:else}<Icon name="refresh" size={13} />{/if}
									Generate next address
								</button>
							</form>
						</div>
					</div>
				{/if}
			</section>
		</div>

		<!-- ------------------------------------------- mining rewards -->
		<!-- Coinbase (mining reward) UTXOs only — empty for a normal wallet, so
		     the whole section is absent unless the wallet actually mined. -->
		{#if data.coinbaseUtxos.length > 0}
			<MiningRewards utxos={data.coinbaseUtxos} tipHeight={data.tipHeight} />
		{/if}

		<!-- ------------------------------------------- backup / export -->
		<section class="card card-pad backup-card" id="backup">
			<div class="row" style="gap: 8px">
				<Icon name="arrow-down-left" size={15} />
				<span class="card-title grow">Export wallet config <span class="optional-tag">optional</span></span>
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
				or back into Cairn. It <strong>can't spend</strong>.
			</p>
			<div class="row" style="gap: 8px; flex-wrap: wrap">
				<a
					href="/api/wallets/{data.wallet.id}/config"
					class="btn btn-primary btn-sm"
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
			</div>
			<div class="backup-notes">
				<span class="hint">
					<strong>Wallet config</strong> — re-import the key into Cairn, Sparrow or Electrum. ·
					<strong>Descriptor</strong> — the raw text form, for Bitcoin Core and power users.
				</span>
			</div>
		</section>

		<!-- Consolidation suggestion: appears only when the wallet holds coins
		     from huge batch payouts (slow to sign on hardware wallets). Fetches
		     its own data lazily and renders nothing when there's nothing to say. -->
		<ConsolidationCard
			walletId={data.wallet.id}
			scriptType={data.wallet.scriptType}
			receiveAddress={receive?.address ?? null}
		/>

		<!-- ------------------------------------------- tabs -->
		<div class="tabs" role="tablist">
			<button
				type="button"
				role="tab"
				class="tab"
				class:active={tab === 'transactions'}
				aria-selected={tab === 'transactions'}
				onclick={() => (tab = 'transactions')}
			>
				Transactions
				<span class="tab-count">{data.scan.txs.length}</span>
			</button>
			<button
				type="button"
				role="tab"
				class="tab"
				class:active={tab === 'addresses'}
				aria-selected={tab === 'addresses'}
				onclick={() => (tab = 'addresses')}
			>
				Addresses
				<span class="tab-count">{data.scan.addresses.length}</span>
			</button>
			<button
				type="button"
				role="tab"
				class="tab"
				class:active={tab === 'saved'}
				aria-selected={tab === 'saved'}
				onclick={() => (tab = 'saved')}
			>
				Sending
				{#if savedTxs.length > 0}
					<span class="tab-count">{savedTxs.length}</span>
				{/if}
			</button>
		</div>

		{#if tab === 'transactions'}
			<section class="card">
				{#if data.scan.txs.length === 0}
					<div class="empty-state">
						<Icon name="activity" size={22} />
						<span class="empty-title">No transactions yet</span>
						<span>Send some sats to a receive address and they'll show up here.</span>
					</div>
				{:else}
					<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Transaction</th>
									<th></th>
									<th class="num">Amount</th>
									<th>When</th>
									<th class="num">Fee</th>
								</tr>
							</thead>
							<tbody>
								{#each data.scan.txs as tx (tx.txid)}
									<tr>
										<td>
											<a href="/explorer/tx/{tx.txid}" class="mono">
												{truncateMiddle(tx.txid, 8, 8)}
											</a>
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
											{:else if labels[tx.txid]}
												<div class="tx-label-row">
													<button
														type="button"
														class="tx-label"
														title="{LABEL_PRIVACY_NOTE} Click to edit."
														onclick={() => startLabelEdit(tx.txid)}
													>
														{labels[tx.txid]}
													</button>
												</div>
											{:else}
												<div class="tx-label-row">
													<button
														type="button"
														class="label-add"
														title={LABEL_PRIVACY_NOTE}
														onclick={() => startLabelEdit(tx.txid)}
													>
														<Icon name="plus" size={11} />
														label
													</button>
												</div>
											{/if}
										</td>
										<td>
											<span class="dir" class:in={tx.delta >= 0} class:out={tx.delta < 0}>
												<Icon
													name={tx.delta >= 0 ? 'arrow-down-left' : 'arrow-up-right'}
													size={14}
												/>
												{tx.delta >= 0 ? 'Received' : 'Sent'}
											</span>
										</td>
										<td class="num">
											<span
												class="delta tabular"
												class:in={tx.delta >= 0}
												class:out={tx.delta < 0}
												title="{formatSats(tx.delta)} sats"
											>
												{tx.delta > 0 ? '+' : ''}{formatBtc(tx.delta)} BTC
											</span>
										</td>
										<td>
											{#if tx.height <= 0}
												<div class="pending-cell">
													<span class="badge badge-warning">
														<Icon name="clock" size={11} />
														pending
													</span>
													{#if speedUpByTxid[tx.txid]}
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
																<button
																	class="btn btn-primary btn-sm"
																	type="submit"
																	disabled={cpfping}
																>
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
											{:else}
												<span class="text-muted">{timeAgo(tx.time)}</span>
											{/if}
										</td>
										<td class="num text-muted">
											{tx.fee != null ? `${formatSats(tx.fee)} sats` : '—'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{:else if tab === 'addresses'}
			<section class="card">
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
				</div>
				{#if shownAddrs.length === 0}
					<div class="empty-state">
						<span class="empty-title">
							{addrFilter === 'used' ? 'No used addresses yet' : 'No unused addresses in the window'}
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
										<td class="mono text-muted">{addr.derivationPath}</td>
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
				<section class="card">
					<div class="empty-state">
						<Icon name="arrow-up-right" size={22} />
						<span class="empty-title">Nothing in progress</span>
						<span>
							This is where transactions you're building and signing live. Cairn builds an
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
						<section class="card card-pad saved-row">
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
										download="cairn-tx-{tx.id}.psbt"
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
	{/if}
</div>

<style>
	/* Shared layout (header, grid, tabs, tables, labels) comes from
	   $lib/styles/wallet-detail.css; only what differs from the multisig
	   detail page lives here. */

	.banner-dismiss:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	/* Official device-help expandable near the header (same quiet <details>
	   idiom as the import wizard's optional-config box). */
	.device-help {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 8px 14px;
		margin: -8px 0 18px;
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

	.head {
		gap: 14px;
	}

	.confirm-text {
		white-space: nowrap;
	}

	.delete-confirm {
		align-items: flex-start;
	}

	.optional-tag {
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		padding: 1px 6px;
		margin-left: 6px;
		vertical-align: middle;
	}

	.backup-copy {
		margin: 0;
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

	.top-grid {
		margin-bottom: 18px;
	}

	/* --- tx labels --- */

	.tx-label-row {
		margin-top: 3px;
	}

	.tx-label {
		display: inline-block;
		max-width: 260px;
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

	tr:hover .label-add,
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

	.progress-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 18px;
	}

	.progress-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.progress-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 13px;
	}

	/* --- saved transactions --- */

	.saved-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 14px;
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
		gap: 12px;
	}

	.saved-row {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
		border-top: 1px solid var(--border-subtle);
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
	}

	.bump-input {
		width: 90px;
		font-size: 12.5px;
		padding: 4px 8px;
	}

	/* Pending tx history cell: badge + inline Speed up affordance. */
	.pending-cell {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.speed-up-btn {
		gap: 4px;
	}

	.bump-error {
		flex-basis: 100%;
		font-size: 12.5px;
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
