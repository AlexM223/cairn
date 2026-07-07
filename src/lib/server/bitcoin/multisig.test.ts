import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { p2ms } from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { parseXpub, addressToScriptPubKey } from './xpub';
import {
	deriveMultisigAddress,
	multisigKeyDerivations,
	multisigTestAddress,
	multisigToDescriptor,
	parseDescriptor,
	descriptorChecksum,
	validateCosignerKeyPath,
	validateMultisigKeyPaths,
	cosignerPathPurpose,
	canonicalXpub,
	MultisigError,
	MAX_MULTISIG_KEYS,
	type MultisigConfig,
	type MultisigKeyDescriptor,
	type MultisigScriptType
} from './multisig';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path. Test-only keys, never a real wallet.
const BIP48_PATH = "m/48'/0'/0'/2'";

function makeKey(seedByte: number, name?: string): MultisigKeyDescriptor {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH,
		...(name ? { name } : {})
	};
}

const KEYS = [1, 2, 3, 4, 5].map((n) => makeKey(n));
const MULTISIG_2OF3: MultisigConfig = { threshold: 2, keys: KEYS.slice(0, 3) };
const MULTISIG_3OF5: MultisigConfig = { threshold: 3, keys: KEYS.slice(0, 5) };

/** Re-encode a standard xpub with the SLIP-132 Zpub (p2wsh multisig) prefix. */
function toZpub(xpub: string): string {
	const b58 = base58check(sha256);
	const raw = b58.decode(xpub);
	raw.set([0x02, 0xaa, 0x7e, 0xd3], 0);
	return b58.encode(raw);
}

// ── BIP-380 checksum ─────────────────────────────────────────────────────────

describe('descriptorChecksum', () => {
	it('matches the published Bitcoin Core wpkh test vector (#cjjspncu)', () => {
		// From Bitcoin Core's descriptor docs (deriveaddresses RPC example).
		const body =
			'wpkh([d34db33f/84h/0h/0h]xpub6DJ2dNUysrn5Vt36jH2KLBT2i1auw1tTSSomg8PhqNiUtx8QX2SvC9nrHu81fT41fvDUnhMjEzQgXnQjKEu3oaqMSzhSrHMxyyoEAmUHQbY/0/*)';
		expect(descriptorChecksum(body)).toBe('cjjspncu');
	});

	it('matches the Bitcoin Core raw() and BIP-380 pk() vectors', () => {
		expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
		expect(
			descriptorChecksum('pk(0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)')
		).toBe('gn28ywm7');
	});

	it('rejects characters outside the descriptor charset', () => {
		expect(() => descriptorChecksum('raw(💥)')).toThrow(MultisigError);
	});
});

// ── Address derivation ───────────────────────────────────────────────────────

