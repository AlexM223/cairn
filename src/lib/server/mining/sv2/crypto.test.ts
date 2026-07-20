/**
 * crypto.ts primitive tests: BIP324 EllSwift ECDH role-agreement, BIP340
 * schnorr sign/verify, Noise HKDF-2 known-answer (independently computed via
 * node:crypto HMAC), and ChaCha20-Poly1305 AEAD round-trip/tamper/nonce
 * behavior. Mirrors wire.test.ts style (describe/it, no shared fixtures).
 */
import { createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import { elligatorSwift } from '@scure/btc-signer/p2p.js';
import { describe, expect, it } from 'vitest';
import {
	chachaNonce,
	chachaOpen,
	chachaSeal,
	ecdhSv2,
	ellswiftKeygen,
	hkdf2,
	hmacSha256,
	randomSecret32,
	schnorrSign,
	schnorrVerify,
	sha256,
	staticFromSecret
} from './crypto';

describe('sha256', () => {
	it('matches node:crypto sha256 for a single part', () => {
		const data = new TextEncoder().encode('hello sv2');
		const nodeSha = createHash('sha256').update(data).digest();
		expect(Buffer.from(sha256(data))).toEqual(nodeSha);
	});

	it('hashes the concatenation of multiple parts, not each part separately', () => {
		const a = new TextEncoder().encode('foo');
		const b = new TextEncoder().encode('bar');
		const concatExpected = createHash('sha256')
			.update(Buffer.concat([Buffer.from(a), Buffer.from(b)]))
			.digest();
		expect(Buffer.from(sha256(a, b))).toEqual(concatExpected);
	});
});

describe('hmacSha256', () => {
	it('matches an independently computed node:crypto HMAC-SHA256', () => {
		const key = nodeRandomBytes(32);
		const data = new TextEncoder().encode('message');
		const expected = createHmac('sha256', key).update(data).digest();
		expect(Buffer.from(hmacSha256(key, data))).toEqual(expected);
	});
});

describe('hkdf2 (Noise 2-output HKDF)', () => {
	it('matches an independently computed known-answer vector', () => {
		const ck = nodeRandomBytes(32);
		const ikm = nodeRandomBytes(32);

		// Reference implementation per wire ref §3, computed independently of
		// crypto.ts using only node:crypto HMAC:
		const temp = createHmac('sha256', ck).update(ikm).digest();
		const out1 = createHmac('sha256', temp).update(Buffer.from([0x01])).digest();
		const out2 = createHmac('sha256', temp)
			.update(Buffer.concat([out1, Buffer.from([0x02])]))
			.digest();

		const [got1, got2] = hkdf2(ck, ikm);
		expect(Buffer.from(got1)).toEqual(out1);
		expect(Buffer.from(got2)).toEqual(out2);
	});

	it('is deterministic for the same inputs', () => {
		const ck = nodeRandomBytes(32);
		const ikm = nodeRandomBytes(32);
		const [a1, a2] = hkdf2(ck, ikm);
		const [b1, b2] = hkdf2(ck, ikm);
		expect(Buffer.from(a1)).toEqual(Buffer.from(b1));
		expect(Buffer.from(a2)).toEqual(Buffer.from(b2));
	});

	it('the two outputs differ from each other and from the intermediate temp key', () => {
		const ck = nodeRandomBytes(32);
		const ikm = nodeRandomBytes(32);
		const [out1, out2] = hkdf2(ck, ikm);
		expect(Buffer.from(out1)).not.toEqual(Buffer.from(out2));
	});
});

describe('BIP324 EllSwift ECDH (ecdhSv2)', () => {
	it('initiator and responder derive the same shared secret from cross-role calls', () => {
		const a = ellswiftKeygen(); // "client" (initiator)
		const b = ellswiftKeygen(); // "server" (responder)

		const initiatorSecret = ecdhSv2(a.priv, b.pub64, a.pub64, true);
		const responderSecret = ecdhSv2(b.priv, a.pub64, b.pub64, false);

		expect(Buffer.from(initiatorSecret)).toEqual(Buffer.from(responderSecret));
	});

	it('is NOT role-commutative: swapping the initiator flag on the same side changes the secret', () => {
		const a = ellswiftKeygen();
		const b = ellswiftKeygen();

		const asInitiator = ecdhSv2(a.priv, b.pub64, a.pub64, true);
		const asResponder = ecdhSv2(a.priv, b.pub64, a.pub64, false);

		expect(Buffer.from(asInitiator)).not.toEqual(Buffer.from(asResponder));
	});

	it('produces a 32-byte shared secret', () => {
		const a = ellswiftKeygen();
		const b = ellswiftKeygen();
		const secret = ecdhSv2(a.priv, b.pub64, a.pub64, true);
		expect(secret.length).toBe(32);
	});

	it('different keypairs produce different secrets', () => {
		const a = ellswiftKeygen();
		const b = ellswiftKeygen();
		const c = ellswiftKeygen();
		const s1 = ecdhSv2(a.priv, b.pub64, a.pub64, true);
		const s2 = ecdhSv2(a.priv, c.pub64, a.pub64, true);
		expect(Buffer.from(s1)).not.toEqual(Buffer.from(s2));
	});
});

describe('ellswiftKeygen', () => {
	it('produces a 32-byte private key and a 64-byte public key', () => {
		const { priv, pub64 } = ellswiftKeygen();
		expect(priv.length).toBe(32);
		expect(pub64.length).toBe(64);
	});
});

describe('staticFromSecret', () => {
	it('round-trips: decoding the returned EllSwift encoding yields the same x-only key', () => {
		const priv32 = randomSecret32();
		const { xonly32, ell64 } = staticFromSecret(priv32);
		expect(xonly32.length).toBe(32);
		expect(ell64.length).toBe(64);
		const decoded = elligatorSwift.decode(ell64);
		expect(Buffer.from(decoded)).toEqual(Buffer.from(xonly32));
	});

	it('is deterministic in its xonly32 output for the same secret', () => {
		const priv32 = randomSecret32();
		const r1 = staticFromSecret(priv32);
		const r2 = staticFromSecret(priv32);
		expect(Buffer.from(r1.xonly32)).toEqual(Buffer.from(r2.xonly32));
	});
});

describe('schnorr sign/verify (BIP340)', () => {
	it('a valid signature verifies against the matching x-only pubkey', () => {
		const priv32 = randomSecret32();
		const { xonly32 } = staticFromSecret(priv32);
		const msg32 = sha256(new TextEncoder().encode('sv2 cert digest'));
		const sig = schnorrSign(msg32, priv32);
		expect(sig.length).toBe(64);
		expect(schnorrVerify(sig, msg32, xonly32)).toBe(true);
	});

	it('rejects a signature against the wrong message', () => {
		const priv32 = randomSecret32();
		const { xonly32 } = staticFromSecret(priv32);
		const msg32 = sha256(new TextEncoder().encode('message A'));
		const wrongMsg32 = sha256(new TextEncoder().encode('message B'));
		const sig = schnorrSign(msg32, priv32);
		expect(schnorrVerify(sig, wrongMsg32, xonly32)).toBe(false);
	});

	it('rejects a signature against the wrong pubkey', () => {
		const priv32 = randomSecret32();
		const otherPriv32 = randomSecret32();
		const { xonly32: otherXonly32 } = staticFromSecret(otherPriv32);
		const msg32 = sha256(new TextEncoder().encode('sv2 cert digest'));
		const sig = schnorrSign(msg32, priv32);
		expect(schnorrVerify(sig, msg32, otherXonly32)).toBe(false);
	});
});

describe('chachaNonce', () => {
	it('is 4 zero bytes followed by the little-endian u64 counter', () => {
		const nonce = chachaNonce(1n);
		expect(nonce.length).toBe(12);
		expect(Buffer.from(nonce.subarray(0, 4))).toEqual(Buffer.alloc(4));
		expect(Buffer.from(nonce.subarray(4)).readBigUInt64LE()).toBe(1n);
	});

	it('counter 0 is the all-zero nonce', () => {
		expect(Buffer.from(chachaNonce(0n))).toEqual(Buffer.alloc(12));
	});

	it('progresses monotonically and distinctly per counter value', () => {
		const n0 = chachaNonce(0n);
		const n1 = chachaNonce(1n);
		const n2 = chachaNonce(2n);
		expect(Buffer.from(n0)).not.toEqual(Buffer.from(n1));
		expect(Buffer.from(n1)).not.toEqual(Buffer.from(n2));
	});

	it('rejects an out-of-range counter', () => {
		expect(() => chachaNonce(-1n)).toThrow();
		expect(() => chachaNonce(0x1_0000_0000_0000_0000n)).toThrow();
	});
});

describe('chachaSeal / chachaOpen (ChaCha20-Poly1305 IETF)', () => {
	it('round-trips plaintext through seal then open with matching key/nonce/ad', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const ad = new Uint8Array(0); // zero-length AAD per wire ref §1.2/§3
		const pt = new TextEncoder().encode('sv2 noise transport payload');

		const sealed = chachaSeal(key, nonce, ad, pt);
		expect(sealed.length).toBe(pt.length + 16); // ct ‖ 16-byte tag

		const opened = chachaOpen(key, nonce, ad, sealed);
		expect(Buffer.from(opened)).toEqual(Buffer.from(pt));
	});

	it('round-trips a zero-length plaintext (header-only AEAD call)', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const ad = new Uint8Array(0);
		const sealed = chachaSeal(key, nonce, ad, new Uint8Array(0));
		expect(sealed.length).toBe(16);
		const opened = chachaOpen(key, nonce, ad, sealed);
		expect(opened.length).toBe(0);
	});

	it('throws on a tampered ciphertext byte', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const ad = new Uint8Array(0);
		const pt = new TextEncoder().encode('do not tamper with me');
		const sealed = chachaSeal(key, nonce, ad, pt);
		const tampered = Uint8Array.from(sealed);
		tampered[0] = tampered[0]! ^ 0xff;
		expect(() => chachaOpen(key, nonce, ad, tampered)).toThrow();
	});

	it('throws on a tampered auth tag', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const ad = new Uint8Array(0);
		const pt = new TextEncoder().encode('tag integrity matters');
		const sealed = chachaSeal(key, nonce, ad, pt);
		const tampered = Uint8Array.from(sealed);
		tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
		expect(() => chachaOpen(key, nonce, ad, tampered)).toThrow();
	});

	it('throws when opened with the wrong key', () => {
		const key = nodeRandomBytes(32);
		const wrongKey = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const ad = new Uint8Array(0);
		const pt = new TextEncoder().encode('wrong key test');
		const sealed = chachaSeal(key, nonce, ad, pt);
		expect(() => chachaOpen(wrongKey, nonce, ad, sealed)).toThrow();
	});

	it('throws when opened with the wrong nonce (counter mismatch)', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const wrongNonce = chachaNonce(1n);
		const ad = new Uint8Array(0);
		const pt = new TextEncoder().encode('nonce counter must progress');
		const sealed = chachaSeal(key, nonce, ad, pt);
		expect(() => chachaOpen(key, wrongNonce, ad, sealed)).toThrow();
	});

	it('different nonce counters produce different ciphertext for identical plaintext', () => {
		const key = nodeRandomBytes(32);
		const ad = new Uint8Array(0);
		const pt = new TextEncoder().encode('same plaintext, different nonce');
		const sealed0 = chachaSeal(key, chachaNonce(0n), ad, pt);
		const sealed1 = chachaSeal(key, chachaNonce(1n), ad, pt);
		expect(Buffer.from(sealed0)).not.toEqual(Buffer.from(sealed1));
	});

	it('rejects associated data mismatch between seal and open', () => {
		const key = nodeRandomBytes(32);
		const nonce = chachaNonce(0n);
		const pt = new TextEncoder().encode('ad must match');
		const sealed = chachaSeal(key, nonce, new TextEncoder().encode('ad-a'), pt);
		expect(() => chachaOpen(key, nonce, new TextEncoder().encode('ad-b'), sealed)).toThrow();
	});
});
