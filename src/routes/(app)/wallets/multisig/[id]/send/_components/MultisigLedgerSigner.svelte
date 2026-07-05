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

	// Live USB multisig signing for one multisig key. A multisig-local sibling of the
	// wallets flow's LedgerSigner (same connect → verify-on-device → sign
	// idiom) with the Ledger-specific multisig prerequisite handled inline:
	// the app refuses to co-sign a named BIP-388 policy it hasn't REGISTERED —
	// a one-time on-device review of the multisig's name, quorum and every
	// cosigner key that yields an HMAC. Cairn persists that HMAC (it is not a
	// secret; it only spares re-approving), so later signatures from the same
	// device skip straight to signing.
	let {
		multisigId,
		unsignedPsbt,
		keyName,
		keyFingerprint,
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
		multisigId: number;
		/** The CURRENT combined PSBT (other cosigners' signatures included). */
		unsignedPsbt: string;
		/** Which multisig key this signature is being collected from. */
		keyName: string;
		/** That key's recorded master fingerprint ('00000000' when unknown). */
		keyFingerprint: string;
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

	interface StoredRegistration {
		masterFp: string;
		policyName: string;
		policyHmac: string;
		policyId: string | null;
	}

	// WebHID must only be probed in the browser: navigator.hid does not exist
	// during SSR. Start pessimistic and re-check after mount.
	let mounted = $state(false);
	let available = $state(false);

	// Stored registrations for this multisig; null until the lookup resolves. A
	// failed lookup degrades to [] — signing then just takes the register path,
	// which is always safe (the device dedupes: re-approving an already-known
	// policy simply returns a fresh valid HMAC).
	let registrations = $state<StoredRegistration[] | null>(null);

	type Phase = 'idle' | 'signing' | 'registering' | 'saving';
	let phase = $state<Phase>('idle');
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);
	// Set when a sign attempt used a STORED registration and failed — the HMAC
	// may be stale (device reset / re-seeded), so offer re-registration.
	let offerReregister = $state(false);
	// The registration succeeded on-device but Cairn couldn't persist it.
	let saveWarning = $state(false);

	const busy = $derived(phase !== 'idle');

	onMount(() => {
		mounted = true;
		available = isWebHidAvailable();
		if (available) void loadRegistrations();
	});

	async function loadRegistrations() {
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/ledger-registration`);
			const body = await res.json();
			registrations = res.ok && Array.isArray(body.registrations) ? body.registrations : [];
		} catch {
			registrations = [];
		}
	}

	// Which stored registration to try before connecting: the one recorded for
	// the key being signed (we know its fingerprint), else — when the multisig has
	// exactly one Ledger registered — that one. Anything ambiguous falls to the
	// register path, which the device resolves itself.
	const storedRegistration = $derived.by<StoredRegistration | null>(() => {
		if (!registrations || registrations.length === 0) return null;
		if (keyFingerprint && keyFingerprint !== '00000000') {
			const byFp = registrations.find((r) => r.masterFp === keyFingerprint.toLowerCase());
			if (byFp) return byFp;
		}
		return registrations.length === 1 ? registrations[0] : null;
	});
	const needsRegistration = $derived(registrations !== null && storedRegistration === null);

	function fail(err: unknown) {
		if (err instanceof LedgerError) {
			// Typed, plain-language messages; wrong_device already names both
			// fingerprints (connected vs the multisig's expected set).
			error = err.message;
			wrongDevice = err.code === 'wrong_device';
		} else {
			error = 'The Ledger request failed unexpectedly.';
		}
	}

	async function connectAndSign(forceRegister = false) {
		error = null;
		wrongDevice = false;
		offerReregister = false;
		saveWarning = false;

		const reg = forceRegister ? null : storedRegistration;
		try {
			if (reg) {
				// Fast path: this device already approved the multisig — sign directly.
				phase = 'signing';
				try {
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
					return;
				} catch (err) {
					if (err instanceof LedgerError && err.code === 'policy_unregistered') {
						// Stored record unusable — fall through to registration.
					} else {
						fail(err);
						if (err instanceof LedgerError && !wrongDevice && err.code !== 'rejected') {
							offerReregister = true;
						}
						return;
					}
				}
			}

			// Register path: one-time on-device policy approval, persist, then sign.
			phase = 'registering';
			const result = await registerMultisigPolicy({
				policyName: multisigName,
				threshold,
				keys: multisigKeys,
				scriptType
			});
			// The name the HMAC covers is the SANITIZED one the driver registered.
			const policyName = sanitizeMultisigPolicyName(multisigName);

			phase = 'saving';
			try {
				const res = await fetch(`/api/wallets/multisig/${multisigId}/ledger-registration`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						masterFp: result.masterFp,
						policyName,
						policyHmac: result.policyHmac,
						policyId: result.policyId
					})
				});
				if (!res.ok) saveWarning = true;
			} catch {
				saveWarning = true;
			}
			// Keep the local cache honest either way — signing continues with the
			// fresh HMAC the device just handed us.
			registrations = [
				...(registrations ?? []).filter((r) => r.masterFp !== result.masterFp),
				{ masterFp: result.masterFp, policyName, policyHmac: result.policyHmac, policyId: result.policyId }
			];

			phase = 'signing';
			const signed = await signMultisigPsbtWithLedger({
				unsignedPsbt,
				threshold,
				keys: multisigKeys,
				scriptType,
				policyName,
				policyHmac: result.policyHmac
			});
			done = true;
			onsigned(signed);
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

	<HowItWorks id="multisig-ledger-sign">
		<p>
			Your <strong>private keys never leave the Ledger</strong>. Cairn hands the device the current
			transaction — including every signature already collected — and the Ledger shows the
			destination and amount on its own screen for a spend from this
			<strong>{threshold}-of-{totalKeys} multisig wallet</strong>. It returns one more signature, which Cairn
			merges into the transaction.
		</p>
		<p>
			A Ledger co-signs only for multisig wallets it has <strong>registered</strong>: a one-time on-device
			review of the wallet's name, its {threshold}-of-{totalKeys} quorum, and every cosigner key.
			Cairn remembers that approval, so you do it once per device — not per transaction.
		</p>
	</HowItWorks>

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes navigator. -->
		<div class="hint">Checking for device support…</div>
	{:else if !available}
		<!-- WebHID unavailable: disabled state with a plain-language reason. -->
		<div class="unavailable" role="note">
			<span class="unavailable-icon"><Icon name="alert-triangle" size={18} /></span>
			<div>
				<p class="unavailable-title" id="ledger-unavailable-title">
					Ledger signing isn't available in this browser
				</p>
				<!-- The id ties this reason to the fallback control below: screen
				     reader users landing on the button by control navigation hear
				     WHY the device path is unavailable, not just the workaround. -->
				<p class="hint" id="ledger-unavailable-reason">
					It needs
					<Term tip="A browser API for talking to USB devices directly.">WebHID</Term>, which is
					only in Chromium-based desktop browsers — Chrome, Edge, or Brave — served over HTTPS or
					localhost. Open this page in one of those, or sign this key with the file method
					instead.
				</p>
			</div>
		</div>
		{#if onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="ledger-unavailable-title ledger-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
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
		{#if needsRegistration}
			<!-- One-time prerequisite, framed as the device protecting the user. -->
			<div class="register-callout" role="note">
				<Icon name="alert-triangle" size={15} />
				<div>
					<strong>First time signing with “{multisigName}” on a Ledger? A one-time registration comes
						first.</strong>
					Your Ledger reviews and stores this wallet's details — the name, the
					{threshold}-of-{totalKeys} quorum, and every cosigner key — and asks you to approve them
					on the device. That's the Ledger protecting you: it will never quietly co-sign for a
					wallet you haven't personally vetted on its screen. Cairn saves the approval, so
					this happens once per device. Signing continues right after.
				</div>
			</div>
		{/if}

		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Ledger before approving</span>
			</div>
			<p class="verify-body">
				The Ledger will present this as a spend from the registered
				<strong>{threshold}-of-{totalKeys} multisig wallet</strong> and walk through each output. Check the
				address <strong>on the Ledger's screen</strong> — not just here — matches:
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
				If the address on the device screen does not match the one above, reject it on the Ledger.
				A compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if saveWarning}
			<div class="save-warning" role="status" aria-live="polite">
				<Icon name="alert-triangle" size={14} />
				<span>
					The Ledger approved the wallet, but Cairn couldn't save the registration — signing still
					works now, but the device may ask you to register again next time.
				</span>
			</div>
		{/if}

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Ledger that holds <strong>{keyName}</strong>'s key — or pick a different
						key chip above to sign with the device you have connected.
					</p>
				{:else if offerReregister}
					<div class="reregister-actions">
						<button class="btn btn-secondary btn-sm" onclick={() => connectAndSign(true)}>
							<Icon name="refresh" size={14} /> Wallet not recognized on the device? Register it
							again
						</button>
					</div>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={() => connectAndSign()} disabled={busy}>
				{#if phase === 'registering'}
					<span class="spinner"></span> Approve the wallet on your Ledger…
				{:else if phase === 'saving'}
					<span class="spinner"></span> Saving the registration…
				{:else if phase === 'signing'}
					<span class="spinner"></span> Approve on your Ledger…
				{:else if error}
					<Icon name="refresh" size={15} /> Try again
				{:else if needsRegistration}
					<Icon name="shield" size={15} /> Connect Ledger — register &amp; sign
				{:else}
					<Icon name="shield" size={15} /> Connect Ledger &amp; sign
				{/if}
			</button>
			{#if registrations === null}
				<span class="hint">Checking this wallet's Ledger registrations…</span>
			{/if}
		</div>

		{#if phase === 'registering'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> On the Ledger: unlock it, open the Bitcoin app, and step
				through the registration — it shows “{sanitizeMultisigPolicyName(multisigName)}”, the
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

	/* One-time registration callout — warning-toned like the ColdCard/QR ones:
	   a hard device-side prerequisite, not optional education. */
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

	.save-warning {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-secondary);
		background: var(--warning-muted);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		margin-bottom: 12px;
	}

	.save-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.reregister-actions {
		margin-top: 10px;
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
