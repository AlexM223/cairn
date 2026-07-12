// Unit tests for the wizard's client-side key-check compare
// (MULTISIG-KEY-AUDIT-DESIGN §7 Wave 2) — no server round-trip, so this pure
// module is the only thing that can be exercised directly.

import { describe, it, expect } from 'vitest';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { compareWizardKey } from './wizardKeyCheckLogic';

const b58check = createBase58check(sha256);

/** Build a real, valid 78-byte extended-key string under the given version
 *  bytes — same body (depth/parentFp/childNum/chaincode/pubkey) every time,
 *  so two encodings differing only in version bytes are genuinely the same
 *  key material (what normalizeXpub's SLIP-132 canonicalization relies on). */
function encodeExtendedKey(version: number): string {
	const body = new Uint8Array(74); // depth(1) + parentFp(4) + childNum(4) + chaincode(32) + pubkey(33)
	body[0] = 3; // depth
	body.set([0xaa, 0xbb, 0xcc, 0xdd], 1); // parent fingerprint
	body.set([0x80, 0x00, 0x00, 0x02], 5); // child number (hardened 2')
	for (let i = 0; i < 32; i++) body[9 + i] = i; // chaincode filler
	body[41] = 0x02; // compressed-pubkey prefix
	for (let i = 0; i < 32; i++) body[42 + i] = 255 - i; // pubkey filler
	const raw = new Uint8Array(78);
	raw[0] = (version >>> 24) & 0xff;
	raw[1] = (version >>> 16) & 0xff;
	raw[2] = (version >>> 8) & 0xff;
	raw[3] = version & 0xff;
	raw.set(body, 4);
	return b58check.encode(raw);
}

const XPUB_VERSION = 0x0488b21e;
const ZPUB_MULTISIG_VERSION = 0x02aa7ed3; // SLIP-132 Zpub (p2wsh multisig)

const STORED = {
	xpub: encodeExtendedKey(XPUB_VERSION),
	fingerprint: 'A1B2C3D4'
};

describe('compareWizardKey (wizard client-side key-check compare)', () => {
	it('matches when xpub and fingerprint are identical', () => {
		const result = compareWizardKey(STORED, { xpub: STORED.xpub, fingerprint: STORED.fingerprint });
		expect(result).toEqual({ fingerprintMatch: true, xpubMatch: true, verified: true });
	});

	it('fingerprint compare is case-insensitive and whitespace-tolerant', () => {
		const result = compareWizardKey(STORED, {
			xpub: STORED.xpub,
			fingerprint: '  a1b2c3d4  '
		});
		expect(result.fingerprintMatch).toBe(true);
		expect(result.verified).toBe(true);
	});

	it('flags a fingerprint mismatch (wrong seed / passphrase signal)', () => {
		const result = compareWizardKey(STORED, { xpub: STORED.xpub, fingerprint: 'deadbeef' });
		expect(result).toEqual({ fingerprintMatch: false, xpubMatch: true, verified: false });
	});

	it('flags an xpub mismatch even when the fingerprint matches (non-standard-account case)', () => {
		// A different depth (4 instead of 3) — a genuinely different key body,
		// re-encoded under the same xpub version bytes.
		const differentBody = new Uint8Array(78);
		differentBody.set(encodeRaw(XPUB_VERSION, 4));
		const result = compareWizardKey(STORED, {
			xpub: b58check.encode(differentBody),
			fingerprint: STORED.fingerprint
		});
		expect(result.fingerprintMatch).toBe(true);
		expect(result.xpubMatch).toBe(false);
		expect(result.verified).toBe(false);
	});

	it('canonicalizes SLIP-132 aliases before comparing xpubs (Zpub reading vs stored xpub)', () => {
		// Same key body as STORED.xpub, but re-encoded with the SLIP-132 Zpub
		// (multisig) version bytes — a device/tool that labels its export
		// differently should still be recognized as the very same key.
		const zpubReading = encodeExtendedKey(ZPUB_MULTISIG_VERSION);
		const result = compareWizardKey(STORED, { xpub: zpubReading, fingerprint: STORED.fingerprint });
		expect(result).toEqual({ fingerprintMatch: true, xpubMatch: true, verified: true });
	});
});

function encodeRaw(version: number, depth: number): Uint8Array {
	const raw = new Uint8Array(78);
	raw[0] = (version >>> 24) & 0xff;
	raw[1] = (version >>> 16) & 0xff;
	raw[2] = (version >>> 8) & 0xff;
	raw[3] = version & 0xff;
	raw[4] = depth;
	raw.set([0xaa, 0xbb, 0xcc, 0xdd], 5);
	raw.set([0x80, 0x00, 0x00, 0x02], 9);
	for (let i = 0; i < 32; i++) raw[13 + i] = i;
	raw[45] = 0x02;
	for (let i = 0; i < 32; i++) raw[46 + i] = 255 - i;
	return raw;
}
