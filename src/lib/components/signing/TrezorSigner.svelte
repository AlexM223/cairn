<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import DeviceHelpLink from '$lib/components/signing/DeviceHelpLink.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isTrezorConnectAvailable,
		signPsbtWithTrezor,
		signMultisigPsbtWithTrezor,
		TrezorError,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/trezor';

	// Live USB Trezor signing for BOTH send flows — the single component the
	// 2026-07-06 architecture review asked for instead of the former
	// TrezorSigner / MultisigTrezorSigner fork. The connect → verify-on-device →
	// sign idiom is identical for both wallet types; passing `multisig` selects
	// the multisig flow, whose differences are confined to copy and the sign
	// call: the FULL cosigner set travels to the device with every request, the
	// Trezor shows the multisig's M-of-N quorum on its own screen each time (no
	// registration step — unlike Ledger/ColdCard, Trezor keeps no persistent
	// multisig memory), and the signed PSBT that comes back still carries every
	// previously collected signature — the device only ADDS one.

	interface MultisigContext {
		/** Which multisig key this signature is being collected from. */
		keyName: string;
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
		/** What the user must verify on-device (SignerContext-compatible). */
		context: {
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

	// The availability check must only run in the browser: window does not
	// exist during SSR. We start pessimistic (unavailable) and re-check after
	// mount, so the server-rendered markup is the safe disabled state and never
	// touches window. `mounted` gates the whole interactive UI on client hydration.
	let mounted = $state(false);
	let available = $state(false);

	// idle → signing → done. Errors live alongside (not a state) so a failed
	// attempt can show the retry button on the still-visible connect card.
	let signing = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);
	// Set when the driver's device call hit its DEVICE_TIMEOUT_MS budget
	// (cairn-zv34) rather than a normal on-device rejection — a frozen,
	// unattended popup, or a locked Trezor. The `finally` below already
	// recovers `signing` to false; this only adds a more specific hint.
	let timedOut = $state(false);

	onMount(() => {
		mounted = true;
		available = isTrezorConnectAvailable();
	});

	async function connectAndSign() {
		error = null;
		wrongDevice = false;
		timedOut = false;
		signing = true;
		try {
			const signed = multisig
				? await signMultisigPsbtWithTrezor({
						unsignedPsbt,
						threshold: multisig.threshold,
						keys: multisig.keys,
						scriptType: multisig.scriptType
					})
				: await signPsbtWithTrezor(unsignedPsbt);
			done = true;
			onsigned(signed);
		} catch (err) {
			// The sign functions throw typed, plain-language TrezorErrors — the
			// wrong_device message already names both fingerprints (connected vs
			// expected); timeout means the device/popup never responded within
			// the driver's budget; anything else is surfaced rather than swallowed.
			if (err instanceof TrezorError) {
				error = err.message;
				wrongDevice = err.code === 'wrong_device';
				timedOut = err.code === 'timeout';
			} else {
				error = 'The Trezor request failed unexpectedly.';
				wrongDevice = false;
				timedOut = false;
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
				{#if multisig}Sign with {multisig.keyName} — Trezor{:else}Trezor{/if}
			</h3>
			<p class="method-sub">
				Sign on-device via the
				<Term
					tip="Trezor Connect is Trezor's official browser integration. It opens a small popup window from trezor.io that talks to your device — no extra app or driver, and it works in any modern browser."
				>
					Trezor Connect
				</Term>
				popup. Nothing leaves the device but {multisig ? "this key's signature" : 'signatures'}.
			</p>
		</div>
	</div>

	{#if multisig}
		<HowItWorks id="multisig-trezor-sign">
			<p>
				Your <strong>private keys never leave the Trezor</strong>. Heartwood hands the device the
				current transaction — including every signature already collected — and the Trezor shows
				the full picture on its own screen: that this is a <strong>{multisig.threshold}-of-{multisig.totalKeys}
				multisig spend</strong>, plus the destination and amount. It returns one more signature,
				which Heartwood merges into the transaction.
			</p>
			<p>
				No registration step is needed: unlike some devices, a Trezor doesn't store the wallet — it
				re-checks the complete {multisig.threshold}-of-{multisig.totalKeys} cosigner set with every
				signature, every time. That re-check is the reassurance, not a hurdle.
			</p>
		</HowItWorks>
	{:else}
		<HowItWorks id="trezor-sign">
			<p>
				Your <strong>private keys never leave the Trezor</strong>. Heartwood sends the unsigned
				transaction to the device through Trezor's Connect popup; the Trezor shows you the amount
				and destination on its own screen and asks you to physically approve. It returns only
				signatures, which Heartwood merges back into the transaction to broadcast.
			</p>
			<p>
				The device is the source of truth — always confirm the address <strong>on the Trezor's
				screen</strong>, not just here, before approving.
			</p>
		</HowItWorks>
	{/if}

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes window. -->
		<div class="hint">Checking for device support…</div>
	{:else if !available}
		<!-- Not a browser environment: disabled state with a plain-language reason. -->
		<div class="unavailable" role="note">
			<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
			<div>
				<p class="unavailable-title" id="trezor-unavailable-title">
					Trezor signing isn't available here
				</p>
				<!-- The id ties this reason to the fallback control below: screen
				     reader users landing on the button by control navigation hear
				     WHY the device path is unavailable, not just the workaround. -->
				<p class="hint" id="trezor-unavailable-reason">
					The Trezor Connect popup can't open here. {multisig
						? 'Sign this key with the file method instead'
						: 'Use the Generic wallet / file method instead'}.
				</p>
				<DeviceHelpLink device="trezor" kind="buy" />
			</div>
		</div>
		{#if multisig && onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="trezor-unavailable-title trezor-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{:else if !multisig}
			<button class="btn btn-secondary" disabled>
				<Icon name="shield" size={15} /> Connect Trezor
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Trezor</p>
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
		<!-- Verification callout: the user MUST check the destination on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Trezor before approving</span>
			</div>
			<p class="verify-body">
				{#if multisig}
					The Trezor will present this as a <strong>{multisig.threshold}-of-{multisig.totalKeys}
					multisig transaction</strong> and walk through each output. Check the address
					<strong>on the Trezor's screen</strong> — not just here — matches:
				{:else}
					Your device will ask you to confirm this transaction. Check the address
					<strong>on the Trezor's screen</strong> — not just here — matches:
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
				If the address on the device screen does not match the one above, reject it on the Trezor.
				A compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if multisig && wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Trezor that holds <strong>{multisig.keyName}</strong>'s key — or pick a
						different key chip above to sign with the device you have connected.
					</p>
				{:else if timedOut}
					<p class="hint" style="margin-top: 6px">
						Check that the Connect popup is open and the Trezor is unlocked, then try again.
					</p>
				{/if}
			</div>
			<!-- Official troubleshooting resource — always shown on an error, never
			     flag-gated (it is help, not promotion). -->
			<DeviceHelpLink device="trezor" kind="support" />
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={signing}>
				{#if signing}
					<span class="spinner"></span> Approve on your Trezor…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else}
					<Icon name="shield" size={15} /> Connect Trezor &amp; sign
				{/if}
			</button>
			{#if !multisig && oncancel && !signing}
				<button class="btn btn-ghost" onclick={() => oncancel?.()}>Cancel</button>
			{/if}
		</div>

		{#if signing}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> A Trezor Connect window will open — approve it there, then
				unlock the device and confirm.
				{#if multisig}
					The Trezor shows “{multisig.multisigName}”'s quorum and each output; check the address on
					its screen first.
				{:else}
					Check the address on the Trezor's screen first.
				{/if}
			</p>
		{/if}

		{#if multisig && onusefile && !signing}
			<p class="fallback-line">
				or <button type="button" class="fallback-link" onclick={onusefile}
					>sign with the file method instead</button>
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
