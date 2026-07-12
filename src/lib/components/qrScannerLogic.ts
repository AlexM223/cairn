// Pure logic behind <QrScanner> (QrScanner.svelte) — split into a plain module
// so it's unit-testable directly. This repo's vitest config has no Svelte
// plugin (only .ts files run through vitest; every other *.test.ts in this
// codebase tests a plain module, never a .svelte file's <script module>
// exports), so anything meant to get a real test needs to live here rather
// than inside the component file.
//
// This holds the decision logic QrScanner.svelte extracted out of
// QrSigner.svelte's and JadeQrSigner.svelte's near-identical scan phases (see
// QR-SCAN-DESIGN.md §1.3/§5/§6 Wave 2): which codec's joiner/frame-shape/copy
// to use, and how a pasted animated-mode string resolves (frame reassembly vs.
// raw-base64 passthrough) — identical to what each signer's own `submitManual`
// did before this migration.
import { PsbtQrJoiner as BbqrJoiner, looksLikeBbqrFrame } from '$lib/hw/bbqr';
import { PsbtQrJoiner as UrJoiner, looksLikeUrFrame } from '$lib/hw/jadeUr';

export interface QrJoinerLike {
	add(frame: string): { complete: boolean; progress: { have: number; total: number } };
	isComplete(): boolean;
	progress(): { have: number; total: number };
	result(): string;
	reset(): void;
}

export type AnimatedCodec = 'bbqr' | 'ur';
export type ScanMode = 'single' | 'animated';

export function createJoinerFor(codec: AnimatedCodec | undefined): QrJoinerLike {
	return codec === 'ur' ? new UrJoiner() : new BbqrJoiner();
}

export function looksLikeFrameFor(codec: AnimatedCodec | undefined): (text: string) => boolean {
	return codec === 'ur' ? looksLikeUrFrame : looksLikeBbqrFrame;
}

/** Codec-specific paste-box copy (divider label + textarea placeholder). */
export function frameCopyFor(codec: AnimatedCodec | undefined): { label: string; placeholder: string } {
	return codec === 'ur'
		? { label: 'ur:crypto-psbt', placeholder: 'ur:crypto-psbt/… (one frame per line)  —  or  —  cHNidP8B…' }
		: { label: 'BBQr', placeholder: 'B$2P… (one frame per line)  —  or  —  cHNidP8B…' };
}

export function resultNounFor(mode: ScanMode): string {
	return mode === 'animated' ? 'the signed transaction' : 'the value';
}

export function doneLabelFor(mode: ScanMode): string {
	return mode === 'animated' ? 'Signed transaction received.' : 'Value captured.';
}

/** Matches the exact original wording ("BarcodeDetector isn't supported — try
 *  Chrome, Edge, or Brave. Paste the signed transaction instead.") for the one
 *  mode actually migrated (animated); single mode gets an analogous generic. */
export function noCameraMessageFor(mode: ScanMode): string {
	return mode === 'animated'
		? "This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste the signed transaction instead."
		: "This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste it instead.";
}

export type AnimatedPasteOutcome =
	| { kind: 'value'; value: string }
	| { kind: 'incomplete'; have: number; total: number }
	| { kind: 'error'; message: string };

/**
 * The exact paste-fallback decision both signers made pre-extraction (see the
 * removed `submitManual` bodies in QrSigner.svelte/JadeQrSigner.svelte): treat
 * the paste as this codec's QR frame(s) if any line looks like one
 * (reassembling via a fresh joiner — tolerates shuffled order + duplicates,
 * same as a live scan); otherwise pass it straight through as a raw base64
 * PSBT for the caller to re-validate.
 */
export function resolveAnimatedPaste(raw: string, codec: AnimatedCodec | undefined): AnimatedPasteOutcome {
	const lines = raw
		.split(/\s+/)
		.map((l) => l.trim())
		.filter(Boolean);
	const looksLikeFrame = looksLikeFrameFor(codec);

	if (lines.some(looksLikeFrame)) {
		const j = createJoinerFor(codec);
		try {
			for (const line of lines) {
				if (looksLikeFrame(line)) j.add(line);
			}
		} catch (e) {
			return { kind: 'error', message: e instanceof Error ? e.message : 'Those QR frames could not be read.' };
		}
		if (!j.isComplete()) {
			const p = j.progress();
			return { kind: 'incomplete', have: p.have, total: p.total };
		}
		try {
			return { kind: 'value', value: j.result() };
		} catch (e) {
			return { kind: 'error', message: e instanceof Error ? e.message : 'Could not reassemble those frames.' };
		}
	}

	// Not this codec's frame shape → assume it's a base64 PSBT the device/app
	// exported directly. The caller re-validates it before use.
	return { kind: 'value', value: raw };
}
