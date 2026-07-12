// Proves the BC-UR crypto-hdkey/crypto-account cosigner-key QR import path
// WITHOUT a camera or a real air-gapped device: hand-build realistic
// BCR-2020-007/BCR-2020-015 CBOR fixtures (the same shapes SeedSigner/
// Keystone/Passport/Jade emit), bytewords+multipart-encode them with
// jadeUr.ts's own (now-shared) encoder helpers, feed them through
// BcurKeyJoiner exactly like a live scan would, and check the rebuilt xpub,
// fingerprint, path, and testnet-conversion notice.

import { describe, it, expect } from 'vitest';
import { bytewordsEncode, cborByteString, cborUint, encodePart } from './jadeUr';
import {
	BcurKeyJoiner,
	decodeScannedKeyCbor,
	looksLikeBcurKeyFrame,
	looksLikePlainKeyText,
	parseBcurKeyFrame,
	type ScannedKeyImport
} from './bcurKey';
import { XPUB_VERSION, b58check } from './common';

// ── tiny local CBOR encoder for building test fixtures ──────────────────────
// (bcurKey.ts itself only ever DECODES — production has no encoder to reuse,
// so fixture-building duplicates a handful of trivial header-encoders that
// mirror jadeUr.ts's cborByteString/cborUint exactly.)

