<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isWebSerialAvailable,
		signPsbtWithJade,
		registerMultisigWithJade,
		JadeError,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/jade';

	// Live USB multisig signing for one multisig key. A multisig-local sibling of the
	// wallets flow's JadeUsbSigner (same connect → verify-on-device → sign idiom),
	// with the Jade-specific multisig prerequisite handled inline: Jade refuses to
	// co-sign a multisig it has not REGISTERED — a one-time on-device review of the
	// wallet's name, quorum and every cosigner key. Jade stores that registration
	// itself (there is no Cairn-side record to keep, unlike Ledger's HMAC), and
	// re-registering the same descriptor is idempotent, so this signer registers
	// then signs each time; a device that already knows the wallet simply
	// re-confirms and moves on. Jade speaks raw PSBT BYTES, so we base64-decode the
	// PSBT before signing and re-encode the signed bytes for the parent's attach path.
	let {
		unsignedPsbt,
		keyName,
		ourKeyIndex,
		multisigName,
		threshold,
		totalKeys,
		scriptType,
		multisigKeys,
		destinationAddress,
		amountSats,
		feeSats,
		changeSats = 0,
		onsigned,
		onusefile
	}: {
		/** The CURRENT combined PSBT (other cosigners' signatures included). */
		unsignedPsbt: string;
		/** Which multisig key this signature is being collected from. */
		keyName: string;
		/** Index of THIS key in the roster — used to verify the right Jade is plugged in. */
		ourKeyIndex: number;
		multisigName: string;
		threshold: number;
		totalKeys: number;
		scriptType: MultisigScriptType;
		/** The multisig's full cosigner roster, in position order. */
		multisigKeys: MultisigSignKey[];
		destinationAddress: string;
		amountSats: number;
		feeSats: number;
		changeSats?: number;
		onsigned: (signedPsbtBase64: string) => void;
		/** Route this key through the generic file method instead. */
		onusefile?: () => void;
	} = $props();

	// Web Serial must only be probed in the browser: navigator.serial does not
	// exist during SSR. Start pessimistic and re-check after mount.
	let mounted = $state(false);
	let available = $state(false);

	type Phase = 'idle' | 'registering' | 'signing';
	let phase = $state<Phase>('idle');
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);

	const busy = $derived(phase !== 'idle');

	onMount(() => {
		mounted = true;
		available = isWebSerialAvailable();
	});

	// Jade takes raw PSBT bytes; the parent works in base64. Decode before, encode
	// after, so nothing else in the flow has to know Jade is byte-oriented.
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

	function fail(err: unknown) {
		if (err instanceof JadeError) {
			error = err.message;
			wrongDevice = err.code === 'wrong_device';
		} else {
			error = 'The Jade request failed unexpectedly.';
		}
	}

	async function connectAndSign() {
		error = null;
		wrongDevice = false;
		try {
			// One-time on-device registration first — idempotent, so it's safe to run
			// every time; a Jade that already knows this wallet just re-confirms.
			phase = 'registering';
			await registerMultisigWithJade({
				name: multisigName,
				threshold,
				keys: multisigKeys,
				scriptType,
				// Verify the connected Jade is actually this key before registering/signing,
				// so a wrong device gets the early, clear wrong_device error (cairn-86n5).
				expectedKey: multisigKeys[ourKeyIndex]
			});

			phase = 'signing';
			const psbtBytes = base64ToBytes(unsignedPsbt);
			// Cairn is mainnet-only; the driver ignores the network arg and uses its
			// canonical one, but we pass it for parity with the driver signature.
			const signedBytes = await signPsbtWithJade('mainnet', psbtBytes);
			done = true;
			onsigned(bytesToBase64(signedBytes));
		} catch (err) {
			fail(err);
		} finally {
			if (!done) phase = 'idle';
		}
	}
</script>

