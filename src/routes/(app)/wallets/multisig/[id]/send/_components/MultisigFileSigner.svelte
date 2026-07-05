<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatBtc, formatSats, truncateMiddle } from '$lib/format';

	// The file round trip for one multisig key: download the CURRENT combined
	// PSBT, sign it on/with the device, load the result back. Two flavors of
	// the same protocol:
	//
	//   coldcard — the microSD ritual, with ColdCard-specific menu names and
	//              the first-time multisig-registration callout (an air-gapped
	//              device refuses to co-sign for a multisig it has never seen;
	//              the registration file teaches it the M-of-N policy).
	//   generic  — any PSBT-capable signer (Sparrow, Electrum, Trezor Suite,
	//              Ledger via Sparrow, mobile wallets), download/upload/paste.
	//
	// This is a multisig-local sibling of the wallets flow's ColdCardSigner: that
	// component hard-codes the /api/wallets file URL and predates the
	// registration requirement, so multisig sends get their own copy of the
	// idiom pointed at the multisig endpoints. It stays a pass-through — the
	// DEVICE handles the multisig math; Cairn only ferries the PSBT.
	let {
		flavor,
		fileUrl,
		registrationUrl,
		multisigName,
		threshold,
		totalKeys,
		keyName,
		destinationAddress,
		amountSats,
		feeSats,
		onsigned,
		oncancel
	}: {
		flavor: 'coldcard' | 'generic';
		/** Binary .psbt download for the CURRENT combined PSBT. */
		fileUrl: string;
		/** The multisig registration file (ColdCard format) download. */
		registrationUrl: string;
		multisigName: string;
		threshold: number;
		totalKeys: number;
		/** Which multisig key this round trip is collecting a signature from. */
		keyName: string;
		destinationAddress: string;
		amountSats: number;
		feeSats: number;
		onsigned: (signedPsbtBase64: string) => void;
		oncancel?: () => void;
	} = $props();

	let signError = $state<string | null>(null);
	let reading = $state(false);
	let loadedName = $state<string | null>(null);
	let pastedPsbt = $state('');

	// Binary .psbt files (magic "psbt\xff") are base64-encoded; anything else
	// is treated as the base64/hex text a signer exported. The server
	// normalizes and validates either way.
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
			// Let the same card/file be re-selected if the server bounces it back.
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
		<span class="method-icon"><Icon name={flavor === 'coldcard' ? 'shield' : 'wallet'} size={18} /></span>
		<div class="grow">
			{#if flavor === 'coldcard'}
				<h3 class="method-title">Sign with {keyName} — ColdCard (microSD)</h3>
				<p class="method-sub">
					<Term
						tip="An air-gapped signer never connects to a network or a USB data link. The transaction travels to it — and the signature travels back — on a microSD card you carry by hand."
						>Air-gapped</Term
					> signing over a microSD card — no cable, no connection
				</p>
			{:else}
				<h3 class="method-title">Sign with {keyName} — file</h3>
				<p class="method-sub">
					Sparrow, Electrum, Trezor Suite, or any PSBT-capable signer — download, sign, bring it back
				</p>
			{/if}
		</div>
	</div>

	{#if flavor === 'coldcard'}
		<HowItWorks id="multisig-send-coldcard">
			<p>
				The card only carries the transaction — <strong>your ColdCard's screen is the source of
				truth.</strong> It shows the destination, the amount, and that this is a
				{threshold}-of-{totalKeys} spend from “{multisigName}”. Read those off the device before
				approving; this browser could be lying, the device cannot.
			</p>
			<p>
				The PSBT you download already contains every signature collected so far — the ColdCard
				<em>adds</em> its own and hands the file back.
			</p>
		</HowItWorks>

		<!-- Hard prerequisite, not optional education: a ColdCard REFUSES to sign
		     multisig PSBTs for a wallet it has never been taught — device-side
		     security, so a refusal must read as "go register", not as a bug. -->
		<div class="register-callout" role="note">
			<Icon name="alert-triangle" size={15} />
			<div>
				<strong>First time signing with “{multisigName}” on this ColdCard? Register the multisig wallet on the
					device first.</strong>
				A ColdCard <em>refuses to sign</em> multisig transactions for a multisig wallet it doesn't know —
				that's the device protecting you. Download the registration file, copy it to the microSD
				card alongside the transaction, and import it on the ColdCard under
				<em>Settings → Multisig Wallets → Import from SD</em> — a one-time step per device. If you
				skip it, the ColdCard will report an unknown or unenrolled wallet instead of signing:
				expected, not a bug — register and retry.
				<div class="register-actions">
					<!-- aria-label carries the surrounding paragraph's context so the
					     control makes sense when reached on its own. -->
					<a
						class="btn btn-secondary btn-sm"
						href={registrationUrl}
						download
						aria-label={`Download the registration file that teaches your ColdCard the “${multisigName}” multisig wallet — a one-time import before it will sign`}
					>
						<Icon name="arrow-down-left" size={14} /> Download registration file
					</a>
				</div>
			</div>
		</div>
	{/if}

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
				{#if flavor === 'coldcard'}
					<span class="hint">
						Copy it to the <strong>top folder</strong> of a FAT32 microSD card — the ColdCard only
						sees <code>.psbt</code> files in the card's root.
					</span>
				{:else}
					<span class="hint">
						It already carries every signature collected so far — your signer adds one more.
					</span>
				{/if}
				<a
					class="btn btn-secondary btn-sm"
					href={fileUrl}
					download
					aria-label={`Download the unsigned transaction file (.psbt) to sign with ${keyName}`}
				>
					<Icon name="arrow-down-left" size={14} /> Download .psbt
				</a>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Sign with {keyName}</span>
				<span class="hint">
					{#if flavor === 'coldcard'}
						Insert the card, choose <em>Ready To Sign</em>, and open the PSBT. Confirm on the
						ColdCard that it is paying
						<span class="mono inline-addr">{truncateMiddle(destinationAddress, 12, 10)}</span>
						{formatBtc(amountSats)} BTC, then approve. It writes a signed file (often named
						<code>-signed.psbt</code>) back to the card.
					{:else}
						Open the file in the wallet software that holds this key, verify the recipient and
						amount on the device screen, sign, and export the signed PSBT. Don't worry if the
						export still says “partially signed” — that's expected until the last key.
					{/if}
				</span>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Bring the signed PSBT back</span>
				<label class="file-drop" class:busy={reading}>
					<!-- Explicit aria-label: the wrapping label's visible text mutates
					     through Reading…/Loaded states — the input's accessible name
					     stays stable and carries the key context. -->
					<input
						type="file"
						accept=".psbt,.txt,text/plain,application/octet-stream"
						onchange={onSignedFile}
						disabled={reading}
						aria-label={`Upload the transaction file (.psbt) signed with ${keyName}`}
					/>
					{#if reading}
						<span class="spinner"></span>
						<span>Reading…</span>
					{:else if loadedName}
						<Icon name="check" size={15} />
						<span>Loaded {loadedName}</span>
					{:else}
						<Icon name="arrow-up-right" size={15} />
						<span>{flavor === 'coldcard' ? 'Load signed .psbt from the card' : 'Upload signed .psbt file'}</span>
					{/if}
				</label>
				{#if flavor === 'generic'}
					<div class="or-divider"><span>or paste base64 / hex</span></div>
					<textarea
						class="input mono"
						rows="3"
						placeholder="cHNidP8BA…"
						aria-label={`Paste the transaction signed with ${keyName}, as base64 or hex`}
						bind:value={pastedPsbt}
					></textarea>
					<button
						class="btn btn-primary btn-sm"
						onclick={submitPaste}
						disabled={pastedPsbt.trim().length === 0}
					>
						Attach signed transaction
					</button>
				{/if}
				{#if signError}
					<div class="form-error" role="alert">{signError}</div>
				{/if}
			</div>
		</li>
	</ol>

	{#if oncancel}
		<div class="signer-foot">
			<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>
				<Icon name="x" size={14} /> Use a different key
			</button>
		</div>
	{/if}
</div>

<style>
	/* Mirrors the .method-active idiom from the send flows so this card sits
	   naturally in the per-key stepper. */
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

	/* ---- first-time multisig-registration callout ----
	   Warning-toned: registration is a hard prerequisite (the device refuses
	   to sign otherwise), not optional education. */
	.register-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
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

	/* ---- verify panel (same idiom as the wallet signers) ---- */
	.verify-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
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

	/* ---- numbered workflow ---- */
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

	.sign-step-body code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-chip);
		padding: 0 4px;
	}

	.inline-addr {
		word-break: break-all;
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

	.signer-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}
</style>