function concatAll(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function cborArrayHeader(n: number): Uint8Array {
	if (n < 24) return new Uint8Array([0x80 | n]);
	return new Uint8Array([0x98, n]);
}

function cborMapHeader(n: number): Uint8Array {
	if (n < 24) return new Uint8Array([0xa0 | n]);
	return new Uint8Array([0xb8, n]);
}

function cborTagHeader(tag: number): Uint8Array {
	// crypto-hdkey/keypath/coin-info/account tags (303/304/305/311) all need
	// the 2-byte-length form (major type 6, additional info 25) — they're all
	// > 255, so the naive 1-byte form would silently truncate the tag number.
	if (tag < 24) return new Uint8Array([0xc0 | tag]);
	if (tag < 256) return new Uint8Array([0xd8, tag]);
	if (tag < 65536) return new Uint8Array([0xd9, (tag >> 8) & 0xff, tag & 0xff]);
	return new Uint8Array([0xda, (tag >>> 24) & 0xff, (tag >>> 16) & 0xff, (tag >>> 8) & 0xff, tag & 0xff]);
}

function cborBool(b: boolean): Uint8Array {
	return new Uint8Array([b ? 0xf5 : 0xf4]);
}

/** [index, hardened, index, hardened, …] flat components array for a path. */
function cborComponents(indices: { index: number; hardened: boolean }[]): Uint8Array {
	const parts: Uint8Array[] = [cborArrayHeader(indices.length * 2)];
	for (const { index, hardened } of indices) {
		parts.push(cborUint(index), cborBool(hardened));
	}
	return concatAll(...parts);
}

/** crypto-keypath (tag 304): {1: components, 2: sourceFingerprint}. */
function cborKeypath(indices: { index: number; hardened: boolean }[], sourceFingerprint: number): Uint8Array {
	return concatAll(
		cborTagHeader(304),
		cborMapHeader(2),
		cborUint(1),
		cborComponents(indices),
		cborUint(2),
		cborUint(sourceFingerprint)
	);
}

/** crypto-coin-info (tag 305): {2: network} (0 mainnet, 1 testnet). */
function cborUseInfo(network: number): Uint8Array {
	return concatAll(cborTagHeader(305), cborMapHeader(1), cborUint(2), cborUint(network));
}

/** crypto-hdkey (tag 303) map body — NOT yet tag-wrapped. */
function cborHDKeyMapBody(opts: {
	pubkey: Uint8Array;
	chainCode: Uint8Array;
	parentFingerprint: number;
	sourceFingerprint: number;
	indices: { index: number; hardened: boolean }[];
	network?: number;
}): Uint8Array {
	const hasUseInfo = opts.network !== undefined;
	const fieldCount = 4 + (hasUseInfo ? 1 : 0); // key-data, chain-code, origin, parent-fp [+ use-info]
	const parts: Uint8Array[] = [cborMapHeader(fieldCount)];
	parts.push(cborUint(3), cborByteString(opts.pubkey));
	parts.push(cborUint(4), cborByteString(opts.chainCode));
	if (hasUseInfo) parts.push(cborUint(5), cborUseInfo(opts.network!));
	parts.push(cborUint(6), cborKeypath(opts.indices, opts.sourceFingerprint));
	parts.push(cborUint(8), cborUint(opts.parentFingerprint));
	return concatAll(...parts);
}

function cborHDKeyTagged(opts: Parameters<typeof cborHDKeyMapBody>[0]): Uint8Array {
	return concatAll(cborTagHeader(303), cborHDKeyMapBody(opts));
}

/** crypto-account (tag 311): {1: masterFp, 2: [output-descriptors]}. Wraps a
 *  single tagged crypto-hdkey directly as descriptor[0] — the common shape
 *  for a per-cosigner-key export (no multi-key script wrapper needed). */
function cborAccountTagged(masterFingerprint: number, hdKey: Uint8Array): Uint8Array {
	return concatAll(
		cborTagHeader(311),
		cborMapHeader(2),
		cborUint(1),
		cborUint(masterFingerprint),
		cborUint(2),
		cborArrayHeader(1),
		hdKey
	);
}

/** Wrap raw CBOR message bytes as a single-part `ur:<type>/<bytewords>` frame. */
function singlePartFrame(type: string, cbor: Uint8Array): string {
	return `ur:${type}/${bytewordsEncode(cbor)}`;
}

/** Split raw CBOR message bytes into N `ur:<type>/i-N/<bytewords>` frames. */
function multiPartFrames(type: string, cbor: Uint8Array, parts: number): string[] {
	const fragLen = Math.ceil(cbor.length / parts);
	const padded = new Uint8Array(fragLen * parts);
	padded.set(cbor, 0);
	const checksum = crc32For(cbor);
	const frames: string[] = [];
	for (let i = 1; i <= parts; i++) {
		const fragment = padded.slice((i - 1) * fragLen, i * fragLen);
		const part = encodePart(i, parts, cbor.length, checksum, fragment);
		frames.push(`ur:${type}/${i}-${parts}/${bytewordsEncode(part)}`);
	}
	return frames;
}

// crc32 isn't exported for direct fixture use under that name conflict-free —
// reuse jadeUr's own encode/decode round trip instead: bytewords carries its
// own CRC, and encodePart's `checksum` field is independently verified by
// BcurKeyJoiner against a fresh crc32 of the reassembled message, so fixture
// correctness there is exercised by the multi-part test passing at all. This
// tiny local CRC-32 (identical IEEE/reflected algorithm) only feeds encodePart's
// `checksum` field, which decodePart just carries through structurally.
function crc32For(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

// ── fixture key material ─────────────────────────────────────────────────────

const PUBKEY = new Uint8Array(33);
PUBKEY[0] = 0x02;
for (let i = 1; i < 33; i++) PUBKEY[i] = i;

const CHAIN_CODE = new Uint8Array(32);
for (let i = 0; i < 32; i++) CHAIN_CODE[i] = 100 + i;

const SOURCE_FP = 0xa1b2c3d4;
const PARENT_FP = 0x11223344;
const PATH_INDICES = [
	{ index: 48, hardened: true },
	{ index: 0, hardened: true },
	{ index: 0, hardened: true },
	{ index: 2, hardened: true }
];

function expectedXpub(): string {
	const raw = new Uint8Array(78);
	raw[0] = (XPUB_VERSION >>> 24) & 0xff;
	raw[1] = (XPUB_VERSION >>> 16) & 0xff;
	raw[2] = (XPUB_VERSION >>> 8) & 0xff;
	raw[3] = XPUB_VERSION & 0xff;
	raw[4] = 4; // depth
	raw[5] = (PARENT_FP >>> 24) & 0xff;
	raw[6] = (PARENT_FP >>> 16) & 0xff;
	raw[7] = (PARENT_FP >>> 8) & 0xff;
	raw[8] = PARENT_FP & 0xff;
	const lastIndex = 2 + 0x80000000; // hardened 2'
	raw[9] = (lastIndex >>> 24) & 0xff;
	raw[10] = (lastIndex >>> 16) & 0xff;
	raw[11] = (lastIndex >>> 8) & 0xff;
	raw[12] = lastIndex & 0xff;
	raw.set(CHAIN_CODE, 13);
	raw.set(PUBKEY, 45);
	return b58check.encode(raw);
}

describe('parseBcurKeyFrame / looksLikeBcurKeyFrame / looksLikePlainKeyText', () => {
	it('recognizes single- and multi-part crypto-hdkey/crypto-account envelopes', () => {
		expect(parseBcurKeyFrame('ur:crypto-hdkey/abcdefgh')).toEqual({
			type: 'crypto-hdkey',
			seqNum: null,
			seqLen: null,
			body: 'abcdefgh'
		});
		expect(parseBcurKeyFrame('UR:CRYPTO-ACCOUNT/2-5/abcd')).toEqual({
			type: 'crypto-account',
			seqNum: 2,
			seqLen: 5,
			body: 'abcd'
		});
		expect(looksLikeBcurKeyFrame('ur:crypto-hdkey/abcd')).toBe(true);
	});

	it('rejects a crypto-psbt frame and plain text', () => {
		expect(parseBcurKeyFrame('ur:crypto-psbt/abcd')).toBeNull();
		expect(looksLikeBcurKeyFrame('not a qr frame')).toBe(false);
	});

	it('still recognizes the wizard\'s pre-existing plain-text key acceptance', () => {
		expect(looksLikePlainKeyText('xpub6D4BDPcP2...')).toBe(true);
		expect(looksLikePlainKeyText("[a1b2c3d4/48'/0'/0'/2']xpub6D...")).toBe(true);
		expect(looksLikePlainKeyText('hello world')).toBe(false);
	});
});

describe('decodeScannedKeyCbor — crypto-hdkey (BCR-2020-007)', () => {
	it('rebuilds the xpub under HEARTWOOD\'s own mainnet version bytes and extracts fingerprint/path', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const scanned = decodeScannedKeyCbor('crypto-hdkey', cbor);
		expect(scanned.xpub).toBe(expectedXpub());
		expect(scanned.xpub.startsWith('xpub')).toBe(true);
		expect(scanned.fingerprint).toBe('a1b2c3d4');
		expect(scanned.bip32Path).toBe("m/48'/0'/0'/2'");
		expect(scanned.convertedFromTestnet).toBe(false);
	});

	it('flags convertedFromTestnet when the BC-UR use-info says testnet, but still rebuilds a mainnet xpub', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES,
			network: 1 // testnet
		});
		const scanned = decodeScannedKeyCbor('crypto-hdkey', cbor);
		expect(scanned.convertedFromTestnet).toBe(true);
		expect(scanned.xpub).toBe(expectedXpub()); // same key material -> same rebuilt xpub
		expect(scanned.xpub.startsWith('xpub')).toBe(true); // never a tpub
	});

	it('rejects a key with no chain code (a non-extended single public key)', () => {
		const cbor = concatAll(
			// crypto-hdkey map with ONLY key-data — no chain-code field.
			new Uint8Array([0xa1]), // map(1)
			cborUint(3),
			cborByteString(PUBKEY)
		);
		expect(() => decodeScannedKeyCbor('crypto-hdkey', cbor)).toThrow(/chain code/i);
	});
});