describe('deriveMultisigAddress', () => {
	it('2-of-3: p2wsh address whose program is sha256(witnessScript)', () => {
		const { address, witnessScript, sortedPubkeys } = deriveMultisigAddress(MULTISIG_2OF3, 0, 0);
		expect(address.startsWith('bc1q')).toBe(true);
		expect(address.length).toBe(62); // 32-byte program → long bech32

		// Cross-check with xpub.ts's independently hand-rolled address decoder:
		// scriptPubKey must be OP_0 PUSH32 sha256(witnessScript).
		const program = sha256(witnessScript!);
		const expectedSpk = new Uint8Array([0x00, 0x20, ...program]);
		expect(bytesToHex(addressToScriptPubKey(address))).toBe(bytesToHex(expectedSpk));

		// Witness script structure: OP_2 <33> <33> <33> OP_3 OP_CHECKMULTISIG.
		expect(witnessScript![0]).toBe(0x52);
		expect(witnessScript![witnessScript!.length - 2]).toBe(0x53);
		expect(witnessScript![witnessScript!.length - 1]).toBe(0xae);
		expect(sortedPubkeys).toHaveLength(3);
		for (const pk of sortedPubkeys) expect(pk.length).toBe(33);
	});

	it('3-of-5: OP_3 … OP_5 OP_CHECKMULTISIG', () => {
		const { witnessScript, sortedPubkeys } = deriveMultisigAddress(MULTISIG_3OF5, 0, 0);
		expect(witnessScript![0]).toBe(0x53);
		expect(witnessScript![witnessScript!.length - 2]).toBe(0x55);
		expect(witnessScript![witnessScript!.length - 1]).toBe(0xae);
		expect(sortedPubkeys).toHaveLength(5);
	});

	it('BIP-67: key input order never changes the address (that is the point)', () => {
		const shuffled: MultisigConfig = {
			threshold: 3,
			keys: [KEYS[4], KEYS[1], KEYS[3], KEYS[0], KEYS[2]]
		};
		for (const index of [0, 1, 7]) {
			const a = deriveMultisigAddress(MULTISIG_3OF5, 0, index);
			const b = deriveMultisigAddress(shuffled, 0, index);
			expect(b.address).toBe(a.address);
			expect(bytesToHex(b.witnessScript!)).toBe(bytesToHex(a.witnessScript!));
		}
	});

	it('BIP-67: pubkeys are lexicographically sorted, and sorting genuinely reorders', () => {
		// Config-order child pubkeys, derived independently via parseXpub.
		const configOrder = (index: number): string[] =>
			MULTISIG_3OF5.keys.map((k) =>
				bytesToHex(parseXpub(k.xpub).hdkey.deriveChild(0).deriveChild(index).publicKey!)
			);

		let reorderSeen = false;
		for (let index = 0; index < 20; index++) {
			const { sortedPubkeys } = deriveMultisigAddress(MULTISIG_3OF5, 0, index);
			const sortedHex = sortedPubkeys.map(bytesToHex);
			// Equal-length lowercase hex: string order === byte order.
			expect([...sortedHex].sort()).toEqual(sortedHex);
			if (configOrder(index).join() !== sortedHex.join()) reorderSeen = true;
		}
		// With 5 keys over 20 indexes, the derivation order matching BIP-67
		// order every time would mean the sort never does anything.
		expect(reorderSeen).toBe(true);
	});

	it('pins the BIP-67 test-vector-1 script encoding (2 keys, sorted)', () => {
		// Keys from BIP-67 vector 1; sorted order puts 02fe… before 02ff….
		// No published p2wsh sortedmulti ADDRESS vector exists to pin (BIP-67's
		// addresses are P2SH) — this pins the script body our addresses hash.
		const k1 = hexToBytes('02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8');
		const k2 = hexToBytes('02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f');
		const script = p2ms(2, [k2, k1]).script;
		expect(bytesToHex(script)).toBe(
			'5221' + bytesToHex(k2) + '21' + bytesToHex(k1) + '52ae'
		);
	});

	it('receive and change chains differ; consecutive indexes differ', () => {
		const r0 = deriveMultisigAddress(MULTISIG_2OF3, 0, 0).address;
		const r1 = deriveMultisigAddress(MULTISIG_2OF3, 0, 1).address;
		const c0 = deriveMultisigAddress(MULTISIG_2OF3, 1, 0).address;
		expect(r0).not.toBe(r1);
		expect(r0).not.toBe(c0);
		expect(r1).not.toBe(c0);
	});

	it('is deterministic across calls', () => {
		const a = deriveMultisigAddress(MULTISIG_3OF5, 0, 42);
		const b = deriveMultisigAddress(MULTISIG_3OF5, 0, 42);
		expect(b.address).toBe(a.address);
		expect(bytesToHex(b.witnessScript!)).toBe(bytesToHex(a.witnessScript!));
		expect(multisigToDescriptor(MULTISIG_3OF5)).toBe(multisigToDescriptor(MULTISIG_3OF5));
	});

	it('rejects an invalid index', () => {
		expect(() => deriveMultisigAddress(MULTISIG_2OF3, 0, -1)).toThrow(MultisigError);
		expect(() => deriveMultisigAddress(MULTISIG_2OF3, 0, 1.5)).toThrow(MultisigError);
		expect(() => deriveMultisigAddress(MULTISIG_2OF3, 0, 0x80000000)).toThrow(MultisigError);
	});

	it('accepts SLIP-132 Zpub cosigner keys, deriving the same address', () => {
		const viaZpub: MultisigConfig = {
			threshold: 2,
			keys: MULTISIG_2OF3.keys.map((k) => ({ ...k, xpub: toZpub(k.xpub) }))
		};
		expect(deriveMultisigAddress(viaZpub, 0, 0).address).toBe(
			deriveMultisigAddress(MULTISIG_2OF3, 0, 0).address
		);
	});
});

