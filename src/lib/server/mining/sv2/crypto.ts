/**
 * Thin wrapper over the vendored dep crypto used by the Stratum V2 Noise
 * handshake and transport. The rest of sv2/ never imports `@scure`/`@noble`/
 * `node:crypto` directly — everything primitive-shaped lives here so the two
 * (handshake + transport) sides of the protocol cannot disagree on byte math.
 *
 * Primitives, per docs/SV2-WIRE-REFERENCE.md §3:
 *  - EllSwift keygen/encode/decode + BIP324 ECDH: `@scure/btc-signer/p2p.js`
 *    (`elligatorSwift`), verified to compute SV2's exact Noise `ee`/`es` ECDH.
 *  - BIP340 Schnorr sign/verify: `@noble/curves/secp256k1.js` (`schnorr`).
 *  - SHA-256 / HMAC-SHA256 / Noise HKDF (2-output HMAC construction, NOT
 *    RFC 5869 HKDF-expand): `@noble/hashes`.
 *  - ChaCha20-Poly1305 IETF AEAD (16-byte tag, 12-byte nonce): `node:crypto`.
 */
import { elligatorSwift } from '@scure/btc-signer/p2p.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE } from '@noble/curves/utils.js';
import { sha256 as _sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import * as nodeCrypto from 'node:crypto';

const CHACHA_ALG = 'chacha20-poly1305';
const TAG_LEN = 16;

/** SHA-256 of the concatenation of every part (no copy beyond the final digest). */
export function sha256(...parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return _sha256(parts[0]!);
	let total = 0;
	for (const p of parts) total += p.length;
	const buf = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		buf.set(p, off);
		off += p.length;
	}
	return _sha256(buf);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
	return hmac(_sha256, key, data);
}

/**
 * Noise HKDF (2-output form; wire ref §3): temp = HMAC(ck, ikm);
 * out1 = HMAC(temp, 0x01); out2 = HMAC(temp, out1 ‖ 0x02).
 * Returns [ck', temp_k]. NOT the RFC 5869 HKDF-expand construction.
 */
export function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
	const temp = hmacSha256(ck, ikm);
	const out1 = hmacSha256(temp, Uint8Array.of(0x01));
	const out2 = hmacSha256(temp, new Uint8Array([...out1, 0x02]));
	return [out1, out2];
}

/** Ephemeral EllSwift keypair: 32-byte secp secret + 64-byte EllSwift public. */
export function ellswiftKeygen(): { priv: Uint8Array; pub64: Uint8Array } {
	const { privateKey, publicKey } = elligatorSwift.keygen();
	return { priv: privateKey, pub64: publicKey };
}

/**
 * SV2 Noise ECDH = BIP324 v2_ecdh. `initiator` must match this side's role in
 * the handshake (the ECDH is NOT commutative between initiator/responder
 * framing — both sides must agree on who is who for the tagged hash).
 */
export function ecdhSv2(
	ourPriv32: Uint8Array,
	theirPub64: Uint8Array,
	ourPub64: Uint8Array,
	initiator: boolean
): Uint8Array {
	return elligatorSwift.getSharedSecretBip324(ourPriv32, theirPub64, ourPub64, initiator);
}

/** From a persisted 32-byte static secret → x-only (cert field) + a valid 64-byte EllSwift wire encoding. */
export function staticFromSecret(priv32: Uint8Array): { xonly32: Uint8Array; ell64: Uint8Array } {
	const xonly32 = schnorr.getPublicKey(priv32);
	const ell64 = elligatorSwift.encode(bytesToNumberBE(xonly32));
	return { xonly32, ell64 };
}

/** 64-byte BIP340 Schnorr signature. */
export function schnorrSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array {
	return schnorr.sign(msg32, priv32);
}

export function schnorrVerify(sig64: Uint8Array, msg32: Uint8Array, xonly32: Uint8Array): boolean {
	return schnorr.verify(sig64, msg32, xonly32);
}

/** Random 32-byte secp256k1 secret scalar (rejects 0 / >= n internally). */
export function randomSecret32(): Uint8Array {
	return schnorr.utils.randomSecretKey();
}

/**
 * Build the 12-byte IETF ChaCha20-Poly1305 nonce for a Noise CipherState:
 * 4 zero bytes ‖ little-endian u64 counter.
 */
export function chachaNonce(counter: bigint): Uint8Array {
	if (counter < 0n || counter > 0xffffffffffffffffn) {
		throw new Error('chachaNonce: counter out of u64 range');
	}
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setBigUint64(4, counter, true);
	return nonce;
}

/** ChaCha20-Poly1305 IETF seal. nonce12 = 4 zero bytes ‖ LE u64 counter. Returns ct‖tag. */
export function chachaSeal(
	key32: Uint8Array,
	nonce12: Uint8Array,
	ad: Uint8Array,
	pt: Uint8Array
): Uint8Array {
	if (key32.length !== 32) throw new Error('chachaSeal: key must be 32 bytes');
	if (nonce12.length !== 12) throw new Error('chachaSeal: nonce must be 12 bytes');
	const cipher = nodeCrypto.createCipheriv(CHACHA_ALG, key32, nonce12, {
		authTagLength: TAG_LEN
	});
	cipher.setAAD(ad, { plaintextLength: pt.length });
	const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
	const tag = cipher.getAuthTag();
	return new Uint8Array(Buffer.concat([ct, tag]));
}

/** ChaCha20-Poly1305 IETF open. Throws on a bad tag (never returns unauthenticated plaintext). */
export function chachaOpen(
	key32: Uint8Array,
	nonce12: Uint8Array,
	ad: Uint8Array,
	ctTag: Uint8Array
): Uint8Array {
	if (key32.length !== 32) throw new Error('chachaOpen: key must be 32 bytes');
	if (nonce12.length !== 12) throw new Error('chachaOpen: nonce must be 12 bytes');
	if (ctTag.length < TAG_LEN) throw new Error('chachaOpen: ciphertext shorter than tag');
	const ct = ctTag.subarray(0, ctTag.length - TAG_LEN);
	const tag = ctTag.subarray(ctTag.length - TAG_LEN);
	const decipher = nodeCrypto.createDecipheriv(CHACHA_ALG, key32, nonce12, {
		authTagLength: TAG_LEN
	});
	decipher.setAAD(ad, { plaintextLength: ct.length });
	decipher.setAuthTag(tag);
	const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
	return new Uint8Array(pt);
}
