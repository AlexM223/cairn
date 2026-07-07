import { describe, it, expect } from 'vitest';
import { Transaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
	psbtHasKeyOrigin,
	normalizeFingerprint,
	normalizeOriginPath,
	parseKeyOriginInput
} from './keyOrigin';

const PUBKEY = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const HARDENED = 0x80000000;
const DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function makeInput(withDerivation: boolean) {
	return {
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n },
		...(withDerivation
			? {
					bip32Derivation: [
						[
							PUBKEY,
							{
								fingerprint: 0x1a2b3c4d,
								path: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED, 0, 4]
							}
						]
					] as [Uint8Array, { fingerprint: number; path: number[] }][]
				}
			: {})
	};
}

function makePsbt(inputs: boolean[]): string {
	const tx = new Transaction();
	for (const withDerivation of inputs) tx.addInput(makeInput(withDerivation));
	tx.addOutputAddress(DEST, 90_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('psbtHasKeyOrigin', () => {
	it('is true when every input carries bip32Derivation', () => {
		expect(psbtHasKeyOrigin(makePsbt([true, true]))).toBe(true);
	});

	it('is false for a bare-xpub PSBT with no derivation info', () => {
		expect(psbtHasKeyOrigin(makePsbt([false]))).toBe(false);
	});

	it('is false when any single input is missing key-origin', () => {
		expect(psbtHasKeyOrigin(makePsbt([true, false]))).toBe(false);
	});

	it('is false for garbage input', () => {
		expect(psbtHasKeyOrigin('not-a-psbt')).toBe(false);
	});

	it('is false for a PSBT with no inputs', () => {
		const tx = new Transaction();
		tx.addOutputAddress(DEST, 90_000n, NETWORK);
		expect(psbtHasKeyOrigin(base64.encode(tx.toPSBT()))).toBe(false);
	});
});

// ------------------------- key-origin input parsing (cairn-alw8) -------------------------

// BIP84 test-vector zpub ("abandon … about") — public test key, never a real wallet.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('normalizeFingerprint', () => {
	it('lowercases a valid 8-hex-char fingerprint', () => {
		expect(normalizeFingerprint('73C5DA0A')).toBe('73c5da0a');
		expect(normalizeFingerprint('  73c5da0a ')).toBe('73c5da0a');
	});

	it('rejects the all-zero placeholder', () => {
		expect(normalizeFingerprint('00000000')).toBeNull();
	});

	it('rejects wrong lengths, non-hex, and non-strings', () => {
		expect(normalizeFingerprint('73c5da0')).toBeNull(); // 7 chars
		expect(normalizeFingerprint('73c5da0a1')).toBeNull(); // 9 chars
		expect(normalizeFingerprint('73c5dazz')).toBeNull();
		expect(normalizeFingerprint('')).toBeNull();
		expect(normalizeFingerprint(null)).toBeNull();
		expect(normalizeFingerprint(undefined)).toBeNull();
		expect(normalizeFingerprint(0x73c5da0a)).toBeNull(); // number, not hex string
	});
});

describe('normalizeOriginPath', () => {
	it('canonicalizes apostrophe and h/H hardened markers', () => {
		expect(normalizeOriginPath("m/84'/0'/0'")).toBe("m/84'/0'/0'");
		expect(normalizeOriginPath('m/84h/0h/0h')).toBe("m/84'/0'/0'");
		expect(normalizeOriginPath('m/84H/0H/0H')).toBe("m/84'/0'/0'");
		expect(normalizeOriginPath("84'/0'/0'")).toBe("m/84'/0'/0'"); // no m/ prefix
	});

	it('keeps unhardened segments unhardened', () => {
		expect(normalizeOriginPath("m/45'/0/0")).toBe("m/45'/0/0");
	});

	it('rejects garbage, empty, bare m, and out-of-range indices', () => {
		expect(normalizeOriginPath('')).toBeNull();
		expect(normalizeOriginPath('m')).toBeNull();
		expect(normalizeOriginPath('not/a/path')).toBeNull();
		expect(normalizeOriginPath("m/84'/x/0'")).toBeNull();
		expect(normalizeOriginPath("m/2147483648'")).toBeNull(); // 2^31
		expect(normalizeOriginPath("m/-1'")).toBeNull();
		expect(normalizeOriginPath(null)).toBeNull();
	});
});

describe('parseKeyOriginInput', () => {
	it('passes a bare xpub through with no origin', () => {
		expect(parseKeyOriginInput(`  ${ZPUB}  `)).toEqual({
			xpub: ZPUB,
			fingerprint: null,
			path: null
		});
	});

	it('extracts fingerprint and path from key-origin form', () => {
		expect(parseKeyOriginInput(`[73C5DA0A/84'/0'/0']${ZPUB}`)).toEqual({
			xpub: ZPUB,
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
	});

	it('handles h-hardened markers and a trailing derivation suffix', () => {
		expect(parseKeyOriginInput(`[73c5da0a/84h/0h/0h]${ZPUB}/0/*`)).toEqual({
			xpub: ZPUB,
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
	});

	it('unwraps a full descriptor with multipath suffix and checksum', () => {
		// The exact shape TrezorConnect.getPublicKey returns in `descriptor`.
		expect(parseKeyOriginInput(`wpkh([73c5da0a/84'/0'/0']${ZPUB}/<0;1>/*)#8yg7wpms`)).toEqual({
			xpub: ZPUB,
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
	});

	it('unwraps nested script functions (sh(wpkh(…)))', () => {
		expect(parseKeyOriginInput(`sh(wpkh([73c5da0a/49'/0'/0']${ZPUB}/0/*))`)).toEqual({
			xpub: ZPUB,
			fingerprint: '73c5da0a',
			path: "m/49'/0'/0'"
		});
	});

	it('is lenient about an unusable embedded origin — key survives, origin nulls', () => {
		// Placeholder fingerprint.
		expect(parseKeyOriginInput(`[00000000/84'/0'/0']${ZPUB}`)).toEqual({
			xpub: ZPUB,
			fingerprint: null,
			path: "m/84'/0'/0'"
		});
		// Malformed fingerprint AND path.
		expect(parseKeyOriginInput(`[nonsense/xyz]${ZPUB}`)).toEqual({
			xpub: ZPUB,
			fingerprint: null,
			path: null
		});
		// Fingerprint only, no path.
		expect(parseKeyOriginInput(`[73c5da0a]${ZPUB}`)).toEqual({
			xpub: ZPUB,
			fingerprint: '73c5da0a',
			path: null
		});
	});

	it('returns whatever non-key garbage remains for downstream validation', () => {
		// parseXpub is the real validator; this parser just never throws.
		expect(parseKeyOriginInput('').xpub).toBe('');
		expect(parseKeyOriginInput('hello world').xpub).toBe('hello world');
	});
});
