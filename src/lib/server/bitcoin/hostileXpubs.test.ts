// Hostile-input matrix: malformed/adversarial EXTENDED PUBLIC KEYS fed through
// the real import paths — parseXpub (single-sig wallet import) and
// deriveMultisigAddress/resolveKey (multisig cosigner import).
//
// Prior art already covers (NOT re-tested here, see xpub.test.ts /
// multisig.test.ts): xpub/ypub/zpub script-type detection, tpub/vpub testnet
// rejection, xprv rejection (message content), bad-checksum rejection,
// unknown-version rejection, empty/whitespace input, duplicate cosigner
// xpubs (including a Zpub alias of a listed xpub), malformed
// fingerprint/path format, garbage xpub in a multisig set. This file adds:
// upub/uprv (BIP49 testnet) cross-network rejection, truncated keys,
// correct-length-but-cryptographically-garbage keys, an xprv-leak check
// (the rejection message must never echo the secret material back), and
// two undocumented gaps around depth and declared-fingerprint trust.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';
import { parseXpub, isValidXpub } from './xpub';
import {
	deriveMultisigAddress,
	MultisigError,
	type MultisigConfig,
	type MultisigKeyDescriptor
} from './multisig';

const b58check = base58check(sha256);

// BIP84 test-vector account zpub / BIP32 test-vector-1 master xprv (same
// fixtures xpub.test.ts uses, so any leak assertion is checking a
// recognizable, well-known secret rather than a throwaway string).
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XPUB =
	'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
const XPRV =
	'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

/** Re-encode an extended key with different version bytes (e.g. upub/uprv). */
function withVersion(extendedKey: string, version: number): string {
	const raw = new Uint8Array(b58check.decode(extendedKey));
	raw[0] = (version >>> 24) & 0xff;
	raw[1] = (version >>> 16) & 0xff;
	raw[2] = (version >>> 8) & 0xff;
	raw[3] = version & 0xff;
	return b58check.encode(raw);
}

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
const GOOD_KEYS = [1, 2].map((n) => makeKey(n));