// ── Script types (p2wsh / p2sh-p2wsh / p2sh) ─────────────────────────────────

describe('deriveMultisigAddress script types', () => {
	const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
	const withType = (scriptType: MultisigScriptType): MultisigConfig => ({
		...MULTISIG_2OF3,
		scriptType
	});

	it('absent scriptType means p2wsh (identical address)', () => {
		expect(deriveMultisigAddress(withType('p2wsh'), 0, 0).address).toBe(
			deriveMultisigAddress(MULTISIG_2OF3, 0, 0).address
		);
	});

	it('p2wsh: bc1q… address, witnessScript only', () => {
		const a = deriveMultisigAddress(withType('p2wsh'), 0, 0);
		expect(a.address.startsWith('bc1q')).toBe(true);
		expect(a.address.length).toBe(62); // 32-byte program
		expect(a.witnessScript).toBeDefined();
		expect(a.redeemScript).toBeUndefined();
	});

	it('p2sh: base58 3… address; redeemScript IS the p2ms script; no witness data', () => {
		const a = deriveMultisigAddress(withType('p2sh'), 0, 0);
		expect(a.address.startsWith('3')).toBe(true);
		expect(a.address.length).toBe(34);
		expect(a.witnessScript).toBeUndefined();
		expect(a.redeemScript).toBeDefined();
		// redeemScript = OP_2 <33> <33> <33> OP_3 OP_CHECKMULTISIG (BIP-67 sorted).
		expect(bytesToHex(a.redeemScript!)).toBe(bytesToHex(p2ms(2, a.sortedPubkeys).script));
		// scriptPubKey (via the independent decoder in xpub.ts) commits to
		// hash160(redeemScript): a914 <20 bytes> 87.
		expect(bytesToHex(addressToScriptPubKey(a.address))).toBe(
			'a914' + bytesToHex(hash160(a.redeemScript!)) + '87'
		);
	});

	it('p2sh-p2wsh: 3… address; redeemScript = OP_0 <sha256(witnessScript)>; witnessScript = p2ms', () => {
		const a = deriveMultisigAddress(withType('p2sh-p2wsh'), 0, 0);
		expect(a.address.startsWith('3')).toBe(true);
		expect(a.address.length).toBe(34);
		expect(a.witnessScript).toBeDefined();
		expect(a.redeemScript).toBeDefined();
		expect(bytesToHex(a.witnessScript!)).toBe(bytesToHex(p2ms(2, a.sortedPubkeys).script));
		expect(bytesToHex(a.redeemScript!)).toBe('0020' + bytesToHex(sha256(a.witnessScript!)));
		expect(bytesToHex(addressToScriptPubKey(a.address))).toBe(
			'a914' + bytesToHex(hash160(a.redeemScript!)) + '87'
		);
	});

	it('the three script types derive three DISTINCT addresses from one key set', () => {
		const addrs = (['p2wsh', 'p2sh-p2wsh', 'p2sh'] as const).map(
			(t) => deriveMultisigAddress(withType(t), 0, 0).address
		);
		expect(new Set(addrs).size).toBe(3);
	});

	it('BIP-67 sorting is identical across all three script types', () => {
		const wsh = deriveMultisigAddress(withType('p2wsh'), 0, 5);
		const shwsh = deriveMultisigAddress(withType('p2sh-p2wsh'), 0, 5);
		const sh = deriveMultisigAddress(withType('p2sh'), 0, 5);
		const hex = (pks: Uint8Array[]) => pks.map(bytesToHex);
		expect(hex(shwsh.sortedPubkeys)).toEqual(hex(wsh.sortedPubkeys));
		expect(hex(sh.sortedPubkeys)).toEqual(hex(wsh.sortedPubkeys));
		// Same key set + same sort = the very same p2ms script everywhere; only
		// the wrapping differs.
		expect(bytesToHex(shwsh.witnessScript!)).toBe(bytesToHex(wsh.witnessScript!));
		expect(bytesToHex(sh.redeemScript!)).toBe(bytesToHex(wsh.witnessScript!));
	});

	it('rejects an unknown script type (taproot multisig included) by name', () => {
		const bad = { ...MULTISIG_2OF3, scriptType: 'p2tr' as MultisigScriptType };
		expect(() => deriveMultisigAddress(bad, 0, 0)).toThrow(/not supported/);
		expect(() => multisigToDescriptor(bad)).toThrow(/not supported/);
	});
});

