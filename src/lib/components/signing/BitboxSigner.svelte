<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isWebHidAvailable,
		signPsbtWithBitbox02,
		buildSimpleScriptConfig,
		singleSigAccountPath,
		bitbox02SupportsScriptType,
		buildMultisigScriptConfig,
		multisigAccountPath,
		bitbox02SupportsMultisigScriptType,
		Bitbox02Error,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/bitbox02';
	import type { ScriptType } from '$lib/types';

	// Live USB BitBox02 signing for BOTH send flows — the single component the
	// 2026-07-06 architecture review asked for instead of the former
	// BitboxSigner / MultisigBitboxSigner fork. The connect → verify-on-device →
	// sign idiom is identical for both wallet types; passing `multisig` selects
	// the multisig flow, whose one prerequisite is BitBox02-specific: the device
	// must have the multisig SCRIPT CONFIG registered before it will sign.
	// Unlike Ledger (whose registration yields a persistable HMAC Cairn stores),
	// the bitbox-api registers the config on the device itself during the first
	// btcSignPSBT for that config — so there is no Cairn-side registration record
	// to keep. The user simply approves the wallet on-device the first time, then
	// approves the spend; the driver's single signPsbtWithBitbox02 call covers both.

	interface MultisigContext {
		/** Which multisig key this signature is being collected from. */
		keyName: string;
		/** Index of THIS device's key in the roster (bitbox-api's ourXpubIndex). */
		ourKeyIndex: number;
		multisigName: string;
		threshold: number;
		totalKeys: number;
		scriptType: MultisigScriptType;
		/** The multisig's full cosigner roster, in position order. */
		keys: MultisigSignKey[];
	}

	let {
		unsignedPsbt,
		context,
		multisig,
		onsigned,
		oncancel,
		onusefile
	}: {
		/** Unsigned tx, base64 PSBT. For a multisig this is the CURRENT combined
		 *  PSBT (other cosigners' signatures included). */
		unsignedPsbt: string;
		/** What the user must verify on-device (SignerContext-compatible). The
		 *  wallet scriptType gates single-sig support (the firmware has no legacy
		 *  P2PKH config). */
		context: {
			scriptType?: string;
			destinationAddress: string;
			amountSats: number;
			feeSats: number;
			changeSats: number;
		};
		/** Present → sign as one key of this multisig; absent → single-sig. */
		multisig?: MultisigContext;
		onsigned: (signedPsbtBase64: string) => void;
		/** Optional: surfaced when the user backs out (single-sig flow). */
		oncancel?: () => void;
		/** Optional: route this key through the generic file method instead
		 *  (multisig flow). */
		onusefile?: () => void;
	} = $props();

	// WebHID must only be probed in the browser: navigator.hid does not exist
	// during SSR. We start pessimistic (unavailable) and re-check after mount, so
	// the server-rendered markup is the safe disabled state and never touches
	// navigator. `mounted` gates the whole interactive UI on client hydration.
	let mounted = $state(false);
	let available = $state(false);

	// The script type decides whether the BitBox02 can sign at all: the firmware
	// has no legacy single-sig (P2PKH) or legacy multisig (plain-P2SH) config, so
	// either is a hard "can't sign here" we surface up front rather than mid-flow.
	// svelte-ignore state_referenced_locally
	const scriptSupported = multisig
		? bitbox02SupportsMultisigScriptType(multisig.scriptType)
		: bitbox02SupportsScriptType(context.scriptType as ScriptType);

	// idle → signing → done. Errors live alongside (not a state) so a failed
	// attempt can show the retry button on the still-visible connect card.
	let signing = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);

	onMount(() => {
		mounted = true;
		available = isWebHidAvailable();
	});

	async function connectAndSign() {
		error = null;
		wrongDevice = false;
		signing = true;
		try {
			let signed: string;
			if (multisig) {
				// The device signs under the FULL ordered cosigner set + this device's
				// index + the script type. The first time it sees this config it walks
				// the user through registering the wallet, then signs.
				const scriptConfig = buildMultisigScriptConfig(
					multisig.keys,
					multisig.ourKeyIndex,
					multisig.threshold,
					multisig.scriptType
				);
				const keypath = multisigAccountPath(multisig.scriptType);
				// walletName is shown on-device during the one-time registration the driver
				// performs before the first signature for this multisig (cairn-5kth).
				signed = await signPsbtWithBitbox02(unsignedPsbt, {
					scriptConfig,
					keypath,
					walletName: multisig.multisigName,
					// Verify the connected device is actually this key before signing, so a
					// wrong BitBox02 gets the early, clear wrong_device error (cairn-86n5).
					expectedKey: multisig.keys[multisig.ourKeyIndex]
				});
			} else {
				// Build the single-sig script config + account keypath the device signs
				// under. Both throw a typed Bitbox02Error for an unsupported script type,
				// caught below — but the tile is already gated on scriptSupported.
				const scriptType = context.scriptType as ScriptType;
				const scriptConfig = buildSimpleScriptConfig(scriptType);
				const keypath = singleSigAccountPath(scriptType);
				// The BitBox02 signs the PSBT and hands back the fully-signed PSBT as
				// base64 directly (no per-input merge-back — the device does it).
				signed = await signPsbtWithBitbox02(unsignedPsbt, { scriptConfig, keypath });
			}
			done = true;
			onsigned(signed);
		} catch (err) {
			// signPsbtWithBitbox02 throws typed, plain-language Bitbox02Errors; the
			// wrong_device case names the mismatch. Anything else is surfaced.
			if (err instanceof Bitbox02Error) {
				error = err.message;
				wrongDevice = err.code === 'wrong_device';
			} else {
				error = 'The BitBox02 request failed unexpectedly.';
			}
		} finally {
			signing = false;
		}
	}