<div class="card card-pad method-active">
	<div class="method-head">
		<span class="method-icon"><Icon name="shield" size={18} /></span>
		<div class="grow">
			<h3 class="method-title">Sign with {keyName} — Jade (USB)</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="Web Serial is a browser API that lets a web page talk to a USB serial device like a Blockstream Jade — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					Web Serial
				</Term>. Nothing leaves the device but this key's signature.
			</p>
		</div>
	</div>

	<HowItWorks id="multisig-jade-usb-sign">
		<p>
			Your <strong>private keys never leave the Jade</strong>. Cairn hands the device the current
			transaction — including every signature already collected — and the Jade shows the
			destination and amount on its own screen for a spend from this
			<strong>{threshold}-of-{totalKeys} multisig wallet</strong>. It returns one more signature,
			which Cairn merges into the transaction.
		</p>
		<p>
			A Jade co-signs only for multisig wallets it has <strong>registered</strong>: a one-time
			on-device review of the wallet's name, its {threshold}-of-{totalKeys} quorum, and every
			cosigner key. Jade remembers that approval, so after the first time it goes straight to
			signing.
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
				<p class="unavailable-title" id="jade-unavailable-title">
					Jade (USB) signing isn't available in this browser
				</p>
				<p class="hint" id="jade-unavailable-reason">
					It needs
					<Term tip="A browser API for talking to USB serial devices directly.">Web Serial</Term>,
					which is only in Chromium-based desktop browsers — Chrome, Edge, or Brave — served over
					HTTPS or localhost. Open this page in one of those, or sign this key with the file method
					instead.
				</p>
			</div>
		</div>
		{#if onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="jade-unavailable-title jade-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Jade</p>
				<p class="hint">
					{keyName}'s signature was merged into the transaction — the quorum tracker above shows
					what's still needed.
				</p>
			</div>
		</div>
	{:else}
		<!-- One-time prerequisite, framed as the device protecting the user. -->
		<div class="register-callout" role="note">
			<Icon name="alert-triangle" size={15} />
			<div>
				<strong>First time signing with “{multisigName}” on a Jade? A one-time registration comes
					first.</strong>
				Your Jade reviews and stores this wallet's details — the name, the
				{threshold}-of-{totalKeys} quorum, and every cosigner key — and asks you to approve them on
				the device. That's the Jade protecting you: it will never quietly co-sign for a wallet you
				haven't personally vetted on its screen. Jade remembers the approval, so this happens once
				per device.
			</div>
		</div>

		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Jade before approving</span>
			</div>
			<p class="verify-body">
				The Jade will present this as a spend from the registered
				<strong>{threshold}-of-{totalKeys} multisig wallet</strong> and walk through each output.
				Check the address <strong>on the Jade's screen</strong> — not just here — matches:
			</p>
			<dl class="verify-facts">
				<div class="fact">
					<dt>Sending</dt>
					<dd class="num">{formatSats(amountSats)} sats</dd>
				</div>
				<div class="fact">
					<dt>To</dt>
					<dd>
						<CopyText
							value={destinationAddress}
							display={truncateMiddle(destinationAddress, 14, 12)}
						/>
					</dd>
				</div>
				<div class="fact">
					<dt>Network fee</dt>
					<dd class="num">{formatSats(feeSats)} sats</dd>
				</div>
				{#if changeSats > 0}
					<div class="fact">
						<dt>Change back to the wallet</dt>
						<dd class="num">{formatSats(changeSats)} sats</dd>
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
			<div class="form-error" role="alert">
				{error}
				{#if wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Jade that holds <strong>{keyName}</strong>'s key — or pick a different key
						chip above to sign with the device you have connected.
					</p>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={busy}>
				{#if phase === 'registering'}
					<span class="spinner"></span> Approve the wallet on your Jade…
				{:else if phase === 'signing'}
					<span class="spinner"></span> Approve on your Jade…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else}
					<Icon name="shield" size={15} /> Connect Jade — register &amp; sign
				{/if}
			</button>
		</div>

		{#if phase === 'registering'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Pick your Jade from the browser's serial-port prompt and
				unlock it with your PIN. It shows “{multisigName}”, the {threshold}-of-{totalKeys} quorum,
				and each cosigner key — approve each screen to register the wallet.
			</p>
		{:else if phase === 'signing'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Waiting for you to confirm the transaction on the Jade.
				Check the address on the Jade's screen first.
			</p>
		{/if}

		{#if onusefile && !busy}
			<p class="fallback-line">
				or <button type="button" class="fallback-link" onclick={onusefile}>sign with the file
					method instead</button>
			</p>
		{/if}
	{/if}
</div>

<style>
	/* Mirror the send flows' .method-active card idiom (icon head + callouts). */
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
		line-height: 1.5;
	}

	/* One-time registration callout — warning-toned like the Ledger one. */
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
		margin-bottom: 14px;
	}

	.register-callout :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.register-callout strong {
		display: block;
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

	/* "or sign with the file method instead" — a quiet inline escape hatch. */
	.fallback-line {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 12px;
	}

	.fallback-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
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
