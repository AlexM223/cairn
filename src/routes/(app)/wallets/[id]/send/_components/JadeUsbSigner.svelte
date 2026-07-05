<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import { isWebSerialAvailable, signPsbtWithJade, JadeError } from '$lib/hw/jade';
	import type { SignerProps } from './signerContract';

	let { unsignedPsbt, context, onsigned, oncancel }: SignerProps = $props();

	// Web Serial must only be probed in the browser: navigator.serial does not
	// exist during SSR. We start pessimistic (unavailable) and re-check after
	// mount, so the server-rendered markup is the safe disabled state and never
	// touches navigator. `mounted` gates the whole interactive UI on hydration.
	let mounted = $state(false);
	let available = $state(false);

	// idle → signing → done. Errors live alongside (not a state) so a failed
	// attempt can show the retry button on the still-visible connect card.
	let signing = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		mounted = true;
		available = isWebSerialAvailable();
	});

	// Jade speaks raw PSBT BYTES over Web Serial, not base64 — decode the base64
	// PSBT to bytes before handing it over, and re-encode the signed bytes back
	// to base64 so the parent's attach path (which expects base64) is unchanged.
	function base64ToBytes(b64: string): Uint8Array {
		const bin = atob(b64.trim());
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	function bytesToBase64(bytes: Uint8Array): string {
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin);
	}

	async function connectAndSign() {
		error = null;
		signing = true;
		try {
			const psbtBytes = base64ToBytes(unsignedPsbt);
			// Cairn is mainnet-only; the driver ignores the network arg and uses its
			// canonical one, but we pass it for parity with the driver signature.
			const signedBytes = await signPsbtWithJade('mainnet', psbtBytes);
			const signed = bytesToBase64(signedBytes);
			done = true;
			onsigned(signed);
		} catch (err) {
			// signPsbtWithJade throws typed, plain-language JadeErrors; a base64
			// decode failure (malformed PSBT) is unexpected but still surfaced.
			error = err instanceof JadeError ? err.message : 'The Jade request failed unexpectedly.';
		} finally {
			signing = false;
		}
	}
</script>

<div class="card card-pad method-active">
	<div class="method-head">
		<span class="method-icon"><Icon name="shield" size={18} /></span>
		<div>
			<h3 class="method-title">Jade (USB)</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="Web Serial is a browser API that lets a web page talk to a USB serial device like a Blockstream Jade — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					Web Serial
				</Term>. Nothing leaves the device but signatures.
			</p>
		</div>
	</div>

	<HowItWorks id="jade-usb-sign">
		<p>
			Your <strong>private keys never leave the Jade</strong>. Cairn sends the unsigned
			transaction to the device; the Jade shows you the amount and destination on its own screen
			and asks you to physically confirm. It returns the signed transaction, which Cairn
			broadcasts.
		</p>
		<p>
			The device is the source of truth — always confirm the address <strong>on the Jade's
			screen</strong>, not just here, before approving.
		</p>
	</HowItWorks>

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes navigator. -->
		<div class="hint">Checking for device support…</div>
	{:else if !available}
		<!-- Web Serial unavailable: disabled state with a plain-language reason. -->
		<div class="unavailable" role="note">
			<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
			<div>
				<p class="unavailable-title">Jade (USB) signing isn't available in this browser</p>
				<p class="hint">
					It needs
					<Term tip="A browser API for talking to USB serial devices directly.">Web Serial</Term>,
					which is only in Chromium-based desktop browsers — Chrome, Edge, or Brave — served over
					HTTPS or localhost. Open this page in one of those, or use the Animated QR / file method
					instead.
				</p>
			</div>
		</div>
		<button class="btn btn-secondary" disabled>
			<Icon name="shield" size={15} /> Connect Jade
		</button>
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Jade</p>
				<p class="hint">The signed transaction was handed back for the final review step.</p>
			</div>
		</div>
	{:else}
		<!-- Verification callout: the user MUST check the destination on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Jade before approving</span>
			</div>
			<p class="verify-body">
				Your device will ask you to confirm this transaction. Check the address
				<strong>on the Jade's screen</strong> — not just here — matches:
			</p>
			<dl class="verify-facts">
				<div class="fact">
					<dt>Sending</dt>
					<dd class="num">{formatSats(context.amountSats)} sats</dd>
				</div>
				<div class="fact">
					<dt>To</dt>
					<dd>
						<CopyText
							value={context.destinationAddress}
							display={truncateMiddle(context.destinationAddress, 14, 12)}
						/>
					</dd>
				</div>
				<div class="fact">
					<dt>Network fee</dt>
					<dd class="num">{formatSats(context.feeSats)} sats</dd>
				</div>
				{#if context.changeSats > 0}
					<div class="fact">
						<dt>Change back</dt>
						<dd class="num">{formatSats(context.changeSats)} sats</dd>
					</div>
				{/if}
			</dl>
			<p class="verify-warn">
				If the address on the device screen does not match the one above, reject it on the Jade. A
				compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={signing}>
				{#if signing}
					<span class="spinner"></span> Confirm on your Jade…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else}
					<Icon name="shield" size={15} /> Connect Jade &amp; sign
				{/if}
			</button>
			{#if oncancel && !signing}
				<button class="btn btn-ghost" onclick={() => oncancel?.()}>Cancel</button>
			{/if}
		</div>

		{#if signing}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Pick your Jade from the browser's serial-port prompt,
				unlock it with your PIN, then confirm the transaction on the device. Check the address on
				the Jade's screen first.
			</p>
		{/if}
	{/if}
</div>

<style>
	/* Mirror the send page's .method-active card idiom (icon head + steps). */
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

	.method-title {
		font-size: 15px;
		font-weight: 600;
	}

	.method-sub {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 2px;
		line-height: 1.5;
	}

	.verify-callout {
		border: 1px solid var(--accent-border);
		background: var(--accent-muted);
		border-radius: var(--radius-card);
		padding: 14px;
		margin-bottom: 14px;
	}

	.verify-head {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.verify-body {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-bottom: 12px;
	}

	.verify-body strong {
		color: var(--text);
		font-weight: 600;
	}

	.verify-facts {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0 0 12px;
		padding: 12px;
		background: var(--surface-elevated);
		border-radius: var(--radius-control);
	}

	.fact {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		font-size: 13px;
	}

	.fact dt {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.fact dd {
		margin: 0;
		text-align: right;
		min-width: 0;
	}

	.fact dd.num {
		font-variant-numeric: tabular-nums;
		font-weight: 500;
	}

	.verify-warn {
		font-size: 12px;
		line-height: 1.6;
		color: var(--text-muted);
		margin: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 14px;
	}

	.signing-hint {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		line-height: 1.5;
	}

	/* Unavailable / success blocks share a two-column icon + copy layout. */
	.unavailable,
	.signed-ok {
		display: flex;
		gap: 12px;
		padding: 14px;
		border-radius: var(--radius-card);
		margin-bottom: 12px;
	}

	.unavailable {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
	}

	.unavailable-icon {
		color: var(--text-muted);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.unavailable-title {
		font-size: 13.5px;
		font-weight: 600;
		margin-bottom: 3px;
	}

	.signed-ok {
		background: var(--success-muted);
		border: 1px solid rgba(90, 200, 120, 0.3);
	}

	.ok-icon {
		color: var(--success);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.ok-title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--success);
		margin-bottom: 3px;
	}
</style>
