<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '$lib/components/Banner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo, formatDateTime } from '$lib/format';

	let { data, form } = $props();

	// --- Scheduled backups (cairn-ivae.3) ---
	// svelte-ignore state_referenced_locally — seeds the editable fields
	let schedEnabled = $state(data.schedule.enabled);
	// svelte-ignore state_referenced_locally
	let schedInterval = $state(data.schedule.interval);
	// svelte-ignore state_referenced_locally
	let schedPath = $state(data.schedule.path);
	const schedLastRunUnix = $derived(
		data.schedule.lastRunAt ? Math.floor(Date.parse(data.schedule.lastRunAt) / 1000) : null
	);

	type Summary = {
		usersAdded: number;
		usersSkipped: number;
		wallets: number;
		multisigs: number;
		shares: number;
		addresses: number;
		labels: number;
		settings: number;
		// Setting keys the backup carried that were withheld — security-posture
		// keys (registration mode, SSRF guard, auth/instance mode, …) are never
		// silently adopted from an import (cairn-0dg4). Empty when nothing was withheld.
		settingsSkipped: string[];
		// One single-use recovery code per newly-restored account (cairn-j1q9) —
		// shown once here so this admin can hand each owner a way back in. A
		// restored account has no password and no passkeys (backups never
		// contain credentials), so this is its ONLY path to sign in.
		reclaimCodes: { email: string; code: string }[];
	};

	// How stale before we warn: 30 days without a fresh instance backup. Also
	// treats "never backed up" as stale.
	const STALE_DAYS = 30;

	// The last instance backup, as unix seconds (or null when never done).
	// Seeded from the server load and refreshed optimistically after a successful
	// download (via `justBackedUpUnix`) so the banner clears without a reload.
	let justBackedUpUnix = $state<number | null>(null);
	const lastBackupUnix = $derived<number | null>(
		justBackedUpUnix ??
			(data.lastInstanceBackupAt ? Math.floor(Date.parse(data.lastInstanceBackupAt) / 1000) : null)
	);
	const backupStale = $derived(
		lastBackupUnix === null ||
			Date.now() / 1000 - lastBackupUnix > STALE_DAYS * 24 * 60 * 60
	);

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
			// The server just recorded last_instance_backup_at — reflect it now so
			// the staleness warning clears without a page reload.
			justBackedUpUnix = Math.floor(Date.now() / 1000);
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
	<title>Backup — Health — Heartwood</title>
</svelte:head>