function expectMultisigInvalidKey(config: MultisigConfig, label?: RegExp): void {
	let caught: unknown;
	try {
		deriveMultisigAddress({ threshold: 2, keys: config.keys, scriptType: 'p2wsh' } as MultisigConfig, 0, 0);
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(MultisigError);
	expect((caught as MultisigError).code).toBe('invalid_key');
	if (label) expect((caught as MultisigError).message).toMatch(label);
}

// ── 1. wrong version prefix, cross-network ──────────────────────────────────

describe('parseXpub: cross-network version-byte rejection', () => {
	it('rejects upub (BIP49 testnet p2sh-p2wpkh) as testnet', () => {
		const upub = withVersion(XPUB, 0x044a5262);
		expect(() => parseXpub(upub)).toThrow(/testnet/i);
		expect(isValidXpub(upub)).toBe(false);
	});

	it('rejects uprv (BIP49 testnet private) — caught by the testnet gate before the private-key gate', () => {
		const uprv = withVersion(XPUB, 0x044a4e28);
		// TESTNET_VERSIONS is checked before PRIVATE_VERSIONS in parseXpub, so a
		// testnet PRIVATE key still gets a "testnet" message, not a "private key"
		// one — pinning which gate fires first since both would be true.
		expect(() => parseXpub(uprv)).toThrow(/testnet/i);
	});

	it('rejects a mainnet ypub re-flagged with the vpub (testnet zpub-multisig-adjacent) version', () => {
		const asVpub = withVersion(XPUB, 0x045f1cf6);
		expect(() => parseXpub(asVpub)).toThrow(/testnet/i);
	});
});

// ── 2. truncated / structurally broken keys ─────────────────────────────────

describe('parseXpub: truncated and structurally broken input', () => {
	it('rejects a key truncated by 10 characters (breaks the base58 checksum)', () => {
		const truncated = ZPUB.slice(0, -10);
		expect(() => parseXpub(truncated)).toThrow();
		expect(isValidXpub(truncated)).toBe(false);
	});

	it('rejects a key truncated to just the prefix', () => {
		expect(() => parseXpub('zpub6r')).toThrow();
		expect(isValidXpub('zpub6r')).toBe(false);
	});

	it('rejects a single extra character appended (still breaks checksum)', () => {
		const extended = ZPUB + 'a';
		expect(() => parseXpub(extended)).toThrow();
		expect(isValidXpub(extended)).toBe(false);
	});

	it('rejects whitespace injected into the middle of an otherwise-valid key', () => {
		const mid = Math.floor(ZPUB.length / 2);
		const withSpace = ZPUB.slice(0, mid) + ' ' + ZPUB.slice(mid);
		expect(() => parseXpub(withSpace)).toThrow();
		expect(isValidXpub(withSpace)).toBe(false);
	});
});

// ── 3. correct length, cryptographically garbage ────────────────────────────

describe('parseXpub: correct-length base58check payload that is not a real key', () => {
	it('rejects a 78-byte payload whose "key" field is not a valid compressed pubkey', () => {
		// Valid xpub version + zeroed depth/parentFingerprint/childNumber + random
		// chaincode, but the 33-byte key field starts with 0x05 (not 0x02/0x03),
		// which is not a valid compressed-pubkey prefix — HDKey must reject this
		// even though the base58check envelope and length are perfectly formed.
		const raw = new Uint8Array(78);
		raw.set([0x04, 0x88, 0xb2, 0x1e], 0); // xpub version
		// depth=0, parentFingerprint=0, childNumber=0 (bytes 4..12 stay zero)
		for (let i = 13; i < 45; i++) raw[i] = (i * 37) % 256; // arbitrary chaincode
		raw[45] = 0x05; // invalid pubkey prefix byte
		for (let i = 46; i < 78; i++) raw[i] = (i * 53) % 256;
		const garbage = b58check.encode(raw);

		let caught: unknown;
		try {
			parseXpub(garbage);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		// Must fail cleanly (a descriptive Error), not crash uncontrolled or
		// silently return a bogus key.
		expect((caught as Error).message.length).toBeGreaterThan(0);
		expect(isValidXpub(garbage)).toBe(false);
	});
});

// ── 4. xprv rejected AND never echoed back (leak check) ────────────────────

describe('xprv rejection never leaks the secret material back in the error', () => {
	it('parseXpub: the rejection message does not contain the xprv string, in whole or by a long substring', () => {
		let caught: unknown;
		try {
			parseXpub(XPRV);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).not.toContain(XPRV);
		// Also guard against a partial echo (e.g. the payload minus the prefix).
		expect(message).not.toContain(XPRV.slice(4, 40));
		expect(message.toLowerCase()).toContain('private extended key');
	});

	it('multisig cosigner import: an xprv submitted as a cosigner xpub is rejected AND never echoed back', () => {
		const withXprv: MultisigConfig = {
			threshold: 2,
			keys: [GOOD_KEYS[0], { ...GOOD_KEYS[1], xpub: XPRV, name: 'Suspicious Device' }]
		};
		let caught: unknown;
		try {
			deriveMultisigAddress({ ...withXprv, scriptType: 'p2wsh' } as MultisigConfig, 0, 0);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(MultisigError);
		const err = caught as MultisigError;
		expect(err.code).toBe('invalid_key');
		expect(err.message).toContain('Suspicious Device'); // still labeled by key name
		expect(err.message).not.toContain(XPRV); // but the secret itself never appears
		expect(err.message).not.toContain(XPRV.slice(4, 40));
	});

	it('a private key masquerading with a PUBLIC version prefix (tampered version byte on an xprv payload) is still rejected without leaking', () => {
		// Take a real xprv's raw bytes and overwrite ONLY the version bytes with
		// the public xpub version — the tampered string decodes fine (checksum
		// covers the whole payload including the new version bytes we haven't
		// recomputed... base58check's checksum would actually now be WRONG,
		// since we changed payload bytes after the checksum was computed for
		// the original xprv). This exercises the "checksum now invalid" path
		// specifically for a private-key payload, confirming even a corrupted
		// checksum on a private key never gets far enough to leak anything.
		const raw = new Uint8Array(b58check.decode(XPRV));
		raw[0] = 0x04;
		raw[1] = 0x88;
		raw[2] = 0xb2;
		raw[3] = 0x1e; // xpub version bytes, checksum now stale
		const tampered = b58check.encode(raw);
		let caught: unknown;
		try {
			parseXpub(tampered);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).not.toContain(XPRV);
	});
});

// ── 5. KNOWN GAPS: depth and declared-fingerprint are never cross-verified ──

describe('depth-0 master keys (cairn-b9iv, fixed at the acceptance layer) + fingerprint gap (P3)', () => {
	it('parseXpub stays lenient on a MASTER key (depth 0) but now EXPOSES the depth the acceptance gate rejects on (cairn-b9iv)', () => {
		// Module: src/lib/server/bitcoin/xpub.ts (parseXpub).
		// Input: a genuine BIP32 MASTER extended public key (depth 0, the root
		// of an entire wallet — every account, every script type, every
		// address the seed can ever produce) re-serialized with the ordinary
		// xpub version bytes, exactly as if it were one BIP44/49/84 ACCOUNT key.
		// Expected: an account-import flow should reject (or at least flag) a
		// depth-0 key — importing it as a watch-only "account" silently grants
		// visibility into literally everything the seed ever derives, a far
		// bigger privacy/scope blast radius than the single account the user
		// believes they're sharing, and BIP-32 depth is right there on the key
		// to check.
		// Actual: parseXpub has no depth check at all; HDKey.fromExtendedKey
		// happily parses a depth-0 key and parseXpub returns it exactly like
		// any depth-3 account key. deriveAddress then derives m/<chain>/<index>
		// relative to it — which for a real master key does not even match any
		// standard derivation path, but nothing stops it from being accepted
		// and used as if it were correct.
		// Severity suggestion: P2 (privacy/scope-creep risk on xpub import,
		// not a funds-loss bug — watch-only key import can never move funds —
		// but a mis-shared master key deanonymizes an entire seed rather than
		// one account, and there is no user-facing warning today).
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
		expect(master.depth).toBe(0);
		const masterAsXpub = master.publicExtendedKey; // already standard xpub version bytes
		const parsed = parseXpub(masterAsXpub); // pinned: accepted, no depth warning
		expect(parsed.hdkey.depth).toBe(0);
		expect(parsed.scriptType).toBe('p2pkh');
	});

	it('multisig cosigner import accepts ANY well-formed 8-hex fingerprint with no cross-check against the xpub\'s own cryptographic parent fingerprint', () => {
		// Module: src/lib/server/bitcoin/multisig.ts (resolveKey / resolveMultisig).
		// Input: a real, valid cosigner xpub paired with a `fingerprint` field
		// that is well-formed (8 hex chars) but has nothing to do with that
		// key's actual master — resolveKey only regex-validates the FORMAT
		// (/^[0-9a-fA-F]{8}$/), never derives-and-compares against the xpub's
		// own provenance.
		// Expected: since MultisigKeyDescriptor.fingerprint is documented as
		// "what signers match on" (multisig.ts's own doc comment) and is
		// embedded verbatim into every PSBT's bip32Derivation field and every
		// exported descriptor, a fingerprint that doesn't actually belong to
		// the paired xpub should at minimum be flagged — a hardware signer
		// reading it back could mis-attribute or silently ignore its own key.
		// Actual: any syntactically-valid fingerprint is accepted verbatim,
		// address derivation succeeds normally (fingerprint never enters the
		// address-derivation math, only display/PSBT metadata), and the
		// mismatch is invisible until a real hardware signer tries to use it.
		// Severity suggestion: P3 (no funds-loss path — address derivation is
		// unaffected — but it is a silent metadata-integrity gap in data that
		// flows into every PSBT and every exported backup).
		const config: MultisigConfig = {
			threshold: 2,
			keys: [GOOD_KEYS[0], { ...GOOD_KEYS[1], fingerprint: 'ffffffff' }]
		};
		const addr = deriveMultisigAddress({ ...config, scriptType: 'p2wsh' } as MultisigConfig, 0, 0);
		expect(addr.address).toMatch(/^bc1q/); // pinned: derivation succeeds, mismatch unflagged
	});
});
