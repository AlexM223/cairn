import { describe, it, expect, afterEach } from 'vitest';
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
	isValidXpub,
	setDefaultNetwork,
	getDefaultNetwork
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

// ── network-aware prefix validation (cairn-10ox) ────────────────────────────
//
// parseXpub(input, network) must accept exactly the SLIP-132 prefix family
// that matches `network`, and reject every other family — in BOTH directions.
// This is a Bitcoin-correctness boundary, not just UX friction: a mainnet
// backend accepting a tpub (or vice versa) would let a wallet watch/derive
// against the wrong chain. The matrix below is exhaustive over every
// (network × version-byte) combination so no future edit can silently loosen
// one direction while "fixing" the other.
describe('parseXpub: network-aware prefix validation (cairn-10ox)', () => {
	afterEach(() => {
		// parseXpub's default `network` argument reads a module-level variable
		// (setDefaultNetwork/getDefaultNetwork) kept in sync with the configured
		// chain backend outside of tests. Any test that mutates it MUST restore
		// 'mainnet' afterward so it can't leak into unrelated test files sharing
		// this module instance.
		setDefaultNetwork('mainnet');
	});

	const MAINNET_PUBLIC = [
		{ label: 'xpub', version: 0x0488b21e, scriptType: 'p2pkh' },
		{ label: 'ypub', version: 0x049d7cb2, scriptType: 'p2sh-p2wpkh' },
		{ label: 'zpub', version: 0x04b24746, scriptType: 'p2wpkh' }
	] as const;
	const MAINNET_PRIVATE = [
		{ label: 'xprv', version: 0x0488ade4 },
		{ label: 'yprv', version: 0x049d7878 },
		{ label: 'zprv', version: 0x04b2430c }
	] as const;
	const TESTNET_PUBLIC = [
		{ label: 'tpub', version: 0x043587cf, scriptType: 'p2pkh' },
		{ label: 'upub', version: 0x044a5262, scriptType: 'p2sh-p2wpkh' },
		{ label: 'vpub', version: 0x045f1cf6, scriptType: 'p2wpkh' }
	] as const;
	const TESTNET_PRIVATE = [
		{ label: 'tprv', version: 0x04358394 },
		{ label: 'uprv', version: 0x044a4e28 },
		{ label: 'vprv', version: 0x045f18bc }
	] as const;

	describe.each(['testnet', 'regtest'] as const)('network=%s', (network) => {
		it.each(TESTNET_PUBLIC)('accepts $label and maps it to $scriptType', ({ label, version, scriptType }) => {
			const key = withVersion(XPUB, version);
			const parsed = parseXpub(key, network);
			expect(parsed.scriptType).toBe(scriptType);
			// Address derivation itself stays mainnet-encoded regardless of the
			// network the PREFIX was validated against (file header) — sanity
			// check the parsed key is otherwise usable.
			expect(parsed.hdkey.publicKey).toBeDefined();
			void label;
		});

		it.each(MAINNET_PUBLIC)('rejects mainnet $label as a foreign-network key', ({ version, label }) => {
			const key = withVersion(XPUB, version);
			expect(() => parseXpub(key, network)).toThrow(new RegExp(`mainnet.*not supported.*${network}`, 'i'));
			void label;
		});

		it.each(TESTNET_PRIVATE)('rejects $label as a private key (private gate fires before the network gate)', ({ label, version }) => {
			const key = withVersion(XPUB, version);
			expect(() => parseXpub(key, network)).toThrow(/private extended key/i);
			void label;
		});

		it.each(MAINNET_PRIVATE)(
			'rejects mainnet $label as a private key even though it is also a foreign-network key',
			({ label, version }) => {
				const key = withVersion(XPUB, version);
				expect(() => parseXpub(key, network)).toThrow(/private extended key/i);
				void label;
			}
		);
	});

	describe('network=mainnet (default)', () => {
		it.each(MAINNET_PUBLIC)('accepts $label and maps it to $scriptType', ({ version, scriptType }) => {
			const key = withVersion(XPUB, version);
			expect(parseXpub(key, 'mainnet').scriptType).toBe(scriptType);
			// Omitting the network argument must behave identically — 'mainnet'
			// is parseXpub's default.
			expect(parseXpub(key).scriptType).toBe(scriptType);
		});

		it.each(TESTNET_PUBLIC)('rejects $label as a foreign-network key', ({ label, version }) => {
			const key = withVersion(XPUB, version);
			expect(() => parseXpub(key, 'mainnet')).toThrow(/testnet.*not supported.*mainnet/i);
			expect(() => parseXpub(key)).toThrow(/testnet.*not supported.*mainnet/i);
			void label;
		});

		it.each(MAINNET_PRIVATE)('rejects $label as a private key', ({ label, version }) => {
			const key = withVersion(XPUB, version);
			expect(() => parseXpub(key, 'mainnet')).toThrow(/private extended key/i);
			void label;
		});

		it.each(TESTNET_PRIVATE)('rejects $label as a private key', ({ label, version }) => {
			const key = withVersion(XPUB, version);
			expect(() => parseXpub(key, 'mainnet')).toThrow(/private extended key/i);
			void label;
		});
	});

	it('the SAME raw key parses differently depending on the network argument (no stale cross-network cache leak)', () => {
		// parseCache is keyed on `${network}|${trimmed}` specifically so this
		// can never regress: a tpub string must be rejected under 'mainnet' and
		// accepted under 'regtest', however many times each is parsed, in
		// whichever order.
		const tpub = withVersion(XPUB, 0x043587cf);
		expect(() => parseXpub(tpub, 'mainnet')).toThrow(/testnet/i);
		expect(parseXpub(tpub, 'regtest').scriptType).toBe('p2pkh');
		expect(() => parseXpub(tpub, 'mainnet')).toThrow(/testnet/i); // still rejected after the regtest parse cached a result
		expect(parseXpub(tpub, 'testnet').scriptType).toBe('p2pkh');
	});

	it('setDefaultNetwork changes the outcome for callers that omit the network argument', () => {
		const tpub = withVersion(XPUB, 0x043587cf);
		expect(getDefaultNetwork()).toBe('mainnet');
		expect(() => parseXpub(tpub)).toThrow(/testnet/i);

		setDefaultNetwork('regtest');
		expect(getDefaultNetwork()).toBe('regtest');
		expect(parseXpub(tpub).scriptType).toBe('p2pkh');

		// A mainnet xpub, meanwhile, now becomes the foreign-network key.
		expect(() => parseXpub(XPUB)).toThrow(/mainnet.*not supported.*regtest/i);

		setDefaultNetwork('mainnet');
		expect(parseXpub(XPUB).scriptType).toBe('p2pkh');
		expect(() => parseXpub(tpub)).toThrow(/testnet/i);
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

// cairn-xqnn7: deriveAddress's ENCODING (bech32 HRP / base58check version byte)
// is network-aware — before this fix it hardcoded mainnet bytes regardless of
// the instance's configured network, so a regtest/testnet instance rendered
// unusable `bc1…` receive addresses. These are minimal regression tests, not
// full vectors — see addressToScriptPubKey's own network-aware block below for
// the matching decode-side coverage.
describe('deriveAddress: network-aware encoding (cairn-xqnn7)', () => {
	it('encodes a p2wpkh address with the right HRP per network, same witness program as mainnet', () => {
		const parsed = parseXpub(ZPUB);
		const mainnet = deriveAddress(parsed, 0, 0);
		const regtest = deriveAddress(parsed, 0, 0, 'regtest');
		const testnet = deriveAddress(parsed, 0, 0, 'testnet');
		expect(regtest.address.startsWith('bcrt1q')).toBe(true);
		expect(testnet.address.startsWith('tb1q')).toBe(true);
		expect(regtest.path).toBe('m/0/0');
		// Same underlying witness program across networks — only the HRP differs.
		const mainnetDec = bech32.decode(mainnet.address as `bc1${string}`);
		const regtestDec = bech32.decode(regtest.address as `${string}1${string}`);
		const testnetDec = bech32.decode(testnet.address as `${string}1${string}`);
		expect(regtestDec.words).toEqual(mainnetDec.words);
		expect(testnetDec.words).toEqual(mainnetDec.words);
	});

	it('does not cross-cache addresses derived for different networks at the same (key, change, index)', () => {
		const parsed = parseXpub(ZPUB);
		const mainnet = deriveAddress(parsed, 0, 5);
		const regtest = deriveAddress(parsed, 0, 5, 'regtest');
		expect(regtest.address).not.toBe(mainnet.address);
		// Repeated calls still agree (the warm cache hit is also network-keyed).
		expect(deriveAddress(parsed, 0, 5, 'regtest').address).toBe(regtest.address);
		expect(deriveAddress(parsed, 0, 5).address).toBe(mainnet.address);
	});

	it('encodes p2pkh (BIP44 xpub) and p2sh-p2wpkh (BIP49 ypub) under regtest/testnet version bytes', () => {
		// regtest reuses testnet's base58 version bytes: 0x6f (p2pkh) / 0xc4 (p2sh).
		const p2pkh = deriveAddress(parseXpub(XPUB), 0, 0, 'regtest');
		const p2shP2wpkh = deriveAddress(parseXpub(YPUB), 0, 0, 'regtest');
		expect(b58check.decode(p2pkh.address)[0]).toBe(0x6f);
		expect(b58check.decode(p2shP2wpkh.address)[0]).toBe(0xc4);
	});
});

// The memoization added for cairn-8ubd must be invisible to correctness: same key +
// index → same address (warm hit), and nothing leaks across keys or script types.
describe('derivation memoization (cairn-8ubd)', () => {
	it('parseXpub returns a cached instance for identical input (hit)', () => {
		expect(parseXpub(ZPUB)).toBe(parseXpub(ZPUB)); // same object reference on repeat
		expect(parseXpub(`  ${ZPUB}\n`)).toBe(parseXpub(ZPUB)); // trimmed to the same key
		expect(parseXpub(YPUB)).not.toBe(parseXpub(ZPUB)); // different keys, different entries
	});

	it('deriveAddress is stable across repeated calls (warm hit equals cold)', () => {
		const parsed = parseXpub(ZPUB);
		const first = deriveAddress(parsed, 0, 3);
		const second = deriveAddress(parsed, 0, 3); // served from the address cache
		expect(second).toEqual(first);
		// A fresh parse of the same key (distinct ParsedXpub) still derives the same address.
		expect(deriveAddress(parseXpub(ZPUB), 0, 3).address).toBe(first.address);
		// Warm hits still match the BIP84 vectors — the cache stores real values.
		expect(deriveAddress(parsed, 0, 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
	});

	it('does not leak across change chains or indices', () => {
		const parsed = parseXpub(ZPUB);
		const r0 = deriveAddress(parsed, 0, 0).address;
		const c0 = deriveAddress(parsed, 1, 0).address;
		const r1 = deriveAddress(parsed, 0, 1).address;
		expect(new Set([r0, c0, r1]).size).toBe(3); // all distinct
		expect(deriveAddress(parsed, 1, 0).address).toBe(c0); // change chain still stable
	});

	it('does not collide two script types over the same underlying key bytes', () => {
		// Same 78-byte key, re-versioned as a ypub (p2sh-p2wpkh) — a DIFFERENT script
		// form than the zpub (p2wpkh). The address cache keys on script type, so these
		// must derive different addresses, never a cross-script-type cache hit.
		const yOfZ = withVersion(ZPUB, 0x049d7cb2); // ypub version bytes
		const asZpub = deriveAddress(parseXpub(ZPUB), 0, 0);
		const asYpub = deriveAddress(parseXpub(yOfZ), 0, 0);
		expect(parseXpub(yOfZ).scriptType).toBe('p2sh-p2wpkh');
		expect(asYpub.address).not.toBe(asZpub.address);
		expect(asYpub.address.startsWith('3')).toBe(true); // p2sh-p2wpkh
		expect(asZpub.address.startsWith('bc1q')).toBe(true); // p2wpkh
	});

	it('does not leak across different wallets at the same index', () => {
		expect(deriveAddress(parseXpub(XPUB), 0, 7).address).not.toBe(
			deriveAddress(parseXpub(ZPUB), 0, 7).address
		);
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

// cairn-xqnn7: addressToScriptPubKey now validates the address against an
// explicit `network` argument (default: mainnet) instead of only ever
// accepting `bc1…`/mainnet base58 — and a RECOGNIZED address for a DIFFERENT
// network throws a plain-language mismatch message rather than a generic
// "invalid"/"unknown version byte" error (this is what lets the send flow and
// wallet import say "this address is for a different network").
describe('addressToScriptPubKey: network-aware validation (cairn-xqnn7)', () => {
	it('accepts a regtest bech32 address under network="regtest" (same script as its mainnet encoding) and rejects it under "mainnet"', () => {
		const parsed = parseXpub(ZPUB);
		const bcrt1 = deriveAddress(parsed, 0, 0, 'regtest').address;
		const bc1 = deriveAddress(parsed, 0, 0).address;
		expect(bytesToHex(addressToScriptPubKey(bcrt1, 'regtest'))).toBe(
			bytesToHex(addressToScriptPubKey(bc1, 'mainnet'))
		);
		expect(() => addressToScriptPubKey(bcrt1, 'mainnet')).toThrow(/doesn't match this wallet's network/i);
		expect(() => addressToScriptPubKey(bcrt1)).toThrow(/doesn't match this wallet's network/i); // default is mainnet
	});

	it('accepts a mainnet bech32 address under "mainnet" and rejects it as a network mismatch under "regtest"/"testnet"', () => {
		const bc1 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
		expect(() => addressToScriptPubKey(bc1, 'regtest')).toThrow(/doesn't match this wallet's network/i);
		expect(() => addressToScriptPubKey(bc1, 'testnet')).toThrow(/doesn't match this wallet's network/i);
	});

	it('base58 p2pkh: a mainnet address is a network mismatch (not a generic "unknown version byte") under regtest', () => {
		const mainnetP2pkh = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
		expect(() => addressToScriptPubKey(mainnetP2pkh, 'regtest')).toThrow(/doesn't match this wallet's network/i);
	});

	it('a testnet/regtest base58 address is accepted under both "testnet" and "regtest" (they share version bytes)', () => {
		const testnetP2pkh = createBase58check(sha256).encode(
			Uint8Array.from([0x6f, ...Array(20).fill(1)])
		);
		expect(() => addressToScriptPubKey(testnetP2pkh, 'testnet')).not.toThrow();
		expect(() => addressToScriptPubKey(testnetP2pkh, 'regtest')).not.toThrow();
		expect(() => addressToScriptPubKey(testnetP2pkh, 'mainnet')).toThrow(/doesn't match this wallet's network/i);
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

	it('accepts a regtest address only when network="regtest" is passed, not under the mainnet default (cairn-xqnn7)', () => {
		const bcrt1 = deriveAddress(parseXpub(ZPUB), 0, 0, 'regtest').address;
		expect(isValidAddress(bcrt1)).toBe(false); // default network is mainnet
		expect(isValidAddress(bcrt1, 'mainnet')).toBe(false);
		expect(isValidAddress(bcrt1, 'regtest')).toBe(true);
		expect(isValidAddress(bcrt1, 'testnet')).toBe(false); // 'bcrt' HRP is regtest-only, distinct from testnet's 'tb'
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