// ── Config validation ────────────────────────────────────────────────────────

describe('multisig config validation', () => {
	const expectCode = (fn: () => unknown, code: string, msgPattern?: RegExp) => {
		try {
			fn();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigError);
			expect((e as MultisigError).code).toBe(code);
			if (msgPattern) expect((e as MultisigError).message).toMatch(msgPattern);
			return;
		}
		throw new Error('expected a MultisigError');
	};

	it('rejects threshold 0 and threshold > key count', () => {
		expectCode(() => deriveMultisigAddress({ ...MULTISIG_2OF3, threshold: 0 }, 0, 0), 'invalid_config');
		expectCode(() => deriveMultisigAddress({ ...MULTISIG_2OF3, threshold: 4 }, 0, 0), 'invalid_config');
		expectCode(() => deriveMultisigAddress({ ...MULTISIG_2OF3, threshold: 1.5 }, 0, 0), 'invalid_config');
	});

	it('rejects an empty key set and more than MAX_MULTISIG_KEYS keys', () => {
		expectCode(() => deriveMultisigAddress({ threshold: 1, keys: [] }, 0, 0), 'invalid_config');
		const many = Array.from({ length: MAX_MULTISIG_KEYS + 1 }, (_, i) => makeKey(i + 1));
		expectCode(() => deriveMultisigAddress({ threshold: 2, keys: many }, 0, 0), 'invalid_config');
	});

	it('rejects duplicate xpubs — including a Zpub alias of a listed xpub', () => {
		const dup: MultisigConfig = { threshold: 2, keys: [KEYS[0], KEYS[1], KEYS[0]] };
		expectCode(() => deriveMultisigAddress(dup, 0, 0), 'invalid_config', /distinct/);
		const aliased: MultisigConfig = {
			threshold: 2,
			keys: [KEYS[0], KEYS[1], { ...KEYS[0], xpub: toZpub(KEYS[0].xpub) }]
		};
		expectCode(() => deriveMultisigAddress(aliased, 0, 0), 'invalid_config', /distinct/);
	});

	it('rejects a garbage xpub, naming the key', () => {
		const bad: MultisigConfig = {
			threshold: 2,
			keys: [KEYS[0], KEYS[1], { ...KEYS[2], xpub: 'xpub-not-a-key', name: 'Coldcard' }]
		};
		expectCode(() => deriveMultisigAddress(bad, 0, 0), 'invalid_key', /Coldcard/);
	});

	it('rejects a malformed fingerprint or path', () => {
		expectCode(
			() =>
				deriveMultisigAddress(
					{ threshold: 1, keys: [{ ...KEYS[0], fingerprint: 'xyz' }] },
					0,
					0
				),
			'invalid_key',
			/fingerprint/
		);
		expectCode(
			() =>
				deriveMultisigAddress({ threshold: 1, keys: [{ ...KEYS[0], path: 'm/48q/nope' }] }, 0, 0),
			'invalid_key'
		);
	});
});

// ── Descriptors ──────────────────────────────────────────────────────────────

// Cross-project pin: Bastion (C:\dev\bastion, proven against Sparrow/Electrum/
// Core imports) generates exactly this descriptor for the same 2-of-2 config,
// and its #e2frtjsz checksum is verified against Core's getdescriptorinfo in
// its test suite. Keys are BIP32 spec test-vector masters (fingerprint of TV1
// is 3442193e per the spec).
const TV1_MASTER =
	'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const TV2_MASTER =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