<div class="stack wrap fade-in">
	<div class="intro">
		<Icon name="info" size={16} />
		<p>
			A backup captures your instance's <strong>config</strong> — accounts, wallet and multisig
			setups, settings, labels and the address book. It never contains passkeys, session tokens, or
			private keys (Heartwood only ever holds public xpubs), so your bitcoin is safe regardless.
			Keep a recent backup as routine maintenance: if you ever lose access, spin up a fresh
			instance and restore it.
		</p>
	</div>

	<section class="hw-section section" class:stale={backupStale}>
		<div class="section-head">
			<span class="hw-title">Download backup</span>
			{#if backupStale}
				<span class="badge badge-warning">
					<Icon name="alert-triangle" size={11} />
					{lastBackupUnix === null ? 'Never backed up' : 'Backup is out of date'}
				</span>
			{:else}
				<span class="badge badge-neutral">
					<Icon name="check" size={11} />
					Backed up {timeAgo(lastBackupUnix)}
				</span>
			{/if}
		</div>

		{#if backupStale}
			<div class="stale-note" role="status">
				<Icon name="alert-triangle" size={16} />
				<div>
					<strong>Regular backups protect your users' wallet configurations.</strong>
					{#if lastBackupUnix === null}
						This instance has never been backed up — download one now and keep it somewhere safe.
					{:else}
						The last backup was {timeAgo(lastBackupUnix)} ({formatDateTime(lastBackupUnix)}). Download a
						fresh one to stay current.
					{/if}
				</div>
			</div>
		{:else}
			<p class="hint">
				Last backup: {formatDateTime(lastBackupUnix)} ({timeAgo(lastBackupUnix)}).
			</p>
		{/if}

		<p class="hint">
			Encrypted with a passphrase you choose (AES-256-GCM). Store the passphrase safely — without it
			the backup can't be restored.
		</p>
		{#if backupError}<Banner variant="error">{backupError}</Banner>{/if}
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

	<section class="hw-section section">
		<div class="section-head">
			<span class="hw-title">Automatic backups</span>
			{#if data.schedule.enabled}
				{#if data.schedule.lastError}
					<span class="badge badge-error">
						<Icon name="alert-triangle" size={11} />
						Last run failed
					</span>
				{:else if schedLastRunUnix !== null}
					<span class="badge badge-neutral">
						<Icon name="check" size={11} />
						Last ran {timeAgo(schedLastRunUnix)}
					</span>
				{:else}
					<span class="badge badge-neutral">Waiting for first run</span>
				{/if}
			{/if}
		</div>
		<p class="hint">
			Write an encrypted backup to a folder on the server automatically — a mounted drive, NAS
			path, or synced folder. Uses the same encrypted format as the download above; scheduled runs
			also refresh the "last backup" status. The newest 30 files are kept.
		</p>

		{#if data.schedule.enabled && data.schedule.lastError}
			<Banner variant="error">
				The last scheduled backup failed: {data.schedule.lastError}
			</Banner>
		{/if}
		{#if form?.error}<Banner variant="error">{form.error}</Banner>{/if}
		{#if form?.scheduleSaved}
			<Banner variant="success">Scheduled backup settings saved.</Banner>
		{/if}

		<form method="POST" action="?/saveSchedule" class="section" use:enhance>
			<label class="check-row">
				<input type="checkbox" name="enabled" bind:checked={schedEnabled} />
				<span>Back up automatically</span>
			</label>

			{#if schedEnabled}
				<div class="two-col">
					<div class="field">
						<label class="label" for="sched-interval">How often</label>
						<select class="input" id="sched-interval" name="interval" bind:value={schedInterval}>
							<option value="daily">Daily</option>
							<option value="weekly">Weekly</option>
						</select>
					</div>
					<div class="field">
						<label class="label" for="sched-path">Destination folder on the server</label>
						<input
							class="input"
							id="sched-path"
							name="path"
							type="text"
							placeholder="/data/backups"
							bind:value={schedPath}
						/>
					</div>
				</div>
				<div class="two-col">
					<div class="field">
						<label class="label" for="sched-pp">
							Encryption passphrase{data.schedule.hasPassphrase ? ' (blank = keep current)' : ''}
						</label>
						<input class="input" id="sched-pp" name="passphrase" type="password" autocomplete="new-password" />
					</div>
					<div class="field">
						<label class="label" for="sched-pp2">Confirm passphrase</label>
						<input class="input" id="sched-pp2" name="confirm" type="password" autocomplete="new-password" />
					</div>
				</div>
				<p class="hint">
					Store the passphrase safely — a scheduled backup file can't be restored without it.
				</p>
			{:else}
				<!-- Keep the stored values submitted so toggling off doesn't wipe them. -->
				<input type="hidden" name="interval" value={schedInterval} />
				<input type="hidden" name="path" value={schedPath} />
			{/if}

			<div class="actions">
				<button class="btn btn-secondary">Save schedule</button>
			</div>
		</form>
	</section>

	<section class="hw-section section">
		<span class="hw-title">Restore</span>
		<p class="hint">
			Restore is additive: existing accounts (matched by email) are left untouched. Imported accounts
			arrive with no password and no passkeys — each gets a single-use recovery code below that you
			hand its owner out-of-band; they redeem it at the recover-access screen to sign back in.
		</p>
		{#if restoreError}<Banner variant="error">{restoreError}</Banner>{/if}
		{#if summary}
			<Banner variant="success">
				Restored {summary.usersAdded} account{summary.usersAdded === 1 ? '' : 's'}
				({summary.usersSkipped} already existed), {summary.wallets} wallet{summary.wallets === 1
					? ''
					: 's'}, {summary.multisigs} multisig{summary.multisigs === 1 ? '' : 's'}, {summary.shares}
					shared-wallet link{summary.shares === 1 ? '' : 's'}, {summary.addresses}
				saved address{summary.addresses === 1 ? '' : 'es'}, {summary.labels} label{summary.labels === 1
					? ''
					: 's'}, and {summary.settings} setting{summary.settings === 1 ? '' : 's'}.
			</Banner>
			{#if summary.reclaimCodes.length > 0}
				<div style="margin-top: 8px">
					<Banner variant="success">
						<strong>Recovery codes — shown once, save them now:</strong>
						<ul class="reclaim-codes">
							{#each summary.reclaimCodes as rc (rc.email)}
								<li><span class="mono">{rc.code}</span> — {rc.email}</li>
							{/each}
						</ul>
						Send each code to its owner out-of-band. They redeem it at
						<code>/recover</code> to set a new passkey or password and sign back in.
					</Banner>
				</div>
			{/if}
			{#if summary.settingsSkipped.length > 0}
				<div style="margin-top: 8px">
					<Banner variant="warning">
						<strong>Not restored (security-sensitive):</strong>
						{summary.settingsSkipped.join(', ')}. These control this instance's auth/security posture
						and are never adopted from an imported backup — set them yourself in Admin → Settings if
						that was intended.
					</Banner>
				</div>
			{/if}
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
		gap: 0;
		max-width: 640px;
	}

	/* Lead note above the first hairline — no box. */
	.intro {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.55;
		padding-bottom: 22px;
		/* The first hw-section renders no top rule; this closes the intro. */
		border-bottom: 1px solid var(--hairline);
		margin-bottom: 24px;
	}

	.intro :global(svg) {
		color: var(--text-muted);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.intro strong {
		color: var(--text);
	}

	.section {
		gap: 12px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.stale-note {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-control);
	}

	.stale-note :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.stale-note strong {
		color: var(--text);
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

	.check-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		cursor: pointer;
	}

	.reclaim-codes {
		list-style: none;
		margin: 6px 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.reclaim-codes .mono {
		font-weight: 600;
	}
</style>
