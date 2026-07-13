<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import { parseKeyOriginInput } from '$lib/hw/keyOrigin';
	import { compareWizardKey, type WizardKeyCompareResult } from './wizardKeyCheckLogic';
	import {
		readKeyFromTrezor,
		readKeyFromLedger,
		readKeyFromBitbox02,
		readKeyFromJade,
		readCollabKeyFromTrezor,
		readCollabKeyFromLedger,
		supportsCollaborativeRead,
		DeviceReadUnavailable
	} from './deviceRead';
	import { DEVICE_LABELS } from '../../labels';
	import {
		KEY_MATCH_HEADLINE,
		WRONG_SEED_HEADLINE,
		WRONG_SEED_BODY,
		PASSPHRASE_CAUSE_HEADLINE,
		PASSPHRASE_CAUSE_BODY,
		PASSPHRASE_LOSS_WARNING,
		PASSPHRASE_NOT_RECOMMENDED,
		NO_FINGERPRINT_ON_RECORD_NOTE
	} from '../../_components/keyCheckCopy';

	// Wave 2 of the multisig key-check redesign (MULTISIG-KEY-AUDIT-DESIGN §7):
	// the CREATION wizard's own "verify this key" affordance, so a wrong-account
	// export or a passphrase-enabled device is caught BEFORE the wallet exists —
	// the highest-stakes moment, since no funds are committed yet. There's no
	// keyId to POST to (the multisig isn't created until the final step), so
	// this compares CLIENT-SIDE (wizardKeyCheckLogic.ts) instead of hitting
	// `/keys/[keyId]/verified` — same canonicalization, same result copy
	// (keyCheckCopy.ts) as the post-creation check in KeyHealthRow.svelte.
	type ScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';
	type DeviceType = 'trezor' | 'ledger' | 'coldcard' | 'bitbox02' | 'jade' | 'qr' | 'file' | null;
	type ConnectMethod = 'trezor' | 'ledger' | 'bitbox02' | 'jade';
	type VaultMode = 'collaborative' | 'personal';

	interface KeyInfo {
		name: string;
		deviceType: DeviceType;
		xpub: string;
		fingerprint: string;
		path: string;
	}

	let { keyInfo, scriptType, vaultMode }: {
		keyInfo: KeyInfo;
		scriptType: ScriptType;
		/** Which purpose this vault's keys were read at — decides whether a
		 *  device re-check reads m/45' (collaborative) or the BIP-48 account
		 *  (personal), exactly like the add-key flow's connectDevice(). */
		vaultMode: VaultMode;
	} = $props();

	let expanded = $state(false);
	let busy = $state(false);

	type CheckResult =
		| { kind: 'ok'; noFingerprintOnRecord?: boolean }
		| { kind: 'mismatch'; deviceFingerprint: string; fingerprintMatch: boolean }
		| { kind: 'error'; message: string };
	let result = $state<CheckResult | null>(null);

	// Method A (live re-derive) is only meaningful for the one-click-connect
	// devices this wizard already knows how to read from directly — the exact
	// same set connectDevice() dispatches to when the key was first added.
	const isConnectDevice = $derived(
		keyInfo.deviceType === 'trezor' ||
			keyInfo.deviceType === 'ledger' ||
			keyInfo.deviceType === 'bitbox02' ||
			keyInfo.deviceType === 'jade'
	);
	// BitBox02/Jade can't export the shared-vault m/45' key through the browser
	// (deviceRead.ts's collaborative gate) — same restriction applies to a
	// re-check, so those fall back to Method B only in a collaborative vault.
	const canDeviceCheck = $derived(
		isConnectDevice &&
			(vaultMode !== 'collaborative' || supportsCollaborativeRead(keyInfo.deviceType as ConnectMethod))
	);
	const deviceLabel = $derived(keyInfo.deviceType ? DEVICE_LABELS[keyInfo.deviceType] : 'this key');

	function fromComparison(cmp: WizardKeyCompareResult, deviceFingerprint: string): CheckResult {
		if (cmp.verified) return { kind: 'ok', noFingerprintOnRecord: cmp.matchedWithoutFingerprint };
		return { kind: 'mismatch', deviceFingerprint, fingerprintMatch: cmp.fingerprintMatch };
	}

	async function runDeviceCheck() {
		busy = true;
		result = null;
		try {
			let reading: { xpub: string; fingerprint: string; path: string };
			if (vaultMode === 'collaborative') {
				reading =
					keyInfo.deviceType === 'trezor'
						? await readCollabKeyFromTrezor()
						: await readCollabKeyFromLedger();
			} else {
				const reader =
					keyInfo.deviceType === 'trezor'
						? readKeyFromTrezor
						: keyInfo.deviceType === 'ledger'
							? readKeyFromLedger
							: keyInfo.deviceType === 'bitbox02'
								? readKeyFromBitbox02
								: readKeyFromJade;
				reading = await reader(scriptType);
			}
			const cmp = compareWizardKey(keyInfo, reading);
			result = fromComparison(cmp, reading.fingerprint.trim().toLowerCase());
		} catch (e) {
			if (e instanceof DeviceReadUnavailable) {
				result = {
					kind: 'error',
					message: `${e.message} Paste a fresh export of the key instead, below.`
				};
			} else {
				result = {
					kind: 'error',
					message: e instanceof Error ? e.message : 'Could not read the device.'
				};
			}
		} finally {
			busy = false;
		}
	}

	// ------------------------------------------------------ Method B: paste-xpub compare
	let showPaste = $state(false);
	let pasteXpub = $state('');
	let pasteFingerprint = $state('');
	let pasteError = $state<string | null>(null);

	function togglePaste() {
		showPaste = !showPaste;
		pasteError = null;
	}

	$effect(() => {
		if (pasteFingerprint) return;
		const parsed = parseKeyOriginInput(pasteXpub);
		if (parsed.fingerprint) pasteFingerprint = parsed.fingerprint;
	});

	function runPasteCheck() {
		result = null;
		pasteError = null;
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
		const cmp = compareWizardKey(keyInfo, { xpub: parsed.xpub, fingerprint });
		result = fromComparison(cmp, fingerprint.toLowerCase());
		if (cmp.verified) {
			pasteXpub = '';
			pasteFingerprint = '';
			showPaste = false;
		}
	}