const BASTION_CFG: MultisigConfig = {
	threshold: 2,
	keys: [
		{ xpub: TV1_MASTER, fingerprint: '3442193e', path: BIP48_PATH },
		{ xpub: TV2_MASTER, fingerprint: 'deadbeef', path: BIP48_PATH }
	]
};
const BASTION_RECEIVE = `wsh(sortedmulti(2,[3442193e/48h/0h/0h/2h]${TV1_MASTER}/0/*,[deadbeef/48h/0h/0h/2h]${TV2_MASTER}/0/*))`;
const BASTION_CHANGE = `wsh(sortedmulti(2,[3442193e/48h/0h/0h/2h]${TV1_MASTER}/1/*,[deadbeef/48h/0h/0h/2h]${TV2_MASTER}/1/*))`;

describe('multisigToDescriptor', () => {
	it('emits the exact Bastion/Core-verified format, checksum included', () => {
		expect(multisigToDescriptor(BASTION_CFG)).toBe(`${BASTION_RECEIVE}#e2frtjsz`);
		expect(multisigToDescriptor(BASTION_CFG, { chain: 1 })).toBe(
			`${BASTION_CHANGE}#${descriptorChecksum(BASTION_CHANGE)}`
		);
	});

	it('normalizes an uppercase fingerprint and a Zpub key to canonical form', () => {
		const cfg: MultisigConfig = {
			threshold: 2,
			keys: [
				{ xpub: toZpub(TV1_MASTER), fingerprint: '3442193E', path: BIP48_PATH },
				{ xpub: TV2_MASTER, fingerprint: 'deadbeef', path: BIP48_PATH }
			]
		};
		expect(multisigToDescriptor(cfg)).toBe(`${BASTION_RECEIVE}#e2frtjsz`);
	});
});

// parseDescriptor always reports the script form it recognized.
const BASTION_PARSED: MultisigConfig = { ...BASTION_CFG, scriptType: 'p2wsh' };

