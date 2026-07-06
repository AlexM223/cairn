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
		buildMultisigScriptConfig,
		multisigAccountPath,
		bitbox02SupportsMultisigScriptType,
		Bitbox02Error,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/bitbox02';

	// Live USB multisig signing for one multisig key. A multisig-local sibling of the
	// wallets flow's BitboxSigner (same connect → verify-on-device → sign idiom),
	// with the BitBox02-specific multisig prerequisite handled inline: the device
	// must have the multisig SCRIPT CONFIG registered before it will sign. Unlike
	// Ledger (whose registration yields a persistable HMAC Cairn stores), the
	// bitbox-api registers the config on the device itself during the first
	// btcSignPSBT for that config — so there is no Cairn-side registration record
	// to keep. The user simply approves the wallet on-device the first time, then
	// approves the spend; the driver's single signPsbtWithBitbox02 call covers both.
	let {
		unsignedPsbt,
		keyName,
		keyFingerprint,
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
		/** That key's recorded master fingerprint ('00000000' when unknown). */
		keyFingerprint: string;
		/** Index of THIS device's key in the roster (bitbox-api's ourXpubIndex). */
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

	// WebHID must only be probed in the browser: navigator.hid does not exist
	// during SSR. Start pessimistic and re-check after mount.
	let mounted = $state(false);
	let available = $state(false);

	// The BitBox02 can't sign a plain-P2SH multisig — the device firmware has no
	// legacy-P2SH multisig script config. That's a hard "can't sign here" we show
	// up front rather than failing mid-flow.
	// svelte-ignore state_referenced_locally
	const scriptSupported = bitbox02SupportsMultisigScriptType(scriptType);

	// idle → signing → done. Errors live alongside (not a state) so a failed
	// attempt keeps the retry button on the still-visible connect card.
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
			// The device signs under the FULL ordered cosigner set + this device's
			// index + the script type. The first time it sees this config it walks
			// the user through registering the wallet, then signs.
			const scriptConfig = buildMultisigScriptConfig(
				multisigKeys,
				ourKeyIndex,
				threshold,
				scriptType
			);
			const keypath = multisigAccountPath(scriptType);
			// walletName is shown on-device during the one-time registration the driver
			// performs before the first signature for this multisig (cairn-5kth).
			const signed = await signPsbtWithBitbox02(unsignedPsbt, {
				scriptConfig,
				keypath,
				walletName: multisigName,
				// Verify the connected device is actually this key before signing, so a
				// wrong BitBox02 gets the early, clear wrong_device error (cairn-86n5).
				expectedKey: multisigKeys[ourKeyIndex]
			});
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
			<h3 class="method-title">Sign with {keyName} — BitBox02</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="WebHID is a browser API that lets a web page talk directly to USB devices like a BitBox02 — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					WebHID
				</Term>. Nothing leaves the device but this key's signature.
			</p>
		</div>
	</div>

	<HowItWorks id="multisig-bitbox02-sign">
		<p>
			Your <strong>private keys never leave the BitBox02</strong>. Cairn hands the device the
			current transaction — including every signature already collected — and the BitBox02 shows
			the destination and amount on its own screen for a spend from this
			<strong>{threshold}-of-{totalKeys} multisig wallet</strong>. It returns one more signature,
			which Cairn merges into the transaction.
		</p>
		<p>
			A BitBox02 co-signs only for multisig wallets it has <strong>registered</strong>: the first
			time you sign for “{multisigName}”, the device walks you through the wallet's name, its
			{threshold}-of-{totalKeys} quorum, and every cosigner key, and asks you to approve it. That
			happens once per device, right before the first signature.
		</p>
	</HowItWorks>

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes navigator. -->
		<div class="hint">Checking for device support…</div>
	{:else if !scriptSupported}
		<!-- Plain-P2SH multisig: the BitBox02 firmware has no config for it. -->
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
					localhost. Open this page in one of those, or sign this key with the file method instead.
				</p>
			</div>
		</div>
		{#if onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="bitbox02-unavailable-title bitbox02-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your BitBox02</p>
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
				<strong>First time signing with “{multisigName}” on a BitBox02? A one-time registration
					comes first.</strong>
				Your BitBox02 reviews and stores this wallet's details — the name, the
				{threshold}-of-{totalKeys} quorum, and every cosigner key — and asks you to approve them on
				the device. That's the BitBox02 protecting you: it will never quietly co-sign for a wallet
				you haven't personally vetted on its screen. It happens once per device, right before this
				first signature.
			</div>
		</div>

		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your BitBox02 before approving</span>
			</div>
			<p class="verify-body">
				The BitBox02 will present this as a spend from the
				<strong>{threshold}-of-{totalKeys} multisig wallet</strong> and walk through each output.
				Check the address <strong>on the BitBox02's screen</strong> — not just here — matches:
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
				If the address on the device screen does not match the one above, reject it on the
				BitBox02. A compromised computer can lie about what's on this page — the device screen
				can't be tampered with the same way.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the BitBox02 that holds <strong>{keyName}</strong>'s key — or pick a different
						key chip above to sign with the device you have connected.
					</p>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={signing}>
				{#if signing}
					<span class="spinner"></span> Approve on your BitBox02…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else}
					<Icon name="shield" size={15} /> Connect BitBox02 &amp; sign
				{/if}
			</button>
		</div>

		{#if signing}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Pick your BitBox02 from the browser prompt and unlock it.
				On a first connection, confirm the pairing code; the first time you sign for
				“{multisigName}”, approve the wallet's registration too. Then confirm the transaction —
				check the address on the BitBox02's screen first.
			</p>
		{/if}

		{#if onusefile && !signing}
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