</script>

{#snippet pasteForm()}
	<div class="wkc-paste">
		<label class="wkc-paste-label" for="wkc-paste-{keyInfo.name}">
			Paste the extended public key
		</label>
		<textarea
			id="wkc-paste-{keyInfo.name}"
			class="input mono wkc-paste-input"
			rows="2"
			placeholder={"xpub6D…, or [a1b2c3d4/48'/0'/0'/2']xpub6D…"}
			spellcheck="false"
			autocomplete="off"
			bind:value={pasteXpub}
		></textarea>
		<label class="wkc-paste-label" for="wkc-fp-{keyInfo.name}">
			Fingerprint <span class="wkc-optional">(filled in automatically when included above)</span>
		</label>
		<input
			id="wkc-fp-{keyInfo.name}"
			class="input mono wkc-paste-fp"
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
			disabled={!pasteXpub.trim()}
		>
			<Icon name="check" size={13} />
			Compare to this key
		</button>
	</div>
{/snippet}

<div class="wkc" class:expanded>
	<div class="wkc-row">
		<span class="wkc-name truncate">{keyInfo.name}</span>
		{#if keyInfo.deviceType}
			<span class="wkc-sub">{DEVICE_LABELS[keyInfo.deviceType]}</span>
		{/if}
		{#if keyInfo.fingerprint !== '00000000'}
			<span class="wkc-sub mono">{keyInfo.fingerprint}</span>
		{/if}
		<button
			type="button"
			class="wkc-toggle"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			Verify this key
			<Icon name="chevron-down" size={13} />
		</button>
	</div>

	{#if expanded}
		<div class="wkc-panel fade-in">
			{#if canDeviceCheck}
				<p class="wkc-copy">
					Re-connect the {deviceLabel} and Heartwood reads its public key again, comparing it with
					what you already added — before this wallet exists, so a wrong device or a stray
					passphrase is caught while nothing is at stake yet.
				</p>
				<button type="button" class="btn btn-secondary btn-sm" onclick={runDeviceCheck} disabled={busy}>
					{#if busy}<span class="spinner"></span>{:else}<Icon name="refresh" size={13} />{/if}
					Read key from {deviceLabel}
				</button>
				<SecureContextHelp what="key verification" />
				<div class="wkc-altcheck">
					<button
						type="button"
						class="wkc-link-btn"
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
				{#if isConnectDevice}
					<p class="wkc-copy">
						This vault is shared, and the {deviceLabel} can't export the shared-vault key
						(<span class="mono">m/45'</span>) through the browser — paste a fresh export instead.
					</p>
				{:else}
					<p class="wkc-copy">
						Paste the key again — a fresh export off the device, or the same file/QR you used to
						add it — and Heartwood compares it to what you entered above.
					</p>
				{/if}
				{@render pasteForm()}
			{/if}

			{#if result?.kind === 'ok'}
				<div class="wkc-result wkc-ok" role="status">
					<Icon name="check" size={14} />
					<span>
						<strong>{KEY_MATCH_HEADLINE}</strong>
						{keyInfo.name} still checks out.
					</span>
				</div>
				{#if result.noFingerprintOnRecord}
					<p class="wkc-copy wkc-neutral-note">{NO_FINGERPRINT_ON_RECORD_NOTE}</p>
				{/if}
			{:else if result?.kind === 'mismatch'}
				<div class="wkc-result wkc-warn" role="alert">
					<Icon name="alert-triangle" size={14} />
					{#if !result.fingerprintMatch}
						<div class="wkc-nomatch">
							<p>
								<strong>This doesn't match what you added.</strong> It reports fingerprint
								<span class="mono">{result.deviceFingerprint}</span>, but this key was added with
								<span class="mono">{keyInfo.fingerprint}</span>. There are two likely causes:
							</p>
							<ul class="wkc-causes">
								<li><strong>{WRONG_SEED_HEADLINE}</strong> {WRONG_SEED_BODY}</li>
								<li><strong>{PASSPHRASE_CAUSE_HEADLINE}</strong> {PASSPHRASE_CAUSE_BODY}</li>
							</ul>
							<p>
								Remove this key (above) and add it again — better to sort this out now than after
								the wallet is created and funded.
							</p>
						</div>
					{:else}
						<span>
							<strong>Right device, unexpected key.</strong> The fingerprint matches, but the key
							it returned differs from the one you added (path <span class="mono">{keyInfo.path}</span
							>). Double-check the account/path this device is exporting from.
						</span>
					{/if}
				</div>
				{#if !result.fingerprintMatch}
					<div class="wkc-passphrase-warn" role="alert">
						<Icon name="alert-triangle" size={16} />
						<div>
							<p class="wkc-passphrase-lede">{PASSPHRASE_LOSS_WARNING}</p>
							<p>{PASSPHRASE_NOT_RECOMMENDED}</p>
						</div>
					</div>
				{/if}
			{:else if result?.kind === 'error'}
				<div class="wkc-result wkc-warn" role="alert">
					<Icon name="alert-triangle" size={14} />
					<span>{result.message}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.wkc {
		border-top: 1px solid var(--hairline);
		padding: 10px 0;
	}

	.wkc-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.wkc-name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-rows);
		max-width: 200px;
	}

	.wkc-sub {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.wkc-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: auto;
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 4px 6px;
		margin-top: -4px;
		margin-bottom: -4px;
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

	.wkc-toggle:hover {
		color: var(--accent-bright);
		background: var(--accent-muted);
	}

	.wkc-toggle :global(svg) {
		transition: transform 150ms var(--ease);
	}

	.wkc.expanded .wkc-toggle :global(svg) {
		transform: rotate(180deg);
	}

	.wkc-panel {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		margin-top: 10px;
	}

	.wkc-copy {
		font-size: 12.5px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.wkc-altcheck {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
	}

	.wkc-link-btn {
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

	.wkc-link-btn:hover {
		color: var(--accent-bright);
	}

	.wkc-link-btn :global(svg) {
		transition: transform 150ms var(--ease);
	}

	.wkc-link-btn.rotated :global(svg) {
		transform: rotate(180deg);
	}

	.wkc-paste {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		width: 100%;
		max-width: 420px;
	}

	.wkc-paste-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.wkc-optional {
		font-weight: 400;
		color: var(--text-muted);
	}

	.wkc-paste-input,
	.wkc-paste-fp {
		width: 100%;
	}

	.wkc-result {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 12.5px;
		line-height: 1.6;
		padding-top: 10px;
		border-top: 1px solid var(--hairline);
		width: 100%;
	}

	.wkc-result :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.wkc-ok {
		color: var(--sage);
	}

	.wkc-ok span {
		color: var(--text-secondary);
	}

	.wkc-ok strong {
		color: var(--text);
	}

	.wkc-neutral-note {
		color: var(--text-muted);
	}

	.wkc-warn {
		color: var(--attention);
	}

	.wkc-warn span,
	.wkc-warn p {
		color: var(--text-secondary);
	}

	.wkc-warn strong {
		color: var(--attention);
	}

	.wkc-nomatch p {
		margin: 0 0 6px;
	}

	.wkc-causes {
		margin: 6px 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.wkc-passphrase-warn {
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

	.wkc-passphrase-warn :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.wkc-passphrase-warn p {
		margin: 0 0 4px;
		color: var(--text-secondary);
	}

	.wkc-passphrase-warn p:last-child {
		margin-bottom: 0;
	}

	.wkc-passphrase-lede {
		font-weight: 600;
		color: var(--text);
	}
</style>
