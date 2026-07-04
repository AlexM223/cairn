// BBQr encode/decode for air-gapped PSBT transfer over animated QR codes.
//
// A camera-based signer (SeedSigner, Foundation Passport, Blockstream Jade)
// cannot take a file: the unsigned PSBT reaches it as a sequence of QR frames
// it films off this screen, and its signature comes back the same way — a
// sequence of QR frames we film off *its* screen. BBQr is the framing format
// both ends speak: it splits a payload into N base32-encoded chunks, each
// prefixed with an 8-char header ("B$2P0402…" — magic, encoding, file-type,
// total, index), so the frames can be scanned in any order and reassembled.
//
// This module is a thin, framework-agnostic wrapper over the installed `bbqr`
// package's real API (`splitQRs` / `joinQRs`) plus base64⇄bytes conversion for
// PSBTs (which travel as base64 everywhere else in Cairn). It is DELIBERATELY
// pure — no DOM, no camera, no Svelte — so the encode→reassemble round-trip is
// unit-testable without any hardware (see bbqr.test.ts). The camera plumbing
// lives in qrScan.ts; the UI in QrSigner.svelte.

import { splitQRs, joinQRs } from 'bbqr';
import { base64 } from '@scure/base';

// BBQr file-type letter for a PSBT. The `bbqr` package types this as a single
// registry key; 'P' is the PSBT type per the BBQr spec.
const PSBT_FILETYPE = 'P';

/**
 * Encode a base64 PSBT as an array of BBQr frame strings, ready to render one
 * QR code per frame and cycle through on a timer.
 *
 * `encoding: '2'` forces plain base32 (no zlib) so every frame is a
 * self-describing, independently-decodable chunk — the default 'Z' would
 * zlib-compress across the whole payload, which is fine for real transfers but
 * makes per-frame reasoning (and the multi-frame test below) harder to trust.
 * A signer reassembles the frames identically either way.
 *
 * @param psbtBase64 the unsigned PSBT, base64 (as `constructPsbt` emits it)
 * @param opts.maxSplit cap on frame count (forces smaller chunks → more frames)
 * @param opts.minSplit floor on frame count (forces a multi-frame split even
 *   for tiny payloads — used by the round-trip test to exercise reassembly)
 * @param opts.maxVersion cap on per-frame QR density (lower = smaller QR = more
 *   frames but easier for a phone camera to read). Also lets `minSplit` actually
 *   take effect on a small payload: the package won't split below its
 *   `minVersion` floor, so a small PSBT can't be forced into many frames unless
 *   the per-frame capacity is capped too.
 * @returns BBQr frame strings, in index order (0…N-1)
 */
export function encodePsbtToFrames(
	psbtBase64: string,
	opts: { maxSplit?: number; minSplit?: number; maxVersion?: number } = {}
): string[] {
	const bytes = base64.decode(psbtBase64.trim());
	const minSplit = opts.minSplit ?? 1;
	// To honor a minSplit > 1 on a payload that would otherwise fit in one frame,
	// the per-frame capacity must be small enough that `minSplit` chunks are
	// actually needed — cap the QR version (and drop minVersion to 1) so the
	// splitter can produce the requested frame count. `Version` is typed as a
	// keyof the package's capacity table; the numbers are valid versions.
	const capVersion = opts.maxVersion ?? (minSplit > 1 ? 5 : undefined);
	const { parts } = splitQRs(bytes, PSBT_FILETYPE, {
		encoding: '2', // Base32 — self-contained per-frame, no cross-frame zlib
		minSplit,
		maxSplit: opts.maxSplit ?? 1295,
		...(capVersion !== undefined
			? { minVersion: 1 as never, maxVersion: capVersion as never }
			: {})
	});
	return parts;
}

/**
 * Incremental reassembler for BBQr frames scanned back from a signing device.
 *
 * Frames arrive from a live camera in no guaranteed order and are re-read many
 * times before the device's display advances, so `add` tolerates duplicates
 * and out-of-order delivery, reporting progress after each accepted frame.
 * `joinQRs` (the `bbqr` package) does the actual base32/zlib decode once every
 * frame is present.
 */
