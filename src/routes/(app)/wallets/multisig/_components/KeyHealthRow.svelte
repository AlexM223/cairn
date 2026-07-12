<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import KeyCategoryIcon from './KeyCategoryIcon.svelte';
	import { DEVICE_LABELS } from '../labels';
	import { accountFromPath } from './keyHealth';
	import { parseKeyOriginInput } from '$lib/hw/keyOrigin';
	import {
		KEY_MATCH_HEADLINE,
		WRONG_SEED_HEADLINE,
		WRONG_SEED_BODY,
		PASSPHRASE_CAUSE_HEADLINE,
		PASSPHRASE_CAUSE_BODY,
		PASSPHRASE_LOSS_WARNING,
		PASSPHRASE_NOT_RECOMMENDED
	} from './keyCheckCopy';

	// One key's health check (cairn-hvp), Casa-style: prove now and then that
	// each key still exists and still derives this multisig. Trezor/Ledger/
	// BitBox02/Jade keys are re-read live over USB/Connect/WebHID/Web Serial and
	// compared server-side (Method A); every key can also be re-verified by
	// pasting a fresh export of its public key, compared the same cryptographic
	// way (Method B) — the always-available fallback over plain HTTP and for
	// air-gapped signers (ColdCard/QR/file), replacing a bare by-eye address
	// check with an actual compare. ColdCard/QR/file keys keep the by-eye
	// address check too, but now as a secondary, collapsed option.
	type ScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';
	type DeviceType = 'trezor' | 'ledger' | 'coldcard' | 'bitbox02' | 'jade' | 'qr' | 'file' | null;
	interface KeyInfo {
		id: number;
		name: string;
		deviceType: DeviceType;
		fingerprint: string;
		/** The stored extended public key — safe to show/copy (never redacted). */
		xpub: string;
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
	// Method A (live re-derive) covers every device this app can read a
	// multisig account key from — Trezor/Ledger over Connect/WebHID, BitBox02
	// over BitBoxBridge/WebHID, Jade over Web Serial (deviceRead.ts's seam).
	const isDeviceKey = $derived(
		keyInfo.deviceType === 'trezor' ||
			keyInfo.deviceType === 'ledger' ||
			keyInfo.deviceType === 'bitbox02' ||
			keyInfo.deviceType === 'jade'
	);
	// The account the device would be asked to re-derive — null when the stored
	// path isn't the standard BIP-48 layout for this script type. A null account
	// means a live re-read would probe the WRONG derivation (it used to silently
	// assume account 0), so such keys fall back to Method B (paste) or the
	// manual address check.
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

	function mismatchFrom(data: Record<string, unknown>): CheckResult {
		return {
			kind: 'mismatch',
			deviceFingerprint:
				typeof data.deviceFingerprint === 'string' ? data.deviceFingerprint : 'unknown',
			fingerprintMatch: data.fingerprintMatch === true
		};
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
					`This key's stored derivation path (${keyInfo.path}) isn't the standard BIP-48 layout, so Heartwood can't re-read it from the device — paste the key instead, or verify it manually against the receive address.`
				);
			}
			let reading: { xpub: string; fingerprint: string };
			if (keyInfo.deviceType === 'trezor') {
				const mod = await import('$lib/hw/trezor');
				reading = await mod.readMultisigKeyFromTrezor(scriptType, account);
			} else if (keyInfo.deviceType === 'ledger') {
				const mod = await import('$lib/hw/ledger');
				reading = await mod.readMultisigKeyFromLedger(scriptType, account);
			} else if (keyInfo.deviceType === 'bitbox02') {
				const mod = await import('$lib/hw/bitbox02');
				reading = await mod.readMultisigKeyFromBitbox02(scriptType, account);
			} else {
				const mod = await import('$lib/hw/jade');
				reading = await mod.readMultisigKeyFromJade(scriptType, account);
			}
			const data = await postVerified({
				method: 'device',
				xpub: reading.xpub,
				fingerprint: reading.fingerprint
			});
			if (data.verified) {
				recordSuccess(data);
			} else {
				result = mismatchFrom(data);
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

	// ------------------------------------------------------ Method B: paste-xpub compare
	//
	// Air-gapped/ColdCard/no-device (and plain-HTTP, where WebHID/Web Serial are
	// withheld) fallback: re-export the key and paste it back in. Compared the
	// SAME cryptographic way as a live device read (server's compareMultisigKey),
	// not the old "I looked at the address" honor system.
	let showPaste = $state(false);
	let showManual = $state(false);
	let pasteXpub = $state('');
	let pasteFingerprint = $state('');
	let pasteError = $state<string | null>(null);
	let showFullXpub = $state(false);

	function togglePaste() {
		showPaste = !showPaste;
		pasteError = null;
	}

	// Auto-fill the fingerprint the moment the pasted text carries its own
	// [fingerprint/path] origin — same courtesy the wizard's add-key paste form
	// gives — but only while the field is still empty, so a manual entry (or
	// one already filled from a previous paste) is never clobbered.
	$effect(() => {
		if (pasteFingerprint) return;
		const parsed = parseKeyOriginInput(pasteXpub);
		if (parsed.fingerprint) pasteFingerprint = parsed.fingerprint;
	});

	async function runPasteCheck() {
		busy = true;
		result = null;
		pasteError = null;
		try {
			const parsed = parseKeyOriginInput(pasteXpub);
			if (!parsed.xpub) {
				pasteError = 'Paste the public key first.';
				return;
			}
			const fingerprint = (pasteFingerprint || parsed.fingerprint || '').trim();
			if (!fingerprint) {
				pasteError =
					"Enter the key's fingerprint too (or paste it together with its origin, e.g. [a1b2c3d4/48'/0'/0'/2']xpub…) so Heartwood can check both.";
				return;
			}
			const data = await postVerified({ method: 'paste', xpub: parsed.xpub, fingerprint });
			if (data.verified) {
				recordSuccess(data);
				pasteXpub = '';
				pasteFingerprint = '';
				showPaste = false;
			} else {
				result = mismatchFrom(data);
			}
		} catch (e) {
			result = {
				kind: 'error',
				message: e instanceof Error ? e.message : 'Could not check that key.'
			};
		} finally {
			busy = false;
		}
	}
</script>

{#snippet pasteForm()}
	<div class="khr-paste">
		<label class="khr-paste-label" for="khr-paste-{keyInfo.id}"> Paste the extended public key </label>
		<textarea
			id="khr-paste-{keyInfo.id}"
			class="input mono khr-paste-input"
			rows="2"
			placeholder={"xpub6D…, or [a1b2c3d4/48'/0'/0'/2']xpub6D…"}
			spellcheck="false"
			autocomplete="off"
			bind:value={pasteXpub}
		></textarea>
		<label class="khr-paste-label" for="khr-fp-{keyInfo.id}">
			Fingerprint <span class="khr-optional">(filled in automatically when included above)</span>
		</label>
		<input
			id="khr-fp-{keyInfo.id}"
			class="input mono khr-paste-fp"
			placeholder="a1b2c3d4"
			maxlength="8"
			bind:value={pasteFingerprint}
		/>
		{#if pasteError}
			<div class="form-error" role="alert">{pasteError}</div>
		{/if}
		<button
			type="button"
			class="btn btn-secondary btn-sm"
			onclick={runPasteCheck}
			disabled={busy || !pasteXpub.trim()}
		>
			{#if busy}<span class="spinner"></span>{:else}<Icon name="check" size={13} />{/if}
			Compare to the stored key
		</button>
	</div>
{/snippet}

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
			<!-- Supporting audit display (secondary to the check itself): the
			     stored path + the full public key, copyable/expandable. Never
			     redacted server-side — safe to show in full. -->
			<div class="khr-stored">
				<span class="khr-stored-row">
					<span class="khr-stored-label">Path</span>
					<span class="mono">{keyInfo.path}</span>
				</span>
				<span class="khr-stored-row">
					<span class="khr-stored-label">Public key</span>
					<CopyText value={keyInfo.xpub} truncate={showFullXpub ? 0 : 10} />
					<button
						type="button"
						class="khr-link-btn khr-inline"
						onclick={() => (showFullXpub = !showFullXpub)}
					>
						{showFullXpub ? 'Show less' : 'Show full key'}
					</button>
				</span>
			</div>

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
				<SecureContextHelp what="key verification" />
				<div class="khr-altcheck">
					<button
						type="button"
						class="khr-link-btn"
						class:rotated={showPaste}
						onclick={togglePaste}
						aria-expanded={showPaste}
					>
						<Icon name="chevron-down" size={12} />
						{showPaste ? 'Hide the paste option' : "Don't have the device? Paste the key instead"}
					</button>
					{#if showPaste}
						<div class="fade-in">
							{@render pasteForm()}
						</div>
					{/if}
				</div>
			{:else}
				{#if isDeviceKey}
					<p class="khr-copy">
						This {deviceLabel} key was stored with a non-standard derivation path
						(<span class="mono">{keyInfo.path}</span>), so Heartwood can't ask the device for it
						directly — a live re-read would look at the wrong derivation.
					</p>
				{/if}
				<p class="khr-copy">
					Paste the key again — a fresh export off the device, or the same file/QR you used
					originally — and Heartwood compares it to what's stored here, the same cryptographic
					check a live device read does. This works over plain HTTP and with air-gapped signers.
				</p>
				{@render pasteForm()}

				<div class="khr-altcheck">
					<button
						type="button"
						class="khr-link-btn"
						class:rotated={showManual}
						onclick={() => (showManual = !showManual)}
						aria-expanded={showManual}
					>
						<Icon name="chevron-down" size={12} />
						{showManual ? 'Hide the by-eye check' : 'Or check by eye against the receive address'}
					</button>
					{#if showManual}
						<div class="fade-in">
							{#if receiveAddress}
								<div class="khr-addr"><CopyText value={receiveAddress} truncate={14} /></div>
							{:else}
								<p class="khr-copy khr-warn-text">
									The receive address isn't available right now (the wallet scan failed) — retry
									the scan first.
								</p>
							{/if}
							<p class="khr-copy">
								{#if keyInfo.deviceType === 'coldcard'}
									On the ColdCard: <strong>Settings → Multisig Wallets → (this wallet) →
									Address Explorer</strong> and confirm this address appears. If the wallet isn't
									listed, re-import the registration file from the backup card above.
								{:else if keyInfo.deviceType === 'qr'}
									On the device (SeedSigner, Passport, Keystone…): load this wallet's
									registration, open its address explorer or verify-address feature, and confirm
									it shows this exact address.
								{:else}
									Open your backup file (or the descriptor) together with this key in another
									wallet tool — Sparrow works well — and confirm it derives this exact address.
								{/if}
							</p>
							<p class="khr-copy khr-honest">
								Honest caveat: this proves the key still <strong>derives this wallet's addresses</strong>.
								It doesn't prove the device can still sign — for full confidence, send yourself a
								small test amount and sign with this key once in a while.
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
						</div>
					{/if}
				</div>
			{/if}

			{#if result?.kind === 'ok'}
				<div class="khr-result khr-ok" role="status">
					<Icon name="check" size={14} />
					<span>
						<strong>{KEY_MATCH_HEADLINE}</strong>
						{keyInfo.name} still holds the exact key this wallet expects. Recorded; you're covered
						for another while.
					</span>
				</div>
			{:else if result?.kind === 'mismatch'}
				<div class="khr-result khr-warn" role="alert">
					<Icon name="alert-triangle" size={14} />
					{#if !result.fingerprintMatch}
						<div class="khr-nomatch">
							<p>
								<strong>This key doesn't match what's stored for this wallet.</strong> It reports
								fingerprint <span class="mono">{result.deviceFingerprint}</span>, but this multisig
								key was created with <span class="mono">{keyInfo.fingerprint}</span>. There are two
								likely causes:
							</p>
							<ul class="khr-causes">
								<li><strong>{WRONG_SEED_HEADLINE}</strong> {WRONG_SEED_BODY}</li>
								<li><strong>{PASSPHRASE_CAUSE_HEADLINE}</strong> {PASSPHRASE_CAUSE_BODY}</li>
							</ul>
							<p>
								If you can't resolve this, treat this key as lost, and consider moving funds while
								your remaining keys still meet the quorum.
							</p>
						</div>
					{:else}
						<span>
							<strong>Right device, unexpected key.</strong> The fingerprint matches, but the
							key it returned differs from the one stored here (stored path:
							<span class="mono">{keyInfo.path}</span>). The key may live at a non-standard
							derivation path — verify it manually against the receive address instead.
						</span>
					{/if}
				</div>
				{#if !result.fingerprintMatch}
					<!-- Prominent, first-class loss-of-funds warning — not a tooltip, not
					     buried below a disclosure. Passphrase + multisig is an easy,
					     common way to accidentally end up here. -->
					<div class="khr-passphrase-warn" role="alert">
						<Icon name="alert-triangle" size={16} />
						<div>
							<p class="khr-passphrase-lede">{PASSPHRASE_LOSS_WARNING}</p>
							<p>{PASSPHRASE_NOT_RECOMMENDED}</p>
						</div>
					</div>
				{/if}
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

	/* Supporting audit display: stored path + full xpub, copy/expand. */
	.khr-stored {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		font-size: 12.5px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
	}

	.khr-stored-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.khr-stored-label {
		flex-shrink: 0;
		width: 62px;
		color: var(--text-muted);
	}

	/* Quiet secondary-option toggles (paste fallback / manual by-eye check). */
	.khr-altcheck {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
	}

	.khr-link-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: none;
		border: none;
		padding: 2px 0;
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
	}

	.khr-link-btn:hover {
		color: var(--accent-bright);
	}

	.khr-link-btn :global(svg) {
		transition: transform 150ms var(--ease);
	}

	.khr-link-btn.rotated :global(svg) {
		transform: rotate(180deg);
	}

	.khr-inline {
		font-size: 11.5px;
	}

	/* Method B paste form. */
	.khr-paste {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		width: 100%;
		max-width: 420px;
	}

	.khr-paste-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.khr-optional {
		font-weight: 400;
		color: var(--text-muted);
	}

	.khr-paste-input,
	.khr-paste-fp {
		width: 100%;
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

	.khr-warn span,
	.khr-warn p {
		color: var(--text-secondary);
	}

	.khr-warn strong {
		color: var(--attention);
	}

	.khr-nomatch p {
		margin: 0 0 6px;
	}

	.khr-causes {
		margin: 6px 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* Prominent, first-class passphrase loss-of-funds warning — a bordered
	   callout, never a tooltip, never behind a disclosure. */
	.khr-passphrase-warn {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		width: 100%;
		margin-top: 4px;
		padding: 12px 14px;
		border: 1px solid var(--warning-border, var(--attention));
		border-radius: var(--radius-strip, 8px);
		background: var(--attention-muted);
		color: var(--attention);
		font-size: 12.5px;
		line-height: 1.6;
	}

	.khr-passphrase-warn :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.khr-passphrase-warn p {
		margin: 0 0 4px;
		color: var(--text-secondary);
	}

	.khr-passphrase-warn p:last-child {
		margin-bottom: 0;
	}

	.khr-passphrase-lede {
		font-weight: 600;
		color: var(--text);
	}
</style>
