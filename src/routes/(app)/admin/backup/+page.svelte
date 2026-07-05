<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	type Summary = {
		usersAdded: number;
		usersSkipped: number;
		wallets: number;
		multisigs: number;
		addresses: number;
		labels: number;
		settings: number;
	};

	// --- Backup ---
	let passphrase = $state('');
	let confirm = $state('');
	let backingUp = $state(false);
	let backupError = $state<string | null>(null);

	async function downloadBackup() {
		backupError = null;
		if (passphrase.length < 8) {
			backupError = 'Choose a passphrase of at least 8 characters.';
			return;
		}
		if (passphrase !== confirm) {
			backupError = 'The passphrases do not match.';
			return;
		}
		backingUp = true;
		try {
			const res = await fetch('/api/admin/backup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ passphrase })
			});
			if (!res.ok) {
				const e = await res.json().catch(() => null);
				throw new Error(e?.error || 'Backup failed.');
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `cairn-backup-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			passphrase = '';
			confirm = '';
		} catch (e) {
			backupError = e instanceof Error ? e.message : 'Backup failed.';
		} finally {
			backingUp = false;
		}
	}

	// --- Restore ---
	let file = $state<File | null>(null);
	let restorePass = $state('');
	let restoring = $state(false);
	let restoreError = $state<string | null>(null);
	let summary = $state<Summary | null>(null);

	function onFile(e: Event) {
		file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
		summary = null;
		restoreError = null;
	}

	async function restore() {
		restoreError = null;
		summary = null;
		if (!file) {
			restoreError = 'Choose a backup file.';
			return;
		}
		if (!restorePass) {
			restoreError = 'Enter the backup passphrase.';
			return;
		}
		restoring = true;
		try {
			const text = await file.text();
			const res = await fetch('/api/admin/restore', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ passphrase: restorePass, backup: text })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Restore failed.');
			summary = body.summary;
			restorePass = '';
		} catch (e) {
			restoreError = e instanceof Error ? e.message : 'Restore failed.';
		} finally {
			restoring = false;
		}
	}
</script>

<svelte:head>
	<title>Backup — Admin — Cairn</title>
</svelte:head>

<div class="stack wrap fade-in">
	<div class="intro card card-pad">
		<Icon name="info" size={16} />
		<p>
			A backup captures your instance's <strong>config</strong> — accounts, wallet and multisig
			setups, settings, labels and the address book. It never contains passkeys, session tokens, or
			private keys (Cairn only ever holds public xpubs), so your bitcoin is safe regardless. Keep a
			recent backup as routine maintenance: if you ever lose access, spin up a fresh instance and
			restore it.
		</p>
	</div>

	<section class="card card-pad section">
		<span class="card-title">Download backup</span>
		<p class="hint">
			Encrypted with a passphrase you choose (AES-256-GCM). Store the passphrase safely — without it
			the backup can't be restored.
		</p>
		{#if backupError}<div class="form-error" role="alert">{backupError}</div>{/if}
		<div class="two-col">
			<div class="field">
				<label class="label" for="pp">Passphrase</label>
				<input class="input" id="pp" type="password" autocomplete="new-password" bind:value={passphrase} />
			</div>
			<div class="field">
				<label class="label" for="pp2">Confirm passphrase</label>
				<input class="input" id="pp2" type="password" autocomplete="new-password" bind:value={confirm} />
			</div>
		</div>
		<div class="actions">
			<button class="btn btn-primary" onclick={downloadBackup} disabled={backingUp}>
				{#if backingUp}<span class="spinner"></span>{:else}<Icon name="arrow-down-left" size={15} />{/if}
				Download backup
			</button>
		</div>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Restore</span>
		<p class="hint">
			Restore is additive: existing accounts (matched by email) are left untouched, and imported
			accounts arrive without passkeys — each owner reclaims their account by adding a passkey on the
			normal sign-in screen.
		</p>
		{#if restoreError}<div class="form-error" role="alert">{restoreError}</div>{/if}
		{#if summary}
			<div class="saved-note" role="status">
				Restored {summary.usersAdded} account{summary.usersAdded === 1 ? '' : 's'}
				({summary.usersSkipped} already existed), {summary.wallets} wallet{summary.wallets === 1
					? ''
					: 's'}, {summary.multisigs} multisig{summary.multisigs === 1 ? '' : 's'}, {summary.addresses}
				saved address{summary.addresses === 1 ? '' : 'es'}, {summary.labels} label{summary.labels === 1
					? ''
					: 's'}, and {summary.settings} setting{summary.settings === 1 ? '' : 's'}.
			</div>
		{/if}
		<div class="field">
			<label class="label" for="file">Backup file</label>
			<input class="input file" id="file" type="file" accept="application/json,.json" onchange={onFile} />
		</div>
		<div class="field" style="max-width: 320px">
			<label class="label" for="rpp">Backup passphrase</label>
			<input class="input" id="rpp" type="password" autocomplete="off" bind:value={restorePass} />
		</div>
		<div class="actions">
			<button class="btn btn-secondary" onclick={restore} disabled={restoring}>
				{#if restoring}<span class="spinner"></span>{/if}
				Restore from backup
			</button>
		</div>
	</section>
</div>

<style>
	.wrap {
		gap: 14px;
		max-width: 640px;
	}

	.intro {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.55;
	}

	.intro strong {
		color: var(--text);
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.two-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	@media (max-width: 560px) {
		.two-col {
			grid-template-columns: 1fr;
		}
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.file {
		padding: 7px 10px;
	}

	.saved-note {
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
		line-height: 1.5;
	}
</style>