describe('decodeScannedKeyCbor — crypto-account (BCR-2020-015)', () => {
	it('finds the first output descriptor\'s embedded crypto-hdkey and prefers the account-level master fingerprint', () => {
		const hdKey = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: 0xdeadbeef, // deliberately different from the account-level fp below
			indices: PATH_INDICES
		});
		const cbor = cborAccountTagged(SOURCE_FP, hdKey);
		const scanned = decodeScannedKeyCbor('crypto-account', cbor);
		expect(scanned.xpub).toBe(expectedXpub());
		// crypto-account's own master-fingerprint (field 1) wins over the nested
		// hdkey's own origin fingerprint, per BCR-2020-015 precedence.
		expect(scanned.fingerprint).toBe('a1b2c3d4');
		expect(scanned.bip32Path).toBe("m/48'/0'/0'/2'");
	});
});

describe('BcurKeyJoiner — single-part scan', () => {
	it('completes immediately on one crypto-hdkey frame and JSON-encodes the ScannedKeyImport', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const frame = singlePartFrame('crypto-hdkey', cbor);
		const joiner = new BcurKeyJoiner();
		const { complete, progress } = joiner.add(frame);
		expect(complete).toBe(true);
		expect(progress).toEqual({ have: 1, total: 1 });
		const scanned = JSON.parse(joiner.result()) as ScannedKeyImport;
		expect(scanned.kind).toBe('bcur');
		expect(scanned.urType).toBe('crypto-hdkey');
		expect(scanned.xpub).toBe(expectedXpub());
		expect(scanned.fingerprint).toBe('a1b2c3d4');
	});

	it('accepts the wizard\'s pre-existing plain-text paste (bare xpub / [fp/path]xpub) as an instant single frame', () => {
		const joiner = new BcurKeyJoiner();
		const { complete } = joiner.add("[a1b2c3d4/48'/0'/0'/2']xpub6Dfoo");
		expect(complete).toBe(true);
		const scanned = JSON.parse(joiner.result()) as ScannedKeyImport;
		expect(scanned).toEqual({
			kind: 'plain',
			xpub: "[a1b2c3d4/48'/0'/0'/2']xpub6Dfoo",
			fingerprint: null,
			bip32Path: null,
			convertedFromTestnet: false
		});
	});

	it('throws on an unrecognized frame (a stray/foreign QR)', () => {
		const joiner = new BcurKeyJoiner();
		expect(() => joiner.add('ur:crypto-psbt/abcdefgh')).toThrow(/not a recognized public-key export/i);
	});

	it('reset() clears progress and the plain/BC-UR result state', () => {
		const joiner = new BcurKeyJoiner();
		joiner.add('xpub6Dfoo');
		expect(joiner.isComplete()).toBe(true);
		joiner.reset();
		expect(joiner.isComplete()).toBe(false);
		expect(joiner.progress()).toEqual({ have: 0, total: 0 });
	});
});

