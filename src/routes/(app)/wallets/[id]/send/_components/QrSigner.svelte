<script lang="ts">
	import QRCode from 'qrcode';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import { formatBtc, formatSats, truncateMiddle } from '$lib/format';
	import { encodePsbtToFrames, PsbtQrJoiner, looksLikeBbqrFrame } from '$lib/hw/bbqr';
	import { isCameraScanAvailable, startScan, type ScanHandle } from '$lib/hw/qrScan';
	import type { SignerProps } from './signerContract';
	import { onDestroy } from 'svelte';

	// Air-gapped QR signer for camera-based devices (SeedSigner, Foundation
	// Passport, Blockstream Jade). No cable, no connection: the unsigned PSBT
	// leaves this screen as an animated sequence of BBQr QR frames the device
	// films, and the signature comes back as QR frames we film off the device's
	// screen. Cairn does the encode/scan plumbing; the DEVICE is the source of
	// truth for what's being signed — the verify panel exists to make the user
	// read the destination + amount off the device, never trusting this browser.
	let { unsignedPsbt, context, onsigned, oncancel }: SignerProps = $props();

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

	$effect(() => {
		if (phase !== 'display' || frameImages.length <= 1) return;
		const id = setInterval(() => {
			currentFrame = (currentFrame + 1) % frameImages.length;
		}, FRAME_MS);
		return () => clearInterval(id);
	});

	// Reset to the first frame whenever we (re)enter the display phase.
	$effect(() => {
		if (phase === 'display') currentFrame = 0;
	});

	// ── SCAN: camera + BarcodeDetector, feeding frames into the joiner ─────────
	const cameraAvailable = isCameraScanAvailable();
	let videoEl = $state<HTMLVideoElement | null>(null);
	let scanHandle: ScanHandle | null = null;
	let scanning = $state(false);
	let scanError = $state<string | null>(null);

	// Reassembly progress. `have`/`total` drive the "3 / 5 frames" readout.
	let joiner = new PsbtQrJoiner();
	let progress = $state<{ have: number; total: number }>({ have: 0, total: 0 });
	let scanComplete = $state(false);

	// ── Manual paste fallback (no camera, or a device that shows one QR at a
	//    time the user copies, or a plain base64 export) ───────────────────────
	let showManual = $state(false);
	let manualText = $state('');
	let manualError = $state<string | null>(null);

	function feedFrame(text: string) {
		if (scanComplete) return;
		try {
			const { complete, progress: p } = joiner.add(text);
			progress = p;
			scanError = null;
			if (complete) {
				finishScan();
			}
		} catch {
			// A non-BBQr QR wandered into view (an address QR elsewhere). Ignore
			// silently during a live scan — it's noise, not a failure.
		}
	}

	function finishScan() {
		scanComplete = true;
		stopCamera();
		try {
			const signed = joiner.result();
			onsigned(signed);
		} catch (e) {
			scanError =
				e instanceof Error ? e.message : 'The scanned frames could not be reassembled — rescan.';
			scanComplete = false;
		}
	}

	async function beginCameraScan() {
		scanError = null;
		manualError = null;
		showManual = false;
		joiner = new PsbtQrJoiner();
		progress = { have: 0, total: 0 };
		scanComplete = false;
		scanning = true;
		// Let the <video> mount before attaching the stream.
		await Promise.resolve();
		if (!videoEl) {
			scanning = false;
			scanError = 'Could not find the camera preview element.';
			return;
		}
		try {
			scanHandle = await startScan(videoEl, feedFrame, {
				onError: (err) => {
					scanError = err.message;
					scanning = false;
				}
			});
		} catch (e) {
			scanning = false;
			scanError = e instanceof Error ? e.message : 'Could not start the camera.';
			showManual = true; // offer paste when the camera won't open
		}
	}

	function stopCamera() {
		scanHandle?.stop();
		scanHandle = null;
		scanning = false;
	}

	function cancelScan() {
		stopCamera();
		phase = 'display';
	}

	// Manual fallback: accept either pasted BBQr frame strings (one per line) or a
	// raw base64 PSBT. BBQr frames go through the joiner (so a multi-frame paste
	// still reassembles); a base64 PSBT is passed straight through.
	function submitManual() {
		manualError = null;
		const raw = manualText.trim();
		if (!raw) {
			manualError = 'Paste the signed transaction — its QR frames or its base64.';
			return;
		}
		const lines = raw
			.split(/\s+/)
			.map((l) => l.trim())
			.filter(Boolean);

		if (lines.some(looksLikeBbqrFrame)) {
			// Treat the paste as BBQr frame(s).
			const j = new PsbtQrJoiner();
			try {
				for (const line of lines) {
					if (looksLikeBbqrFrame(line)) j.add(line);
				}
			} catch (e) {
				manualError = e instanceof Error ? e.message : 'Those QR frames could not be read.';
				return;
			}
			if (!j.isComplete()) {
				const p = j.progress();
				manualError = `Incomplete — ${p.have} of ${p.total} QR frames pasted. Paste all frames.`;
				return;
			}
			try {
				onsigned(j.result());
				scanComplete = true;
			} catch (e) {
				manualError = e instanceof Error ? e.message : 'Could not reassemble those frames.';
			}
			return;
		}

		// Not BBQr → assume it's a base64 PSBT the device/app exported directly.
		// The parent re-validates it (same-transaction guard) before broadcast.
		onsigned(raw);
		scanComplete = true;
	}

	onDestroy(stopCamera);
