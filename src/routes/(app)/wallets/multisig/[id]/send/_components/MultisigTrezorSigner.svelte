<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatSats, truncateMiddle } from '$lib/format';
	import {
		isTrezorConnectAvailable,
		signMultisigPsbtWithTrezor,
		TrezorError,
		type MultisigScriptType,
		type MultisigSignKey
	} from '$lib/hw/trezor';

	// Live USB multisig signing for one multisig key. A multisig-local sibling of the
	// wallets flow's TrezorSigner (same connect → verify-on-device → sign
	// idiom), with the multisig differences spelled out: the FULL cosigner set
	// travels to the device with every request, the Trezor shows the multisig's
	// M-of-N quorum on its own screen each time (no registration step — unlike
	// Ledger/ColdCard, Trezor keeps no persistent multisig memory), and the
	// signed PSBT that comes back still carries every previously collected
	// signature — this device only ADDS one.
	let {
		unsignedPsbt,
		keyName,
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

	// The secure-context check must only run in the browser: window does not
	// exist during SSR. Start pessimistic and re-check after mount, so the
	// server-rendered markup is the safe disabled state.
	let mounted = $state(false);
	let available = $state(false);

	// idle → signing → done. Errors live alongside (not a state) so a failed
	// attempt keeps the retry button on the still-visible connect card.
	let signing = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);
	let wrongDevice = $state(false);

	onMount(() => {
		mounted = true;
		available = isTrezorConnectAvailable();
	});

	async function connectAndSign() {
		error = null;
		wrongDevice = false;
		signing = true;
		try {
			const signed = await signMultisigPsbtWithTrezor({
				unsignedPsbt,
				threshold,
				keys: multisigKeys,
				scriptType
			});
			done = true;
			onsigned(signed);
		} catch (err) {
			// signMultisigPsbtWithTrezor throws typed, plain-language TrezorErrors —
			// the wrong_device message already names both fingerprints (connected
			// vs expected); anything else is surfaced rather than swallowed.
			if (err instanceof TrezorError) {
				error = err.message;
				wrongDevice = err.code === 'wrong_device';
			} else {
				error = 'The Trezor request failed unexpectedly.';
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
			<h3 class="method-title">Sign with {keyName} — Trezor</h3>
			<p class="method-sub">
				Sign on-device via the
				<Term
					tip="Trezor Connect is Trezor's official browser integration. It opens a small popup window from trezor.io that talks to your device — no extra app or driver, and it works in any modern browser over HTTPS or localhost."
				>
					Trezor Connect
				</Term> popup. Nothing leaves the device but this key's signature.
			</p>
		</div>
	</div>

	<HowItWorks id="multisig-trezor-sign">
		<p>
			Your <strong>private keys never leave the Trezor</strong>. Cairn hands the device the current
			transaction — including every signature already collected — and the Trezor shows the full
			picture on its own screen: that this is a <strong>{threshold}-of-{totalKeys} multisig
			spend</strong>, plus the destination and amount. It returns one more signature, which Cairn
			merges into the transaction.
		</p>
		<p>
			No registration step is needed: unlike some devices, a Trezor doesn't store the wallet — it
			re-checks the complete {threshold}-of-{totalKeys} cosigner set with every signature, every
			time. That re-check is the reassurance, not a hurdle.
		</p>
	</HowItWorks>

	{#if !mounted}
		<!-- Server-rendered / pre-hydration placeholder. Never probes window. -->
		<div class="hint">Checking for device support…</div>
	{:else if !available}
		<!-- Insecure context: disabled state with a plain-language reason. -->
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
					The Trezor Connect popup needs a secure page — HTTPS or localhost. Open Cairn over one of
					those, or sign this key with the file method instead.
				</p>
			</div>
		</div>
		{#if onusefile}
			<button
				class="btn btn-secondary"
				onclick={onusefile}
				aria-describedby="trezor-unavailable-title trezor-unavailable-reason"
			>
				Use the file method for this key
			</button>
		{/if}
	{:else if done}
		<div class="signed-ok" role="status" aria-live="polite">
			<span class="ok-icon"><Icon name="check" size={18} /></span>
			<div>
				<p class="ok-title">Signed on your Trezor</p>
				<p class="hint">
					{keyName}'s signature was merged into the transaction — the quorum tracker above shows
					what's still needed.
				</p>
			</div>
		</div>
	{:else}
		<!-- Verification callout: the user MUST check everything on-device. -->
		<div class="verify-callout" role="note">
			<div class="verify-head">
				<Icon name="alert-triangle" size={16} />
				<span>Verify on your Trezor before approving</span>
			</div>
			<p class="verify-body">
				The Trezor will present this as a <strong>{threshold}-of-{totalKeys} multisig
				transaction</strong> and walk through each output. Check the address
				<strong>on the Trezor's screen</strong> — not just here — matches:
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
				If the address on the device screen does not match the one above, reject it on the Trezor.
				A compromised computer can lie about what's on this page — the device screen can't be
				tampered with the same way.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">
				{error}
				{#if wrongDevice}
					<p class="hint" style="margin-top: 6px">
						Plug in the Trezor that holds <strong>{keyName}</strong>'s key — or pick a different
						key chip above to sign with the device you have connected.
					</p>
				{/if}
			</div>
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
		</div>

		{#if signing}
			<p class="hint signing-hint">
				<Icon name="clock" size={13} /> A Trezor Connect window will open — approve it there, then
				unlock the device and confirm. The Trezor shows “{multisigName}”'s quorum and each output;
				check the address on its screen first.
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

	.verify-callout {
		border: 1px solid rgba(232, 147, 90, 0.35);
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