describe('parseDescriptor', () => {
	it('round-trips: config → descriptor → identical config', () => {
		const noNames: MultisigConfig = {
			threshold: MULTISIG_2OF3.threshold,
			keys: MULTISIG_2OF3.keys.map(({ xpub, fingerprint, path }) => ({ xpub, fingerprint, path }))
		};
		const desc = multisigToDescriptor(noNames);
		expect(parseDescriptor(desc)).toEqual({ ...noNames, scriptType: 'p2wsh' });
		// And the re-export is byte-identical.
		expect(multisigToDescriptor(parseDescriptor(desc))).toBe(desc);
	});

	it('round-trips every script type, with the matching wrapper and checksum', () => {
		const wrappers: Record<MultisigScriptType, RegExp> = {
			p2wsh: /^wsh\(sortedmulti\(2,/,
			'p2sh-p2wsh': /^sh\(wsh\(sortedmulti\(2,/,
			p2sh: /^sh\(sortedmulti\(2,/
		};
		for (const scriptType of ['p2wsh', 'p2sh-p2wsh', 'p2sh'] as const) {
			const cfg: MultisigConfig = { ...BASTION_CFG, scriptType };
			const desc = multisigToDescriptor(cfg);
			expect(desc).toMatch(wrappers[scriptType]);
			expect(desc).toMatch(/#[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/);
			const parsed = parseDescriptor(desc);
			expect(parsed).toEqual(cfg);
			expect(multisigToDescriptor(parsed)).toBe(desc);
			// The parsed config derives the same first address as the original.
			expect(multisigTestAddress(parsed)).toBe(multisigTestAddress(cfg));
		}
	});

	it('parses a config that derives the same addresses as the original', () => {
		const parsed = parseDescriptor(multisigToDescriptor(MULTISIG_3OF5));
		expect(multisigTestAddress(parsed)).toBe(multisigTestAddress(MULTISIG_3OF5));
	});

	it('accepts a checksum-less descriptor and apostrophe hardened markers', () => {
		expect(parseDescriptor(BASTION_RECEIVE)).toEqual(BASTION_PARSED);
		const apostrophes = `wsh(sortedmulti(2,[3442193e/48'/0'/0'/2']${TV1_MASTER}/0/*,[deadbeef/48'/0'/0'/2']${TV2_MASTER}/0/*))`;
		expect(parseDescriptor(apostrophes)).toEqual(BASTION_PARSED);
	});

	it('accepts /1/* (change) and <0;1> multipath variants as the same multisig', () => {
		expect(parseDescriptor(`${BASTION_CHANGE}#${descriptorChecksum(BASTION_CHANGE)}`)).toEqual(
			BASTION_PARSED
		);
		const multipath = BASTION_RECEIVE.replace(/\/0\/\*/g, '/<0;1>/*');
		expect(parseDescriptor(multipath)).toEqual(BASTION_PARSED);
	});

	it('accepts origin-less keys with a placeholder fingerprint', () => {
		const desc = `wsh(sortedmulti(2,${TV1_MASTER}/0/*,${TV2_MASTER}/0/*))`;
		const cfg = parseDescriptor(desc);
		expect(cfg.keys.map((k) => [k.fingerprint, k.path])).toEqual([
			['00000000', 'm'],
			['00000000', 'm']
		]);
		// Round-trips: origin-less keys are re-emitted bare.
		expect(multisigToDescriptor(cfg)).toBe(`${desc}#${descriptorChecksum(desc)}`);
	});

	it('rejects a wrong checksum, naming the expected one', () => {
		expect(() => parseDescriptor(`${BASTION_RECEIVE}#qqqqqqqq`)).toThrow(/e2frtjsz/);
		expect(() => parseDescriptor(`${BASTION_RECEIVE}#nope`)).toThrow(/checksum/);
	});

	it('rejects multi() with a message steering to sortedmulti', () => {
		const desc = `wsh(multi(2,${TV1_MASTER}/0/*,${TV2_MASTER}/0/*))`;
		expect(() => parseDescriptor(desc)).toThrow(/sortedmulti/);
		try {
			parseDescriptor(desc);
		} catch (e) {
			expect((e as MultisigError).code).toBe('unsupported_descriptor');
		}
	});

	it('rejects tr(…) taproot multisig with a "not supported" message', () => {
		const desc = `tr(${TV1_MASTER}/0/*,sortedmulti_a(2,${TV1_MASTER}/0/*,${TV2_MASTER}/0/*))`;
		expect(() => parseDescriptor(desc)).toThrow(/not supported/);
		try {
			parseDescriptor(desc);
		} catch (e) {
			expect((e as MultisigError).code).toBe('unsupported_descriptor');
		}
	});

	it('rejects non-multisig descriptors and malformed bodies', () => {
		expect(() => parseDescriptor(`wpkh(${TV1_MASTER}/0/*)`)).toThrow(MultisigError);
		expect(() => parseDescriptor('wsh(sortedmulti(2))')).toThrow(/at least one key/);
		expect(() => parseDescriptor(`wsh(sortedmulti(x,${TV1_MASTER}/0/*))`)).toThrow(
			/not a whole number/
		);
	});

	it('rejects threshold/key-count mismatches', () => {
		expect(() =>
			parseDescriptor(`wsh(sortedmulti(3,${TV1_MASTER}/0/*,${TV2_MASTER}/0/*))`)
		).toThrow(/Threshold/);
		expect(() => parseDescriptor(`wsh(sortedmulti(0,${TV1_MASTER}/0/*))`)).toThrow(/Threshold/);
	});

	it('rejects a garbage key and a bad derivation suffix', () => {
		expect(() => parseDescriptor('wsh(sortedmulti(1,notakey/0/*))')).toThrow(MultisigError);
		expect(() => parseDescriptor(`wsh(sortedmulti(1,${TV1_MASTER}/5/*))`)).toThrow(/suffix/);
		expect(() => parseDescriptor(`wsh(sortedmulti(1,[3442193e/48h${TV1_MASTER}/0/*))`)).toThrow(
			/unterminated/
		);
	});
});

// ── Wizard helpers ───────────────────────────────────────────────────────────

describe('multisigTestAddress', () => {
	it('is the first receive address', () => {
		expect(multisigTestAddress(MULTISIG_2OF3)).toBe(deriveMultisigAddress(MULTISIG_2OF3, 0, 0).address);
	});
});

// ── Cosigner path acceptance (cairn-1kc3.1 / .3 / .5) ────────────────────────

describe('validateCosignerKeyPath', () => {
	const rejects = (path: string, scriptType: MultisigScriptType, pattern: RegExp) => {
		try {
			validateCosignerKeyPath(path, scriptType, 'Coldcard');
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigError);
			expect((e as MultisigError).code).toBe('invalid_key');
			expect((e as MultisigError).message).toMatch(/Coldcard/);
			expect((e as MultisigError).message).toMatch(pattern);
			return;
		}
		throw new Error(`expected "${path}" (${scriptType}) to be rejected`);
	};

	it('accepts unknown-origin and Caravan-masked paths (no purpose claim)', () => {
		for (const path of ['m', '', 'm/0/0/0/0', 'm/0']) {
			expect(() => validateCosignerKeyPath(path, 'p2wsh', 'k')).not.toThrow();
		}
	});

	it('accepts BIP-45 paths at any depth regardless of script type (no subfields to check)', () => {
		for (const scriptType of ['p2wsh', 'p2sh-p2wsh', 'p2sh'] as const) {
			expect(() => validateCosignerKeyPath("m/45'", scriptType, 'k')).not.toThrow();
			expect(() => validateCosignerKeyPath("m/45'/0", scriptType, 'k')).not.toThrow();
			expect(() => validateCosignerKeyPath("m/45'/2/0/17", scriptType, 'k')).not.toThrow();
		}
	});

	it('accepts BIP-48 paths whose script-type suffix matches the wallet (2\' = p2wsh, 1\' = both p2sh forms)', () => {
		expect(() => validateCosignerKeyPath("m/48'/0'/0'/2'", 'p2wsh', 'k')).not.toThrow();
		expect(() => validateCosignerKeyPath("m/48'/0'/7'/2'", 'p2wsh', 'k')).not.toThrow();
		expect(() => validateCosignerKeyPath("m/48'/0'/0'/1'", 'p2sh', 'k')).not.toThrow();
		expect(() => validateCosignerKeyPath("m/48'/0'/0'/1'", 'p2sh-p2wsh', 'k')).not.toThrow();
		// h/H hardened markers are equivalent to apostrophes.
		expect(() => validateCosignerKeyPath('m/48h/0h/0h/2h', 'p2wsh', 'k')).not.toThrow();
	});

	it('rejects every single-sig purpose, naming the BIP (cairn-1kc3.3)', () => {
		rejects("m/44'/0'/0'", 'p2wsh', /BIP-44.*single-sig/);
		rejects("m/49'/0'/0'", 'p2wsh', /BIP-49.*single-sig/);
		rejects("m/84'/0'/0'", 'p2wsh', /BIP-84.*single-sig/);
		rejects("m/86'/0'/0'", 'p2wsh', /BIP-86.*single-sig/);
		// A full single-sig RECEIVE path (not even account-level) — the exact
		// shape the audit found being accepted silently.
		rejects("m/84'/0'/0'/0/0", 'p2wsh', /single-sig/);
		// Unhardened single-sig purposes are just as wrong.
		rejects('m/44/0/0', 'p2sh', /single-sig/);
	});

	it('rejects unknown purposes and unhardened 45/48', () => {
		rejects("m/1234'/0'/0'", 'p2wsh', /not a multisig derivation path/);
		rejects('m/48/0/0/2', 'p2wsh', /unhardened/);
		rejects('m/45/0', 'p2wsh', /unhardened/);
	});

	it("rejects a BIP-48 suffix contradicting the wallet's script type (cairn-1kc3.1)", () => {
		// The audit's concrete case: P2WSH wallet, P2SH-suffix path.
		rejects("m/48'/0'/0'/1'", 'p2wsh', /script type 1'.*p2wsh/);
		rejects("m/48'/0'/0'/2'", 'p2sh', /script type 2'.*p2sh/);
		rejects("m/48'/0'/0'/2'", 'p2sh-p2wsh', /script type 2'.*p2sh-p2wsh/);
		// Unknown suffixes (e.g. 3' — no BIP-48 meaning) are rejected too.
		rejects("m/48'/0'/0'/3'", 'p2wsh', /script type 3'/);
	});

	it('rejects a truncated BIP-48 path', () => {
		rejects("m/48'", 'p2wsh', /incomplete/);
		rejects("m/48'/0'/0'", 'p2wsh', /incomplete/);
	});

	it("rejects a non-mainnet coin type on a 48' path (cairn-1kc3.5)", () => {
		rejects("m/48'/1'/0'/2'", 'p2wsh', /coin type 1/);
		rejects("m/48'/1'/0'/2'", 'p2wsh', /mainnet/);
		// BIP-45 has no coin-type field, so nothing to reject there.
		expect(() => validateCosignerKeyPath("m/45'", 'p2wsh', 'k')).not.toThrow();
	});

	it('surfaces parse errors under the key label', () => {
		rejects('m/48q/nope', 'p2wsh', /48q/);
	});
});

describe('validateMultisigKeyPaths', () => {
	it('validates each key against the config script type, labeling by key name', () => {
		const config: MultisigConfig = {
			threshold: 2,
			scriptType: 'p2sh',
			keys: [
				{ ...KEYS[0], path: "m/48'/0'/0'/1'", name: 'Trezor' },
				{ ...KEYS[1], path: "m/48'/0'/0'/2'", name: 'Ledger' },
				{ ...KEYS[2], path: "m/48'/0'/0'/1'", name: 'Backup' }
			]
		};
		expect(() => validateMultisigKeyPaths(config)).toThrow(/Ledger/);
		config.keys[1] = { ...config.keys[1], path: "m/48'/0'/0'/1'" };
		expect(() => validateMultisigKeyPaths(config)).not.toThrow();
	});

	it('defaults an absent scriptType to p2wsh, like every other config consumer', () => {
		const config: MultisigConfig = {
			threshold: 1,
			keys: [{ ...KEYS[0], path: "m/48'/0'/0'/1'" }]
		};
		expect(() => validateMultisigKeyPaths(config)).toThrow(/p2wsh/);
	});
});

describe('cosignerPathPurpose', () => {
	it('reports 45, 48, or null (no purpose claim)', () => {
		expect(cosignerPathPurpose("m/45'")).toBe(45);
		expect(cosignerPathPurpose("m/45'/1/0/2")).toBe(45);
		expect(cosignerPathPurpose("m/48'/0'/0'/2'")).toBe(48);
		expect(cosignerPathPurpose('m')).toBeNull();
		expect(cosignerPathPurpose('')).toBeNull();
		expect(cosignerPathPurpose('m/0/0/0/0')).toBeNull();
		expect(cosignerPathPurpose("m/84'/0'/0'")).toBeNull();
		expect(cosignerPathPurpose('garbage')).toBeNull();
	});
});

describe('canonicalXpub', () => {
	it('passes a standard xpub through and normalizes a SLIP-132 Zpub alias', () => {
		expect(canonicalXpub(KEYS[0].xpub)).toBe(KEYS[0].xpub);
		expect(canonicalXpub(toZpub(KEYS[0].xpub))).toBe(KEYS[0].xpub);
		expect(canonicalXpub(` ${KEYS[0].xpub} `)).toBe(KEYS[0].xpub);
	});

	it('returns null for garbage', () => {
		expect(canonicalXpub('not-a-key')).toBeNull();
		expect(canonicalXpub('')).toBeNull();
	});
});

describe('multisigKeyDerivations', () => {
	it('returns one entry per key, in witness-script (BIP-67) order', () => {
		const { sortedPubkeys } = deriveMultisigAddress(MULTISIG_3OF5, 0, 7);
		const derivations = multisigKeyDerivations(MULTISIG_3OF5, 0, 7);
		expect(derivations).toHaveLength(5);
		expect(derivations.map((d) => bytesToHex(d.pubkey))).toEqual(sortedPubkeys.map(bytesToHex));
	});

	it('carries numeric fingerprints and full origin+chain+index paths', () => {
		const derivations = multisigKeyDerivations(MULTISIG_2OF3, 1, 3);
		const expectedFps = new Set(MULTISIG_2OF3.keys.map((k) => parseInt(k.fingerprint, 16) >>> 0));
		const H = 0x80000000;
		for (const d of derivations) {
			expect(expectedFps.has(d.fingerprint)).toBe(true);
			expect(d.path).toEqual([48 + H, 0 + H, 0 + H, 2 + H, 1, 3]);
		}
	});
});
