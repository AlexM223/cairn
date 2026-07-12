<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import { isCameraScanAvailable, cameraScanUnavailableReason, startScan, type ScanHandle } from '$lib/hw/qrScan';
	// Shared camera-QR scanner, extracted from the SCAN phase of QrSigner.svelte
	// and JadeQrSigner.svelte (the two already-built animated-QR scan-back UIs —
	// see QR-SCAN-DESIGN.md §1.3/§5/§6 Wave 2). Both signers' scan loops were
	// byte-for-byte duplicates of each other except for which codec's joiner they
	// drove (bbqr vs jadeUr) and a handful of device-name/copy strings, so this
	// component absorbs the loop once and both signers now render it in
	// `mode="animated"`.
	//
	// `mode="single"` (one-shot value, e.g. an address or an xpub) is also
	// implemented here per the design's component contract, ready for Wave 3/4
	// (send-destination scan, wallet-import migration) to consume — but nothing
	// wires it up yet in this pass; only the two animated signer migrations are
	// exercised by real pages today.
	//
	// The pure decision logic (which frame-copy/joiner a codec picks, and how a
	// pasted animated-mode string resolves) lives in ./qrScannerLogic.ts, NOT
	// inline here, specifically so qrScannerLogic.test.ts can exercise it
	// directly with real bbqr/jadeUr fixtures the way bbqr.test.ts/jadeUr.test.ts
	// already exercise the codecs themselves: this repo's vitest config has no
	// Svelte plugin, so a .test.ts can't import a .svelte file at all — the logic
	// has to live in a plain module to be testable.
	import {
		type QrJoinerLike,
		type AnimatedCodec,
		createJoinerFor,
		resultNounFor,
		doneLabelFor,
		frameCopyFor,
		noCameraMessageFor,
		resolveAnimatedPaste
	} from './qrScannerLogic';

	interface Props {
		/** 'single': first frame passing `validate` wins. 'animated': multi-frame
		 *  reassembly via the codec's PsbtQrJoiner. */
		mode: 'single' | 'animated';
		/** Which joiner/frame-shape to use. Required (and only meaningful) when
		 *  `mode === 'animated'`. */
		codec?: AnimatedCodec;
		/** Fired with the scanned/pasted/reassembled value: single mode gets the
		 *  raw accepted text; animated mode gets the reassembled base64 PSBT. */
		onresult: (value: string) => void;
		/** `mode:'single'` shape-gate: a candidate frame/paste is ignored unless
		 *  this returns true. Unused in animated mode — the codec's own frame
		 *  parser (inside the joiner) is the gate there, exactly as before this
		 *  extraction (a non-matching QR makes `joiner.add` throw; caught and
		 *  ignored, same as the pre-extraction behavior). */
		validate?: (text: string) => boolean;
		/** Placeholder text (+ optional divider label) for the paste box in
		 *  `mode:'single'`. Animated mode derives its own codec-specific copy
		 *  (BBQr vs ur:crypto-psbt) instead, since `codec` already says which. */
		pasteHint?: { placeholder: string; label?: string };
		/** The noun this device is called in copy ("the device", "the Jade", …).
		 *  Not in the design's illustrative prop sketch — added so the two
		 *  migrated signers can each keep their EXACT original wording (device
		 *  name substitution was the one real copy difference between them)
		 *  through one shared component. Defaults to a generic noun. */
		deviceLabel?: string;
		/** Rendered right after the scan-error message, e.g. JadeQrSigner's
		 *  <DeviceHelpLink> — the one other per-consumer addition on top of an
		 *  otherwise-identical error state. Absent for QrSigner (unchanged). */
		errorExtra?: Snippet<[string]>;
		/** Force the camera path off regardless of browser capability — the
		 *  admin-facing `qr_scan` feature flag (multisig wizard's QR-import
		 *  method, single-sig wizard, RecipientCombobox) is enforced by callers
		 *  passing this rather than by suppressing the mount entirely, so the
		 *  paste fallback (always available) still renders normally. Defaults to
		 *  false — every pre-existing caller is unaffected. */
		forceNoCamera?: boolean;
	}

	let {
		mode,
		codec,
		onresult,
		validate,
		pasteHint,
		deviceLabel = 'the device',
		errorExtra,
		forceNoCamera = false
	}: Props = $props();

	// ── Capability gating (mirrors the pre-extraction components, which never
	//    re-checked isCameraScanAvailable() after mount — only `forceNoCamera`
	//    is reactive here, and only because it comes from a caller-supplied
	//    feature flag that's read once anyway; $derived just avoids the
	//    "references a prop locally" compiler warning a plain `const` gets) ──
	const cameraAvailable = $derived(!forceNoCamera && isCameraScanAvailable());
	const unavailableReason = cameraScanUnavailableReason();

	// ── Copy that varies by mode/codec — kept here so the two migrated signers
	//    don't need to pass a pile of literal strings; the ONLY thing they still
	//    own is `codec` + `deviceLabel` (+ errorExtra for Jade). All derived from
	//    props via $derived (not plain `const`) so a future caller that changes
	//    `mode`/`codec`/`pasteHint` after mount gets correctly-updated copy
	//    instead of whatever was true at first render. ──────────────────────────
	const resultNoun = $derived(resultNounFor(mode, codec));
	const doneLabel = $derived(doneLabelFor(mode, codec));
	const frameCopy = $derived(frameCopyFor(codec));
	const pastePlaceholder = $derived(
		mode === 'animated' ? frameCopy.placeholder : (pasteHint?.placeholder ?? 'Paste a value…')
	);
	const pasteDividerLabel = $derived(
		mode === 'animated'
			? `paste the ${frameCopy.label} frames or ${codec === 'bcur-key' ? 'the plain key' : 'the base64 PSBT'}`
			: (pasteHint?.label ?? 'paste it')
	);
	const noCameraMessage = $derived(noCameraMessageFor(mode, codec));

	// ── Scan state (identical shape to the pre-extraction QrSigner/JadeQrSigner
	//    scan phase) ──────────────────────────────────────────────────────────
	let videoEl = $state<HTMLVideoElement | null>(null);
	let scanHandle: ScanHandle | null = null;
	let scanning = $state(false);
	let scanError = $state<string | null>(null);

	// Placeholder joiner — always replaced with the real codec's joiner inside
	// beginCameraScan() before any frame is fed to it (nothing can call
	// feedFrame before a scan starts), so reading the literal `undefined` here
	// instead of the reactive `codec` prop is harmless and avoids Svelte's
	// state_referenced_locally warning for a value that's about to be
	// overwritten anyway.
	let joiner: QrJoinerLike = createJoinerFor(undefined);
	let progress = $state<{ have: number; total: number }>({ have: 0, total: 0 });
	let scanComplete = $state(false);

	// Progressive-enhancement torch toggle (new in this extraction — neither
	// original component had one). Guarded throughout: most cameras/browsers lack
	// `track.getCapabilities().torch`, in which case the button never appears.
	let torchSupported = $state(false);
	let torchOn = $state(false);

	const scanAnnouncement = $derived(
		scanComplete
			? doneLabel
			: mode === 'animated' && progress.total > 0
				? `${progress.have} of ${progress.total} frames captured.`
				: ''
	);

	let showManual = $state(false);
	let manualText = $state('');
	let manualError = $state<string | null>(null);

	function feedFrame(text: string) {
		if (scanComplete) return;
		if (mode === 'single') {
			if (validate && !validate(text)) return; // not our shape — ignore, keep scanning
			scanComplete = true;
			stopCamera();
			onresult(text);
			return;
		}
		try {
			const { complete, progress: p } = joiner.add(text);
			progress = p;
			scanError = null;
			if (complete) finishScan();
		} catch {
			// A stray/foreign QR wandered into view (e.g. an address QR, or a
			// frame from the OTHER codec). Ignore silently during a live scan —
			// it's noise, not a failure. (Unchanged from the pre-extraction
			// behavior in both signers.)
		}
	}

	function finishScan() {
		scanComplete = true;
		stopCamera();
		try {
			const result = joiner.result();
			onresult(result);
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
		if (mode === 'animated') {
			joiner = createJoinerFor(codec);
			progress = { have: 0, total: 0 };
		}
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
			detectTorch();
		} catch (e) {
			scanning = false;
			scanError = e instanceof Error ? e.message : 'Could not start the camera.';
			showManual = true; // offer paste when the camera won't open
		}
	}

	// `startScan` (qrScan.ts) only returns `{ stop() }` — it doesn't hand back the
	// underlying track, so torch support is probed the same way a caller could:
	// through the <video> element's own `srcObject`, which `startScan` attaches
	// the live MediaStream to.
	function detectTorch() {
		torchSupported = false;
		torchOn = false;
		try {
			const stream = videoEl?.srcObject as MediaStream | null;
			const track = stream?.getVideoTracks?.()[0];
			const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
			torchSupported = !!caps?.torch;
		} catch {
			torchSupported = false;
		}
	}

	async function toggleTorch() {
		try {
			const stream = videoEl?.srcObject as MediaStream | null;
			const track = stream?.getVideoTracks?.()[0];
			if (!track) return;
			const next = !torchOn;
			await track.applyConstraints({
				advanced: [{ torch: next } as unknown as MediaTrackConstraintSet]
			});
			torchOn = next;
		} catch {
			// Torch toggle failing isn't fatal — leave state as-is; the button
			// stays put so the user can try again.
		}
	}

	function stopCamera() {
		scanHandle?.stop();
		scanHandle = null;
		scanning = false;
		torchSupported = false;
		torchOn = false;
	}

	// Manual fallback: in animated mode, accept either pasted frame strings (one
	// per line) or a raw base64 PSBT — identical logic to the pre-extraction
	// `submitManual` in both signers. In single mode, accept one pasted value
	// gated by `validate`.
	function submitManual() {
		manualError = null;
		const raw = manualText.trim();
		if (!raw) {
			manualError =
				mode === 'animated'
					? 'Paste the signed transaction — its QR frames or its base64.'
					: 'Paste a value first.';
			return;
		}

		if (mode === 'single') {
			if (validate && !validate(raw)) {
				manualError = "That doesn't look right — check the pasted value.";
				return;
			}
			onresult(raw);
			scanComplete = true;
			return;
		}

		const outcome = resolveAnimatedPaste(raw, codec);
		switch (outcome.kind) {
			case 'incomplete':
				manualError = `Incomplete — ${outcome.have} of ${outcome.total} QR frames pasted. Paste all frames.`;
				break;
			case 'error':
				manualError = outcome.message;
				break;
			case 'value':
				onresult(outcome.value);
				scanComplete = true;
				break;
		}
	}

	onDestroy(stopCamera);
