<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatBtc, formatSats, timeAgo, truncateMiddle } from '$lib/format';
	import KeyCategoryIcon from '../_components/KeyCategoryIcon.svelte';
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
					<div class="table-wrap">
						<table class="table">
							<thead>
								<tr>
									<th>Path</th>
									<th>Address</th>
									<th class="num">Balance</th>
									<th class="num">Txs</th>
								</tr>
							</thead>
							<tbody>
								{#each shownAddrs as addr (addr.address)}
									<tr>
										<td class="mono text-muted">{addr.chain}/{addr.index}</td>
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
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
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
</style>
