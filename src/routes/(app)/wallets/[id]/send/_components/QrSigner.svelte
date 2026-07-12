<script lang="ts">
	import QRCode from 'qrcode';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import { formatBtc, formatSats, truncateMiddle } from '$lib/format';
	import { encodePsbtToFrames } from '$lib/hw/bbqr';
	import { psbtHasKeyOrigin } from '$lib/hw/keyOrigin';
	import type { SignerProps } from './signerContract';
	import { MediaQuery } from 'svelte/reactivity';

	// Air-gapped QR signer for camera-based devices (SeedSigner, Foundation
	// Passport, Blockstream Jade). No cable, no connection: the unsigned PSBT
	// leaves this screen as an animated sequence of BBQr QR frames the device
	// films, and the signature comes back as QR frames we film off the device's
	// screen. Cairn does the encode/scan plumbing; the DEVICE is the source of
	// truth for what's being signed — the verify panel exists to make the user
	// read the destination + amount off the device, never trusting this browser.
	let { unsignedPsbt, context, onsigned, oncancel }: SignerProps = $props();

	// Camera signers match inputs to their own keys via the PSBT's key-origin
	// data. Bare-xpub wallets (no recorded master fingerprint) produce PSBTs
	// without it, so the QR dance is doomed before it starts — warn upfront
	// instead of after the user has filmed frames at a device that will balk.
	const hasKeyOrigin = $derived(psbtHasKeyOrigin(unsignedPsbt));

	// ── Phase ────────────────────────────────────────────────────────────────
	// 'display' = showing the unsigned PSBT to the device; 'scan' = reading the
	// signed PSBT back. The user drives the switch (they only scan once the
	// device has finished signing).
	let phase = $state<'display' | 'scan'>('display');

	// ── DISPLAY: encode the PSBT to BBQr frames + render each as a QR image ────
	// Encoding is deterministic and cheap; do it once up front. A malformed PSBT
	// (shouldn't happen — the parent built it) surfaces as an inline error rather
	// than a blank card. Frames and error come out of ONE derived — a derived must
	// not write other $state (Svelte throws state_unsafe_mutation), so the error
	// is part of the derived value instead of a separate $state cell.
	const encoded = $derived.by<{ frames: string[]; error: string | null }>(() => {
		try {
			return { frames: encodePsbtToFrames(unsignedPsbt), error: null };
		} catch (e) {
			return {
				frames: [],
				error: e instanceof Error ? e.message : 'Could not encode this transaction as QR.'
			};
		}
	});
	const frames = $derived(encoded.frames);
	const encodeError = $derived(encoded.error);

	// Render every frame to an SVG data URL once, keyed by frame text. `toString`
	// with type:'svg' needs no canvas and stays crisp at any size.
	let frameImages = $state<string[]>([]);
	let renderError = $state<string | null>(null);

	$effect(() => {
		const fs = frames;
		if (fs.length === 0) {
			frameImages = [];
			return;
		}
		let cancelled = false;
		renderError = null;
		Promise.all(
			fs.map((f) =>
				QRCode.toString(f, {
					type: 'svg',
					errorCorrectionLevel: 'L',
					margin: 2
				})
			)
		)
			.then((svgs) => {
				if (cancelled) return;
				frameImages = svgs.map((svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
			})
			.catch(() => {
				if (!cancelled) renderError = 'Could not render the QR codes in this browser.';
			});
		return () => {
			cancelled = true;
		};
	});

	// Cycle through the frames on a timer while in the display phase. Single-frame
	// PSBTs (small transactions) just hold on frame 0 — no animation needed.
	let currentFrame = $state(0);
	const FRAME_MS = 300;

	// A 300ms flicker is exactly what prefers-reduced-motion asks us not to do,
	// and the signing device doesn't need it — BBQr frames reassemble in any
	// order, so the user can step them by hand. When the OS asks for reduced
	// motion, hold still and show previous/next controls instead of the timer.
	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)', false);

	$effect(() => {
		if (phase !== 'display' || frameImages.length <= 1 || reducedMotion.current) return;
		const id = setInterval(() => {
			currentFrame = (currentFrame + 1) % frameImages.length;
		}, FRAME_MS);
		return () => clearInterval(id);
	});

	// Manual stepping for the reduced-motion display. Wraps at both ends so the
	// user can loop through the sequence as many times as the device needs.
	function prevFrame() {
		currentFrame = (currentFrame - 1 + frameImages.length) % frameImages.length;
	}

	function nextFrame() {
		currentFrame = (currentFrame + 1) % frameImages.length;
	}

	// Reset to the first frame whenever we (re)enter the display phase.
	$effect(() => {
		if (phase === 'display') currentFrame = 0;
	});

	// ── SCAN: the camera/paste loop itself is <QrScanner mode="animated">
	//    (extracted from what used to live here — see QR-SCAN-DESIGN.md §6 Wave
	//    2). Cancelling just flips the phase back to 'display'; unmounting
	//    <QrScanner> (it's only rendered while phase === 'scan') runs its
	//    onDestroy cleanup, which stops the camera — same net effect as the old
	//    `stopCamera(); phase = 'display';` here, just via unmount instead of an
	//    explicit call. ───────────────────────────────────────────────────────
	function cancelScan() {
		phase = 'display';
	}
</script>

<div class="method-active qr-signer">
	<div class="method-head">
		<span class="method-icon"><Icon name="qr" size={18} /></span>
		<div class="grow">
			<h3 class="method-title">Animated QR (SeedSigner, Passport, Jade)</h3>
			<p class="method-sub">
				<Term
					tip="An air-gapped signer never connects to a network or a USB data link. The unsigned transaction reaches it as QR codes it films off this screen, and its signature comes back the same way. Malware on this computer can never reach the keys."
					>Air-gapped</Term
				> signing over the camera — nothing is ever plugged in
			</p>
		</div>
	</div>

	{#if !hasKeyOrigin}
		<div class="form-error" role="alert">
			<strong>This wallet can't sign with a camera device directly.</strong> It was added without
			key-origin data (no master fingerprint recorded), so a SeedSigner, Passport, or Jade won't
			recognize these coins as its own and will refuse to sign. Use the
			<strong>Generic wallet / file</strong> method with software that knows this wallet, or
			re-import the wallet with its master fingerprint.
		</div>
		{#if oncancel}
			<div class="signer-foot">
				<button type="button" class="btn btn-secondary btn-sm" onclick={oncancel}>
					<Icon name="chevron-left" size={14} /> Choose another method
				</button>
			</div>
		{/if}
	{:else}
	<HowItWorks id="send-qr">
		<p>
			Your signing device <strong>never touches this computer.</strong> The unsigned transaction crosses
			the air gap as a sequence of QR codes it films off this screen, and its signature comes back the
			same way — QR codes you film off the device. Nothing on this machine can reach your keys.
		</p>
		<p>
			The frames use <Term
				tip="BBQr is a QR framing format from Coinkite: it splits a payload into numbered chunks (headers like 'B$2P0402…'), so a large transaction fits across several QR codes that can be filmed in any order and reassembled."
				>BBQr</Term
			>, the multi-frame QR format SeedSigner, Foundation Passport, and other camera signers read
			directly. Because the device is the one true source, <strong
				>read the destination and amount off the device's own screen</strong
			> before you approve — this browser could be lying; the device cannot.
		</p>
	</HowItWorks>

	<!-- Verify panel: what the user must read off the DEVICE, not here. -->
	<div class="verify-panel">
		<div class="verify-head">
			<Icon name="alert-triangle" size={15} />
			<span>Verify these on the signing device screen — not here</span>
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

	{#if phase === 'display'}
		<!-- ═══════════════════════════════ DISPLAY ═══════════════════════════ -->
		<div class="phase-body fade-in">
			<ol class="sign-steps">
				<li>
					<div class="sign-step-body">
						<span class="sign-step-title">Scan this QR with your device</span>
						<span class="hint">
							On your signer choose <em>Scan</em> (SeedSigner: "Scan PSBT"; Passport: "Sign with
							QR"), then point its camera at the animated code below. It reads every frame as they
							cycle.
						</span>
					</div>
				</li>
			</ol>

			{#if encodeError}
				<div class="form-error" role="alert">{encodeError}</div>
			{:else if renderError}
				<div class="form-error" role="alert">{renderError}</div>
			{:else if frameImages.length > 0}
				<div class="qr-stage">
					<div class="qr-frame">
						<!-- Data-URL <img> keeps the SVG crisp and lets the browser cache it. -->
						<img src={frameImages[currentFrame]} alt={`Transaction QR frame ${currentFrame + 1}`} />
					</div>
					<div class="qr-meta">
						{#if frameImages.length > 1}
							<span class="frame-count tabular">Frame {currentFrame + 1} / {frameImages.length}</span>
							<div class="frame-dots" aria-hidden="true">
								{#each frameImages as _, i (i)}
									<span class="dot" class:on={i === currentFrame}></span>
								{/each}
							</div>
							{#if reducedMotion.current}
								<!-- Reduced motion: the timer is off, so hand the user the reins. -->
								<div class="frame-controls">
									<button type="button" class="btn btn-secondary btn-sm" onclick={prevFrame}>
										<Icon name="chevron-left" size={14} /> Previous frame
									</button>
									<button type="button" class="btn btn-secondary btn-sm" onclick={nextFrame}>
										Next frame <Icon name="chevron-right" size={14} />
									</button>
								</div>
								<span class="hint">
									Step through the frames while your device watches — it reads them in any order.
								</span>
							{:else}
								<span class="hint">The frames cycle automatically — let your device watch the whole loop.</span>
							{/if}
						{:else}
							<span class="frame-count">Single frame — hold your device steady on it.</span>
						{/if}
					</div>
				</div>
			{:else}
				<div class="qr-stage"><span class="spinner"></span></div>
			{/if}

			<ol class="sign-steps" start="2">
				<li>
					<div class="sign-step-body">
						<span class="sign-step-title">Approve on the device</span>
						<span class="hint">
							Confirm the device is paying <span class="mono inline-addr"
								>{truncateMiddle(context.destinationAddress, 12, 10)}</span
							>
							{formatBtc(context.amountSats)} BTC, then approve. It will show a signed transaction as its
							own QR code (or animated sequence).
						</span>
					</div>
				</li>
				<li>
					<div class="sign-step-body">
						<span class="sign-step-title">Scan the signed transaction back</span>
						<span class="hint">Point this computer's camera at the device's signed-transaction QR.</span>
						<button type="button" class="btn btn-primary btn-sm" onclick={() => (phase = 'scan')}>
							<Icon name="eye" size={14} /> Scan signed QR
						</button>
					</div>
				</li>
			</ol>
		</div>
	{:else}
		<!-- ═══════════════════════════════ SCAN ══════════════════════════════ -->
		<div class="phase-body fade-in">
			<div class="scan-head">
				<button type="button" class="btn btn-ghost btn-sm" onclick={cancelScan}>
					<Icon name="chevron-left" size={14} /> Back to the QR
				</button>
				<span class="scan-title">Scan the signed transaction from your device</span>
			</div>

			<QrScanner mode="animated" codec="bbqr" deviceLabel="the device" onresult={onsigned} />
		</div>
	{/if}

	{#if oncancel}
		<div class="signer-foot">
			<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>
				<Icon name="x" size={14} /> Use a different method
			</button>
		</div>
	{/if}
	{/if}
</div>

<style>
	/* Mirrors the .method-active idiom from the Sign step and ColdCardSigner
	   (hairline row, not a boxed card) so this sits flush in the method grid. */
	.method-active {
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
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
		border-radius: var(--radius-icon-btn);
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

	/* ---- Verify panel (identical idiom to ColdCardSigner) ---- */
	.verify-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
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

	.phase-body {
		display: flex;
		flex-direction: column;
		gap: 16px;
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

	.sign-steps[start='2'] {
		counter-reset: sign 1;
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
		background: var(--bg-input);
		border: 1px solid var(--border-control);
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

	.inline-addr {
		word-break: break-all;
	}

	/* ---- QR display stage ---- */
	.qr-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 4px 0;
	}

	.qr-frame {
		width: 260px;
		max-width: 100%;
		aspect-ratio: 1;
		background: #ffffff;
		border-radius: var(--radius-card);
		padding: 12px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
	}

	.qr-frame img {
		display: block;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}

	.qr-meta {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		text-align: center;
	}

	.frame-count {
		font-size: 12.5px;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.frame-dots {
		display: flex;
		gap: 5px;
		flex-wrap: wrap;
		justify-content: center;
		max-width: 240px;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--border);
		transition: background 120ms var(--ease);
	}

	.dot.on {
		background: var(--accent);
	}

	/* Manual previous/next stepping shown when prefers-reduced-motion is set. */
	.frame-controls {
		display: flex;
		gap: 8px;
	}

	/* ---- Scan phase header (the camera/paste body itself is <QrScanner>,
	   which carries its own styles) ---- */
	.scan-head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.scan-title {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text);
	}

	.signer-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}
</style>
