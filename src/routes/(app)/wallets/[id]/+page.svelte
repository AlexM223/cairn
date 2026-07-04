<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import TxStatusBadge from '$lib/components/TxStatusBadge.svelte';
	import { formatBtc, formatFeeRate, formatSats, timeAgo, truncateMiddle } from '$lib/format';
	import { SCRIPT_TYPE_LABELS } from '../labels';

	let { data, form } = $props();

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
	// parked mid-signing is never lost behind a tab.
	const inProgress = $derived(savedTxs.filter((t) => t.status !== 'completed'));
	let confirmTxId = $state<number | null>(null);
	let deletingTxId = $state<number | null>(null);

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
	const usedAddrs = $derived((data.scan?.addresses ?? []).filter((a) => a.used));
	// Unused = the forward gap window on the receive chain.
	const unusedAddrs = $derived(
		(data.scan?.addresses ?? []).filter((a) => !a.used && !a.change)
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

<div class="detail fade-in">
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
		<div class="row grow" style="gap: 12px; min-width: 0">
			<h1 class="page-title truncate">{data.wallet.name}</h1>
			<span class="badge badge-neutral">{SCRIPT_TYPE_LABELS[data.wallet.scriptType]}</span>
		</div>
		<a href="/wallets/{data.wallet.id}/send" class="btn btn-primary btn-sm">
			<Icon name="arrow-up-right" size={14} />
			Send
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
			</form>
		{/if}
	</div>
	<p class="hint watch-note">
		<Icon name="eye" size={12} />
		Watch-only · {truncateMiddle(data.wallet.xpub, 10, 8)}
	</p>

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

							{#if tx.status === 'completed' && tx.txid}
								<div class="saved-field">
									<span class="saved-label">Transaction</span>
									<a href="/explorer/tx/{tx.txid}" class="mono">
										{truncateMiddle(tx.txid, 10, 8)}
									</a>
								</div>
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

	.imported-banner {
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

	.banner-dismiss:focus-visible {
		opacity: 1;
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	.banner-dismiss:hover {
		opacity: 1;
	}

	.head {
		gap: 14px;
		flex-wrap: wrap;
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
		white-space: nowrap;
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

	/* --- top grid --- */

	.top-grid {
		display: grid;
		grid-template-columns: 1fr 1.2fr;
		gap: 14px;
		margin-bottom: 18px;
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

	@media (max-width: 480px) {
		.saved-time {
			margin-left: 0;
		}

		.saved-actions .grow {
			display: none;
		}
	}
</style>
