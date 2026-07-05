<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatBtc, formatSats, truncateMiddle } from '$lib/format';
	import { psbtHasKeyOrigin } from '$lib/hw/keyOrigin';
	import type { SignerProps } from './signerContract';

	// ColdCard is an air-gapped signer: there is no device connection to open,
	// no SDK, no USB data link. The whole protocol is a guided file round-trip
	// over a microSD card. Cairn's job here is purely file I/O plus teaching the
	// user the two things that keep an air-gapped signer trustworthy: put the
	// unsigned PSBT on the card, and verify the destination + amount ON THE
	// COLDCARD'S OWN SCREEN — never trusting this browser for the final check.
	//
	// The download link streams the canonical binary .psbt straight from the
	// server — exactly what a ColdCard reads off the card. `unsignedPsbt` is
	// only inspected for the key-origin gate below.
	let { unsignedPsbt, context, onsigned, oncancel }: SignerProps = $props();

	// A ColdCard matches inputs to its own keys via the PSBT's key-origin data.
	// Bare-xpub wallets (no recorded master fingerprint) produce PSBTs without
	// it, so the SD-card round trip is doomed before it starts — warn here
	// instead of after the user has walked a card to the device and back.
	const hasKeyOrigin = $derived(psbtHasKeyOrigin(unsignedPsbt));

	// The server exposes the unsigned PSBT as a binary .psbt file — the format a
	// ColdCard reads from the top level of the card.
	const fileUrl = $derived(
		`/api/wallets/${context.walletId}/transactions/${context.draftId}/file`
	);

	let signError = $state<string | null>(null);
	let reading = $state(false);
	let loadedName = $state<string | null>(null);

	// Read a file the ColdCard wrote back to the SD card. ColdCard writes a raw
	// binary PSBT (magic bytes "psbt\xff" = 0x70 0x73 0x62 0x74 0xff), typically
	// under a *-signed.psbt / shortened name. Some tooling instead saves base64
	// or hex text. Handle both: binary → base64-encode the bytes; text → trim and
	// pass through (the server normalizes base64/hex when it re-parses anyway).
	async function readFileAsBase64(file: File): Promise<string> {
		const buf = new Uint8Array(await file.arrayBuffer());
		const isBinary =
			buf[0] === 0x70 &&
			buf[1] === 0x73 &&
			buf[2] === 0x62 &&
			buf[3] === 0x74 &&
			buf[4] === 0xff;
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
				signError = 'That file was empty — grab the signed PSBT the ColdCard wrote back to the card.';
				return;
			}
			loadedName = file.name;
			onsigned(signed);
		} catch {
			signError = 'Could not read that file. Make sure it is the .psbt the ColdCard saved.';
		} finally {
			reading = false;
			// Let the same card/file be re-selected if the parent bounces it back.
			input.value = '';
		}
	}
</script>

<div class="card card-pad method-active coldcard">
	<div class="method-head">
		<span class="method-icon"><Icon name="shield" size={18} /></span>
		<div class="grow">
			<h3 class="method-title">ColdCard (microSD)</h3>
			<p class="method-sub">
				<Term
					tip="An air-gapped signer never connects to a network or a USB data link. The unsigned transaction travels to it — and the signature travels back — on a microSD card you carry by hand. Malware on this computer can never reach the keys."
					>Air-gapped</Term
				> signing over a microSD card — no cable, no connection
			</p>
		</div>
	</div>

	{#if !hasKeyOrigin}
		<div class="form-error" role="alert">
			<strong>This wallet can't sign on a ColdCard directly.</strong> It was added without
			key-origin data (no master fingerprint recorded), so the ColdCard won't recognize these
			coins as its own and will refuse to sign. Use the
			<strong>Generic wallet / file</strong> method with software that knows this wallet, or
			re-import the wallet with its master fingerprint.
		</div>
		{#if oncancel}
			<div class="coldcard-foot">
				<button type="button" class="btn btn-secondary btn-sm" onclick={oncancel}>
					<Icon name="chevron-left" size={14} /> Choose another method
				</button>
			</div>
		{/if}
	{:else}
	<HowItWorks id="send-coldcard">
		<p>
			Your ColdCard <strong>never touches this computer.</strong> It has no network and no USB data
			link during signing — the transaction crosses the gap on a microSD card. That air gap is the
			whole point: nothing on this machine can reach your keys.
		</p>
		<p>
			Because the card is a one-way courier, <strong>the ColdCard's own screen is the source of
			truth.</strong> This browser could be lying; the device cannot be. Read the destination and
			amount off the ColdCard before you approve.
		</p>
	</HowItWorks>

	<div class="verify-panel">
		<div class="verify-head">
			<Icon name="alert-triangle" size={15} />
			<span>Verify these on the ColdCard screen — not here</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">Amount</span>
			<span class="verify-val tabular">
				{formatBtc(context.amountSats)} BTC
				<span class="text-muted">· {formatSats(context.amountSats)} sats</span>
			</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">To address</span>
			<span class="verify-val mono">{context.destinationAddress}</span>
		</div>
		<div class="verify-row">
			<span class="verify-label">Fee</span>
			<span class="verify-val tabular">{formatSats(context.feeSats)} sats</span>
		</div>
	</div>

	<ol class="sign-steps">
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Save the unsigned PSBT to a microSD card</span>
				<span class="hint">
					Download the file, then copy it to the <strong>top folder</strong> of a FAT32 microSD card.
					ColdCard only sees files with a <code>.psbt</code> extension in the card's root.
				</span>
				<a class="btn btn-secondary btn-sm" href={fileUrl} download>
					<Icon name="arrow-down-left" size={14} /> Download unsigned .psbt
				</a>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Sign on your ColdCard</span>
				<span class="hint">
					Insert the card, choose <em>Ready To Sign</em>, and open the PSBT. On the ColdCard's own
					screen, confirm it is paying <span class="mono inline-addr"
						>{truncateMiddle(context.destinationAddress, 12, 10)}</span
					>
					{formatBtc(context.amountSats)} BTC, then approve. Trust the device screen, not this browser.
					The ColdCard writes a signed file (often named <code>-signed.psbt</code>) back to the card.
				</span>
			</div>
		</li>
		<li>
			<div class="sign-step-body">
				<span class="sign-step-title">Bring the signed file back</span>
				<span class="hint">
					Eject the card, plug it into this computer, and load the signed <code>.psbt</code> the
					ColdCard wrote.
				</span>
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
						<span>Load signed .psbt from the card</span>
					{/if}
				</label>
				{#if signError}
					<div class="form-error" role="alert">{signError}</div>
				{/if}
			</div>
		</li>
	</ol>

	{#if oncancel}
		<div class="coldcard-foot">
			<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>
				<Icon name="x" size={14} /> Use a different method
			</button>
		</div>
	{/if}
	{/if}
</div>

<style>
	/* Mirrors the .method-active idiom from the Sign step so this card sits
	   naturally alongside the generic-file method and the coming-soon tiles. */
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

	/* ---- Verify panel: what the user must read off the device ---- */
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

	/* ---- Numbered workflow (matches send/+page's .sign-steps) ---- */
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

	.coldcard-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}
</style>
