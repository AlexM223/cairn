import { describe, it, expect } from 'vitest';
import { base64 } from '@scure/base';
import { constructPsbt, type SpendableUtxo } from '$lib/server/bitcoin/psbt';
import {
	encodePsbtToFrames,
	PsbtQrJoiner,
	parseBbqrHeader,
	looksLikeBbqrFrame
} from './bbqr';

// The whole point of this suite: prove the QR path is sound WITHOUT a camera or
// a physical device. If a real base64 PSBT survives encodePsbtToFrames →
// (scan back, in order AND shuffled) → PsbtQrJoiner.result() byte-for-byte,
// then the air-gapped display/scan mechanics work; only the live camera and the
// device itself remain unverifiable here.

// BIP84 documentation vectors ("abandon … about"), same public test keys the
// psbt suite uses — never a real wallet.
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

describe('encodePsbtToFrames', () => {
	it('produces valid BBQr PSBT frames from a real base64 PSBT', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt);
		expect(frames.length).toBeGreaterThan(0);
		for (const f of frames) {
			const h = parseBbqrHeader(f);
			expect(h, `frame parses: ${f.slice(0, 12)}`).not.toBeNull();
			expect(h!.fileType).toBe('P'); // PSBT file type
			expect(h!.total).toBe(frames.length);
		}
		// Indices are the full 0…N-1 set exactly once.
		const indices = frames.map((f) => parseBbqrHeader(f)!.index).sort((a, b) => a - b);
		expect(indices).toEqual(frames.map((_, i) => i));
	});

	it('splits into multiple frames when forced small (exercises reassembly)', async () => {
		const psbt = await realPsbtBase64();
		// Force at least 3 frames so the reassembly path is genuinely multi-part.
		const frames = encodePsbtToFrames(psbt, { minSplit: 3 });
		expect(frames.length).toBeGreaterThanOrEqual(3);
	});
});

describe('PsbtQrJoiner round-trip (encode → scan back → reassemble)', () => {
	it('reassembles a single-frame PSBT byte-for-byte', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt); // small PSBT → likely 1 frame
		const joiner = new PsbtQrJoiner();
		let last = { complete: false, progress: { have: 0, total: 0 } };
		for (const f of frames) last = joiner.add(f);
		expect(last.complete).toBe(true);
		expect(joiner.result()).toBe(psbt);
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});

	it('reassembles a MULTI-frame PSBT fed in order', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minSplit: 3 });
		expect(frames.length).toBeGreaterThanOrEqual(3);

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
		const frames = encodePsbtToFrames(psbt, { minSplit: 4 });
		expect(frames.length).toBeGreaterThanOrEqual(4);

		// Reverse order + a duplicate of the first frame (mimics a camera
		// re-reading the current frame before the device's display advances).
		const scanned = [...frames].reverse();
		scanned.splice(2, 0, frames[0]); // inject a duplicate mid-scan

		const joiner = new PsbtQrJoiner();
		for (const f of scanned) joiner.add(f);
		expect(joiner.isComplete()).toBe(true);
		expect(joiner.progress().have).toBe(frames.length); // duplicate didn't inflate the count
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});

	it('reports missing frames and refuses to reassemble early', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minSplit: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]); // withhold the rest
		expect(joiner.isComplete()).toBe(false);
		expect(joiner.missing().length).toBe(frames.length - 1);
		expect(() => joiner.result()).toThrow(/incomplete/i);
	});

	it('rejects a non-BBQr QR string', () => {
		const joiner = new PsbtQrJoiner();
		expect(() => joiner.add('bitcoin:bc1qexampleaddress')).toThrow(/not a BBQr/i);
		expect(looksLikeBbqrFrame('bitcoin:bc1qexampleaddress')).toBe(false);
	});

	it('reset() clears state to scan a fresh sequence', async () => {
		const psbt = await realPsbtBase64();
		const frames = encodePsbtToFrames(psbt, { minSplit: 3 });
		const joiner = new PsbtQrJoiner();
		joiner.add(frames[0]);
		joiner.reset();
		expect(joiner.progress()).toEqual({ have: 0, total: 0 });
		for (const f of frames) joiner.add(f);
		expect(bytesOf(joiner.result())).toEqual(bytesOf(psbt));
	});
});
