import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createBase58check, bech32, bech32m } from '@scure/base';
import {
	parseXpub,
	deriveAddress,
	addressToScriptPubKey,
	addressToScripthash,
	isValidAddress,
	isExplorerAddress,
	isValidXpub
} from './xpub';

const b58check = createBase58check(sha256);

// BIP84 test vector account zpub (mnemonic "abandon abandon ... about").
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
// BIP49 test vector account ypub (same mnemonic).
const YPUB =
	'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
// BIP44 test vector account xpub (same mnemonic).
const XPUB =
	'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
// BIP32 test vector 1 master private key (must be rejected).
const XPRV =
	'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

/** Re-encode a mainnet xpub with different version bytes (e.g. tpub/vpub). */
function withVersion(extendedKey: string, version: number): string {
	const raw = new Uint8Array(b58check.decode(extendedKey));
	raw[0] = (version >>> 24) & 0xff;
	raw[1] = (version >>> 16) & 0xff;
	raw[2] = (version >>> 8) & 0xff;
	raw[3] = version & 0xff;
	return b58check.encode(raw);
}

describe('parseXpub', () => {
	it('detects xpub as p2pkh (BIP44)', () => {
		expect(parseXpub(XPUB).scriptType).toBe('p2pkh');
	});

	it('detects ypub as p2sh-p2wpkh (BIP49)', () => {
		expect(parseXpub(YPUB).scriptType).toBe('p2sh-p2wpkh');
	});

	it('detects zpub as p2wpkh (BIP84)', () => {
		expect(parseXpub(ZPUB).scriptType).toBe('p2wpkh');
	});

	it('accepts surrounding whitespace', () => {
		expect(parseXpub(`  ${ZPUB}\n`).scriptType).toBe('p2wpkh');
	});

	it('returns an 8-hex-char fingerprint', () => {
		expect(parseXpub(XPUB).fingerprint).toMatch(/^[0-9a-f]{8}$/);
	});

	it('rejects testnet tpub', () => {
		const tpub = withVersion(XPUB, 0x043587cf);
		expect(() => parseXpub(tpub)).toThrow(/testnet/i);
	});

	it('rejects testnet vpub', () => {
		const vpub = withVersion(XPUB, 0x045f1cf6);
		expect(() => parseXpub(vpub)).toThrow(/testnet/i);
	});

	it('rejects private xprv with a helpful message', () => {
		expect(() => parseXpub(XPRV)).toThrow(/private extended key/i);
	});

	it('rejects garbage', () => {
		expect(() => parseXpub('definitely not an xpub')).toThrow();
	});

	it('rejects empty / whitespace-only input', () => {
		expect(() => parseXpub('')).toThrow(/empty/i);
		expect(() => parseXpub('   ')).toThrow(/empty/i);
	});

	it('rejects a bad checksum (one flipped character)', () => {
		const last = XPUB.slice(-1);
		const flipped = XPUB.slice(0, -1) + (last === 'j' ? 'k' : 'j');
		expect(() => parseXpub(flipped)).toThrow(/checksum/i);
	});

	it('rejects an unknown version prefix', () => {
		// Ethereum-style bogus version bytes, valid base58check otherwise.
		const bogus = withVersion(XPUB, 0x11223344);
		expect(() => parseXpub(bogus)).toThrow(/unrecognized/i);
	});
});

