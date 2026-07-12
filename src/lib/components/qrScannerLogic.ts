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
import { BcurKeyJoiner, looksLikeBcurKeyFrame, looksLikePlainKeyText } from '$lib/hw/bcurKey';

export interface QrJoinerLike {
	add(frame: string): { complete: boolean; progress: { have: number; total: number } };
	isComplete(): boolean;
	progress(): { have: number; total: number };
	result(): string;
	reset(): void;
}

// 'bcur-key' is the multisig wizard's cosigner-key import (CARAVAN-QR-
// REFERENCE.md): animated BC-UR crypto-hdkey/crypto-account, reusing the same
// shared QrScanner progress UI/camera plumbing 'bbqr'/'ur' (PSBT signing) do.
export type AnimatedCodec = 'bbqr' | 'ur' | 'bcur-key';
export type ScanMode = 'single' | 'animated';

export function createJoinerFor(codec: AnimatedCodec | undefined): QrJoinerLike {
	if (codec === 'ur') return new UrJoiner();
	if (codec === 'bcur-key') return new BcurKeyJoiner();
	return new BbqrJoiner();
}

export function looksLikeFrameFor(codec: AnimatedCodec | undefined): (text: string) => boolean {
	if (codec === 'ur') return looksLikeUrFrame;
	if (codec === 'bcur-key') return (s: string) => looksLikeBcurKeyFrame(s) || looksLikePlainKeyText(s);
	return looksLikeBbqrFrame;
}

/** Codec-specific paste-box copy (divider label + textarea placeholder). */
export function frameCopyFor(codec: AnimatedCodec | undefined): { label: string; placeholder: string } {
	if (codec === 'ur') {
		return { label: 'ur:crypto-psbt', placeholder: 'ur:crypto-psbt/… (one frame per line)  —  or  —  cHNidP8B…' };
	}
	if (codec === 'bcur-key') {
		return {
			label: 'ur:crypto-hdkey',
			placeholder:
				"ur:crypto-hdkey/… or ur:crypto-account/… (one frame per line)  —  or  —  xpub6D…, or [a1b2c3d4/48'/0'/0'/2']xpub6D…"
		};
	}
	return { label: 'BBQr', placeholder: 'B$2P… (one frame per line)  —  or  —  cHNidP8B…' };
}

export function resultNounFor(mode: ScanMode, codec?: AnimatedCodec): string {
	if (mode !== 'animated') return 'the value';
	return codec === 'bcur-key' ? 'the key' : 'the signed transaction';
}

export function doneLabelFor(mode: ScanMode, codec?: AnimatedCodec): string {
	if (mode !== 'animated') return 'Value captured.';
	return codec === 'bcur-key' ? 'Key captured.' : 'Signed transaction received.';
}

/** Matches the exact original wording ("BarcodeDetector isn't supported — try
 *  Chrome, Edge, or Brave. Paste the signed transaction instead.") for the
 *  pre-existing animated/PSBT modes; the wizard's key-import codec gets its
 *  own analogous copy; single mode gets an analogous generic. */
export function noCameraMessageFor(mode: ScanMode, codec?: AnimatedCodec): string {
	if (mode !== 'animated') {
		return "This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste it instead.";
	}
	if (codec === 'bcur-key') {
		return "This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste the key instead.";
	}
	return "This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste the signed transaction instead.";
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
