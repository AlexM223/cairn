<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import DeviceHelpLink from '$lib/components/signing/DeviceHelpLink.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isWebHidAvailable,
		signPsbtWithLedger,
		signMultisigPsbtWithLedger,
		registerMultisigPolicy,
		sanitizeMultisigPolicyName,
		LedgerError,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/ledger';

	// Live USB Ledger signing for ALL THREE send flows — the single component the
	// 2026-07-06 architecture review asked for instead of the former
	// LedgerSigner / MultisigLedgerSigner / StatelessLedgerSigner fork. The
	// connect → verify-on-device → sign idiom is identical everywhere; passing
	// `multisig` selects the multisig flow, which carries the Ledger-specific
	// prerequisite: the app refuses to co-sign a named BIP-388 policy it hasn't
	// REGISTERED — a one-time on-device review of the multisig's name, quorum and
	// every cosigner key that yields an HMAC. Where that HMAC lives splits the
	// multisig flow in two:
	//   - multisig.multisigId present → PERSISTENT: Heartwood stores the HMAC via the
	//     ledger-registration API (it is not a secret; it only spares
	//     re-approving), so later signatures from the same device skip straight
	//     to signing.
	//   - multisigId absent → STATELESS: there is no row to hang the HMAC on, so
	//     the registration runs on-device each session and the HMAC lives in
	//     component memory only — annoying but safe (the review IS the security
	//     feature).

	interface MultisigContext {
		/** Which multisig key this signature is being collected from. */
		keyName: string;
		multisigName: string;
		threshold: number;
		totalKeys: number;
		scriptType: MultisigScriptType;
		/** The multisig's full cosigner roster, in position order. */
		keys: MultisigSignKey[];
		/** Present → persistent multisig whose device registrations load from and
		 *  save to /api/wallets/multisig/[id]/ledger-registration. Absent → the
		 *  stateless flow: register each session, HMAC kept in memory only. */
		multisigId?: number;
		/** The key's recorded master fingerprint ('00000000' when unknown) — picks
		 *  which stored registration to try before connecting (persistent only). */
		keyFingerprint?: string;
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

	interface StoredRegistration {
		masterFp: string;
		policyName: string;
		policyHmac: string;
		policyId: string | null;
	}

	// Persistent = the registration HMAC has a server row to live in.
	const persistent = $derived(multisig?.multisigId != null);

	// WebHID must only be probed in the browser: navigator.hid does not exist
	// during SSR. We start pessimistic (unavailable) and re-check after mount, so
	// the server-rendered markup is the safe disabled state and never touches
	// navigator. `mounted` gates the whole interactive UI on client hydration.
	let mounted = $state(false);
	let available = $state(false);

	// PERSISTENT multisig: stored registrations; null until the lookup resolves.
	// A failed lookup degrades to [] — signing then just takes the register path,
	// which is always safe (the device dedupes: re-approving an already-known
	// policy simply returns a fresh valid HMAC).
	let registrations = $state<StoredRegistration[] | null>(null);

	// STATELESS multisig: this SESSION's registration, memory only. Signing a
	// second key on the same device within one page lifetime skips the
	// re-review; a reload starts over — that's the stateless deal.
	let sessionRegistration = $state<{ policyName: string; policyHmac: string } | null>(null);

	// idle → (registering → saving →) signing → done. Errors live alongside (not
	// a state) so a failed attempt can show the retry button on the still-visible
	// connect card. Only the persistent multisig flow visits registering/saving;
	// stateless skips saving; single-sig goes straight to signing.
	type Phase = 'idle' | 'signing' | 'registering' | 'saving';
	let phase = $state<Phase>('idle');
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);
	// Set when a sign attempt used a STORED registration and failed — the HMAC
	// may be stale (device reset / re-seeded), so offer re-registration.
	let offerReregister = $state(false);
	// The registration succeeded on-device but Heartwood couldn't persist it.
	let saveWarning = $state(false);

	const busy = $derived(phase !== 'idle');

	onMount(() => {
		mounted = true;
		available = isWebHidAvailable();
		if (available && multisig?.multisigId != null) void loadRegistrations();
	});

	async function loadRegistrations() {
		try {
			const res = await fetch(`/api/wallets/multisig/${multisig!.multisigId}/ledger-registration`);
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
		const fp = multisig?.keyFingerprint;
		if (fp && fp !== '00000000') {
			const byFp = registrations.find((r) => r.masterFp === fp.toLowerCase());
			if (byFp) return byFp;
		}
		return registrations.length === 1 ? registrations[0] : null;
	});

	// Whether the NEXT connect will start with an on-device registration — drives
	// the register callout and the button label in both multisig flavors.
	const needsRegistration = $derived(
		multisig
			? persistent
				? registrations !== null && storedRegistration === null
				: sessionRegistration === null
			: false
	);

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

		// Single-sig: no policy prerequisite — connect and sign.
		if (!multisig) {
			phase = 'signing';
			try {
				const signed = await signPsbtWithLedger(unsignedPsbt);
				done = true;
				onsigned(signed);
			} catch (err) {
				fail(err);
			} finally {
				if (!done) phase = 'idle';
			}
			return;
		}

		// Stateless multisig: one on-device policy review per session — nothing
		// is persisted.
		if (multisig.multisigId == null) {
			try {
				let reg = sessionRegistration;
				if (!reg) {
					phase = 'registering';
					const result = await registerMultisigPolicy({
						policyName: multisig.multisigName,
						threshold: multisig.threshold,
						keys: multisig.keys,
						scriptType: multisig.scriptType
					});
					reg = {
						policyName: sanitizeMultisigPolicyName(multisig.multisigName),
						policyHmac: result.policyHmac
					};
					sessionRegistration = reg;
				}

				phase = 'signing';
				const signed = await signMultisigPsbtWithLedger({
					unsignedPsbt,
					threshold: multisig.threshold,
					keys: multisig.keys,
					scriptType: multisig.scriptType,
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
			return;
		}

		// Persistent multisig.
		const reg = forceRegister ? null : storedRegistration;
		try {
			if (reg) {
				// Fast path: this device already approved the multisig — sign directly.
				phase = 'signing';
				try {
					const signed = await signMultisigPsbtWithLedger({
						unsignedPsbt,
						threshold: multisig.threshold,
						keys: multisig.keys,
						scriptType: multisig.scriptType,
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
				policyName: multisig.multisigName,
				threshold: multisig.threshold,
				keys: multisig.keys,
				scriptType: multisig.scriptType
			});
			// The name the HMAC covers is the SANITIZED one the driver registered.
			const policyName = sanitizeMultisigPolicyName(multisig.multisigName);

			phase = 'saving';
			try {
				const res = await fetch(
					`/api/wallets/multisig/${multisig.multisigId}/ledger-registration`,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							masterFp: result.masterFp,
							policyName,
							policyHmac: result.policyHmac,
							policyId: result.policyId
						})
					}
				);
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
				threshold: multisig.threshold,
				keys: multisig.keys,
				scriptType: multisig.scriptType,
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
			<h3 class="method-title">
				{#if multisig}Sign with {multisig.keyName} — Ledger{:else}Ledger{/if}
			</h3>
			<p class="method-sub">
				Sign on-device over
				<Term
					tip="WebHID is a browser API that lets a web page talk directly to USB devices like a Ledger — no extra app or driver. It works in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost."
				>
					WebHID
				</Term>. Nothing leaves the device but {multisig ? "this key's signature" : 'signatures'}.
			</p>
		</div>
	</div>

	{#if !multisig}
		<HowItWorks id="ledger-sign">
			<p>
				Your <strong>private keys never leave the Ledger</strong>. Heartwood sends the unsigned
				transaction to the device; the Ledger shows you the amount and destination on its own
				screen and asks you to physically approve. It returns only signatures, which Heartwood merges
				back into the transaction to broadcast.
			</p>
			<p>
				The device is the source of truth — always confirm the address <strong>on the Ledger's
				screen</strong>, not just here, before approving.
			</p>
		</HowItWorks>
	{:else if persistent}
		<HowItWorks id="multisig-ledger-sign">
			<p>
				Your <strong>private keys never leave the Ledger</strong>. Heartwood hands the device the current
				transaction — including every signature already collected — and the Ledger shows the
				destination and amount on its own screen for a spend from this
				<strong>{multisig.threshold}-of-{multisig.totalKeys} multisig wallet</strong>. It returns one more
				signature, which Heartwood merges into the transaction.
			</p>
			<p>
				A Ledger co-signs only for multisig wallets it has <strong>registered</strong>: a one-time on-device
				review of the wallet's name, its {multisig.threshold}-of-{multisig.totalKeys} quorum, and every
				cosigner key. Heartwood remembers that approval, so you do it once per device — not per transaction.
			</p>
		</HowItWorks>
	{:else}
		<HowItWorks id="stateless-ledger-sign">
			<p>
				Your <strong>private keys never leave the Ledger</strong>. It shows the destination and
				amount on its own screen for a spend from this
				<strong>{multisig.threshold}-of-{multisig.totalKeys} wallet</strong> and returns one more signature.
			</p>
			<p>
				A Ledger co-signs only for multisig wallets it has <strong>registered</strong> — an on-device
				review of the quorum and every cosigner key. Because this page saves
				<strong>nothing</strong>, that approval can't be remembered between sessions: the Ledger will
				walk you through the registration again each time you come back. (Import the config as a
				persistent multisig wallet if you want one-time registration.)
			</p>
		</HowItWorks>
	{/if}

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
					localhost. Open this page in one of those, or {multisig
						? 'sign this key with the file method instead'
						: 'use the Generic wallet / file method instead'}.
				</p>
				<SecureContextHelp what="Ledger signing" />
				<DeviceHelpLink device="ledger" kind="buy" />
			</div>
		</div>
		{#if multisig && onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="ledger-unavailable-title ledger-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{:else if !multisig}
			<button class="btn btn-secondary" disabled>
				<Icon name="shield" size={15} /> Connect Ledger
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Ledger</p>
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
		{#if multisig && needsRegistration}
			<!-- One-time prerequisite, framed as the device protecting the user. -->
			<div class="register-callout" role="note">
				<Icon name="alert-triangle" size={15} />
				{#if persistent}
					<div>
						<strong>First time signing with “{multisig.multisigName}” on a Ledger? A one-time registration comes
							first.</strong>
						Your Ledger reviews and stores this wallet's details — the name, the
						{multisig.threshold}-of-{multisig.totalKeys} quorum, and every cosigner key — and asks you to approve them
						on the device. That's the Ledger protecting you: it will never quietly co-sign for a
						wallet you haven't personally vetted on its screen. Heartwood saves the approval, so
						this happens once per device. Signing continues right after.
					</div>
				{:else}
					<div>
						<strong>Your Ledger will review “{sanitizeMultisigPolicyName(multisig.multisigName)}” before
							signing.</strong>
						It shows the {multisig.threshold}-of-{multisig.totalKeys} quorum and every cosigner key for on-device
						approval. Because this stateless page saves nothing, the approval happens
						<em>each session</em> — that's the trade for never storing your config.
					</div>
				{/if}
			</div>
		{/if}

		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Ledger before approving</span>
			</div>
			{#if !multisig}
				<p class="verify-body">
					Your device will ask you to confirm this transaction. Check the address
					<strong>on the Ledger's screen</strong> — not just here — matches:
				</p>
			{:else if persistent}
				<p class="verify-body">
					The Ledger will present this as a spend from the registered
					<strong>{multisig.threshold}-of-{multisig.totalKeys} multisig wallet</strong> and walk through each
					output. Check the address <strong>on the Ledger's screen</strong> — not just here — matches:
				</p>
			{/if}
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
				If the address on the device screen does not match the one above, reject it on the Ledger.
				A compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if saveWarning}
			<div class="save-warning" role="status" aria-live="polite">
				<Icon name="alert-triangle" size={14} />
				<span>
					The Ledger approved the wallet, but Heartwood couldn't save the registration — signing still
					works now, but the device may ask you to register again next time.
				</span>
			</div>
		{/if}

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if multisig && wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Ledger that holds <strong>{multisig.keyName}</strong>'s key — or pick a
						different key chip above to sign with the device you have connected.
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
			<!-- Official troubleshooting resource — always shown on an error, never
			     flag-gated (it is help, not promotion). -->
			<DeviceHelpLink device="ledger" kind="support" />
		{/if}

		<div class="actions">
			<button class="btn btn-primary" onclick={() => connectAndSign()} disabled={busy}>
				{#if phase === 'registering'}
					<span class="spinner"></span>
					{persistent
						? 'Approve the wallet on your Ledger…'
						: 'Approve the multisig wallet on your Ledger…'}
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
			{#if persistent && registrations === null}
				<span class="hint">Checking this wallet's Ledger registrations…</span>
			{/if}
			{#if !multisig && oncancel && !busy}
				<button class="btn btn-ghost" onclick={() => oncancel?.()}>Cancel</button>
			{/if}
		</div>

		{#if phase === 'registering'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> On the Ledger: unlock it, open the Bitcoin app, and step
				through the registration — it shows “{sanitizeMultisigPolicyName(
					multisig?.multisigName ?? ''
				)}”, the
				{multisig?.threshold}-of-{multisig?.totalKeys} quorum, and each cosigner key. Approve each screen.
			</p>
		{:else if phase === 'signing'}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> Waiting for you to unlock the device, open the Bitcoin app,
				and approve. Confirm the address on the Ledger's screen first.
			</p>
		{/if}

		{#if multisig && onusefile && !busy}
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
