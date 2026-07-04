// Camera QR scanning via the browser-native BarcodeDetector API.
//
// Scanning back a signed PSBT means reading a live sequence of QR frames off a
// signing device's screen. We deliberately DON'T ship a hand-written QR decoder
// (Reed-Solomon + finder-pattern detection from a noisy webcam feed is a large,
// subtly-failure-prone thing to get right with no camera to test against here):
// we defer to the platform's BarcodeDetector, which Chromium exposes natively.
//
// BarcodeDetector is Chromium-only as of this writing (not Firefox/Safari), so
// `isCameraScanAvailable()` is the honest capability gate the UI checks before
// offering the scan button — when it's false, the component falls back to a
// paste box. Everything here is SSR-safe: no `window`/`navigator`/DOM access at
// module load, and every runtime probe is guarded.

// Minimal structural type for the parts of BarcodeDetector we use. The DOM lib
// doesn't ship a BarcodeDetector type, and we must not reference a global that
// doesn't exist at SSR — so we describe only what we call.
interface DetectedBarcode {
	rawValue: string;
}
interface BarcodeDetectorLike {
	detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
	new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

/** The global BarcodeDetector constructor, or undefined where unsupported / on the server. */
function barcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
	if (typeof globalThis === 'undefined') return undefined;
	const g = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
	return g.BarcodeDetector;
}

/**
 * True when this browser can scan QR codes from a camera: it exposes both the
 * native BarcodeDetector API and a camera surface (`getUserMedia`). SSR-safe —
 * returns false on the server. Callers MUST check this before offering the scan
 * UI and fall back (paste) when it's false.
 */
export function isCameraScanAvailable(): boolean {
	if (typeof navigator === 'undefined') return false;
	if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function')
		return false;
	return barcodeDetectorCtor() !== undefined;
}

/** Handle returned by `startScan` — stop the loop and release the camera. */
export interface ScanHandle {
	/** Stop polling and stop the camera stream. Idempotent. */
	stop(): void;
}

export interface StartScanOptions {
	/** Poll interval in ms between BarcodeDetector reads (default 200). */
	intervalMs?: number;
	/** Called if the camera can't be started or a fatal error occurs mid-scan. */
	onError?: (err: Error) => void;
}

/**
 * Open the rear camera into `video` and poll for QR codes, invoking
 * `onFrame(text)` with each decoded QR string (deduping is the caller's job —
 * a steady camera re-reads the same frame many times; PsbtQrJoiner tolerates
 * that). Returns a handle to stop scanning and release the camera.
 *
 * Rejects (via the returned promise AND `onError`) when the browser can't scan
 * or the user denies camera access — the component surfaces that and offers the
 * paste fallback instead of hanging.
 *
 * @param video a mounted <video> element to attach the stream to
 * @param onFrame called with each decoded QR text
 */
export async function startScan(
	video: HTMLVideoElement,
	onFrame: (text: string) => void,
	opts: StartScanOptions = {}
): Promise<ScanHandle> {
	const Ctor = barcodeDetectorCtor();
	if (!Ctor || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
		throw new Error(
			"This browser can't scan QR codes from a camera. Paste the signed transaction instead."
		);
	}

	const intervalMs = opts.intervalMs ?? 200;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stream: MediaStream | null = null;

	const stop = () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (stream) {
			for (const track of stream.getTracks()) track.stop();
			stream = null;
		}
		// Detach so the element can be reused / GC'd cleanly.
		try {
			video.srcObject = null;
		} catch {
			// Some environments throw on reassigning srcObject — safe to ignore.
		}
	};

	try {
		// Prefer the rear ("environment") camera on phones/tablets; on a laptop
		// the browser falls back to the only camera it has.
		stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: 'environment' },
			audio: false
		});
		if (stopped) {
			// stop() was called while getUserMedia was in flight.
			for (const track of stream.getTracks()) track.stop();
			stream = null;
			return { stop };
		}
		video.srcObject = stream;
		// `playsInline` keeps iOS Safari from going fullscreen; harmless elsewhere.
		video.setAttribute('playsinline', 'true');
		video.muted = true;
		await video.play().catch(() => {
			// Autoplay can reject if not user-initiated; the frames still tick once
			// the element has data, so this isn't fatal.
		});
	} catch (e) {
		stop();
		const err =
			e instanceof Error
				? new Error(
						e.name === 'NotAllowedError'
							? 'Camera access was blocked. Allow the camera, or paste the signed transaction instead.'
							: `Could not start the camera: ${e.message}`
					)
				: new Error('Could not start the camera.');
		opts.onError?.(err);
		throw err;
	}

	const detector = new Ctor({ formats: ['qr_code'] });

	const tick = async () => {
		if (stopped) return;
		try {
			// readyState >= 2 (HAVE_CURRENT_DATA): a frame is available to scan.
			if (video.readyState >= 2) {
				const codes = await detector.detect(video);
				for (const c of codes) {
					if (c?.rawValue) onFrame(c.rawValue);
				}
			}
		} catch {
			// A single failed detect() (transient decode glitch) shouldn't kill the
			// session — just try again next tick.
		}
		if (!stopped) timer = setTimeout(tick, intervalMs);
	};
	tick();

	return { stop };
}
