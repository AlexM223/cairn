<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate, goto, invalidate, replaceState } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import SyncIndicator from '$lib/components/heartwood/SyncIndicator.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import MiningRewards from '$lib/components/MiningRewards.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import QuorumArc from '$lib/components/heartwood/QuorumArc.svelte';
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import WalletStepChart from '../../[id]/_components/WalletStepChart.svelte';
	import { copyToClipboard } from '$lib/clipboard';
	import { formatBtc, formatSats, timeAgo, truncateMiddle } from '$lib/format';
	import KeyHealthRow from '../_components/KeyHealthRow.svelte';
	import AddressScriptDetails from '../_components/AddressScriptDetails.svelte';
	import MultisigCollaborators from '../_components/MultisigCollaborators.svelte';
	import { MULTISIG_SCRIPT_LABELS } from '../labels';
	// Layout/styling shared with the single-sig detail page (namespaced under
	// the root's .wallet-detail class); this page's style block keeps only what
	// differs.
	import '$lib/styles/wallet-detail.css';

	let { data, form } = $props();

	// Stale-while-revalidate (cairn-2zxt): the Electrum-dependent slice (balance
	// scan, receive address, tip, coinbase UTXOs, speed-up eligibility, saved txs)
	// now comes from a persisted snapshot read synchronously in load() — instant,
	// no Electrum on navigation. `refresh()` re-scans in the background and, on
	// success, re-invalidates the loader to pick up the fresh snapshot. `data.scan`
	// is already resolved (not a promise).
	type MultisigScan = (typeof data)['scan'];
	const scan = $derived(data.scan);
	const detail = $derived(scan.detail);
	const coinbaseUtxos = $derived(scan.coinbaseUtxos);
	const tipHeight = $derived(scan.tipHeight);
	const speedUp = $derived(scan.speedUp);
	const savedTxs = $derived(scan.savedTxs);

	// Advanced expander on the receive panel: derivation path is power-user
	// detail, collapsed by default (never persisted — always resets closed).
	let showReceiveAdvanced = $state(false);

	let syncing = $state(false);
	// A refresh failure with nothing cached surfaces as the scan-error state; with
	// cached data showing it's swallowed (keep the stale snapshot up, SWR contract).
	let refreshError = $state<string | null>(null);
	const hasData = $derived(detail !== null);
	const scanLoading = $derived(!hasData && data.lastSyncedAt === null && refreshError === null);
	const scanError = $derived(!hasData ? refreshError : null);

	/** Kick a background re-scan, then re-read the fresh snapshot on success. */
	async function refresh() {
		if (syncing) return;
		syncing = true;
		try {
			const res = await fetch(`/api/wallets/multisig/${data.multisig.id}/refresh`, {
				method: 'POST'
			});
			if (!res.ok) {
				refreshError = 'Could not reach the wallet scanner';
				return;
			}
			refreshError = null;
			await invalidate(`cairn:multisig:${data.multisig.id}`);
		} catch {
			refreshError = 'Could not reach the wallet scanner';
		} finally {
			syncing = false;
		}
	}

	// Refresh once on mount, then on every new block via the existing SSE channel.
	// The first SSE delivery is a replay of the current tip on connect (covered by
	// the mount refresh), so it's skipped.
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

	let createdDismissed = $state(false);

	// The ?created=1 flag is one-shot: strip it from the URL so a reload doesn't
	// resurrect the welcome banner later. (Same pattern as the wallet page.)
	afterNavigate(() => {
		setTimeout(() => {
			const url = new URL(window.location.href);
			if (!url.searchParams.has('created')) return;
			url.searchParams.delete('created');
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
	let tab = $state<'transactions' | 'addresses'>('transactions');
	let addrFilter = $state<'used' | 'unused' | 'change'>('used');

	// --- speed up (RBF-vs-CPFP routing, cairn-u9ob.4 multisig parity) ---
	// Detection resolves each unconfirmed inflow to 'rbf' (we originated it and it
	// still signals replaceability — bump it) or 'cpfp' (attach a high-fee child).
	// See docs/CPFP-UNCONFIRMED-PLAN.md §4.
	const speedUpByTxid = $derived<Record<string, MultisigScan['speedUp'][number]>>(
		Object.fromEntries(speedUp.map((s) => [s.txid, s]))
	);
	let speedUpTxid = $state<string | null>(null);
	let speedUpRate = $state('');
	let speedingUp = $state(false);
	let speedUpError = $state<string | null>(null);

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

	async function openSpeedUp(txid: string) {
		const inflow = speedUpByTxid[txid];
		if (!inflow) return;
		speedUpError = null;
		speedUpTxid = txid;
		const saved =
			inflow.action === 'rbf'
				? savedTxs.find(
						(t) => t.txid === txid && (t.status === 'completed' || t.status === 'superseded')
					)
				: undefined;
		speedUpRate = await fastRateSeed(saved?.feeRate ?? 1);
	}

	/** Apply the detection verdict: RBF-bump our own replaceable tx, else CPFP. */
	async function submitSpeedUp(txid: string) {
		if (speedingUp) return;
		const inflow = speedUpByTxid[txid];
		if (!inflow) return;
		speedingUp = true;
		speedUpError = null;
		try {
			let res: Response;
			if (inflow.action === 'rbf') {
				const saved = savedTxs.find(
					(t) => t.txid === txid && (t.status === 'completed' || t.status === 'superseded')
				);
				if (!saved) {
					// No saved row to replace — fall back to a CPFP child.
					res = await fetch(`/api/wallets/multisig/${data.multisig.id}/transactions/cpfp`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ parentTxid: txid, feeRate: Number(speedUpRate) })
					});
				} else {
					res = await fetch(
						`/api/wallets/multisig/${data.multisig.id}/transactions/${saved.id}/bump`,
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ feeRate: Number(speedUpRate) })
						}
					);
				}
			} else {
				res = await fetch(`/api/wallets/multisig/${data.multisig.id}/transactions/cpfp`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ parentTxid: txid, feeRate: Number(speedUpRate) })
				});
			}
			const body = await res.json();
			if (!res.ok) {
				const reason = typeof body?.error === 'string' ? body.error : 'Something unexpected happened.';
				speedUpError = `Couldn't speed this up — ${reason} Your original transaction is unchanged and still valid.`;
				return;
			}
			// The new draft re-enters the roster sign/broadcast flow.
			await goto(`/wallets/multisig/${data.multisig.id}/send?tx=${body.id}`);
		} catch {
			speedUpError =
				"Couldn't speed this up — network hiccup, check your connection and try again. Your original transaction is unchanged and still valid.";
		} finally {
			speedingUp = false;
		}
	}

	const receive = $derived(form?.receive ?? scan?.receive ?? null);

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

	// Backup nudge: gentle reminder until the config has been downloaded. Source
	// of truth is the server-tracked wallet_backups table (data.backedUp); the
	// local flag is a purely-optimistic overlay for this page's own download
	// buttons, so a download from anywhere else still reflects on next load.
	let downloadedNow = $state(false);
	const backupDone = $derived(data.backedUp || downloadedNow);
	function markBackupDownloaded() {
		downloadedNow = true;
	}
	// Only multisigs CREATED from scratch need a backup nudge — their config exists
	// nowhere else. An IMPORTED multisig came from a file the user already holds, so
	// it never nags (the export section below stays available, just without the dot).
	const needsBackup = $derived(data.multisig.source === 'created' && !backupDone);

	// ColdCard-family devices refuse to sign for multisigs they haven't registered
	// (via the setup file on microSD). Track a per-key "I've done this"
	// acknowledgement locally and nag gently until then.
	function needsRegistration(deviceType: string | null): boolean {
		return deviceType === 'coldcard' || deviceType === 'qr';
	}
	let registeredAcks = $state<Record<number, boolean>>({});
	$effect(() => {
		const acks: Record<number, boolean> = {};
		for (const k of data.multisig.keys) {
			if (needsRegistration(k.deviceType)) {
				acks[k.id] =
					localStorage.getItem(`cairn.multisig.registered.${data.multisig.id}.${k.id}`) === 'done';
			}
		}
		registeredAcks = acks;
	});
	function markRegistered(keyId: number) {
		localStorage.setItem(`cairn.multisig.registered.${data.multisig.id}.${keyId}`, 'done');
		registeredAcks = { ...registeredAcks, [keyId]: true };
	}
	const unregisteredKeys = $derived(
		data.multisig.keys.filter((k) => needsRegistration(k.deviceType) && !registeredAcks[k.id])
	);

	const usedAddrs = $derived((detail?.addresses ?? []).filter((a) => a.used));
	// Unused = the forward gap window on the receive chain.
	const unusedAddrs = $derived((detail?.addresses ?? []).filter((a) => !a.used && a.chain === 0));
	// Change = the whole internal chain (…/1/*), used and upcoming — so you can
	// verify where change went AND where the next spend's change will go
	// (cairn-teyh).
	const changeAddrs = $derived(
		(detail?.addresses ?? []).filter((a) => a.chain === 1).toSorted((a, b) => a.index - b.index)
	);
	const shownAddrs = $derived(
		addrFilter === 'used' ? usedAddrs : addrFilter === 'unused' ? unusedAddrs : changeAddrs
	);

	// --- address labels (cairn-nbsx) ---
	let addrLabelOverrides = $state<Record<string, string>>({});
	const addressLabels = $derived<Record<string, string>>({
		...data.addressLabels,
		...addrLabelOverrides
	});
	let editingAddr = $state<string | null>(null);
	let addrEditValue = $state('');
	let savingAddrLabel = $state(false);

	function startAddrLabelEdit(address: string) {
		editingAddr = address;
		addrEditValue = addressLabels[address] ?? '';
	}
	function cancelAddrLabelEdit() {
		editingAddr = null;
	}
	function focusAddrInput(node: HTMLInputElement) {
		node.focus();
		node.select();
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
			const res = await fetch(`/api/wallets/multisig/${data.multisig.id}/address-labels`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address, label: next })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch {
			addrLabelOverrides = { ...addrLabelOverrides, [address]: prev };
			editingAddr = address;
			addrEditValue = next;
		} finally {
			savingAddrLabel = false;
		}
	}

	// --- address transparency (cairn-h73) ---
	// When every key was created at the same account path, each address has ONE
	// unambiguous full path to show. When key paths differ (mixed devices),
	// Caravan's convention applies: show the shared /chain/index suffix (the
	// "braid" path) and list each key's full path in the details disclosure.
	const sharedBasePath = $derived(
		data.multisig.keys.length > 0 &&
			data.multisig.keys[0].path !== 'm' &&
			data.multisig.keys.every((k) => k.path === data.multisig.keys[0].path)
			? data.multisig.keys[0].path
			: null
	);
	let openAddrKey = $state<string | null>(null);
	function toggleAddrDetail(chain: number, index: number) {
		const key = `${chain}/${index}`;
		openAddrKey = openAddrKey === key ? null : key;
	}

	// --- key health checks (cairn-hvp) ---
	// Freshly verified keys update in place (no reload); the nudge below reads
	// through these overrides so it clears as soon as the last stale key passes.
	let verifiedOverrides = $state<Record<number, string>>({});
	function keyVerifiedAt(k: { id: number; lastVerifiedAt: string | null }): string | null {
		return verifiedOverrides[k.id] ?? k.lastVerifiedAt;
	}
	const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
	// A key is stale when unchecked for ~6 months. Never-checked keys count too
	// (that's the Casa pattern) — but not during a multisig's first week, when the
	// wizard's own cross-checks are still fresh and a nag would just be noise.
	const multisigAgeMs = $derived(Date.now() - Date.parse(data.multisig.createdAt));
	const staleKeys = $derived(
		data.multisig.keys.filter((k) => {
			const ts = keyVerifiedAt(k);
			if (!ts) return multisigAgeMs > 7 * 24 * 60 * 60 * 1000;
			return Date.now() - Date.parse(ts) > SIX_MONTHS_MS;
		})
	);

	// The reminder is dismissible per multisig per half-year window: dismissing it
	// in 2026H1 brings it back in 2026H2 — periodic by construction.
	function checkWindowStamp(): string {
		const now = new Date();
		return `${now.getFullYear()}H${now.getMonth() < 6 ? 1 : 2}`;
	}
	let nudgeDismissed = $state(true); // optimistic until localStorage is checked
	$effect(() => {
		nudgeDismissed =
			localStorage.getItem(`cairn.multisig.keycheck.${data.multisig.id}.${checkWindowStamp()}`) ===
			'dismissed';
	});
	function dismissNudge() {
		localStorage.setItem(
			`cairn.multisig.keycheck.${data.multisig.id}.${checkWindowStamp()}`,
			'dismissed'
		);
		nudgeDismissed = true;
	}
	function handleKeyVerified(keyId: number, ts: string) {
		verifiedOverrides = { ...verifiedOverrides, [keyId]: ts };
	}

