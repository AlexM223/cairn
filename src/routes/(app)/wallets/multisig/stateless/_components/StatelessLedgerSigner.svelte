<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isWebHidAvailable,
		signMultisigPsbtWithLedger,
		registerMultisigPolicy,
		sanitizeMultisigPolicyName,
		LedgerError,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/ledger';

	// Ledger signing for the STATELESS flow: register + sign, every session.
	//
	// A Ledger only co-signs a named BIP-388 policy it has REGISTERED — the
	// registration yields an HMAC the app must present with every sign request.
	// The persistent flow (MultisigLedgerSigner) stores that HMAC via
	// /api/wallets/multisig/[id]/ledger-registration so later sessions skip straight to
	// signing. A stateless multisig has no row to hang the HMAC on, so this
	// sibling takes the honest simplest path instead: run the on-device
	// registration each session, keep the returned HMAC in component memory,
	// and sign with it. The extra cost is one on-device policy review per
	// session — annoying but safe (the review IS the security feature); anyone
	// who wants the one-time registration wants a persistent multisig.
	let {
		unsignedPsbt,
		keyName,
		multisigLabel,
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
		/** Which config key this signature is being collected from. */
		keyName: string;
		multisigLabel: string;
		threshold: number;
		totalKeys: number;
		scriptType: MultisigScriptType;
		/** The multisig's full cosigner roster, in config order. */
		multisigKeys: MultisigSignKey[];
		destinationAddress: string;
		amountSats: number;
		feeSats: number;
		changeSats?: number;
		onsigned: (signedPsbtBase64: string) => void;
		/** Route this key through the generic file method instead. */
		onusefile?: () => void;
	} = $props();

	// WebHID must only be probed in the browser (no navigator.hid during SSR).
	let mounted = $state(false);
	let available = $state(false);

	// This SESSION's registration (masterFp → HMAC), memory only. Signing a
	// second key on the same device within one page lifetime skips the
	// re-review; a reload starts over — that's the stateless deal.
	let sessionRegistration = $state<{ policyName: string; policyHmac: string } | null>(null);

	type Phase = 'idle' | 'registering' | 'signing';
	let phase = $state<Phase>('idle');
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);

	const busy = $derived(phase !== 'idle');

	onMount(() => {
		mounted = true;
		available = isWebHidAvailable();
	});

	function fail(err: unknown) {
		if (err instanceof LedgerError) {
			error = err.message;
			wrongDevice = err.code === 'wrong_device';
		} else {
			error = 'The Ledger request failed unexpectedly.';
		}
	}

	async function connectAndSign() {
		error = null;
		wrongDevice = false;
		try {
			let reg = sessionRegistration;
			if (!reg) {
				// One on-device policy review per session — nothing is persisted.
				phase = 'registering';
				const result = await registerMultisigPolicy({
					policyName: multisigLabel,
					threshold,
					keys: multisigKeys,
					scriptType
				});
				reg = {
					policyName: sanitizeMultisigPolicyName(multisigLabel),
					policyHmac: result.policyHmac
				};
				sessionRegistration = reg;
			}

			phase = 'signing';
			const signed = await signMultisigPsbtWithLedger({
				unsignedPsbt,
				threshold,
				keys: multisigKeys,
				scriptType,
				policyName: reg.policyName,
				policyHmac: reg.policyHmac
			});
			done = true;
			onsigned(signed);
		} catch (err) {
			// A stale in-memory HMAC (device swapped mid-session) re-registers on
			// the next attempt rather than wedging.
			if (err instanceof LedgerError && err.code === 'policy_unregistered') {
				sessionRegistration = null;
			}
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
			<h3 class="method-title">Sign with {keyName} — Ledger</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="WebHID is a browser API that lets a web page talk directly to USB devices like a Ledger — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					WebHID
				</Term>. Nothing leaves the device but this key's signature.
			</p>
		</div>
	</div>

	<HowItWorks id="stateless-ledger-sign">
		<p>
			Your <strong>private keys never leave the Ledger</strong>. It shows the destination and
			amount on its own screen for a spend from this
			<strong>{threshold}-of-{totalKeys} wallet</strong> and returns one more signature.
		</p>
		<p>
			A Ledger co-signs only for multisig wallets it has <strong>registered</strong> — an on-device
			review of the quorum and every cosigner key. Because this page saves
			<strong>nothing</strong>, that approval can't be remembered between sessions: the Ledger will
			walk you through the registration again each time you come back. (Import the config as a
			persistent multisig wallet if you want one-time registration.)
		</p>
	</HowItWorks>

	{#if !mounted}
		<div class="hint">Checking for device support…</div>
	{:else if !available}
		<div class="unavailable" role="note">
			<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
			<div>
				<p class="unavailable-title">Ledger signing isn't available in this browser</p>
				<p class="hint">
					It needs
					<Term tip="A browser API for talking to USB devices directly.">WebHID</Term>, which is
					only in Chromium-based desktop browsers — Chrome, Edge, or Brave — served over HTTPS or
					localhost. Open this page in one of those, or sign this key with the file method
					instead.
				</p>
			</div>
		</div>
		{#if onusefile}
			<button class="btn btn-secondary" onclick={onusefile}>
				Use the file method for this key
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Ledger</p>
				<p class="hint">
					{keyName}'s signature was merged into the transaction — the quorum tracker above shows
					what's still needed.
				</p>
			</div>
		</div>
	{:else}
		{#if !sessionRegistration}
			<div class="register-callout" role="note">
				<Icon name="alert-triangle" size={15} />
				<div>
					<strong>Your Ledger will review “{sanitizeMultisigPolicyName(multisigLabel)}” before
						signing.</strong>
					It shows the {threshold}-of-{totalKeys} quorum and every cosigner key for on-device
					approval. Because this stateless page saves nothing, the approval happens
					<em>each session</em> — that's the trade for never storing your config.
				</div>
			</div>
		{/if}

		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Ledger before approving</span>
			</div>
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
				If the address on the device screen does not match the one above, reject it on the Ledger.
				A compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Ledger that holds <strong>{keyName}</strong>'s key — or pick a different
						key chip above to sign with the device you have connected.
					</p>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={connectAndSign} disabled={busy}>
				{#if phase === 'registering'}
					<span class="spinner"></span> Approve the multisig wallet on your Ledger…
				{:else if phase === 'signing'}
					<span class="spinner"></span> Approve on your Ledger…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else if sessionRegistration}
					<Icon name="shield" size={15} /> Connect Ledger &amp; sign
				{:else}
					<Icon name="shield" size={15} /> Connect Ledger — register &amp; sign
				{/if}
			</button>
		</div>

		{#if phase === 'registering'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> On the Ledger: unlock it, open the Bitcoin app, and step
				through the registration — it shows “{sanitizeMultisigPolicyName(multisigLabel)}”, the
				{threshold}-of-{totalKeys} quorum, and each cosigner key. Approve each screen.
			</p>
		{:else if phase === 'signing'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Waiting for you to unlock the device, open the Bitcoin
				app, and approve. Confirm the address on the Ledger's screen first.
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
	/* Mirror the send flows' .method-active card idiom. */
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