export class PsbtQrJoiner {
	// index → raw frame string. A Map de-dupes repeat scans of the same frame.
	private frames = new Map<number, string>();
	private total: number | null = null;

	/**
	 * Feed one decoded QR string. Returns whether the sequence is complete and
	 * how many distinct frames are collected so far.
	 *
	 * Throws on a string that isn't a BBQr frame at all (a stray QR in view — an
	 * address QR elsewhere on screen) so the caller can surface "that's not a
	 * signed-transaction QR" rather than silently ignoring it.
	 */
	add(frame: string): { complete: boolean; progress: { have: number; total: number } } {
		const parsed = parseBbqrHeader(frame);
		if (!parsed) {
			throw new Error('That QR code is not a BBQr transaction frame.');
		}
		const { index, total } = parsed;
		if (this.total === null) {
			this.total = total;
		} else if (this.total !== total) {
			// Two different BBQr sequences in view (e.g. a rescan of a stale
			// display) — refuse to mix them into one corrupt payload.
			throw new Error('These QR frames belong to two different transactions — rescan just one.');
		}
		this.frames.set(index, frame.trim());
		return {
			complete: this.isComplete(),
			progress: { have: this.frames.size, total: this.total }
		};
	}

	/** True once every frame of the sequence has been collected. */
	isComplete(): boolean {
		return this.total !== null && this.frames.size === this.total;
	}

	/** How many distinct frames collected, and the sequence length (0 until the first frame). */
	progress(): { have: number; total: number } {
		return { have: this.frames.size, total: this.total ?? 0 };
	}

	/** 0-based indices still missing (empty once complete). */
	missing(): number[] {
		if (this.total === null) return [];
		const out: number[] = [];
		for (let i = 0; i < this.total; i++) if (!this.frames.has(i)) out.push(i);
		return out;
	}

	/** Reset to scan a fresh sequence. */
	reset(): void {
		this.frames.clear();
		this.total = null;
	}

	/**
	 * Reassemble the collected frames into the signed PSBT, base64. Throws if
	 * the sequence is incomplete or the frames fail to decode.
	 */
	result(): string {
		if (!this.isComplete()) {
			const miss = this.missing().length;
			throw new Error(`BBQr sequence incomplete — ${miss} of ${this.total} frame(s) still missing.`);
		}
		// Feed frames to joinQRs in index order (it accepts any order, but
		// ordering keeps the input deterministic).
		const ordered: string[] = [];
		for (let i = 0; i < (this.total ?? 0); i++) {
			const f = this.frames.get(i);
			if (f === undefined) throw new Error(`Missing BBQr frame ${i}.`);
			ordered.push(f);
		}
		const { raw } = joinQRs(ordered);
		return base64.encode(raw);
	}
}

// BBQr header: "B$" + encoding char + file-type char + total(base36,2) +
// index(base36,2). We parse just the total/index here so the joiner can track
// progress without pulling the whole `bbqr` decoder in per frame. `joinQRs`
// re-validates everything at reconstruct time.
const BBQR_HEADER_RE = /^B\$([A-Z0-9])([A-Z0-9])([0-9A-Z]{2})([0-9A-Z]{2})/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function fromBase36_2(s: string): number {
	const hi = B36.indexOf(s[0]);
	const lo = B36.indexOf(s[1]);
	if (hi < 0 || lo < 0) return NaN;
	return hi * 36 + lo;
}

/** Parse a BBQr frame's header, or null if the string isn't a BBQr frame. */
export function parseBbqrHeader(
	frame: string
): { encoding: string; fileType: string; total: number; index: number } | null {
	const m = BBQR_HEADER_RE.exec(String(frame ?? '').trim());
	if (!m) return null;
	const total = fromBase36_2(m[3]);
	const index = fromBase36_2(m[4]);
	if (!Number.isInteger(total) || !Number.isInteger(index) || index >= total) return null;
	return { encoding: m[1], fileType: m[2], total, index };
}

/** Cheap check: does this string look like a BBQr frame? (pre-filter before `add`). */
export function looksLikeBbqrFrame(s: string): boolean {
	return parseBbqrHeader(s) !== null;
}
