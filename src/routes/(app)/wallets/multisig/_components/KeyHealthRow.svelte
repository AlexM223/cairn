<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import KeyCategoryIcon from './KeyCategoryIcon.svelte';
	import { DEVICE_LABELS } from '../labels';
	import { accountFromPath } from './keyHealth';

	// One key's health check (cairn-hvp), Casa-style: prove now and then that
	// each key still exists and still derives this multisig. Trezor/Ledger keys are
	// re-read live over USB/Connect and compared server-side; ColdCard/QR/file
	// keys get a guided manual check against the multisig's receive address.
	type ScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';
	type DeviceType = 'trezor' | 'ledger' | 'coldcard' | 'bitbox02' | 'jade' | 'qr' | 'file' | null;
	interface KeyInfo {
		id: number;
		name: string;
		deviceType: DeviceType;
		fingerprint: string;
		path: string;
		lastVerifiedAt: string | null;
	}

	let {
		multisigId,
		keyInfo,
		scriptType,
		receiveAddress,
		onVerified,
		category = null,
		emergency = false,
		flag = null,
		flagTitle = undefined
	}: {
		multisigId: number;
		keyInfo: KeyInfo;
		scriptType: ScriptType;
		receiveAddress: string | null;
		onVerified: (keyId: number, lastVerifiedAt: string) => void;
		/** Key category (hardware/mobile/recovery) — renders the category glyph. */
		category?: string | null;
		/** Recovery keys get a quiet "emergency" tag. */
		emergency?: boolean;
		/** Optional amber nudge tag (e.g. "Registered?") with a hover explanation. */
		flag?: string | null;
		flagTitle?: string;
	} = $props();

	let expanded = $state(false);
	let busy = $state(false);
	// A check that just passed updates in place; the prop stays the server truth.
	let freshStamp = $state<string | null>(null);
	const verifiedAt = $derived(freshStamp ?? keyInfo.lastVerifiedAt);

	type CheckResult =
		| { kind: 'ok' }
		| { kind: 'mismatch'; deviceFingerprint: string; fingerprintMatch: boolean }
		| { kind: 'error'; message: string };
	let result = $state<CheckResult | null>(null);

	const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
	const stale = $derived(!verifiedAt || Date.now() - Date.parse(verifiedAt) > SIX_MONTHS_MS);
	const isDeviceKey = $derived(keyInfo.deviceType === 'trezor' || keyInfo.deviceType === 'ledger');
	// The account the device would be asked to re-derive — null when the stored
	// path isn't the standard BIP-48 layout for this script type. A null account
	// means a live re-read would probe the WRONG derivation (it used to silently
	// assume account 0), so such keys fall back to the manual address check.
	const deviceAccount = $derived(isDeviceKey ? accountFromPath(keyInfo.path, scriptType) : null);
	const isDeviceCheck = $derived(isDeviceKey && deviceAccount !== null);
	const deviceLabel = $derived(keyInfo.deviceType ? DEVICE_LABELS[keyInfo.deviceType] : 'this key');

	// Spec 5d's stale-key string shape ("6 mo since signed"), adapted honestly
	// to what this row actually tracks — health checks, not signatures.
	function lastVerifiedLabel(ts: string | null): string {
		if (!ts) return 'never checked';
		const days = Math.floor((Date.now() - Date.parse(ts)) / 86_400_000);
		if (days <= 0) return 'checked today';
		if (days === 1) return 'checked yesterday';
		if (days < 60) return `checked ${days} days ago`;
		return `${Math.floor(days / 30)} mo since checked`;
	}

	async function postVerified(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const res = await fetch(`/api/wallets/multisig/${multisigId}/keys/${keyInfo.id}/verified`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = (await res.json()) as Record<string, unknown>;
		if (!res.ok) {
			throw new Error(
				typeof data.error === 'string' ? data.error : 'The check could not be recorded.'
			);
		}
		return data;
	}

	function recordSuccess(data: Record<string, unknown>) {
		if (typeof data.lastVerifiedAt === 'string') {
			freshStamp = data.lastVerifiedAt;
			onVerified(keyInfo.id, data.lastVerifiedAt);
		}
		result = { kind: 'ok' };
	}

	async function runDeviceCheck() {
		busy = true;
		result = null;
		try {
			const account = deviceAccount;
			if (account === null) {
				// Guard: the UI only offers the device check when the account was
				// inferred, but never probe a guessed derivation.
				throw new Error(
					`This key's stored derivation path (${keyInfo.path}) isn't the standard BIP-48 layout, so Heartwood can't re-read it from the device — verify it manually against the receive address instead.`
				);
			}
			let reading: { xpub: string; fingerprint: string };
			if (keyInfo.deviceType === 'trezor') {
				const mod = await import('$lib/hw/trezor');
				reading = await mod.readMultisigKeyFromTrezor(scriptType, account);
			} else {
				const mod = await import('$lib/hw/ledger');
				reading = await mod.readMultisigKeyFromLedger(scriptType, account);
			}
			const data = await postVerified({
				method: 'device',
				xpub: reading.xpub,
				fingerprint: reading.fingerprint
			});
			if (data.verified) {
				recordSuccess(data);
			} else {
				result = {
					kind: 'mismatch',
					deviceFingerprint:
						typeof data.deviceFingerprint === 'string' ? data.deviceFingerprint : 'unknown',
					fingerprintMatch: data.fingerprintMatch === true
				};
			}
		} catch (e) {
			result = {
				kind: 'error',
				message: e instanceof Error ? e.message : 'Could not read the device.'
			};
		} finally {
			busy = false;
		}
	}

	async function confirmManual() {
		busy = true;
		result = null;
		try {
			recordSuccess(await postVerified({ method: 'manual' }));
		} catch (e) {
			result = {
				kind: 'error',
				message: e instanceof Error ? e.message : 'The check could not be recorded.'
			};
		} finally {
			busy = false;
		}
	}
</script>

<div class="khr" class:expanded>
	<div class="khr-row">
		<!-- Spec 5d: stale = copper dot + amber "N mo since checked"; a fresh key
		     gets a quiet sage dot instead. -->
		<span class="khr-dot" class:stale aria-hidden="true"></span>
		{#if category}
			<span class="khr-cat" title={category}><KeyCategoryIcon {category} size={15} /></span>
		{/if}
		<span class="khr-name truncate">{keyInfo.name}</span>
		{#if keyInfo.deviceType}
			<span class="khr-sub">{DEVICE_LABELS[keyInfo.deviceType]}</span>
		{/if}
		{#if keyInfo.fingerprint !== '00000000'}
			<span class="khr-sub mono">{keyInfo.fingerprint}</span>
		{/if}
		{#if emergency}
			<span class="khr-tag" title="For emergencies only — you won't use this key day to day.">
				emergency
			</span>
		{/if}
		{#if flag}
			<span class="khr-flag" title={flagTitle}>{flag}</span>
		{/if}
		<span class="khr-when" class:stale>
			{lastVerifiedLabel(verifiedAt)}
		</span>
		<button
			type="button"
			class="khr-check"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			Check key
			<Icon name="chevron-down" size={13} />
		</button>
	</div>

	{#if expanded}
		<div class="khr-panel fade-in">
			{#if isDeviceCheck}
				<p class="khr-copy">
					Heartwood asks the {deviceLabel} for its public key and compares it with what this wallet
					stores. Nothing is signed, and nothing secret ever leaves the device — a match proves
					it still holds the exact key this wallet expects.
				</p>
				<button type="button" class="btn btn-secondary btn-sm" onclick={runDeviceCheck} disabled={busy}>
					{#if busy}<span class="spinner"></span>{:else}<Icon name="refresh" size={13} />{/if}
					Read key from {deviceLabel}
				</button>
			{:else}
				{#if isDeviceKey}
					<p class="khr-copy">
						This {deviceLabel} key was stored with a non-standard derivation path
						(<span class="mono">{keyInfo.path}</span>), so Heartwood can't ask the device for it
						directly — a live re-read would look at the wrong derivation. Verify it by hand
						against the wallet's current receive address instead:
					</p>
				{:else}
					<p class="khr-copy">
						Heartwood can't talk to this key directly, so verify it by hand against the wallet's current
						receive address:
					</p>
				{/if}
				{#if receiveAddress}
					<div class="khr-addr"><CopyText value={receiveAddress} truncate={14} /></div>
				{:else}
					<p class="khr-copy khr-warn-text">
						The receive address isn't available right now (the wallet scan failed) — retry the
						scan first.
					</p>
				{/if}
				<p class="khr-copy">
					{#if keyInfo.deviceType === 'coldcard'}
						On the ColdCard: <strong>Settings → Multisig Wallets → (this wallet) → Address
						Explorer</strong> and confirm this address appears. If the wallet isn't listed,
						re-import the registration file from the backup card above.
					{:else if keyInfo.deviceType === 'qr'}
						On the device (SeedSigner, Passport, Keystone…): load this wallet's registration,
						open its address explorer or verify-address feature, and confirm it shows this
						exact address.
					{:else}
						Open your backup file (or the descriptor) together with this key in another wallet
						tool — Sparrow works well — and confirm it derives this exact address.
					{/if}
				</p>
				<p class="khr-copy khr-honest">
					Honest caveat: this proves the key still <strong>derives this wallet's addresses</strong>.
					It doesn't prove the device can still sign — for full confidence, send yourself a small
					test amount and sign with this key once in a while.
				</p>
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					onclick={confirmManual}
					disabled={busy || !receiveAddress}
					title="Only confirm after you've actually checked the address on the device."
				>
					{#if busy}<span class="spinner"></span>{:else}<Icon name="check" size={13} />{/if}
					I checked it — the address matches
				</button>
			{/if}

			{#if result?.kind === 'ok'}
				<div class="khr-result khr-ok" role="status">
					<Icon name="check" size={14} />
					<span>
						<strong>{keyInfo.name}</strong> checked out — it still holds the exact key this
						wallet expects. Recorded; you're covered for another while.
					</span>
				</div>
			{:else if result?.kind === 'mismatch'}
				<div class="khr-result khr-warn" role="alert">
					<Icon name="alert-triangle" size={14} />
					{#if !result.fingerprintMatch}
						<span>
							<strong>This device holds a different key.</strong> It reports fingerprint
							<span class="mono">{result.deviceFingerprint}</span>, but this multisig key was
							created with <span class="mono">{keyInfo.fingerprint}</span>. If the device was
							reset or restored from a different seed phrase, it can no longer sign for this
							wallet — treat this key as lost, and consider moving funds while your remaining
							keys still meet the quorum.
						</span>
					{:else}
						<span>
							<strong>Right device, unexpected key.</strong> The fingerprint matches, but the
							key it returned differs from the one stored here (stored path:
							<span class="mono">{keyInfo.path}</span>). The key may live at a non-standard
							derivation path — verify it manually against the receive address instead.
						</span>
					{/if}
				</div>
			{:else if result?.kind === 'error'}
				<div class="khr-result khr-warn" role="alert">
					<Icon name="alert-triangle" size={14} />
					<span>{result.message}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Hairline key rows (5d): dot + name + device, amber stale string right. */
	.khr {
		border-top: 1px solid var(--hairline);
		padding: 12px 0;
	}

	.khr-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	/* Status dot — sage when recently checked, copper when stale (spec 5d). */
	.khr-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--sage);
	}

	.khr-dot.stale {
		background: var(--accent);
	}

	.khr-name {
		font-size: 14px;
		font-weight: 500;
		color: var(--text-rows);
		max-width: 220px;
	}

	.khr-sub {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.khr-cat {
		display: inline-flex;
		color: var(--accent);
		flex-shrink: 0;
	}

	.khr-tag {
		font-size: 10.5px;
		color: var(--text-faint);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-badge);
		padding: 1px 7px;
		white-space: nowrap;
	}

	.khr-flag {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--attention);
		background: var(--attention-muted);
		border-radius: var(--radius-badge);
		padding: 1px 7px;
		white-space: nowrap;
	}

	.khr-when {
		margin-left: auto;
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.khr-when.stale {
		color: var(--attention);
	}

	.khr-check {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 4px 6px;
		margin: -4px 0;
		border-radius: var(--radius-toggle);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.khr-check:hover {
		color: var(--accent-bright);
		background: var(--accent-muted);
	}

	.khr-check :global(svg) {
		transition: transform 150ms var(--ease);
	}

	.khr.expanded .khr-check :global(svg) {
		transform: rotate(180deg);
	}

	/* Expanded check panel: quietly indented under the row, no box. */
	.khr-panel {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		margin-top: 12px;
		padding-left: 17px;
	}

	.khr-copy {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.khr-copy strong {
		color: var(--text);
	}

	.khr-honest {
		color: var(--text-muted);
	}

	.khr-warn-text {
		color: var(--attention);
	}

	.khr-addr {
		font-size: 13px;
	}

	/* Check outcomes: colored text over a hairline, not tinted boxes. */
	.khr-result {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 12.5px;
		line-height: 1.6;
		padding-top: 10px;
		border-top: 1px solid var(--hairline);
		width: 100%;
	}

	.khr-result :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.khr-ok {
		color: var(--sage);
	}

	.khr-ok span {
		color: var(--text-secondary);
	}

	.khr-ok strong {
		color: var(--text);
	}

	.khr-warn {
		color: var(--attention);
	}

	.khr-warn span {
		color: var(--text-secondary);
	}

	.khr-warn strong {
		color: var(--attention);
	}
</style>
