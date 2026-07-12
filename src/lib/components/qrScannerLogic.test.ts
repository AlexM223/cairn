import { describe, it, expect } from 'vitest';
import { base64 } from '@scure/base';
import { constructPsbt, type SpendableUtxo } from '$lib/server/bitcoin/psbt';
import { encodePsbtToFrames as encodeBbqr } from '$lib/hw/bbqr';
import { encodePsbtToFrames as encodeUr } from '$lib/hw/jadeUr';
import {
	createJoinerFor,
	looksLikeFrameFor,
	frameCopyFor,
	resultNounFor,
	doneLabelFor,
	noCameraMessageFor,
	resolveAnimatedPaste,
	type AnimatedCodec
} from './qrScannerLogic';

// This suite guards the logic QrScanner.svelte (via ./qrScannerLogic.ts) extracted out of
// QrSigner.svelte/JadeQrSigner.svelte's scan phases (QR-SCAN-DESIGN.md §6 Wave
// 2) — the paste-fallback decision and the codec/mode-derived copy — with real
// bbqr/jadeUr fixtures, the same way bbqr.test.ts/jadeUr.test.ts already prove
// the codecs themselves. There's no DOM-rendering harness in this repo (no
// jsdom / @testing-library/svelte dependency), so this is the actual-behavior
// regression guard for the migration in place of mounting the component; the
// exact copy-fidelity assertions below double as the "zero behavior change"
// check the migration promised. Camera-loop mechanics (video element, start/stop,
// torch) and the render-state branching are not exercised here — see
// qrScan.test.ts (Wave 1) for the isCameraScanAvailable/cameraScanUnavailableReason
// gating those branches read, and the progress log's manual-verification note for
// what's left to a real browser.

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const RECEIVE_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const UTXOS: SpendableUtxo[] = [
	{ txid: '11'.repeat(32), vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 },
	{ txid: '22'.repeat(32), vout: 1, value: 40_000, height: 800_001, address: RECEIVE_1, chain: 0, index: 1 }
];

const COMMON = {
	xpub: ZPUB,
	utxos: UTXOS,
	changeAddress: CHANGE_0,
	changeIndex: 0,
	origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
};

async function realPsbtBase64(amount = 30_000): Promise<string> {
	const draft = await constructPsbt({
		...COMMON,
		recipients: [{ address: RECIPIENT, amount }],
		feeRate: 10
	});
	return draft.psbtBase64;
}

function bytesOf(psbtBase64: string): Uint8Array {
	return base64.decode(psbtBase64.trim());
}