describe('BcurKeyJoiner — animated (multi-part) scan', () => {
	it('reassembles a crypto-hdkey split across 3 frames, fed in order', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const frames = multiPartFrames('crypto-hdkey', cbor, 3);
		const joiner = new BcurKeyJoiner();
		let last: { complete: boolean; progress: { have: number; total: number } } | null = null;
		for (const f of frames) last = joiner.add(f);
		expect(last?.complete).toBe(true);
		expect(last?.progress).toEqual({ have: 3, total: 3 });
		const scanned = JSON.parse(joiner.result()) as ScannedKeyImport;
		expect(scanned.xpub).toBe(expectedXpub());
		expect(scanned.fingerprint).toBe('a1b2c3d4');
	});

	it('reassembles out of order, tolerating a duplicate frame, and reports progress along the way', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const frames = multiPartFrames('crypto-hdkey', cbor, 4);
		const joiner = new BcurKeyJoiner();
		const p1 = joiner.add(frames[2]);
		expect(p1.complete).toBe(false);
		expect(p1.progress).toEqual({ have: 1, total: 4 });
		joiner.add(frames[2]); // duplicate — shouldn't double-count
		expect(joiner.progress()).toEqual({ have: 1, total: 4 });
		joiner.add(frames[0]);
		joiner.add(frames[3]);
		const last = joiner.add(frames[1]);
		expect(last.complete).toBe(true);
		const scanned = JSON.parse(joiner.result()) as ScannedKeyImport;
		expect(scanned.xpub).toBe(expectedXpub());
	});

	it('rejects frames mixed from two different key exports', () => {
		const cborA = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const cborB = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: 0x99999999,
			indices: [{ index: 1, hardened: true }]
		});
		const framesA = multiPartFrames('crypto-hdkey', cborA, 3);
		const framesB = multiPartFrames('crypto-hdkey', cborB, 5);
		const joiner = new BcurKeyJoiner();
		joiner.add(framesA[0]);
		expect(() => joiner.add(framesB[1])).toThrow(/two different key exports/i);
	});

	it('rejects mixing crypto-hdkey and crypto-account frames', () => {
		const cbor = cborHDKeyTagged({
			pubkey: PUBKEY,
			chainCode: CHAIN_CODE,
			parentFingerprint: PARENT_FP,
			sourceFingerprint: SOURCE_FP,
			indices: PATH_INDICES
		});
		const hdkeyFrames = multiPartFrames('crypto-hdkey', cbor, 2);
		const accountCbor = cborAccountTagged(SOURCE_FP, cbor);
		const accountFrames = multiPartFrames('crypto-account', accountCbor, 2);
		const joiner = new BcurKeyJoiner();
		joiner.add(hdkeyFrames[0]);
		expect(() => joiner.add(accountFrames[0])).toThrow(/two different key exports/i);
	});
});