</script>

<div class="card card-pad method-active">
	<div class="method-head">
		<span class="method-icon"><Icon name="shield" size={18} /></span>
		<div class="grow">
			<h3 class="method-title">
				{#if multisig}Sign with {multisig.keyName} — BitBox02{:else}BitBox02{/if}
			</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="WebHID is a browser API that lets a web page talk directly to USB devices like a BitBox02 — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					WebHID
				</Term>. Nothing leaves the device but {multisig ? "this key's signature" : 'signatures'}.
			</p>
		</div>
	</div>

	{#if multisig}
		<HowItWorks id="multisig-bitbox02-sign">
			<p>
				Your <strong>private keys never leave the BitBox02</strong>. Cairn hands the device the
				current transaction — including every signature already collected — and the BitBox02 shows
				the destination and amount on its own screen for a spend from this
				<strong>{multisig.threshold}-of-{multisig.totalKeys} multisig wallet</strong>. It returns one more
				signature, which Cairn merges into the transaction.
			</p>
			<p>
				A BitBox02 co-signs only for multisig wallets it has <strong>registered</strong>: the first
				time you sign for “{multisig.multisigName}”, the device walks you through the wallet's name, its
				{multisig.threshold}-of-{multisig.totalKeys} quorum, and every cosigner key, and asks you to approve
				it. That happens once per device, right before the first signature.
			</p>
		</HowItWorks>
	{:else}
		<HowItWorks id="bitbox02-sign">
			<p>
				Your <strong>private keys never leave the BitBox02</strong>. Cairn sends the unsigned
				transaction to the device; the BitBox02 shows you the amount and destination on its own
				screen and asks you to physically confirm. It returns the fully-signed transaction, which
				Cairn broadcasts.
			</p>
			<p>
				The device is the source of truth — always confirm the address <strong>on the BitBox02's
				screen</strong>, not just here, before approving.
			</p>
		</HowItWorks>
	{/if}

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes navigator. -->
		<div class="hint">Checking for device support…</div>
	{:else if !scriptSupported}
		<!-- Legacy script type: the BitBox02 firmware has no config for it. -->
		{#if multisig}
			<div class="unavailable" role="note">
				<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
				<div>
					<p class="unavailable-title" id="bitbox02-unsupported-title">
						A BitBox02 can't sign for this multisig
					</p>
					<p class="hint" id="bitbox02-unsupported-reason">
						This is a legacy (plain P2SH) multisig, and the BitBox02 supports only P2WSH and
						P2SH-P2WSH multisigs. Sign this key with the file method instead.
					</p>
				</div>
			</div>
			{#if onusefile}
				<button
					class="btn btn-secondary"
					onclick={onusefile}
					aria-describedby="bitbox02-unsupported-title bitbox02-unsupported-reason"
				>
					Use the file method for this key
				</button>
			{/if}
		{:else}
			<div class="unavailable" role="note">
				<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
				<div>
					<p class="unavailable-title">The BitBox02 can't sign for this wallet</p>
					<p class="hint">
						This is a legacy (P2PKH) wallet, and the BitBox02 doesn't support legacy single-sig
						accounts. Sign with the Generic wallet / file method instead, or use a SegWit or Taproot
						wallet.
					</p>
				</div>
			</div>
			{#if oncancel}
				<button class="btn btn-secondary" onclick={() => oncancel?.()}>
					<Icon name="chevron-left" size={14} /> Choose another method
				</button>
			{/if}
		{/if}
	{:else if !available}
		<!-- WebHID unavailable: disabled state with a plain-language reason. -->
		<div class="unavailable" role="note">
			<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
			<div>
				<p class="unavailable-title" id="bitbox02-unavailable-title">
					BitBox02 signing isn't available in this browser
				</p>
				<p class="hint" id="bitbox02-unavailable-reason">
					It needs
					<Term tip="A browser API for talking to USB devices directly.">WebHID</Term>, which is
					only in Chromium-based desktop browsers — Chrome, Edge, or Brave — served over HTTPS or
					localhost. Open this page in one of those, or {multisig
						? 'sign this key with the file method instead'
						: 'use the Generic wallet / file method instead'}.
				</p>
			</div>
		</div>
		{#if multisig && onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="bitbox02-unavailable-title bitbox02-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{:else if !multisig}
			<button class="btn btn-secondary" disabled>
				<Icon name="shield" size={15} /> Connect BitBox02
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your BitBox02</p>
				<p class="hint">
					{#if multisig}
						{multisig.keyName}'s signature was merged into the transaction — the quorum tracker
						above shows what's still needed.
					{:else}
						The signed transaction was handed back for the final review step.
					{/if}
				</p>
			</div>
		</div>
	{:else}
		{#if multisig}
			<!-- One-time prerequisite, framed as the device protecting the user. -->
			<div class="register-callout" role="note">
				<Icon name="alert-triangle" size={15} />
				<div>
					<strong>First time signing with “{multisig.multisigName}” on a BitBox02? A one-time registration
						comes first.</strong>
					Your BitBox02 reviews and stores this wallet's details — the name, the
					{multisig.threshold}-of-{multisig.totalKeys} quorum, and every cosigner key — and asks you to
					approve them on the device. That's the BitBox02 protecting you: it will never quietly co-sign
					for a wallet you haven't personally vetted on its screen. It happens once per device, right
					before this first signature.
				</div>
			</div>
		{/if}

		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your BitBox02 before approving</span>
			</div>
			<p class="verify-body">
				{#if multisig}
					The BitBox02 will present this as a spend from the
					<strong>{multisig.threshold}-of-{multisig.totalKeys} multisig wallet</strong> and walk through each
					output. Check the address <strong>on the BitBox02's screen</strong> — not just here — matches:
				{:else}
					Your device will ask you to confirm this transaction. Check the address
					<strong>on the BitBox02's screen</strong> — not just here — matches:
				{/if}
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
						<dt>{multisig ? 'Change back to the wallet' : 'Change back'}</dt>
						<dd class="num">{formatSats(context.changeSats)} sats</dd>
					</div>
				{/if}
			</dl>
			<p class="verify-warn">
				If the address on the device screen does not match the one above, reject it on the
				BitBox02. A compromised computer can lie about what's on this page — the device screen
				can't be tampered with the same way.
			</p>
		</div>

		{#if !multisig}
			<!-- First connection only: the BitBox02 shows a short pairing code to
			     confirm on-device (Noise trust-on-first-use). Framed here so it isn't
			     a surprise — the driver's sign path handles the confirmation on-device.
			     The multisig flow folds this into its registration callout + hint. -->
			<div class="pairing-callout" role="note">
				<Icon name="shield" size={15} />
				<div>
					<strong>First time connecting this BitBox02 here?</strong>
					The device shows a short pairing code the first time — confirm it on the BitBox02 to pair.
					After that, connecting goes straight to signing.
				</div>
			</div>
		{/if}

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if multisig && wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the BitBox02 that holds <strong>{multisig.keyName}</strong>'s key — or pick a
						different key chip above to sign with the device you have connected.
					</p>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={signing}>
				{#if signing}
					<span class="spinner"></span>
					{multisig ? 'Approve on your BitBox02…' : 'Confirm on your BitBox02…'}
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else}
					<Icon name="shield" size={15} /> Connect BitBox02 &amp; sign
				{/if}
			</button>
			{#if !multisig && oncancel && !signing}
				<button class="btn btn-ghost" onclick={() => oncancel?.()}>Cancel</button>
			{/if}
		</div>

		{#if signing}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} />
				{#if multisig}
					Pick your BitBox02 from the browser prompt and unlock it. On a first connection, confirm
					the pairing code; the first time you sign for “{multisig.multisigName}”, approve the
					wallet's registration too. Then confirm the transaction — check the address on the
					BitBox02's screen first.
				{:else}
					Pick your BitBox02 from the browser prompt and unlock it. On a first connection, confirm
					the pairing code on the device, then confirm the transaction. Check the address on the
					BitBox02's screen first.
				{/if}
			</p>
		{/if}

		{#if multisig && onusefile && !signing}
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

	/* One-time registration callout — warning-toned like the Ledger one: a hard
	   device-side prerequisite, not optional education. */
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

	/* First-connection pairing code — accent-toned, it's a step to complete. */
	.pairing-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		margin-bottom: 14px;
	}

	.pairing-callout :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.pairing-callout strong {
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