describe('deriveAddress', () => {
	it('derives BIP84 zpub receive addresses (BIP84 test vectors)', () => {
		const parsed = parseXpub(ZPUB);
		expect(deriveAddress(parsed, 0, 0)).toEqual({
			address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
			path: 'm/0/0'
		});
		expect(deriveAddress(parsed, 0, 1)).toEqual({
			address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
			path: 'm/0/1'
		});
	});

	it('derives BIP84 zpub change address m/1/0 (BIP84 test vector)', () => {
		const parsed = parseXpub(ZPUB);
		expect(deriveAddress(parsed, 1, 0)).toEqual({
			address: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
			path: 'm/1/0'
		});
	});

	it('derives BIP49 ypub m/0/0 (BIP49 test vector)', () => {
		const parsed = parseXpub(YPUB);
		expect(deriveAddress(parsed, 0, 0).address).toBe('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
	});

	it('derives BIP44 xpub m/0/0 (BIP44 test vector)', () => {
		const parsed = parseXpub(XPUB);
		expect(deriveAddress(parsed, 0, 0).address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
	});

	it('rejects invalid derivation indices', () => {
		const parsed = parseXpub(ZPUB);
		expect(() => deriveAddress(parsed, 0, -1)).toThrow(/invalid derivation index/i);
		expect(() => deriveAddress(parsed, 0, 1.5)).toThrow(/invalid derivation index/i);
		expect(() => deriveAddress(parsed, 0, 0x80000000)).toThrow(/invalid derivation index/i);
	});
});

describe('addressToScriptPubKey', () => {
	it('encodes P2PKH (genesis address)', () => {
		const script = addressToScriptPubKey('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
		expect(script.length).toBe(25);
		expect(bytesToHex(script)).toBe('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
	});

	it('encodes P2SH as a914<hash20>87', () => {
		// Construct a P2SH address for a known 20-byte hash so the expected
		// script bytes are unambiguous.
		const hash = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
		const payload = new Uint8Array(21);
		payload[0] = 0x05;
		payload.set(hash, 1);
		const address = b58check.encode(payload);
		expect(address.startsWith('3')).toBe(true);

		const script = addressToScriptPubKey(address);
		expect(script.length).toBe(23);
		expect(bytesToHex(script)).toBe('a914' + bytesToHex(hash) + '87');
	});

	it('encodes bech32 segwit v0 P2WPKH (BIP173 test vector)', () => {
		const script = addressToScriptPubKey('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
		expect(bytesToHex(script)).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6');
	});

	it('encodes taproot bc1p (bech32m, segwit v1) as 5120<program32>', () => {
		const program = Uint8Array.from({ length: 32 }, (_, i) => i);
		const address = bech32m.encode('bc', [1, ...bech32m.toWords(program)]);
		expect(address.startsWith('bc1p')).toBe(true);

		const script = addressToScriptPubKey(address);
		expect(script.length).toBe(34);
		expect(bytesToHex(script)).toBe('5120' + bytesToHex(program));
	});

	it('rejects segwit v1 encoded with bech32 (not bech32m)', () => {
		const program = Uint8Array.from({ length: 32 }, (_, i) => i);
		// Force plain-bech32 encoding of a v1 program — invalid per BIP350.
		const bad = bech32.encode('bc', [1, ...bech32.toWords(program)]);
		expect(() => addressToScriptPubKey(bad)).toThrow();
	});

	it('rejects segwit v0 encoded with bech32m (not bech32)', () => {
		const program = Uint8Array.from({ length: 20 }, (_, i) => i);
		const bad = bech32m.encode('bc', [0, ...bech32m.toWords(program)]);
		expect(() => addressToScriptPubKey(bad)).toThrow();
	});

	it('rejects a witness v1 program that is not exactly 32 bytes (BIP-341)', () => {
		// 20- and 33-byte v1 programs are valid bech32m but NOT valid taproot —
		// Core treats them as non-standard, and funds sent there may be stuck.
		for (const len of [20, 31, 33, 40]) {
			const program = Uint8Array.from({ length: len }, (_, i) => i + 1);
			const addr = bech32m.encode('bc', [1, ...bech32m.toWords(program)]);
			expect(() => addressToScriptPubKey(addr)).toThrow(/taproot/i);
			expect(isValidAddress(addr)).toBe(false);
		}
	});

	it('accepts future witness versions v2..v16 with any 2-40 byte program', () => {
		// Forward compatibility: v2+ semantics are undefined today, so only the
		// BIP-141 program-length bounds apply.
		const cases: [number, number][] = [
			[2, 32],
			[2, 20],
			[16, 2],
			[16, 40]
		];
		for (const [version, len] of cases) {
			const program = Uint8Array.from({ length: len }, (_, i) => i + 1);
			const addr = bech32m.encode('bc', [version, ...bech32m.toWords(program)]);
			const script = addressToScriptPubKey(addr);
			expect(script[0]).toBe(0x50 + version); // OP_2..OP_16
			expect(script[1]).toBe(len);
			expect(script.length).toBe(2 + len);
		}
	});

	it('rejects v2+ programs outside the 2-40 byte BIP-141 bounds', () => {
		for (const len of [1, 41]) {
			const program = Uint8Array.from({ length: len }, (_, i) => i + 1);
			const addr = bech32m.encode('bc', [2, ...bech32m.toWords(program)]);
			expect(() => addressToScriptPubKey(addr)).toThrow(/program length/i);
		}
	});

	it('accepts all-uppercase bech32 and bech32m addresses (the QR form)', () => {
		const upperV0 = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'; // BIP-173 vector
		expect(bytesToHex(addressToScriptPubKey(upperV0))).toBe(
			'0014751e76e8199196d454941c45d1b3a323f1433bd6'
		);
		const program = Uint8Array.from({ length: 32 }, (_, i) => i);
		const upperV1 = bech32m.encode('bc', [1, ...bech32m.toWords(program)]).toUpperCase();
		expect(bytesToHex(addressToScriptPubKey(upperV1))).toBe('5120' + bytesToHex(program));
	});

	it('rejects empty and garbage input', () => {
		expect(() => addressToScriptPubKey('')).toThrow(/empty/i);
		expect(() => addressToScriptPubKey('hello world')).toThrow();
	});
});

describe('addressToScripthash', () => {
	it('computes the Electrum scripthash of the genesis address (byte-reversed sha256)', () => {
		expect(addressToScripthash('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(
			'8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'
		);
	});

	it('is the byte reversal of sha256(scriptPubKey)', () => {
		const address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
		const forward = sha256(addressToScriptPubKey(address));
		const expected = bytesToHex(Uint8Array.from(forward).reverse());
		expect(addressToScripthash(address)).toBe(expected);
	});
});

describe('isValidAddress', () => {
	it.each([
		['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', true],
		['37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', true], // P2SH (BIP-49 vector)
		['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', true],
		['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', true], // P2WSH
		['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', true], // P2TR (BIP-86)
		['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', false], // bad bech32 checksum
		['bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', false], // mixed-case bech32
		['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcs', false], // bad bech32m checksum
		['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', false], // bad base58 checksum
		['', false],
		['   ', false],
		['not an address', false]
	])('%j -> %s', (input, expected) => {
		expect(isValidAddress(input)).toBe(expected);
	});
});

describe('isExplorerAddress', () => {
	// Build checksum-valid segwit addresses for any network/program so the test
	// vectors are unambiguous and don't depend on external fixtures.
	const seg = (hrp: string, version: number, len: number): string => {
		const program = Uint8Array.from({ length: len }, (_, i) => i + 1);
		const enc = version === 0 ? bech32 : bech32m;
		return enc.encode(hrp, [version, ...enc.toWords(program)]);
	};
	const base58 = (version: number): string => {
		const payload = new Uint8Array(21);
		payload[0] = version;
		payload.set(Uint8Array.from({ length: 20 }, (_, i) => i + 1), 1);
		return b58check.encode(payload);
	};

	// A real regtest P2WPKH (bcrt1q, 42 chars) and P2WSH (bcrt1, 62 chars).
	const bcrt1q = seg('bcrt', 0, 20);
	const bcrt1wsh = seg('bcrt', 0, 32);

	it('accepts a real regtest bcrt1q P2WPKH', () => {
		// bcrt HRP (4 chars) makes a P2WPKH 44 chars vs 42 for the 2-char bc/tb.
		expect(bcrt1q.length).toBe(44);
		expect(bcrt1q.startsWith('bcrt1q')).toBe(true);
		expect(isExplorerAddress(bcrt1q)).toBe(true);
	});

	it('accepts a real regtest bcrt1 P2WSH', () => {
		expect(bcrt1wsh.length).toBe(64); // 62 for bc/tb, +2 for the bcrt HRP
		expect(isExplorerAddress(bcrt1wsh)).toBe(true);
	});

	it('accepts mainnet, testnet and regtest bech32/bech32m across witness versions', () => {
		// v0 P2WPKH / P2WSH on each network
		for (const hrp of ['bc', 'tb', 'bcrt']) {
			expect(isExplorerAddress(seg(hrp, 0, 20))).toBe(true);
			expect(isExplorerAddress(seg(hrp, 0, 32))).toBe(true);
			expect(isExplorerAddress(seg(hrp, 1, 32))).toBe(true); // taproot
			expect(isExplorerAddress(seg(hrp, 2, 2))).toBe(true); // future v2
			expect(isExplorerAddress(seg(hrp, 16, 40))).toBe(true); // future v16
		}
	});

	it('accepts a known mainnet bc1q and testnet tb1q from BIP-173/vectors', () => {
		expect(isExplorerAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
		expect(isExplorerAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(true);
	});

	it('accepts uppercase (QR) bech32', () => {
		expect(isExplorerAddress(bcrt1q.toUpperCase())).toBe(true);
	});

	it('accepts base58 P2PKH/P2SH on mainnet and testnet+regtest', () => {
		expect(isExplorerAddress(base58(0x00))).toBe(true); // mainnet P2PKH
		expect(isExplorerAddress(base58(0x05))).toBe(true); // mainnet P2SH
		expect(isExplorerAddress(base58(0x6f))).toBe(true); // testnet/regtest P2PKH
		expect(isExplorerAddress(base58(0xc4))).toBe(true); // testnet/regtest P2SH
	});

	it('rejects BIP-350 encoding mixups', () => {
		const program20 = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
		const program32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
		// v0 encoded as bech32m — invalid
		const v0asM = bech32m.encode('bcrt', [0, ...bech32m.toWords(program20)]);
		expect(isExplorerAddress(v0asM)).toBe(false);
		// v1 encoded as plain bech32 — invalid
		const v1asBech32 = bech32.encode('bcrt', [1, ...bech32.toWords(program32)]);
		expect(isExplorerAddress(v1asBech32)).toBe(false);
	});

	it('rejects bad witness program lengths', () => {
		expect(isExplorerAddress(seg('bcrt', 0, 21))).toBe(false); // v0 must be 20/32
		expect(isExplorerAddress(seg('bcrt', 1, 20))).toBe(false); // taproot must be 32
		expect(isExplorerAddress(seg('bcrt', 2, 1))).toBe(false); // v2 min 2
		expect(isExplorerAddress(seg('bcrt', 2, 41))).toBe(false); // v2 max 40
	});

	it('rejects unknown HRPs and base58 versions', () => {
		expect(isExplorerAddress(seg('ltc', 0, 20))).toBe(false); // wrong HRP
		expect(isExplorerAddress(base58(0x30))).toBe(false); // litecoin P2PKH version
	});

	it('rejects garbage, empty and wrong-checksum addresses', () => {
		expect(isExplorerAddress('')).toBe(false);
		expect(isExplorerAddress('   ')).toBe(false);
		expect(isExplorerAddress('not an address')).toBe(false);
		// flip a char in a valid bcrt1q to break the checksum
		const bad = bcrt1q.slice(0, -1) + (bcrt1q.slice(-1) === 'q' ? 'p' : 'q');
		expect(isExplorerAddress(bad)).toBe(false);
		// wrong base58 checksum
		const wrongB58 = base58(0x6f);
		expect(isExplorerAddress(wrongB58.slice(0, -1) + (wrongB58.slice(-1) === 'A' ? 'B' : 'A'))).toBe(
			false
		);
	});

	it('leaves the mainnet-only isValidAddress unchanged (still rejects bcrt1/tb1)', () => {
		// The wallet-facing gate must remain strictly mainnet.
		expect(isValidAddress(bcrt1q)).toBe(false);
		expect(isValidAddress(bcrt1wsh)).toBe(false);
		expect(isValidAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
		expect(isValidAddress(base58(0x6f))).toBe(false); // testnet P2PKH
		// but still accepts mainnet
		expect(isValidAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
	});
});

describe('isValidXpub', () => {
	it('accepts xpub / ypub / zpub', () => {
		expect(isValidXpub(XPUB)).toBe(true);
		expect(isValidXpub(YPUB)).toBe(true);
		expect(isValidXpub(ZPUB)).toBe(true);
	});

	it('rejects testnet, private, garbage and empty keys', () => {
		expect(isValidXpub(withVersion(XPUB, 0x043587cf))).toBe(false); // tpub
		expect(isValidXpub(XPRV)).toBe(false);
		expect(isValidXpub('garbage')).toBe(false);
		expect(isValidXpub('')).toBe(false);
		expect(isValidXpub('   ')).toBe(false);
	});
});