</script>

<div class="card card-pad method-active qr-signer">
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
							<span class="hint">The frames cycle automatically — let your device watch the whole loop.</span>
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

			{#if scanComplete}
				<div class="scan-done">
					<Icon name="check" size={20} />
					<span>Signed transaction received.</span>
				</div>
			{:else if cameraAvailable}
				{#if !scanning && !showManual}
					<p class="hint">
						Start the camera, then hold the device's signed-transaction QR in view. Multi-frame
						sequences reassemble as the device cycles them.
					</p>
					<button type="button" class="btn btn-primary btn-sm" onclick={beginCameraScan}>
						<Icon name="eye" size={14} /> Start camera
					</button>
				{/if}

				{#if scanning}
					<div class="scan-stage">
						<!-- svelte-ignore a11y_media_has_caption -->
						<video bind:this={videoEl} class="scan-video" playsinline muted></video>
						<div class="scan-progress">
							{#if progress.total > 0}
								<span class="frame-count tabular">Scanned {progress.have} / {progress.total} frames</span>
								<div class="scan-bar">
									<div class="scan-bar-fill" style={`width:${(progress.have / progress.total) * 100}%`}></div>
								</div>
							{:else}
								<span class="hint">Point the camera at the device's QR…</span>
							{/if}
						</div>
						<button type="button" class="btn btn-ghost btn-sm" onclick={stopCamera}>
							<Icon name="x" size={14} /> Stop camera
						</button>
					</div>
				{/if}
			{:else}
				<div class="no-camera">
					<Icon name="info" size={15} />
					<span>
						This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try
						Chrome, Edge, or Brave). Paste the signed transaction instead.
					</span>
				</div>
			{/if}

			{#if scanError}
				<div class="form-error" role="alert">{scanError}</div>
			{/if}

			{#if !scanComplete}
				<!-- Manual fallback is ALWAYS reachable: some devices show a single QR
				     the user photographs, and a paste box is the universal escape hatch. -->
				<div class="manual">
					{#if cameraAvailable && !showManual}
						<button type="button" class="link-btn" onclick={() => (showManual = true)}>
							Camera not working? Paste the signed transaction instead
						</button>
					{/if}
					{#if showManual || !cameraAvailable}
						<div class="or-divider"><span>paste the BBQr frames or the base64 PSBT</span></div>
						<textarea
							class="input mono"
							rows="4"
							placeholder="B$2P… (one frame per line)  —  or  —  cHNidP8B…"
							bind:value={manualText}
						></textarea>
						{#if manualError}
							<div class="form-error" role="alert">{manualError}</div>
						{/if}
						<button
							type="button"
							class="btn btn-primary btn-sm"
							onclick={submitManual}
							disabled={manualText.trim().length === 0}
						>
							Use pasted transaction
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if oncancel}
		<div class="signer-foot">
			<button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>
				<Icon name="x" size={14} /> Use a different method
			</button>
		</div>
	{/if}
</div>

<style>
	/* Mirrors the .method-active idiom from the Sign step and ColdCardSigner so
	   this card sits naturally in the method grid. */
	.method-active {
		border-color: var(--border);
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
	}

	/* ---- Verify panel (identical idiom to ColdCardSigner) ---- */
	.verify-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-card);
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
		background: var(--surface-elevated);
		border: 1px solid var(--border);
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

	/* ---- Scan phase ---- */
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

	.scan-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.scan-video {
		width: 320px;
		max-width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		background: #000;
		border-radius: var(--radius-card);
		border: 1px solid var(--border);
	}

	.scan-progress {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		width: 100%;
		max-width: 320px;
	}

	.scan-bar {
		width: 100%;
		height: 6px;
		background: var(--surface-elevated);
		border-radius: 3px;
		overflow: hidden;
	}

	.scan-bar-fill {
		height: 100%;
		background: var(--accent);
		transition: width 150ms var(--ease);
	}

	.scan-done {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--success);
		font-size: 13.5px;
		font-weight: 500;
		background: var(--success-muted);
		border-radius: var(--radius-control);
		padding: 12px 14px;
	}

	.no-camera {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 13px;
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border-radius: var(--radius-control);
		padding: 12px 14px;
	}

	.no-camera :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
		color: var(--text-muted);
	}

	.manual {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font-family: var(--font-ui);
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.or-divider {
		display: flex;
		align-items: center;
		text-align: center;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.or-divider::before,
	.or-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
	}

	.or-divider span {
		padding: 0 10px;
	}

	.signer-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}
</style>
