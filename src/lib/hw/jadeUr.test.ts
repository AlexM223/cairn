import { describe, it, expect } from 'vitest';
import { base64 } from '@scure/base';
import { constructPsbt, type SpendableUtxo } from '$lib/server/bitcoin/psbt';
import {
	encodePsbtToFrames,
	PsbtQrJoiner,
	parseUrFrame,
	looksLikeUrFrame
} from './jadeUr';

// The whole point of this suite: prove the BC-UR QR path is sound WITHOUT a
// camera or a physical Jade. If a real base64 PSBT survives encodePsbtToFrames →
// (scan back, in order AND shuffled) → PsbtQrJoiner.result() byte-for-byte, then
// the air-gapped display/scan mechanics work; only the live camera and the Jade
// itself remain unverifiable here. The codec is additionally cross-checked
// against the reference @ngraveio/bc-ur implementation during development (see
// jadeUr.ts's library note) — the frames it emits are byte-identical to a stock
// BC-UR encoder's and decode under a stock BC-UR decoder.

// BIP84 documentation vectors ("abandon … about"), same public test keys the
// bbqr/psbt suites use — never a real wallet.
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

async function realPsbtBase64(): Promise<string> {
	const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
	return draft.psbtBase64;
}

/** Bytes a base64 PSBT decodes to — the ground truth a round-trip must reproduce. */
function bytesOf(psbtBase64: string): Uint8Array {
	return base64.decode(psbtBase64.trim());
}

describe('encodePsbtToFrames (BC-UR crypto-psbt)', () => {
	it('produces a single ur:crypto-psbt frame when the PSBT fits one frame', async () => {
		const psbt = await realPsbtBase64();
		// A large per-frame cap keeps even a full single-input PSBT in one frame.
		const frames = encodePsbtToFrames(psbt, { maxFragmentLen: 4000 });
		expect(frames.length).toBe(1);
		expect(frames[0].startsWith('ur:crypto-psbt/')).toBe(true);
		// A single-part UR has NO "<seqNum>-<seqLen>/" segment.
		const parsed = parseUrFrame(frames[0]);
		expect(parsed).not.toBeNull();
		expect(parsed!.seqNum).toBeNull();
		expect(parsed!.seqLen).toBeNull();
	});

	it('splits into a numbered multipart sequence when forced small', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 3 });
		expect(frames.length).toBeGreaterThanOrEqual(3);
		// Every frame is a pure part 1..N of the same sequence.
		const seqLens = new Set<number>();
		const seqNums: number[] = [];
		for (const f of frames) {
			const p = parseUrFrame(f);
			expect(p, `frame parses: ${f.slice(0, 24)}`).not.toBeNull();
			expect(p!.seqLen).toBe(frames.length);
			expect(p!.seqNum).toBeGreaterThanOrEqual(1);
			expect(p!.seqNum).toBeLessThanOrEqual(frames.length);
			seqLens.add(p!.seqLen!);
			seqNums.push(p!.seqNum!);
		}
		expect(seqLens.size).toBe(1); // one consistent seqLen
		// seqNums are exactly 1..N once each.
		expect([...seqNums].sort((a, b) => a - b)).toEqual(frames.map((_, i) => i + 1));
	});

	it('honors maxFragmentLen — a smaller cap yields more frames', async () => {
		const psbt = await realPsbtBase64();
		const few = encodePsbtToFrames(psbt, { maxFragmentLen: 120 });
		const many = encodePsbtToFrames(psbt, { maxFragmentLen: 30 });
		expect(many.length).toBeGreaterThan(few.length);
	});
});

describe('PsbtQrJoiner round-trip (encode → scan back → reassemble)', () => {
	it('reassembles a single-frame PSBT byte-for-byte', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { maxFragmentLen: 4000 });
		expect(frames.length).toBe(1);
		const joiner = new PsbtQrJoiner();
		const last = joiner.add(frames[0]);
		expect(last.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});

	it('reassembles a MULTI-frame PSBT fed in order', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 4 });
		expect(frames.length).toBeGreaterThanOrEqual(4);

		const joiner = new PsbtQrJoiner();
		frames.forEach((f, i) => {
			const { complete, progress } = joiner.add(f);
			expect(progress.have).toBe(i + 1);
			expect(progress.total).toBe(frames.length);
			expect(complete).toBe(i === frames.length - 1);
		});
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});

	it('reassembles a MULTI-frame PSBT fed SHUFFLED and with duplicates', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 5 });
		expect(frames.length).toBeGreaterThanOrEqual(5);

		// Reverse order + a duplicate of the first frame (mimics a camera re-reading
		// the current frame before Jade's display advances).
		const scanned = [...frames].reverse();
		scanned.splice(2, 0, frames[0]);

		const joiner = new PsbtQrJoiner();
		for (const f of scanned) joiner.add(f);
		expect(joiner.isComplete()).toBe(true);
		expect(joiner.progress().have).toBe(frames.length); // duplicate didn't inflate the count
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});

	it('reports missing frames and refuses to reassemble early', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]); // withhold the rest
		expect(joiner.isComplete()).toBe(false);
		expect(joiner.missing().length).toBe(frames.length - 1);
		expect(() => joiner.result()).toThrow(/incomplete/i);
	});

	it('reset() clears state to scan a fresh sequence', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]);
		joiner.reset();
		expect(joiner.progress()).toEqual({ have: 0, total: 0 });
		for (const f of frames) joiner.add(f);
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});
});

describe('malformed / foreign frame rejection', () => {
	it('rejects a non-UR QR string', () => {
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add('bitcoin:bc1qexampleaddress')).toThrow(/not a Jade/i);
		expect(looksLikeUrFrame('bitcoin:bc1qexampleaddress')).toBe(false);
	});

	it('rejects a BBQr frame (wrong codec) rather than mis-decoding it', () => {
		// A BBQr frame ("B$…") is NOT a BC-UR frame — the Jade QR signer must not
		// silently accept the other air-gapped format's frames.
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add('B$2P0100ABCDEF')).toThrow(/not a Jade/i);
		expect(looksLikeUrFrame('B$2P0100ABCDEF')).toBe(false);
	});

	it('rejects a UR frame whose bytewords checksum is corrupted', async () => {
		const psbt = await realPsbtBase64();
		const [frame] = encodePsbtToFrames(psbt);
		// Flip the last character of the bytewords body → checksum (or content)
		// mismatch. The joiner must throw, never return corrupt bytes.
		const flipped = frame.slice(0, -1) + (frame.endsWith('a') ? 'b' : 'a');
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add(flipped)).toThrow();
	});

	it('refuses to mix frames from two different transactions', async () => {
		const a = await realPsbtBase64();
		// A second, different PSBT (different recipient amount → different bytes).
		const draftB = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 25_000 }],
			feeRate: 10
		});
		const framesA = encodePsbtToFrames(a, { minFragments: 3 });
		const framesB = encodePsbtToFrames(draftB.psbtBase64, { minFragments: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(framesA[0]);
		// A frame from a different sequence has a different messageLen/checksum.
		expect(() => joiner.add(framesB[framesB.length - 1])).toThrow(/different transaction/i);
	});

	it('parseUrFrame extracts the sequence header of a multipart frame', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minFragments: 3 });
		const p = parseUrFrame(frames[1]);
		expect(p).not.toBeNull();
		expect(p!.seqNum).toBe(2);
		expect(p!.seqLen).toBe(frames.length);
		expect(p!.body.length).toBeGreaterThan(0);
	});
});
