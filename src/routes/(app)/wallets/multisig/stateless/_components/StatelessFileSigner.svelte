<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, formatSats } from '$lib/format';

	// The file round trip for one stateless-multisig key: download the CURRENT
	// combined PSBT, sign it on any PSBT-capable signer, load the result back.
	//
	// A deliberately compact sibling of the multisig send flow's MultisigFileSigner
	// (duplicated, not imported: that component downloads through server file
	// URLs — /api/wallets/multisig/[id]/…/file — which don't exist for a multisig that was
	// never persisted). Here the PSBT and the registration file live in client
	// memory, so downloads are built as Blobs with proper filenames (.psbt
	// matters: a ColdCard only lists *.psbt files in the card root).
	let {
		psbtBase64,
		registration,
		multisigLabel,
		threshold,
		totalKeys,
		keyName,
		destinationAddress,
		amountSats,
		feeSats,
		onsigned
	}: {
		/** The CURRENT combined PSBT (signatures collected so far included). */
		psbtBase64: string;
		/** ColdCard-format registration file content (from the scan response). */
		registration: string;
		multisigLabel: string;
		threshold: number;
		totalKeys: number;
		/** Which config key this round trip is collecting a signature from. */
		keyName: string;
		destinationAddress: string;
		amountSats: number;
		feeSats: number;
		onsigned: (signedPsbtBase64: string) => void;
	} = $props();

	let signError = $state<string | null>(null);
	let reading = $state(false);
	let loadedName = $state<string | null>(null);
	let pastedPsbt = $state('');

	/** Programmatic download with a real filename — object URLs alone would
	 *  save under a random blob UUID, which air-gapped devices then ignore. */
	function downloadBlob(bytes: Uint8Array | string, filename: string, type: string) {
		const blob = new Blob([bytes as BlobPart], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	function downloadPsbt() {
		const bin = atob(psbtBase64.trim());
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		downloadBlob(bytes, 'cairn-stateless.psbt', 'application/octet-stream');
	}

	function downloadRegistration() {
		downloadBlob(registration, 'cairn-multisig-registration.txt', 'text/plain');
	}

	// Binary .psbt files (magic "psbt\xff") are base64-encoded; anything else
	// is treated as the base64/hex text a signer exported. The server
	// normalizes and validates either way. (Same reader as MultisigFileSigner.)
	async function readFileAsBase64(file: File): Promise<string> {
		const buf = new Uint8Array(await file.arrayBuffer());
		const isBinary =
			buf[0] === 0x70 && buf[1] === 0x73 && buf[2] === 0x62 && buf[3] === 0x74 && buf[4] === 0xff;
		if (isBinary) {
			let bin = '';
			for (const b of buf) bin += String.fromCharCode(b);
			return btoa(bin);
		}
		return new TextDecoder().decode(buf).trim();
	}

	async function onSignedFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		reading = true;
		signError = null;
		loadedName = null;
		try {
			const signed = await readFileAsBase64(file);
			if (!signed) {
				signError = 'That file was empty — pick the signed PSBT your signer exported.';
				return;
			}
			loadedName = file.name;
			onsigned(signed);
		} catch {
			signError = 'Could not read that file. Make sure it is the signed .psbt.';
		} finally {
			reading = false;
			input.value = '';
		}
	}

	function submitPaste() {
		const text = pastedPsbt.trim();
		if (!text) return;
		signError = null;
		onsigned(text);
	}
</script>

<div class="card card-pad method-active">
	<div class="method-head">
		<span class="method-icon"><Icon name="wallet" size={18} /></span>
		<div class="grow">
			<h3 class="method-title">Sign with {keyName} — file</h3>
			<p class="method-sub">
				ColdCard, Sparrow, Electrum, or any PSBT-capable signer — download, sign, bring it back
			</p>
		</div>
	</div>

	<!-- Air-gapped devices (ColdCard & co.) refuse to co-sign for a multisig
	     they were never taught — surface the registration file inline. -->
	<div class="register-callout" role="note">
		<Icon name="alert-triangle" size={15} />
		<div>
			<strong>First time signing for “{multisigLabel}” on this device? It may need the wallet
				registered first.</strong>
			ColdCard (and other air-gapped signers) <em>refuse to sign</em> multisig transactions for a
			{threshold}-of-{totalKeys} setup they don't know — that's the device protecting you. If your
			signer declines the PSBT or reports an unknown wallet, import this registration file on it
			once, then retry.
			<div class="register-actions">
				<button type="button" class="btn btn-secondary btn-sm" onclick={downloadRegistration}>
					<Icon name="arrow-down-left" size={14} /> Download registration file
				</button>
			</div>
		</div>
	</div>

	<div class="verify-panel">
		<div class="verify-head">
			<Icon name="alert-triangle" size={15} />
			<span>Verify these on the signing device's screen — not here</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">Amount</span>
			<span class="verify-val tabular">
				{formatBtc(amountSats)} BTC
				<span class="text-muted">· {formatSats(amountSats)} sats</span>
			</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">To address</span>
			<span class="verify-val mono">{destinationAddress}</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">Fee</span>
			<span class="verify-val tabular">{formatSats(feeSats)} sats</span>
		</div>
	</div>

	<ol class="sign-steps">
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Download the transaction (PSBT)</span>
				<span class="hint">
					It already carries every signature collected so far — your signer adds one more.
				</span>
				<button type="button" class="btn btn-secondary btn-sm" onclick={downloadPsbt}>
					<Icon name="arrow-down-left" size={14} /> Download .psbt
				</button>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Sign with {keyName}</span>
				<span class="hint">
					Open the file in the wallet or device that holds this key, verify the recipient and
					amount on the device screen, sign, and export the signed PSBT. Don't worry if the export
					still says “partially signed” — that's expected until the last key.
				</span>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Bring the signed PSBT back</span>
				<label class="file-drop" class:busy={reading}>
					<input
						type="file"
						accept=".psbt,.txt,text/plain,application/octet-stream"
						onchange={onSignedFile}
						disabled={reading}
					/>
					{#if reading}
						<span class="spinner"></span>
						<span>Reading…</span>
					{:else if loadedName}
						<Icon name="check" size={15} />
						<span>Loaded {loadedName}</span>
					{:else}
						<Icon name="arrow-up-right" size={15} />
						<span>Upload signed .psbt file</span>
					{/if}
				</label>
				<div class="or-divider"><span>or paste base64 / hex</span></div>
				<textarea class="input mono" rows="3" placeholder="cHNidP8BA…" bind:value={pastedPsbt}
				></textarea>
				<button
					class="btn btn-primary btn-sm"
					onclick={submitPaste}
					disabled={pastedPsbt.trim().length === 0}
				>
					Attach signed transaction
				</button>
				{#if signError}
					<div class="form-error" role="alert">{signError}</div>
				{/if}
			</div>
		</li>
	</ol>
</div>

<style>
	/* Mirrors the .method-active idiom from the send flows. */
	.method-active {
		border-color: var(--border);
	}

	.method-head {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 16px;
	}

	.method-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-control);
		background: var(--accent-muted);
		color: var(--accent);
	}

	.grow {
		min-width: 0;
	}

	.method-title {
		font-size: 15px;
		font-weight: 600;
	}

	.method-sub {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.register-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		margin-bottom: 16px;
	}

	.register-callout :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.register-callout strong {
		display: block;
	}

	.register-actions {
		margin-top: 8px;
	}

	.verify-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		margin-bottom: 16px;
	}

	.verify-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 2px;
	}

	.verify-head :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
	}

	.verify-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		font-size: 13px;
	}

	.verify-label {
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.verify-val {
		color: var(--text);
		font-weight: 500;
		text-align: right;
		word-break: break-all;
		min-width: 0;
	}

	.verify-val.mono {
		font-weight: 400;
		font-size: 12.5px;
	}

	.sign-steps {
		list-style: none;
		counter-reset: sign;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sign-steps li {
		counter-increment: sign;
		display: flex;
		gap: 12px;
	}

	.sign-steps li::before {
		content: counter(sign);
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sign-step-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		flex: 1;
	}

	.sign-step-title {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text);
	}

	.file-drop {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-control);
		padding: 12px;
		color: var(--text-secondary);
		font-size: 13px;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.file-drop:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.file-drop.busy {
		cursor: progress;
	}

	.file-drop input {
		display: none;
	}

	.or-divider {
		display: flex;
		align-items: center;
		text-align: center;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.or-divider::before,
	.or-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
	}

	.or-divider span {
		padding: 0 10px;
	}
</style>
