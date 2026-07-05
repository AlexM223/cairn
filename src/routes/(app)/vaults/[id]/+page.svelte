<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatBtc, formatSats, timeAgo, truncateMiddle } from '$lib/format';
	import KeyCategoryIcon from '../_components/KeyCategoryIcon.svelte';
	import KeyHealthRow from '../_components/KeyHealthRow.svelte';
	import AddressScriptDetails from '../_components/AddressScriptDetails.svelte';
	import { KEY_CATEGORY_LABELS, DEVICE_LABELS, VAULT_SCRIPT_LABELS } from '../labels';

	let { data, form } = $props();

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
	let retrying = $state(false);
	let tab = $state<'transactions' | 'addresses'>('transactions');
	let addrFilter = $state<'used' | 'unused'>('used');

	const receive = $derived(form?.receive ?? data.receive);

	// Backup nudge: gentle reminder until the first download happens.
	let backupDone = $state(true); // optimistic until localStorage is checked
	$effect(() => {
		backupDone = localStorage.getItem(`cairn.vault.backup.${data.vault.id}`) === 'done';
	});
	function markBackupDownloaded() {
		localStorage.setItem(`cairn.vault.backup.${data.vault.id}`, 'done');
		backupDone = true;
	}

	// ColdCard-family devices refuse to sign for vaults they haven't registered
	// (via the setup file on microSD). Track a per-key "I've done this"
	// acknowledgement locally and nag gently until then.
	function needsRegistration(deviceType: string | null): boolean {
		return deviceType === 'coldcard' || deviceType === 'qr';
	}
	let registeredAcks = $state<Record<number, boolean>>({});
	$effect(() => {
		const acks: Record<number, boolean> = {};
		for (const k of data.vault.keys) {
			if (needsRegistration(k.deviceType)) {
				acks[k.id] =
					localStorage.getItem(`cairn.vault.registered.${data.vault.id}.${k.id}`) === 'done';
			}
		}
		registeredAcks = acks;
	});
	function markRegistered(keyId: number) {
		localStorage.setItem(`cairn.vault.registered.${data.vault.id}.${keyId}`, 'done');
		registeredAcks = { ...registeredAcks, [keyId]: true };
	}
	const unregisteredKeys = $derived(
		data.vault.keys.filter((k) => needsRegistration(k.deviceType) && !registeredAcks[k.id])
	);

	const usedAddrs = $derived((data.detail?.addresses ?? []).filter((a) => a.used));
	// Unused = the forward gap window on the receive chain.
	const unusedAddrs = $derived(
		(data.detail?.addresses ?? []).filter((a) => !a.used && a.chain === 0)
	);
	const shownAddrs = $derived(addrFilter === 'used' ? usedAddrs : unusedAddrs);

	// --- address transparency (cairn-h73) ---
	// When every key was created at the same account path, each address has ONE
	// unambiguous full path to show. When key paths differ (mixed devices),
	// Caravan's convention applies: show the shared /chain/index suffix (the
	// "braid" path) and list each key's full path in the details disclosure.
	const sharedBasePath = $derived(
		data.vault.keys.length > 0 &&
			data.vault.keys[0].path !== 'm' &&
			data.vault.keys.every((k) => k.path === data.vault.keys[0].path)
			? data.vault.keys[0].path
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
	// (that's the Casa pattern) — but not during a vault's first week, when the
	// wizard's own cross-checks are still fresh and a nag would just be noise.
	const vaultAgeMs = $derived(Date.now() - Date.parse(data.vault.createdAt));
	const staleKeys = $derived(
		data.vault.keys.filter((k) => {
			const ts = keyVerifiedAt(k);
			if (!ts) return vaultAgeMs > 7 * 24 * 60 * 60 * 1000;
			return Date.now() - Date.parse(ts) > SIX_MONTHS_MS;
		})
	);

	// The reminder is dismissible per vault per half-year window: dismissing it
	// in 2026H1 brings it back in 2026H2 — periodic by construction.
	function checkWindowStamp(): string {
		const now = new Date();
		return `${now.getFullYear()}H${now.getMonth() < 6 ? 1 : 2}`;
	}
	let nudgeDismissed = $state(true); // optimistic until localStorage is checked
	$effect(() => {
		nudgeDismissed =
			localStorage.getItem(`cairn.vault.keycheck.${data.vault.id}.${checkWindowStamp()}`) ===
			'dismissed';
	});
	function dismissNudge() {
		localStorage.setItem(
			`cairn.vault.keycheck.${data.vault.id}.${checkWindowStamp()}`,
			'dismissed'
		);
		nudgeDismissed = true;
	}
	function handleKeyVerified(keyId: number, ts: string) {
		verifiedOverrides = { ...verifiedOverrides, [keyId]: ts };
	}

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
	<title>{data.vault.name} — Cairn</title>
</svelte:head>

<div class="detail fade-in">
	<a href="/vaults" class="back-link">
		<Icon name="chevron-left" size={14} />
		Vaults
	</a>

	{#if data.created && !createdDismissed}
		<div class="created-banner" role="status">
			<Icon name="check" size={15} />
			<span class="grow">
				Vault created — fund it with a small test amount first, and keep your backup file safe.
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

	<!-- Header -->
	<div class="head row">
		<div class="row grow" style="gap: 12px; min-width: 0">
			<h1 class="page-title truncate">{data.vault.name}</h1>
			<span class="badge badge-accent quorum-badge">
				<Icon name="shield" size={12} />
				{data.vault.threshold} of {data.vault.keys.length}
			</span>
			<span class="badge badge-neutral">{VAULT_SCRIPT_LABELS[data.vault.scriptType]}</span>
		</div>
		<a href="/vaults/{data.vault.id}/send" class="btn btn-primary btn-sm">
			<Icon name="arrow-up-right" size={14} />
			Send
		</a>
		<a href="#backup" class="btn btn-secondary btn-sm backup-btn">
			<Icon name="arrow-down-left" size={14} />
			Download backup
			{#if !backupDone}
				<span class="backup-dot" title="No backup downloaded yet"></span>
			{/if}
		</a>
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
				class="row"
				style="gap: 8px"
				use:enhance={() => {
					deleting = true;
					return async ({ update }) => {
						deleting = false;
						await update();
					};
				}}
			>
				<span class="confirm-text">Really delete? Your keys keep the money — but Cairn stops watching it.</span>
				<button class="btn btn-danger btn-sm" disabled={deleting}>
					{#if deleting}<span class="spinner"></span>{/if}
					Delete vault
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-sm"
					onclick={() => (confirmDelete = false)}
					disabled={deleting}
				>
					Cancel
				</button>
			</form>
		{/if}
	</div>
	<p class="hint watch-note">
		<Icon name="eye" size={12} />
		Watch-only vault · <Term
			tip="Spending needs signatures from that many of your keys. Cairn tracks the balance and builds transactions, but only your keys can approve them."
			>{data.vault.threshold} of {data.vault.keys.length} keys required to spend</Term
		>
	</p>

	{#if staleKeys.length > 0 && !nudgeDismissed}
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

	<!-- Keys -->
	<section class="card card-pad keys-card">
		<div class="row" style="gap: 8px">
			<Icon name="shield" size={15} />
			<span class="card-title grow">
				{data.vault.threshold} of {data.vault.keys.length} keys required to spend
			</span>
		</div>
		<div class="key-chips">
			{#each data.vault.keys as key (key.id)}
				<span class="key-chip" title="{KEY_CATEGORY_LABELS[key.category]}{key.path !== 'm' ? ` · ${key.path}` : ''}">
					<KeyCategoryIcon category={key.category} size={14} />
					<span class="key-chip-name truncate">{key.name}</span>
					{#if key.deviceType}
						<span class="key-chip-sub">{DEVICE_LABELS[key.deviceType]}</span>
					{/if}
					{#if key.fingerprint !== '00000000'}
						<span class="key-chip-sub mono">{key.fingerprint}</span>
					{/if}
					{#if key.category === 'recovery'}
						<span class="key-chip-tag" title="For emergencies only — you won't use this key day to day.">
							emergency
						</span>
					{/if}
					{#if needsRegistration(key.deviceType) && !registeredAcks[key.id]}
						<span class="key-chip-flag" title="This device refuses to sign for vaults it hasn't registered — see below.">
							Registered?
						</span>
					{/if}
				</span>
			{/each}
		</div>

		<div class="key-health">
			<div class="key-health-head">
				<span class="key-health-title">
					<Term
						tip="Devices die, PINs get forgotten, and a device restored from the wrong seed keeps working for everything except this vault. A quick check proves each key still derives this vault — before you need it to."
						>Key checks</Term
					>
				</span>
				<span class="hint">Confirm each key still works now and then.</span>
			</div>
			{#each data.vault.keys as key (key.id)}
				<KeyHealthRow
					vaultId={data.vault.id}
					keyInfo={{
						id: key.id,
						name: key.name,
						deviceType: key.deviceType,
						fingerprint: key.fingerprint,
						path: key.path,
						lastVerifiedAt: keyVerifiedAt(key)
					}}
					scriptType={data.vault.scriptType}
					receiveAddress={receive?.address ?? null}
					onVerified={handleKeyVerified}
				/>
			{/each}
		</div>

		{#if unregisteredKeys.length > 0}
			<div class="register-callout">
				<span class="register-title">
					<Icon name="alert-triangle" size={14} />
					One-time step: teach {unregisteredKeys.length === 1
						? `"${unregisteredKeys[0].name}"`
						: 'these devices'} this vault
				</span>
				<p class="register-copy">
					A ColdCard (and SeedSigner/Passport) <strong>only signs for vaults it knows</strong>
					— it will refuse this one until registered. Download the registration file, copy it
					to the microSD card, then on the ColdCard: <strong>Settings → Multisig Wallets →
					Import from SD</strong>. The device shows this vault's {data.vault.threshold}-of-{data.vault.keys.length}
					quorum and keys — confirm, and it's done.
				</p>
				<div class="row" style="gap: 8px; flex-wrap: wrap">
					<a href="/api/vaults/{data.vault.id}/coldcard" class="btn btn-secondary btn-sm" download>
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

	{#if data.scanError}
		<!-- ------------------------------------------- scan failed -->
		<div class="card card-pad scan-error">
			<Icon name="alert-triangle" size={18} />
			<div class="grow">
				<div style="font-weight: 500">Can't reach the vault scanner</div>
				<div class="hint">{data.scanError}</div>
			</div>
			<button type="button" class="btn btn-secondary btn-sm" onclick={retry} disabled={retrying}>
				{#if retrying}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
				Retry
			</button>
		</div>
	{:else if data.detail}
		<div class="top-grid">
			<!-- ------------------------------------------- balance hero -->
			<section class="card card-pad balance-card">
				<span class="overline">Confirmed balance</span>
				<div class="balance-line">
					<span
						class="hero-number balance-btc"
						title="{formatSats(data.detail.balance.confirmed)} sats"
					>
						{formatBtc(data.detail.balance.confirmed)}
					</span>
					<span class="balance-unit">BTC</span>
				</div>
				{#if data.detail.balance.unconfirmed !== 0}
					<span class="badge badge-warning" style="align-self: flex-start">
						<Icon name="clock" size={12} />
						{data.detail.balance.unconfirmed > 0 ? '+' : ''}{formatBtc(
							data.detail.balance.unconfirmed
						)} BTC pending
					</span>
				{/if}
				<span class="hint tabular">≈ {formatSats(data.detail.balance.confirmed)} sats</span>
			</section>

			<!-- ------------------------------------------- receive -->
			<section class="card card-pad receive-card">
				<div class="row" style="gap: 8px">
					<Icon name="arrow-down-left" size={15} />
					<span class="card-title grow">Receive</span>
					{#if receive}
						<span class="hint mono">0/{receive.index}</span>
					{/if}
				</div>
				{#if receive}
					<div class="receive-body">
						<img
							class="qr"
							src={receive.qr}
							alt="QR code for {receive.address}"
							width="110"
							height="110"
						/>
						<div class="receive-meta">
							<div class="receive-addr">
								<CopyText value={receive.address} truncate={13} />
							</div>
							<span class="hint">
								Before a large deposit, cross-check this address in another tool (Sparrow can
								open your backup file) — two tools agreeing proves the vault is built from
								your keys alone.
							</span>
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
									{#if generating}<span class="spinner"></span>{:else}<Icon
											name="refresh"
											size={13}
										/>{/if}
									Generate next address
								</button>
							</form>
						</div>
					</div>
				{/if}
			</section>
		</div>

		<!-- ------------------------------------------- backup / export -->
		<section class="card card-pad backup-card" id="backup">
			<div class="row" style="gap: 8px">
				<Icon name="arrow-down-left" size={15} />
				<span class="card-title grow">
					<Term
						tip="Save this file somewhere safe. It's how you recover this vault in another wallet app if needed."
						>Download backup</Term
					>
				</span>
				{#if !backupDone}
					<span class="badge badge-warning">
						<Icon name="alert-triangle" size={11} />
						not downloaded yet
					</span>
				{/if}
			</div>
			<p class="backup-copy">
				The backup describes the vault — quorum and public keys — so any descriptor wallet can
				find your money again. It <strong>can't spend</strong>; spending always needs
				{data.vault.threshold} of your keys. Store it with your seed backups.
			</p>
			<div class="row" style="gap: 8px; flex-wrap: wrap">
				<a
					href="/api/vaults/{data.vault.id}/caravan"
					class="btn btn-primary btn-sm"
					download
					onclick={markBackupDownloaded}
				>
					Wallet config (JSON)
				</a>
				<a
					href="/api/vaults/{data.vault.id}/coldcard"
					class="btn btn-secondary btn-sm"
					download
					onclick={markBackupDownloaded}
				>
					ColdCard file
				</a>
				<a
					href="/api/vaults/{data.vault.id}/descriptor?download=1"
					class="btn btn-ghost btn-sm"
					download
					onclick={markBackupDownloaded}
				>
					Descriptor (.txt)
				</a>
			</div>
			<div class="backup-notes">
				<span class="hint">
					<strong>Wallet config</strong> — opens directly in Sparrow, Caravan and Unchained.
					· <strong>ColdCard file</strong> — put it on the microSD so the ColdCard (or
					Passport/Keystone/SeedSigner) recognizes the vault before co-signing.
					· <strong>Descriptor</strong> — the raw text form, for Bitcoin Core and power users.
				</span>
				<div class="descriptor-line">
					<span class="hint">Descriptor:</span>
					<CopyText value={data.descriptor} truncate={18} />
				</div>
			</div>
		</section>

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
				<span class="tab-count">{data.detail.history.length}</span>
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
				<span class="tab-count">{data.detail.addresses.length}</span>
			</button>
		</div>

		{#if tab === 'transactions'}
			<section class="card">
				{#if data.detail.history.length === 0}
					<div class="empty-state">
						<Icon name="activity" size={22} />
						<span class="empty-title">No transactions yet</span>
						<span>
							Send a small test amount to the receive address above — it'll show up here once
							the network sees it.
						</span>
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
								{#each data.detail.history as tx (tx.txid)}
									<tr>
										<td>
											<a href="/explorer/tx/{tx.txid}" class="mono">
												{truncateMiddle(tx.txid, 8, 8)}
											</a>
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
												<span class="badge badge-warning">
													<Icon name="clock" size={11} />
													pending
												</span>
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
		{:else}
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
					<p class="addr-verify-hint">
						Every address here is built from your {data.vault.keys.length} public keys alone —
						open <strong>Details</strong> on any row for the exact script and derivation paths,
						so you can verify this address on any other wallet tool.
					</p>
					<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Path</th>
									<th>Address</th>
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
													tip="Each of this vault's keys uses its own base path, so only this receive/change suffix is shared — open Details for every key's full path."
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
										<td class="num" title="{formatSats(addr.balance)} sats">
											{#if addr.balance !== 0}
												{formatBtc(addr.balance)}
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
											<td colspan="5">
												<AddressScriptDetails
													vaultId={data.vault.id}
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
								Rows marked <span class="chg-chip">change</span> are this vault's internal
								addresses. When you spend, whatever isn't sent to the recipient comes back to
								one of these — same keys, same {data.vault.threshold}-of-{data.vault.keys.length}
								quorum, just a separate branch so payments you receive stay apart from your own
								leftovers. Seeing them here is normal; that money never left the vault.
							</span>
						</p>
					{/if}
				{/if}
			</section>
		{/if}
	{/if}
</div>

<style>
	.detail {
		display: flex;
		flex-direction: column;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-secondary);
		margin-bottom: 14px;
		align-self: flex-start;
	}

	.back-link:hover {
		color: var(--accent);
	}

	.created-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		margin-bottom: 16px;
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
	}

	.banner-dismiss {
		display: flex;
		align-items: center;
		background: none;
		border: none;
		color: inherit;
		cursor: pointer;
		padding: 2px;
		opacity: 0.7;
	}

	.banner-dismiss:hover,
	.banner-dismiss:focus-visible {
		opacity: 1;
	}

	.head {
		gap: 10px;
		flex-wrap: wrap;
	}

	.quorum-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.backup-btn {
		position: relative;
	}

	.backup-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warning);
		flex-shrink: 0;
	}

	.watch-note {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin: 6px 0 18px;
	}

	.delete-trigger:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	.confirm-text {
		font-size: 12.5px;
		color: var(--error);
	}

	.scan-error {
		display: flex;
		align-items: center;
		gap: 14px;
		color: var(--warning);
	}

	.scan-error .hint {
		color: var(--text-muted);
	}

	/* --- keys --- */

	.keys-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 14px;
	}

	.key-chips {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.key-chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 6px 11px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: 99px;
		font-size: 12.5px;
		color: var(--accent);
		max-width: 100%;
	}

	.key-chip-name {
		color: var(--text);
		font-weight: 500;
	}

	.key-chip-sub {
		color: var(--text-muted);
		font-size: 11px;
	}

	.key-chip-tag {
		font-size: 10.5px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 99px;
		padding: 1px 7px;
	}

	.key-chip-flag {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--warning);
		background: var(--warning-muted, rgba(230, 180, 80, 0.12));
		border-radius: 99px;
		padding: 1px 7px;
	}

	.register-callout {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 13px 14px;
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.35);
		border-radius: var(--radius-control);
	}

	.register-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
	}

	.register-copy {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.register-copy strong {
		color: var(--text);
	}

	/* --- top grid --- */

	.top-grid {
		display: grid;
		grid-template-columns: 1fr 1.2fr;
		gap: 14px;
		margin-bottom: 14px;
	}

	.top-grid > :global(*) {
		min-width: 0;
	}

	@media (max-width: 860px) {
		.top-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 480px) {
		.receive-body {
			flex-direction: column;
			align-items: center;
		}
	}

	.balance-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.balance-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.balance-btc {
		font-size: 40px;
	}

	.balance-unit {
		font-size: 14px;
		color: var(--text-muted);
	}

	.receive-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.receive-body {
		display: flex;
		gap: 16px;
		align-items: flex-start;
	}

	.qr {
		flex-shrink: 0;
		border-radius: var(--radius-control);
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		padding: 6px;
	}

	.receive-meta {
		display: flex;
		flex-direction: column;
		gap: 9px;
		min-width: 0;
		flex: 1;
	}

	.receive-addr {
		font-size: 13.5px;
	}

	/* --- backup --- */

	.backup-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 18px;
		border-color: rgba(232, 147, 90, 0.3);
	}

	.backup-copy {
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.backup-copy strong {
		color: var(--text);
	}

	.backup-notes {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--border-subtle);
		padding-top: 10px;
	}

	.backup-notes .hint {
		line-height: 1.6;
	}

	.backup-notes strong {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.descriptor-line {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		min-width: 0;
	}

	/* --- tabs --- */

	.tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid var(--border-subtle);
		margin-bottom: 14px;
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 8px 14px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		color: var(--text-secondary);
		font: inherit;
		font-size: 13.5px;
		font-weight: 500;
		cursor: pointer;
		transition: color 120ms var(--ease);
	}

	.tab:hover {
		color: var(--text);
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.tab-count {
		font-size: 11px;
		padding: 1px 7px;
		border-radius: 99px;
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.tab.active .tab-count {
		background: var(--accent-muted);
		color: var(--accent);
	}

	/* --- transactions --- */

	.dir {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}

	.dir.in,
	.delta.in {
		color: var(--success);
	}

	.dir.out,
	.delta.out {
		color: var(--error);
	}

	.delta {
		font-weight: 500;
	}

	/* --- addresses --- */

	.chips {
		display: flex;
		gap: 8px;
		padding: 14px 14px 4px;
	}

	.chip {
		padding: 4px 12px;
		border-radius: 99px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.chip:hover {
		color: var(--text);
	}

	.chip.active {
		background: var(--accent-muted);
		border-color: transparent;
		color: var(--accent);
	}

	.addr-cell {
		max-width: 320px;
	}

	/* --- address transparency (cairn-h73) --- */

	.addr-verify-hint {
		padding: 10px 14px 0;
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

	.chg-chip {
		display: inline-block;
		font-size: 10.5px;
		font-weight: 500;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 99px;
		padding: 1px 7px;
		margin-left: 6px;
		vertical-align: middle;
	}

	.detail-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid var(--border);
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

	.change-note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px 14px;
		border-top: 1px solid var(--border-subtle);
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-muted);
	}

	.change-note :global(svg) {
		margin-top: 3px;
	}

	.change-note .chg-chip {
		margin-left: 0;
	}

	/* --- key health (cairn-hvp) --- */

	.keycheck-nudge {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		margin-bottom: 14px;
		background: var(--warning-muted, rgba(230, 180, 80, 0.1));
		border: 1px solid rgba(230, 180, 80, 0.35);
		border-radius: var(--radius-control);
		color: var(--warning);
	}

	.keycheck-nudge :global(svg) {
		margin-top: 2px;
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

	.key-health {
		display: flex;
		flex-direction: column;
	}

	.key-health-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding-bottom: 8px;
	}

	.key-health-title {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}
</style>