describe('createJoinerFor / looksLikeFrameFor / frameCopyFor — codec dispatch', () => {
	it('picks the bbqr joiner/frame-shape/copy for codec "bbqr" (and as the default for undefined)', async () => {
		const psbt = await realPsbtBase64();
		const [frame] = encodeBbqr(psbt);

		for (const codec of ['bbqr', undefined] as (AnimatedCodec | undefined)[]) {
			expect(looksLikeFrameFor(codec)(frame)).toBe(true);
			const joiner = createJoinerFor(codec);
			expect(joiner.add(frame).complete).toBe(true);
			expect(joiner.result()).toBe(psbt);
		}
		expect(frameCopyFor('bbqr')).toEqual({
			label: 'BBQr',
			placeholder: 'B$2P… (one frame per line)  —  or  —  cHNidP8B…'
		});
	});

	it('picks the ur joiner/frame-shape/copy for codec "ur"', async () => {
		const psbt = await realPsbtBase64();
		// A generous maxFragmentLen forces the single-part path (jadeUr's default
		// 200-byte fragment cap splits even this small PSBT into 2 frames).
		const [frame] = encodeUr(psbt, { maxFragmentLen: 10_000 });

		expect(looksLikeFrameFor('ur')(frame)).toBe(true);
		expect(looksLikeFrameFor('bbqr')(frame)).toBe(false); // cross-codec: not a BBQr frame

		const joiner = createJoinerFor('ur');
		expect(joiner.add(frame).complete).toBe(true);
		expect(joiner.result()).toBe(psbt);

		expect(frameCopyFor('ur')).toEqual({
			label: 'ur:crypto-psbt',
			placeholder: 'ur:crypto-psbt/… (one frame per line)  —  or  —  cHNidP8B…'
		});
	});

	it('picks the bcur-key joiner/frame-shape/copy for codec "bcur-key" (the wizard\'s cosigner-key QR import)', () => {
		expect(looksLikeFrameFor('bcur-key')('ur:crypto-hdkey/abcd')).toBe(true);
		expect(looksLikeFrameFor('bcur-key')("[a1b2c3d4/48'/0'/0'/2']xpub6D...")).toBe(true); // plain-text fallback
		expect(looksLikeFrameFor('bcur-key')('ur:crypto-psbt/abcd')).toBe(false); // cross-codec

		const joiner = createJoinerFor('bcur-key');
		const outcome = joiner.add('xpub6Dfoo');
		expect(outcome.complete).toBe(true);
		expect(JSON.parse(joiner.result())).toMatchObject({ kind: 'plain', xpub: 'xpub6Dfoo' });

		expect(frameCopyFor('bcur-key').label).toBe('ur:crypto-hdkey');
	});
});

describe('resultNounFor / doneLabelFor / noCameraMessageFor — exact copy fidelity', () => {
	// These strings are asserted CHAR-FOR-CHAR against what QrSigner.svelte and
	// JadeQrSigner.svelte literally rendered before the Wave 2 extraction — the
	// "zero behavior change" requirement for the one mode (animated) both
	// migrated signers actually use.
	it('animated mode matches the pre-extraction QrSigner/JadeQrSigner copy exactly', () => {
		expect(resultNounFor('animated')).toBe('the signed transaction');
		expect(doneLabelFor('animated')).toBe('Signed transaction received.');
		expect(noCameraMessageFor('animated')).toBe(
			"This browser can't scan QR codes from a camera (BarcodeDetector isn't supported — try Chrome, Edge, or Brave). Paste the signed transaction instead."
		);
	});

	it('single mode gets an analogous (currently unused-in-production) generic', () => {
		expect(resultNounFor('single')).toBe('the value');
		expect(doneLabelFor('single')).toBe('Value captured.');
		expect(noCameraMessageFor('single')).toMatch(/paste it instead/i);
	});

	it('bcur-key codec gets its own key-import copy, distinct from the PSBT-signing wording', () => {
		expect(resultNounFor('animated', 'bcur-key')).toBe('the key');
		expect(doneLabelFor('animated', 'bcur-key')).toBe('Key captured.');
		expect(noCameraMessageFor('animated', 'bcur-key')).toMatch(/paste the key instead/i);
		// codec is ignored outside animated mode, and PSBT-signing codecs are unaffected.
		expect(resultNounFor('animated', 'ur')).toBe('the signed transaction');
		expect(resultNounFor('single', 'bcur-key')).toBe('the value');
	});
});

