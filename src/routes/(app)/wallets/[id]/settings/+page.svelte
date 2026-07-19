<!--
	/wallets/[id]/settings — Tier-2 subpage (cairn-gt05.2, spec §2.2): rename,
	Download backup file, the full address list, and the demoted, confirmation-
	gated Danger block for removing the wallet from tracking.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import FeatureDisabled from '$lib/components/FeatureDisabled.svelte';
	import Term from '$lib/components/Term.svelte';
	import { DESCRIPTOR_TIP_SINGLE } from '$lib/termGlosses';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';

	let { data, form } = $props();

	// --- rename (friction ladder: trivial + reversible — zero dialogs) -------
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let nameValue = $state(data.wallet.name);
	let renaming = $state(false);
	let renamedFlash = $state(false);

	// --- backup download (optimistic overlay on the server-tracked flag) -----
	let downloadedNow = $state(false);
	const backupDone = $derived(data.backedUp || downloadedNow);
	function markBackupDownloaded() {
		downloadedNow = true;
	}

	// --- address list (moved from the detail page's "Addresses · N" tab) -----
	let addrFilter = $state<'used' | 'unused' | 'change'>('used');
	const usedAddrs = $derived(data.addresses.filter((a) => a.used));
	// Unused = the forward gap window on BOTH chains, receive first.
	const unusedAddrs = $derived(
		data.addresses.filter((a) => !a.used).toSorted((a, b) => Number(a.change) - Number(b.change))
	);
	// Change = the whole internal chain (m/1/*), used and upcoming (cairn-teyh).
	const changeAddrs = $derived(
		data.addresses.filter((a) => a.change).toSorted((a, b) => a.index - b.index)
	);
	const shownAddrs = $derived(
		addrFilter === 'used' ? usedAddrs : addrFilter === 'unused' ? unusedAddrs : changeAddrs
	);

	// --- address labels (cairn-nbsx) — optimistic-override idiom -------------
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

	function focusInput(node: HTMLInputElement) {
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

	// --- danger block (confirmation-gated) -----------------------------------
	let confirmDelete = $state(false);
	let deleting = $state(false);
</script>

<svelte:head>
	<title>Settings · {data.wallet.name} · Heartwood</title>
</svelte:head>

<div class="wallet-settings hw-page fade-in">
	<GroveField volume="present" />
	<div class="hw-content">
		<div class="eyebrow-row">
			<EyebrowBreadcrumb path={['Wallets', data.wallet.name]} current="Settings" />
		</div>

		<a class="back-link" href={`/wallets/${data.wallet.id}`}>
			<Icon name="chevron-left" size={14} /> Back to {data.wallet.name}
		</a>

		<h1 class="page-title">Wallet settings</h1>

		<!-- ------------------------------------------------------------ name -->
		<section class="hw-section" aria-label="Wallet name">
			<h2 class="hw-section-title">Name</h2>
			<form
				class="rename-row"
				method="POST"
				action="?/rename"
				use:enhance={() => {
					renaming = true;
					renamedFlash = false;
					return async ({ result, update }) => {
						renaming = false;
						if (result.type === 'success') {
							renamedFlash = true;
							setTimeout(() => (renamedFlash = false), 2000);
						}
						await update({ reset: false });
					};
				}}
			>
				<label class="sr-only" for="wallet-name">Wallet name</label>
				<input
					id="wallet-name"
					class="input"
					name="name"
					maxlength="60"
					bind:value={nameValue}
				/>
				<button class="btn btn-secondary btn-sm" disabled={renaming || nameValue.trim().length === 0}>
					{#if renaming}<span class="spinner"></span>{/if}
					Save
				</button>
				{#if renamedFlash}
					<span class="saved-note" role="status">
						<Icon name="check" size={13} strokeWidth={2.5} /> Saved
					</span>
				{/if}
			</form>
			{#if form?.renameError}
				<div class="form-error" role="alert">{form.renameError}</div>
			{/if}
		</section>

		<!-- --------------------------------------------------------- backup -->
		<section class="hw-section" id="backup" aria-label="Download backup file">
			<div class="hw-section-head">
				<h2 class="hw-section-title">Download backup file</h2>
				{#if backupDone}
					<span class="badge badge-success" title="A copy of this wallet's config has been downloaded">
						<Icon name="check" size={11} />
						downloaded
					</span>
				{/if}
			</div>
			<p class="backup-copy">
				A single-key wallet always rebuilds from your hardware device (just re-import its key),
				so this file is a convenience copy: it describes the wallet (public key and settings)
				for importing into Sparrow, Electrum, or back into Heartwood. It
				<strong>can't spend</strong>.
			</p>
			<div class="row backup-row">
				{#if data.flags?.wallet_config_export !== false}
					<a
						href="/api/wallets/{data.wallet.id}/config"
						class="btn btn-secondary btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Download backup file (JSON)
					</a>
					<a
						href="/api/wallets/{data.wallet.id}/descriptor"
						class="btn btn-ghost btn-sm"
						download
						onclick={markBackupDownloaded}
					>
						Descriptor (.txt)
					</a>
				{:else}
					<FeatureDisabled
						message="Wallet config export has been disabled by your administrator."
					/>
				{/if}
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
				Backup file — re-import the key into Heartwood, Sparrow or Electrum. <Term
					tip={DESCRIPTOR_TIP_SINGLE}>Descriptor</Term
				> — the raw text form, for Bitcoin Core and power users.
			</p>
			{#if data.wallet.xpub}
				<div class="xpub-line">
					<span class="hint">Public key (xpub):</span>
					<CopyText value={data.wallet.xpub} truncate={10} />
				</div>
			{/if}
		</section>

		<!-- ------------------------------------------------------ addresses -->
		<section class="hw-section" aria-label="Addresses">
			<h2 class="hw-section-title">Addresses · {data.addresses.length}</h2>
			{#if data.addresses.length === 0}
				<p class="hw-caption">
					No addresses to show yet — they appear once the wallet has synced with your node.
				</p>
			{:else}
				<div class="chips">
					<button
						type="button"
						class="chip"
						class:active={addrFilter === 'used'}
						aria-pressed={addrFilter === 'used'}
						onclick={() => (addrFilter = 'used')}
					>
						Used {usedAddrs.length}
					</button>
					<button
						type="button"
						class="chip"
						class:active={addrFilter === 'unused'}
						aria-pressed={addrFilter === 'unused'}
						onclick={() => (addrFilter = 'unused')}
					>
						Unused {unusedAddrs.length}
					</button>
					<button
						type="button"
						class="chip"
						class:active={addrFilter === 'change'}
						aria-pressed={addrFilter === 'change'}
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
										<td class="num">
											{#if addr.balance !== 0}
												<Amount sats={addr.balance} size="row" />
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
						<div class="form-error" role="alert">{addrLabelError}</div>
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
			{/if}
		</section>

		<!-- --------------------------------------------------------- danger -->
		<section class="danger-block" aria-label="Remove this wallet">
			{#if !confirmDelete}
				<button type="button" class="danger-trigger" onclick={() => (confirmDelete = true)}>
					Remove this wallet from Heartwood…
				</button>
				<p class="hw-caption">
					This only stops Heartwood tracking it; your funds are safe if you keep your backup.
				</p>
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
					<input type="hidden" name="confirmed" value="yes" />
					<p class="delete-backup-warning">
						<Icon name="alert-triangle" size={16} />
						<span>
							This removes the wallet from Heartwood — it only stops Heartwood tracking it. Your
							funds stay on the blockchain and are safe as long as you keep your backup and your
							signing device.
						</span>
					</p>
					{#if form?.deleteError}
						<div class="form-error" role="alert">{form.deleteError}</div>
					{/if}
					<div class="row" style="gap: 8px">
						<span class="confirm-text">Really remove?</span>
						<button class="btn btn-danger btn-sm" disabled={deleting}>
							{#if deleting}<span class="spinner"></span>{/if}
							Remove wallet
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
		</section>
	</div>
</div>

<style>
	.hw-page {
		position: relative;
	}

	.hw-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		max-width: var(--measure-reading);
	}

	.eyebrow-row {
		margin-bottom: 14px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		margin-bottom: 22px;
	}

	.back-link:hover {
		color: var(--accent);
	}

	.back-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.page-title {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.hw-section {
		border-top: 1px solid var(--hairline);
		margin-top: 36px;
		padding-top: 20px;
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

	.hw-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
		line-height: 1.6;
	}

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

	.rename-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.rename-row .input {
		max-width: 280px;
	}

	.saved-note {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--sage);
	}

	.backup-copy {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.6;
		max-width: 560px;
	}

	.backup-row {
		gap: 8px;
		flex-wrap: wrap;
	}

	.xpub-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 12.5px;
	}

	.chips {
		padding: 4px 0 8px;
	}

	.addr-label-input {
		font-size: 12px;
		padding: 3px 8px;
		width: 180px;
	}

	.addr-label-btn {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		text-align: left;
	}

	.addr-label-btn.has-label {
		color: var(--text-secondary);
		font-style: italic;
	}

	.addr-label-btn.has-label:hover {
		text-decoration: underline;
		text-decoration-style: dotted;
	}

	.addr-label-btn.add-label {
		color: var(--text-muted);
		opacity: 0.7;
	}

	.addr-label-btn.add-label:hover {
		color: var(--accent);
		opacity: 1;
	}

	.addr-label-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 3px;
	}

	.chg-chip {
		margin-left: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		background: var(--bg-input);
		padding: 1px 6px;
		border-radius: var(--radius-badge, 4px);
	}

	.change-note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.6;
		max-width: 620px;
	}

	.change-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	/* Danger: bottom of the page, demoted, red only here (spec §3 color rule). */
	.danger-block {
		border-top: 1px solid var(--hairline);
		margin-top: 48px;
		padding-top: 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.danger-trigger {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 13px;
		color: var(--error);
		opacity: 0.85;
		cursor: pointer;
	}

	.danger-trigger:hover {
		opacity: 1;
		text-decoration: underline;
	}

	.danger-trigger:focus-visible {
		outline: 2px solid var(--error);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.delete-confirm {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.delete-backup-warning {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.6;
		max-width: 560px;
	}

	.delete-backup-warning :global(svg) {
		color: var(--error);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.confirm-text {
		font-size: 13px;
		color: var(--text-secondary);
	}
</style>