</script>

<div class="qr-scanner">
	<!-- Screen-reader progress: announces each captured frame politely. The
	     region is always mounted so the first update is not swallowed. -->
	<div class="sr-only" role="status" aria-live="polite">{scanAnnouncement}</div>

	{#if scanComplete}
		<div class="scan-done">
			<Icon name="check" size={20} />
			<span>{doneLabel}</span>
		</div>
	{:else if cameraAvailable}
		{#if !scanning && !showManual}
			<p class="hint">
				{#if mode === 'animated' && codec === 'bcur-key'}
					Start the camera, then hold {deviceLabel}'s public-key QR in view. Multi-frame sequences
					reassemble as {deviceLabel} cycles them.
				{:else if mode === 'animated'}
					Start the camera, then hold {deviceLabel}'s signed-transaction QR in view. Multi-frame
					sequences reassemble as {deviceLabel} cycles them.
				{:else}
					Start the camera, then hold the QR code in view.
				{/if}
			</p>
			<!-- Paste sits beside the camera as a first-class alternative — a user
			     with no camera (or a locked-down one) must be able to see it before
			     ever attempting a scan, not only after one fails. -->
			<div class="scan-actions">
				<button type="button" class="btn btn-primary btn-sm" onclick={beginCameraScan}>
					<Icon name="eye" size={14} /> Start camera
				</button>
				<button type="button" class="btn btn-secondary btn-sm" onclick={() => (showManual = true)}>
					Paste {resultNoun} instead
				</button>
			</div>
		{/if}

		{#if scanning}
			<div class="scan-stage">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} class="scan-video" playsinline muted></video>
				{#if mode === 'animated'}
					<div class="scan-progress">
						{#if progress.total > 0}
							<span class="frame-count tabular">Scanned {progress.have} / {progress.total} frames</span>
							<div class="scan-bar">
								<div class="scan-bar-fill" style={`width:${(progress.have / progress.total) * 100}%`}></div>
							</div>
						{:else}
							<span class="hint">Point the camera at {deviceLabel}'s QR…</span>
						{/if}
					</div>
				{:else}
					<span class="hint">Point the camera at the QR code…</span>
				{/if}
				<div class="scan-stage-actions">
					{#if torchSupported}
						<button type="button" class="btn btn-ghost btn-sm" onclick={toggleTorch}>
							<Icon name="zap" size={14} /> {torchOn ? 'Torch off' : 'Torch on'}
						</button>
					{/if}
					<button type="button" class="btn btn-ghost btn-sm" onclick={stopCamera}>
						<Icon name="x" size={14} /> Stop camera
					</button>
				</div>
			</div>
		{/if}
	{:else}
		<div class="no-camera">
			<Icon name="info" size={15} />
			<span>{noCameraMessage}</span>
		</div>
		<!-- Self-gating: renders nothing unless this really IS an insecure-context
		     origin with an HTTPS listener to point at (SecureContextHelp.svelte).
		     Always mounted here — same "always mount, let it decide" pattern the
		     USB signer cards already use (LedgerSigner.svelte etc.) — so a user on
		     an unsupported browser (not insecure context) still sees only the
		     message above, unchanged. -->
		{#if unavailableReason === 'insecure-context'}
			<SecureContextHelp what="camera scanning" />
		{/if}
	{/if}

	{#if scanError}
		<div class="form-error" role="alert">{scanError}</div>
		{#if errorExtra}{@render errorExtra(scanError)}{/if}
	{/if}

	{#if !scanComplete}
		<!-- Manual fallback is ALWAYS reachable: offered up front next to "Start
		     camera", as an escape hatch mid-scan, and auto-opened when the camera
		     fails. A paste box is the universal way in. -->
		<div class="manual">
			{#if cameraAvailable && !showManual && scanning}
				<button type="button" class="link-btn" onclick={() => (showManual = true)}>
					Camera not working? Paste {resultNoun} instead
				</button>
			{/if}
			{#if showManual || !cameraAvailable}
				<div class="or-divider"><span>{pasteDividerLabel}</span></div>
				<textarea class="input mono" rows="4" placeholder={pastePlaceholder} bind:value={manualText}
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
					{mode === 'animated' ? 'Use pasted transaction' : 'Use pasted value'}
				</button>
				{#if cameraAvailable && !scanning}
					<!-- Way back out of the paste box — it's an alternative, not a trap. -->
					<button type="button" class="link-btn" onclick={beginCameraScan}>
						Scan with the camera instead
					</button>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.qr-scanner {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Visually hidden but announced — same idiom used across the app. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.scan-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.scan-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.scan-stage-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
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

	.frame-count {
		font-size: 12.5px;
		color: var(--text-secondary);
		font-weight: 500;
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
</style>