</script>

<svelte:head>
	<title>{data.multisig.name} — Heartwood</title>
</svelte:head>

<div class="wallet-detail hw-page fade-in">
	<GroveField volume="present" />
	<div class="hw-content">
		{#if data.created && !createdDismissed}
			<div class="created-banner" role="status">
				<Icon name="check" size={15} />
				<span class="grow">
					Wallet created — fund it with a small test amount first, and keep your backup file safe.
				</span>
				<button
					type="button"
					class="banner-dismiss"
					aria-label="Dismiss"
					onclick={() => (createdDismissed = true)}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		{/if}

		<!-- ------------------------------------------- eyebrow + hero (5d) -->
		<header class="hw-head">
			<div class="hw-eyebrow">
				<EyebrowBreadcrumb
					path={['Wallets', data.multisig.name]}
					current="{data.multisig.threshold}-of-{data.multisig.keys.length} · {MULTISIG_SCRIPT_LABELS[
						data.multisig.scriptType
					]}"
				/>
			</div>

			{#if detail}
				<div class="hw-hero">
					<Amount sats={detail.balance.confirmed} size="hero" />
				</div>
				<p class="hw-hero-sub">
					<span class="tabular">{formatSats(detail.balance.confirmed)} sats</span>
					{#if detail.balance.unconfirmed !== 0}
						<span class="hw-pending">
							· {detail.balance.unconfirmed > 0 ? '+' : ''}{formatBtc(
								detail.balance.unconfirmed
							)} BTC on its way
						</span>
					{/if}
				</p>
			{:else if scanLoading}
				<!-- Balance streams in from the server scan — skeleton until it lands. -->
				<div class="hw-hero">
					<span class="hero-number hw-hero-btc hw-skeleton hw-skeleton-hero" aria-hidden="true"
						>0.00000000</span
					>
					<span class="hw-hero-unit">BTC</span>
				</div>
				<p class="hw-hero-sub">
					<span class="hw-skeleton hw-skeleton-line" aria-hidden="true">loading balance</span>
				</p>
			{:else}
				<div class="hw-hero">
					<span class="hero-number hw-hero-btc hw-hero-muted">—</span>
				</div>
			{/if}

			<div class="hw-pills">
				<!-- Signing surface: hidden from a pure viewer (they can't co-sign). -->
				{#if data.role !== 'viewer'}
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
						<a href="/wallets/multisig/{data.multisig.id}/send" class="btn btn-primary hw-pill">
							<Icon name="arrow-up-right" size={15} />
							Send
						</a>
					{/if}
				{/if}
				<a href="#receive" class="btn btn-secondary hw-pill">
					<Icon name="arrow-down-left" size={15} />
					Receive
				</a>
			</div>

			<p class="hw-sign-note">
				<QuorumArc total={data.multisig.keys.length} collected={data.multisig.threshold} size={16} />
				<Term
					tip="Spending needs signatures from that many of your keys. Heartwood tracks the balance and builds transactions, but only your keys can approve them — your private keys never leave your devices."
					>{data.multisig.threshold} of {data.multisig.keys.length} keys required to spend</Term
				>
			</p>

			<div class="hw-sync-row">
				<SyncIndicator lastSyncedAt={data.lastSyncedAt} {syncing} />
			</div>
		</header>

		{#if staleKeys.length > 0 && !nudgeDismissed}
			<!-- Stale-key nudge: calm amber over a hairline, never a warning box. -->
			<div class="keycheck-nudge" role="status">
				<Icon name="clock" size={16} />
				<div class="grow">
					<div class="nudge-title">When did you last check your keys?</div>
					<p class="nudge-copy">
						A key you can't access is a key you don't have. Check each one now and then —
						especially before you need them. {staleKeys.length === 1
							? `"${staleKeys[0].name}" hasn't`
							: `${staleKeys.length} of your keys haven't`} been checked in over six months.
					</p>
				</div>
				<button
					type="button"
					class="banner-dismiss"
					aria-label="Dismiss reminder"
					onclick={dismissNudge}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
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
		{:else if detail}
			<!-- ------------------------------------------- stepped balance chart -->
			{#if detail.history.some((t) => t.height > 0)}
				<div class="hw-chart">
					<WalletStepChart txs={detail.history} confirmed={detail.balance.confirmed} height={148} />
					<p class="hw-caption">balance over time · each step is a transaction</p>
				</div>
			{/if}

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
										return async ({ update }) => {
											generating = false;
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
										Rotate
									</button>
								</form>
							</div>
							<p class="hw-caption">
								A new address for every payment keeps your history private. Before a large
								deposit, cross-check this address in another tool (Sparrow can open your backup
								file) — two tools agreeing proves the wallet is built from your keys alone.
							</p>
							<div class="disclosure hw-receive-advanced">
								<button
									type="button"
									class="disclosure-toggle"
									onclick={() => (showReceiveAdvanced = !showReceiveAdvanced)}
									aria-expanded={showReceiveAdvanced}
								>
									<Icon name="settings" size={14} />
									Advanced
									<span class="chev" class:open={showReceiveAdvanced}
										><Icon name="chevron-down" size={14} /></span
									>
								</button>
								{#if showReceiveAdvanced}
									<div class="disclosure-body fade-in">
										<span class="hw-addr-path mono">Derivation path: …/0/{receive.index}</span>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</section>
			{/if}

			<!-- ------------------------------------------- mining rewards -->
			<!-- Coinbase (mining reward) UTXOs only — empty for a normal multisig, so
			     the whole section is absent unless the wallet actually mined. -->
			{#if coinbaseUtxos.length > 0}
				<MiningRewards utxos={coinbaseUtxos} {tipHeight} />
			{/if}
		{:else if scanLoading}
			<!-- Balance/history/receive stream in from the server scan — placeholder
			     rows keep the shell from jumping when they land. -->
			<div class="hw-scan-loading" aria-hidden="true">
				<div class="hw-skeleton hw-skeleton-block"></div>
				<div class="hw-skeleton hw-skeleton-block hw-skeleton-block-sm"></div>
			</div>
		{/if}

		<!-- ------------------------------------------- keys (5d key rows) -->
		<section class="hw-section" aria-label="Keys">
			<div class="hw-section-head">
				<h2 class="hw-section-title">Keys · {data.multisig.threshold} of {data.multisig.keys.length}</h2>
				<span class="hint">
					<Term
						tip="Devices die, PINs get forgotten, and a device restored from the wrong seed keeps working for everything except this wallet. A quick check proves each key still derives this wallet — before you need it to."
						>Confirm each key still works now and then.</Term
					>
				</span>
			</div>
			<div class="key-rows">
				{#each data.multisig.keys as key (key.id)}
					<KeyHealthRow
						multisigId={data.multisig.id}
						keyInfo={{
							id: key.id,
							name: key.name,
							deviceType: key.deviceType,
							fingerprint: key.fingerprint,
							xpub: key.xpub,
							path: key.path,
							lastVerifiedAt: keyVerifiedAt(key)
						}}
						scriptType={data.multisig.scriptType}
						receiveAddress={receive?.address ?? null}
						onVerified={handleKeyVerified}
						category={key.category}
						emergency={key.category === 'recovery'}
						flag={needsRegistration(key.deviceType) && !registeredAcks[key.id]
							? 'Registered?'
							: null}
						flagTitle="This device refuses to sign for multisig wallets it hasn't registered — see below."
					/>
				{/each}
			</div>

			{#if unregisteredKeys.length > 0}
				<div class="register-callout">
					<span class="register-title">
						<Icon name="alert-triangle" size={14} />
						One-time step: teach {unregisteredKeys.length === 1
							? `"${unregisteredKeys[0].name}"`
							: 'these devices'} this wallet
					</span>
					<p class="register-copy">
						A ColdCard (and SeedSigner/Passport) <strong>only signs for multisig wallets it knows</strong>
						— it will refuse this one until registered. Download the registration file, copy it
						to the microSD card, then on the ColdCard: <strong>Settings → Multisig Wallets →
						Import from SD</strong>. The device shows this wallet's {data.multisig.threshold}-of-{data.multisig.keys.length}
						quorum and keys — confirm, and it's done.
					</p>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<a href="/api/wallets/multisig/{data.multisig.id}/coldcard" class="btn btn-secondary btn-sm" download>
							Download registration file
						</a>
						{#each unregisteredKeys as key (key.id)}
							<button
								type="button"
								class="btn btn-ghost btn-sm"
								onclick={() => markRegistered(key.id)}
							>
								<Icon name="check" size={13} />
								{key.name} is registered
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</section>

		<!-- ------------------------------------------- collaborators (owner-only) -->
		<!-- Share this wallet with a contact (viewer/cosigner). Gated on owner +
		     team mode server-side (data.canManageShares); independent of the scan,
		     so it renders even when the balance scan above failed. -->
		{#if data.canManageShares}
			<MultisigCollaborators
				multisigId={data.multisig.id}
				keys={data.multisig.keys.map((k) => ({ id: k.id, name: k.name }))}
				threshold={data.multisig.threshold}
				contacts={data.shareableContacts}
				initialCollaborators={data.collaborators}
			/>
		{/if}

		{#if detail}
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
					Transactions · {detail.history.length}
				</button>
				<button
					type="button"
					role="tab"
					class="hw-toggle"
					class:active={tab === 'addresses'}
					aria-selected={tab === 'addresses'}
					onclick={() => (tab = 'addresses')}
				>
					Addresses · {detail.addresses.length}
				</button>
			</div>

			{#if tab === 'transactions'}
				<!-- Hairline tx rows with burial-ring confirmation glyphs (5d). -->
				<section class="hw-txs" aria-label="Transactions">
					{#if detail.history.length === 0}
						<div class="empty-state">
							<Icon name="activity" size={22} />
							<span class="empty-title">No transactions yet</span>
							<span>
								Send a small test amount to the receive address above — it'll show up here once
								the network sees it.
							</span>
						</div>
					{:else}
						{#each detail.history as tx (tx.txid)}
							{@const conf = confirmationsOf(tx.height)}
							<div class="hw-tx-row">
								<BurialRings confirmations={conf} direction={tx.delta >= 0 ? 'in' : 'out'} size={30} />
								<div class="hw-tx-main">
									<span class="hw-tx-title">{tx.delta >= 0 ? 'Received' : 'Sent'}</span>
									<span class="hw-tx-meta">
										{burialRingsLabel(conf)}
										·
										{#if data.flags?.explorer !== false}
											<a href="/explorer/tx/{tx.txid}" class="mono hw-tx-link"
												>{truncateMiddle(tx.txid, 8, 8)}</a
											>
										{:else}
											<span class="mono hw-tx-link">{truncateMiddle(tx.txid, 8, 8)}</span>
										{/if}
										{#if tx.fee != null}
											· network fee <Amount sats={tx.fee} size="inline" />
										{/if}
									</span>
									{#if tx.height <= 0 && speedUpByTxid[tx.txid] && data.role !== 'viewer'}
										{#if speedUpTxid === tx.txid}
											<form
												class="bump-form"
												onsubmit={(e) => {
													e.preventDefault();
													submitSpeedUp(tx.txid);
												}}
											>
												<label class="hint" for="speedup-rate-{tx.txid}">Target rate</label>
												<input
													id="speedup-rate-{tx.txid}"
													class="input bump-input"
													type="number"
													min="1"
													step="any"
													bind:value={speedUpRate}
													disabled={speedingUp}
												/>
												<span class="hint">sat/vB</span>
												<button class="btn btn-primary btn-sm" type="submit" disabled={speedingUp}>
													{#if speedingUp}<span class="spinner"></span>{/if}
													Speed up
												</button>
												<button
													type="button"
													class="btn btn-ghost btn-sm"
													disabled={speedingUp}
													onclick={() => (speedUpTxid = null)}
												>
													Cancel
												</button>
											</form>
											{#if speedUpError}
												<div class="form-error bump-error" role="alert">{speedUpError}</div>
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
			{:else}
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
						<p class="addr-verify-hint">
							Every address here is built from your {data.multisig.keys.length} public keys alone —
							open <strong>Details</strong> on any row for the exact script and derivation paths,
							so you can verify this address on any other wallet tool.
						</p>
						<div class="table-wrap">
							<table class="table">
								<thead>
									<tr>
										<th>Path</th>
										<th>Address</th>
										<th>Label</th>
										<th class="num">Balance</th>
										<th class="num">Txs</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each shownAddrs as addr (addr.address)}
										<tr>
											<td class="path-cell">
												{#if sharedBasePath}
													<span class="mono text-muted path-text">
														<CopyText
															value={`${sharedBasePath}/${addr.chain}/${addr.index}`}
															display={`…/${addr.chain}/${addr.index}`}
														/>
													</span>
												{:else}
													<Term
														tip="Each of this wallet's keys uses its own base path, so only this receive/change suffix is shared — open Details for every key's full path."
													>
														<span class="mono text-muted path-text">/{addr.chain}/{addr.index}</span>
													</Term>
												{/if}
												{#if addr.chain === 1}
													<span
														class="chg-chip"
														title="An internal address — leftovers from your own spends land here."
														>change</span
													>
												{/if}
											</td>
											<td class="addr-cell">
												<CopyText value={addr.address} truncate={12} />
											</td>
											<td class="addr-label-cell">
												{#if editingAddr === addr.address}
													<input
														class="input addr-label-input"
														bind:value={addrEditValue}
														maxlength="120"
														placeholder="e.g. donation address"
														use:focusAddrInput
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
											<td class="num">
												{#if addr.balance !== 0}
													<Amount sats={addr.balance} size="row" />
												{:else}
													<span class="text-muted">0</span>
												{/if}
											</td>
											<td class="num text-muted">{addr.txCount}</td>
											<td class="num">
												<button
													type="button"
													class="detail-toggle"
													class:open={openAddrKey === `${addr.chain}/${addr.index}`}
													aria-expanded={openAddrKey === `${addr.chain}/${addr.index}`}
													onclick={() => toggleAddrDetail(addr.chain, addr.index)}
												>
													Details
													<Icon name="chevron-down" size={12} />
												</button>
											</td>
										</tr>
										{#if openAddrKey === `${addr.chain}/${addr.index}`}
											<tr class="addr-detail-row">
												<td colspan="6">
													<AddressScriptDetails
														multisigId={data.multisig.id}
														chain={addr.chain}
														index={addr.index}
													/>
												</td>
											</tr>
										{/if}
									{/each}
								</tbody>
							</table>
						</div>
						{#if shownAddrs.some((a) => a.chain === 1)}
							<p class="change-note">
								<Icon name="info" size={13} />
								<span>
									Rows marked <span class="chg-chip">change</span> are this wallet's internal
									addresses. When you spend, whatever isn't sent to the recipient comes back to
									one of these — same keys, same {data.multisig.threshold}-of-{data.multisig.keys.length}
									quorum, just a separate branch so payments you receive stay apart from your own
									leftovers. Seeing them here is normal; that money never left the wallet.
								</span>
							</p>
						{/if}
					{/if}
				</section>
			{/if}

			<!-- ------------------------------------------- export config -->
			<!-- Registration/backup exports carry full key origins; only signers (owner
			     or cosigner) can reach these endpoints, so a pure viewer never sees them. -->
			{#if data.role !== 'viewer'}
				<section class="hw-section" id="backup">
					<div class="hw-section-head">
						<h2 class="hw-section-title">
							<Term
								tip="Save this file somewhere safe. It's how you recover this wallet in another wallet app if needed."
								>Export config</Term
							>
						</h2>
						{#if needsBackup}
							<span class="badge badge-warning">
								<Icon name="alert-triangle" size={11} />
								not downloaded yet
							</span>
						{:else if backupDone}
							<span class="badge badge-success" title="A copy of this wallet's config has been downloaded">
								<Icon name="check" size={11} />
								downloaded
							</span>
						{/if}
					</div>
					<p class="backup-copy">
						The backup describes the wallet — quorum and public keys — so any descriptor wallet can
						find your money again. It <strong>can't spend</strong>; spending always needs
						{data.multisig.threshold} of your keys. Store it with your seed backups.
					</p>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<a
							href="/api/wallets/multisig/{data.multisig.id}/caravan"
							class="btn btn-secondary btn-sm"
							download
							onclick={markBackupDownloaded}
						>
							Wallet config (JSON)
						</a>
						<a
							href="/api/wallets/multisig/{data.multisig.id}/coldcard"
							class="btn btn-secondary btn-sm"
							download
							onclick={markBackupDownloaded}
						>
							ColdCard file
						</a>
						<a
							href="/api/wallets/multisig/{data.multisig.id}/descriptor?download=1"
							class="btn btn-ghost btn-sm"
							download
							onclick={markBackupDownloaded}
						>
							Descriptor (.txt)
						</a>
						{#if data.role === 'owner'}
							<a
								href="/api/wallets/multisig/{data.multisig.id}/backup-pdf"
								class="btn btn-ghost btn-sm"
								download
								onclick={markBackupDownloaded}
							>
								<Icon name="shield" size={13} /> Printable backup (PDF)
							</a>
						{/if}
						{#if data.flags?.csv_export !== false}
							<a
								href="/api/wallets/multisig/{data.multisig.id}/history.csv"
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
					<div class="backup-notes">
						<p class="hw-caption">
							<strong>Wallet config</strong> — opens directly in Sparrow, Caravan and Unchained.
							· <strong>ColdCard file</strong> — put it on the microSD so the ColdCard (or
							Passport/Keystone/SeedSigner) recognizes the wallet before co-signing.
							· <strong>Descriptor</strong> — the raw text form, for Bitcoin Core and power users.
						</p>
						{#if data.descriptor}
							<div class="descriptor-line">
								<span class="hint">Descriptor:</span>
								<CopyText value={data.descriptor} truncate={18} />
							</div>
						{/if}
					</div>
				</section>
			{/if}
		{/if}

		<!-- ------------------------------------------- delete (quiet footer) -->
		<!-- Removing the wallet is owner-only (the delete action 404s otherwise). -->
		{#if data.role === 'owner'}
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
								This removes the multisig wallet from Heartwood — your keys keep the money, but
								Heartwood stops watching it. Make sure you have your backup file (every public
								key and the descriptor) and your signing devices — Heartwood can't recover it
								for you.
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
		{/if}
	</div>
</div>

<style>
	/* The Heartwood grove field needs a positioned ancestor; content rides
	   above it at z-index 1. Shared table/label/chip styles come from
	   $lib/styles/wallet-detail.css. */
	.hw-page {
		position: relative;
	}

	.hw-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
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
		gap: 7px;
		flex-wrap: wrap;
		margin: 18px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	.hw-sync-row {
		margin-top: 10px;
	}

	/* --- stale-key nudge: calm amber, hairline-bounded, no box --- */

	.keycheck-nudge {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-top: 32px;
		padding: 14px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		color: var(--attention);
	}

	.keycheck-nudge :global(svg) {
		margin-top: 2px;
		flex-shrink: 0;
	}

	.nudge-title {
		font-size: 13px;
		font-weight: 600;
	}

	.nudge-copy {
		margin-top: 3px;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
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

	.hw-caption strong {
		color: var(--text-muted);
		font-weight: 500;
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

	/* --- streamed-scan skeletons (cairn-vknb.2) ---
	   The balance/history/receive slice now streams in after the shell paints,
	   so these placeholders hold the layout for the brief window before it lands.
	   A soft shimmer over the hairline palette, no hard box. */
	.hw-skeleton {
		position: relative;
		overflow: hidden;
		border-radius: var(--radius-control, 8px);
		background: var(--hairline);
		color: transparent !important;
		user-select: none;
		pointer-events: none;
	}

	.hw-skeleton::after {
		content: '';
		position: absolute;
		inset: 0;
		transform: translateX(-100%);
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in srgb, var(--text-faint) 22%, transparent),
			transparent
		);
		animation: hw-shimmer 1.4s var(--ease, ease) infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.hw-skeleton::after {
			animation: none;
		}
	}

	@keyframes hw-shimmer {
		100% {
			transform: translateX(100%);
		}
	}

	.hw-skeleton-hero {
		display: inline-block;
		border-radius: 12px;
	}

	.hw-skeleton-line {
		display: inline-block;
		min-width: 160px;
		border-radius: 6px;
	}

	.hw-scan-loading {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-top: 40px;
	}

	.hw-skeleton-block {
		height: 148px;
		width: 100%;
	}

	.hw-skeleton-block-sm {
		height: 84px;
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

	/* Advanced disclosure (matches the multisig-new wizard's convention). */
	.hw-receive-advanced {
		margin-top: 4px;
	}

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

	.hw-receive-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
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

	/* --- keys --- */

	.key-rows {
		display: flex;
		flex-direction: column;
	}

	/* Registration is a genuine one-time blocker, so it keeps a little more
	   presence than a nudge — copper-tinted text over hairlines, still no box. */
	.register-callout {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 14px 0 4px;
		border-top: 1px solid var(--hairline);
	}

	.register-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: var(--attention);
	}

	.register-copy {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.register-copy strong {
		color: var(--text);
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

	/* --- speed up (RBF/CPFP) --- */

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

	/* --- addresses tab keeps the shared table; give it breathing room --- */

	.hw-table-section {
		display: flex;
		flex-direction: column;
	}

	.hw-table-section .chips {
		padding: 14px 0 10px;
	}

	.addr-verify-hint {
		padding: 0 0 10px;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-muted);
	}

	.addr-verify-hint strong {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.path-cell {
		white-space: nowrap;
	}

	.path-text {
		font-size: 12px;
	}

	.detail-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid var(--border-control);
		border-radius: 99px;
		padding: 3px 10px;
		color: var(--text-secondary);
		font: inherit;
		font-size: 11.5px;
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.detail-toggle :global(svg) {
		transition: transform 150ms var(--ease);
	}

	.detail-toggle.open :global(svg) {
		transform: rotate(180deg);
	}

	.detail-toggle:hover,
	.detail-toggle.open {
		color: var(--accent);
		border-color: var(--accent);
	}

	.addr-detail-row td {
		padding: 6px 14px 14px;
	}

	/* --- export config --- */

	.backup-copy {
		margin: 0;
		max-width: 640px;
	}

	.backup-notes {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.descriptor-line {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		min-width: 0;
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
		max-width: 460px;
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
</style>