describe('resolveAnimatedPaste — bbqr', () => {
	it('reassembles a single-frame paste', async () => {
		const psbt = await realPsbtBase64();
		const [frame] = encodeBbqr(psbt);
		const outcome = resolveAnimatedPaste(frame, 'bbqr');
		expect(outcome).toEqual({ kind: 'value', value: psbt });
	});

	it('reassembles a multi-frame paste fed in order', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodeBbqr(psbt, { minSplit: 3 });
		expect(frames.length).toBeGreaterThanOrEqual(3);
		const outcome = resolveAnimatedPaste(frames.join('\n'), 'bbqr');
		expect(outcome.kind).toBe('value');
		if (outcome.kind === 'value') expect(bytesOf(outcome.value)).toEqual(bytesOf(psbt));
	});

	it('reassembles a multi-frame paste that is shuffled and has a duplicate + a noise line', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodeBbqr(psbt, { minSplit: 4 });
		expect(frames.length).toBeGreaterThanOrEqual(4);
		const scrambled = [...frames].reverse();
		scrambled.splice(1, 0, frames[0]); // duplicate
		const pasted = ['not a qr frame, just noise', ...scrambled].join('\n');
		const outcome = resolveAnimatedPaste(pasted, 'bbqr');
		expect(outcome.kind).toBe('value');
		if (outcome.kind === 'value') expect(bytesOf(outcome.value)).toEqual(bytesOf(psbt));
	});

	it('reports "incomplete" when only some frames are pasted', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodeBbqr(psbt, { minSplit: 3 });
		const outcome = resolveAnimatedPaste(frames[0], 'bbqr');
		expect(outcome).toEqual({ kind: 'incomplete', have: 1, total: frames.length });
	});

	it('reports "error" when frames from two different transactions are mixed', async () => {
		const psbtA = await realPsbtBase64(30_000);
		const psbtB = await realPsbtBase64(31_000);
		const framesA = encodeBbqr(psbtA, { minSplit: 2 });
		const framesB = encodeBbqr(psbtB, { minSplit: 8 });
		// The mismatch bbqr.ts's joiner detects is a differing frame TOTAL
		// (bbqr.ts:97-103) — precondition-check that these two encodes actually
		// produced different totals, or this test would silently pass for the
		// wrong reason.
		expect(framesA.length).not.toBe(framesB.length);
		const pasted = [framesA[0], framesB[1]].join('\n');
		const outcome = resolveAnimatedPaste(pasted, 'bbqr');
		expect(outcome.kind).toBe('error');
		if (outcome.kind === 'error') expect(outcome.message).toMatch(/different transactions/i);
	});

	it('passes non-frame text straight through as a raw base64 PSBT (e.g. a device that exports base64 directly)', async () => {
		const psbt = await realPsbtBase64();
		const outcome = resolveAnimatedPaste(psbt, 'bbqr');
		expect(outcome).toEqual({ kind: 'value', value: psbt });
	});
});

describe('resolveAnimatedPaste — ur (Jade / BC-UR)', () => {
	it('reassembles a single-frame paste', async () => {
		const psbt = await realPsbtBase64();
		const [frame] = encodeUr(psbt, { maxFragmentLen: 10_000 });
		const outcome = resolveAnimatedPaste(frame, 'ur');
		expect(outcome).toEqual({ kind: 'value', value: psbt });
	});

	it('reassembles a multi-frame paste fed in order', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodeUr(psbt, { minFragments: 3 });
		expect(frames.length).toBeGreaterThanOrEqual(3);
		const outcome = resolveAnimatedPaste(frames.join('\n'), 'ur');
		expect(outcome.kind).toBe('value');
		if (outcome.kind === 'value') expect(bytesOf(outcome.value)).toEqual(bytesOf(psbt));
	});

	it('reports "incomplete" when only some frames are pasted', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodeUr(psbt, { minFragments: 3 });
		const outcome = resolveAnimatedPaste(frames[0], 'ur');
		expect(outcome.kind).toBe('incomplete');
	});

	it('a BBQr paste under codec "ur" is not recognized as a UR frame and passes through as raw text', async () => {
		const psbt = await realPsbtBase64();
		const [bbqrFrame] = encodeBbqr(psbt);
		// Not a ur:crypto-psbt frame, so resolveAnimatedPaste treats it as an
		// (unvalidated) raw base64 PSBT passthrough — identical to the
		// pre-extraction submitManual's fallthrough behavior.
		const outcome = resolveAnimatedPaste(bbqrFrame, 'ur');
		expect(outcome).toEqual({ kind: 'value', value: bbqrFrame });
	});
});
