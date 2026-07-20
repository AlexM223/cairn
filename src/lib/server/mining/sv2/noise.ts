/**
 * SV2 Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256 handshake (wire ref §3) +
 * the post-handshake transport CipherState.
 *
 * Layering: this module owns all Noise symmetric-state mechanics (h/ck/k/n,
 * MixHash/MixKey/EncryptAndHash/DecryptAndHash) and the two wire-level helpers
 * shared with cert issuance (`certDigest`, `encodeSignatureNoiseMessage`) —
 * the initiator needs the exact same digest/encoding authority.ts uses to
 * sign, so those functions live here (no crypto.ts/codec.ts import needed by
 * authority.ts beyond what it already needs) and authority.ts re-exports them
 * rather than duplicating the byte math. This keeps the dependency
 * one-directional: authority.ts -> noise.ts, never the reverse (authority.ts
 * already needs `SignedCert` from here for its own `issueCert` return type).
 *
 * `CipherState` implements frames.ts's `SealOpen` interface directly (same
 * `seal`/`open` method names) so a post-handshake `CipherState` plugs straight
 * into `sealFrame`/`EncryptedFrameReader` with no adapter — see frames.ts's
 * `SealOpen` doc comment.
 *
 * Deviation from docs/SV2-IMPLEMENTATION-PLAN.md §a.4: that section also lists
 * `sealTransport`/`TransportReader` as noise.ts exports. frames.ts (built in a
 * parallel phase) already owns that exact chunking/reassembly logic
 * (`sealFrame`/`EncryptedFrameReader`) against the crypto-agnostic `SealOpen`
 * interface — adding noise.ts-local wrappers would just be duplicate aliases.
 * Callers (this module's own tests, and the future sv2Server.ts) use
 * `frames.sealFrame(cipherState, ...)` / `new frames.EncryptedFrameReader(cipherState)`
 * directly. Flag for the Phase 4 owner if a noise.ts-local re-export is still
 * wanted for ergonomics.
 *
 * Deviation from the P2 brief's "HandshakeState" naming: the initiator and
 * responder roles send/receive different Act1/Act2 halves of the handshake
 * and have materially different public surfaces (writeAct1/readAct2 vs
 * readAct1/writeAct2), so this module exports two concrete classes —
 * `NoiseResponder` (matches plan §a.4 exactly) and `NoiseInitiator` (new, for
 * the P2 self-talk tests and the later mock test client) — rather than one
 * generic `HandshakeState` type.
 */

import { elligatorSwift } from '@scure/btc-signer/p2p.js';
import {
	chachaNonce,
	chachaOpen,
	chachaSeal,
	ecdhSv2,
	ellswiftKeygen,
	hkdf2,
	schnorrVerify,
	sha256
} from './crypto';
import { Reader, Writer } from './codec';
import type { SealOpen } from './frames';

export class NoiseHandshakeError extends Error {}

const PROTOCOL_NAME = 'Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256';

const EPUB_LEN = 64; // EllSwift ephemeral/static public key wire encoding
const MAC_LEN = 16;
const STATIC_CT_LEN = EPUB_LEN + MAC_LEN; // 80: EncryptAndHash(s.pub)
const SIG_MSG_LEN = 74; // version U16 | valid_from U32 | not_valid_after U32 | signature(64)
const SIG_CT_LEN = SIG_MSG_LEN + MAC_LEN; // 90: EncryptAndHash(SIGNATURE_NOISE_MESSAGE)

/** Act-1 wire size: the client's plaintext ephemeral EllSwift public key. */
export const ACT1_LEN = EPUB_LEN;
/** Act-2 wire size: 64 (plaintext e.pub) + 80 (enc static) + 90 (enc signature).
 *  wire ref §3 flags the spec prose's "170 bytes" as an erratum; this itemized
 *  sum (234) is what both writeAct2()/readAct2() enforce. */
export const ACT2_LEN = EPUB_LEN + STATIC_CT_LEN + SIG_CT_LEN;

// ---------------------------------------------------------------------------
// Transport CipherState
// ---------------------------------------------------------------------------

/**
 * One direction of the post-handshake AEAD transport (also reused internally
 * for the handshake's own symmetric-state key, wire ref §3's `k`/`n`).
 * 32-byte key, little-endian u64 counter nonce (`4 zero bytes ‖ LE u64`, via
 * crypto.ts's `chachaNonce`). A failed `open()` throws *before* the counter
 * is advanced — the increment is the statement after the (possibly throwing)
 * crypto call, so a bad tag never desyncs the nonce sequence; callers must
 * still terminate the session on any thrown decrypt (wire ref §1.2).
 */
export class CipherState implements SealOpen {
	private counter = 0n;

	constructor(private readonly key32: Uint8Array) {
		if (key32.length !== 32) {
			throw new NoiseHandshakeError(`CipherState key must be 32 bytes, got ${key32.length}`);
		}
	}

	/** Encrypt-with-associated-data: ChaCha20-Poly1305, post-increment counter. */
	seal(ad: Uint8Array, pt: Uint8Array): Uint8Array {
		const nonce = chachaNonce(this.counter);
		const ct = chachaSeal(this.key32, nonce, ad, pt);
		this.counter += 1n;
		return ct;
	}

	/** Decrypt-with-associated-data. Throws on a bad tag; counter NOT advanced
	 *  on failure (the throw happens before the increment below ever runs). */
	open(ad: Uint8Array, ct: Uint8Array): Uint8Array {
		const nonce = chachaNonce(this.counter);
		const pt = chachaOpen(this.key32, nonce, ad, ct);
		this.counter += 1n;
		return pt;
	}

	/** Current nonce counter (test/debug visibility only). */
	get nonceCounter(): bigint {
		return this.counter;
	}
}

export function newCipherState(key32: Uint8Array): CipherState {
	return new CipherState(key32);
}

// ---------------------------------------------------------------------------
// Certificate wire helpers (shared with authority.ts — see module doc)
// ---------------------------------------------------------------------------

export interface SignedCert {
	version: number;
	validFrom: number;
	notValidAfter: number;
	/** 64-byte BIP340 Schnorr signature. */
	signature: Uint8Array;
}

/**
 * The 32-byte digest the authority signs: SHA256(version ‖ valid_from ‖
 * not_valid_after ‖ server_static_xonly32), each integer field wire-serialized
 * LE via codec.ts's Writer (wire ref §3's "Certificate the client
 * reconstructs and verifies").
 */
export function certDigest(
	version: number,
	validFrom: number,
	notValidAfter: number,
	staticXonly32: Uint8Array
): Uint8Array {
	if (staticXonly32.length !== 32) {
		throw new NoiseHandshakeError(`certDigest: staticXonly32 must be 32 bytes, got ${staticXonly32.length}`);
	}
	const msg = new Writer().u16(version).u32(validFrom).u32(notValidAfter).bytesRaw(staticXonly32).finish();
	return sha256(msg);
}

/** Serialize SIGNATURE_NOISE_MESSAGE (74B): version U16 | valid_from U32 | not_valid_after U32 | signature(64). */
export function encodeSignatureNoiseMessage(cert: SignedCert): Uint8Array {
	if (cert.signature.length !== 64) {
		throw new NoiseHandshakeError(`SIGNATURE_NOISE_MESSAGE signature must be 64 bytes, got ${cert.signature.length}`);
	}
	return new Writer()
		.u16(cert.version)
		.u32(cert.validFrom)
		.u32(cert.notValidAfter)
		.bytesRaw(cert.signature)
		.finish();
}

/** Inverse of {@link encodeSignatureNoiseMessage}. */
export function decodeSignatureNoiseMessage(bytes: Uint8Array): SignedCert {
	if (bytes.length !== SIG_MSG_LEN) {
		throw new NoiseHandshakeError(`SIGNATURE_NOISE_MESSAGE must be ${SIG_MSG_LEN} bytes, got ${bytes.length}`);
	}
	const r = new Reader(bytes);
	const version = r.u16();
	const validFrom = r.u32();
	const notValidAfter = r.u32();
	const signature = r.bytesRaw(64);
	return { version, validFrom, notValidAfter, signature };
}

// ---------------------------------------------------------------------------
// Noise symmetric state (wire ref §3's h/ck/k/n + Mix*/Encrypt*/Decrypt* ops)
// ---------------------------------------------------------------------------

class SymmetricState {
	h: Uint8Array;
	ck: Uint8Array;
	private cipher: CipherState | null = null;

	constructor() {
		// Act 0: protocolName = "Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256";
		// h=SHA256(protocolName); ck=h; h=SHA256(h); k=empty.
		const h0 = sha256(new TextEncoder().encode(PROTOCOL_NAME));
		this.ck = h0;
		this.h = sha256(h0);
	}

	mixHash(d: Uint8Array): void {
		this.h = sha256(this.h, d);
	}

	/** MixKey(ikm): (ck, temp_k)=HKDF(ck, ikm); InitializeKey(temp_k) (k=temp_k, n=0). */
	mixKey(ikm: Uint8Array): void {
		const [ck2, tempK] = hkdf2(this.ck, ikm);
		this.ck = ck2;
		this.cipher = new CipherState(tempK); // fresh CipherState == InitializeKey's n=0
	}

	/** EncryptAndHash(pt): if k set → ct=EncryptWithAd(h, pt) else ct=pt; MixHash(ct); return ct. */
	encryptAndHash(pt: Uint8Array): Uint8Array {
		const ct = this.cipher ? this.cipher.seal(this.h, pt) : pt;
		this.mixHash(ct);
		return ct;
	}

	/** DecryptAndHash(ct): if k set → pt=DecryptWithAd(h, ct) else pt=ct; MixHash(ct); return pt.
	 *  Throws (from the underlying AEAD) on a bad tag — never returns unauthenticated plaintext. */
	decryptAndHash(ct: Uint8Array): Uint8Array {
		const pt = this.cipher ? this.cipher.open(this.h, ct) : ct;
		this.mixHash(ct);
		return pt;
	}

	/** (temp_k1,temp_k2)=HKDF(ck, zerolen); returns the two transport CipherStates. */
	split(): { c1: CipherState; c2: CipherState } {
		const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
		return { c1: new CipherState(k1), c2: new CipherState(k2) };
	}
}

// ---------------------------------------------------------------------------
// Responder (server side of the NX handshake)
// ---------------------------------------------------------------------------

export interface NoiseResponderParams {
	staticPriv32: Uint8Array;
	/** 64-byte EllSwift wire encoding of the same static key (crypto.ts staticFromSecret). */
	staticEll64: Uint8Array;
	cert: SignedCert;
}

/** Server side of the NX handshake (responder). Single-use per connection. */
export class NoiseResponder {
	private readonly sym = new SymmetricState();
	private readonly staticPriv32: Uint8Array;
	private readonly staticEll64: Uint8Array;
	private readonly cert: SignedCert;
	private remoteEphemeralPub64: Uint8Array | null = null;
	private done = false;

	constructor(params: NoiseResponderParams) {
		this.staticPriv32 = params.staticPriv32;
		this.staticEll64 = params.staticEll64;
		this.cert = params.cert;
	}

	/** Consume the 64-byte Act-1 (client ephemeral EllSwift). */
	readAct1(act1: Uint8Array): void {
		if (act1.length !== ACT1_LEN) {
			throw new NoiseHandshakeError(`Act1 must be ${ACT1_LEN} bytes, got ${act1.length}`);
		}
		this.remoteEphemeralPub64 = act1;
		this.sym.mixHash(act1);
	}

	/** Produce the 234-byte Act-2 (wire ref §3; 64 ephemeral + 80 enc static + 90 enc signature). */
	writeAct2(): Uint8Array {
		if (!this.remoteEphemeralPub64) {
			throw new NoiseHandshakeError('writeAct2() called before readAct1()');
		}
		const e = ellswiftKeygen();
		this.sym.mixHash(e.pub64);

		// MixKey(ee): server ephemeral priv/pub against the client's ephemeral pub.
		const ee = ecdhSv2(e.priv, this.remoteEphemeralPub64, e.pub64, false);
		this.sym.mixKey(ee);

		const encStatic = this.sym.encryptAndHash(this.staticEll64); // -> 80B

		// MixKey(es): server static priv/pub against the client's ephemeral pub.
		const es = ecdhSv2(this.staticPriv32, this.remoteEphemeralPub64, this.staticEll64, false);
		this.sym.mixKey(es);

		const sigMsg = encodeSignatureNoiseMessage(this.cert); // 74B
		const encSig = this.sym.encryptAndHash(sigMsg); // -> 90B

		const act2 = Buffer.concat([Buffer.from(e.pub64), Buffer.from(encStatic), Buffer.from(encSig)]);
		if (act2.length !== ACT2_LEN) {
			// Defensive — cannot happen given the fixed-size pieces above, but this
			// is exactly the invariant wire ref §3 flags as spec-vs-erratum risk.
			throw new NoiseHandshakeError(`internal error: Act2 length ${act2.length} !== ${ACT2_LEN}`);
		}
		this.done = true;
		return new Uint8Array(act2);
	}

	/** After Act-2 written: derive the transport ciphers. */
	split(): { recv: CipherState; send: CipherState } {
		if (!this.done) throw new NoiseHandshakeError('split() called before writeAct2()');
		const { c1, c2 } = this.sym.split();
		// c1 = client→server (server RECEIVES with it); c2 = server→client (server SENDS with it).
		return { recv: c1, send: c2 };
	}

	/** Transcript hash at the current point (test/debug: compare both sides post-handshake). */
	get handshakeHash(): Uint8Array {
		return this.sym.h;
	}
}

// ---------------------------------------------------------------------------
// Initiator (client side of the NX handshake — self-talk tests + future mock client)
// ---------------------------------------------------------------------------

export interface NoiseInitiatorParams {
	/** The pinned authority x-only pubkey the received cert must verify against. */
	authorityXonly32: Uint8Array;
	/** Injectable clock (seconds since epoch) for cert validity-window tests. Defaults to Date.now(). */
	now?: () => number;
}

/** Client side of the NX handshake (initiator). Verifies the server's cert
 *  against the pinned authority key + validity window before trusting the
 *  derived transport ciphers. */
export class NoiseInitiator {
	private readonly sym = new SymmetricState();
	private readonly authorityXonly32: Uint8Array;
	private readonly now: () => number;
	private ephemeral: { priv: Uint8Array; pub64: Uint8Array } | null = null;
	private done = false;
	private verifiedCert: SignedCert | null = null;
	private remoteStaticXonly32Value: Uint8Array | null = null;

	constructor(params: NoiseInitiatorParams) {
		this.authorityXonly32 = params.authorityXonly32;
		this.now = params.now ?? (() => Math.floor(Date.now() / 1000));
	}

	/** Produce the 64-byte Act-1 (client ephemeral EllSwift, plaintext). */
	writeAct1(): Uint8Array {
		const e = ellswiftKeygen();
		this.ephemeral = e;
		this.sym.mixHash(e.pub64);
		return e.pub64;
	}

	/**
	 * Consume the 234-byte Act-2: derives ee/es, decrypts the server static key
	 * + cert, and verifies the cert (BIP340 signature against the pinned
	 * authority key, then the validity window against `now`). Throws
	 * NoiseHandshakeError on any tamper, wrong-authority-key, or expired/
	 * not-yet-valid cert — the caller must terminate the connection.
	 */
	readAct2(act2: Uint8Array): void {
		if (!this.ephemeral) throw new NoiseHandshakeError('readAct2() called before writeAct1()');
		if (act2.length !== ACT2_LEN) {
			throw new NoiseHandshakeError(`Act2 must be ${ACT2_LEN} bytes, got ${act2.length}`);
		}

		const rEphemeralPub64 = act2.subarray(0, EPUB_LEN);
		const encStatic = act2.subarray(EPUB_LEN, EPUB_LEN + STATIC_CT_LEN);
		const encSig = act2.subarray(EPUB_LEN + STATIC_CT_LEN, EPUB_LEN + STATIC_CT_LEN + SIG_CT_LEN);

		this.sym.mixHash(rEphemeralPub64);
		const ee = ecdhSv2(this.ephemeral.priv, rEphemeralPub64, this.ephemeral.pub64, true);
		this.sym.mixKey(ee);

		// Throws (bad tag) on any tamper in the static-key ciphertext.
		const staticEll64 = this.sym.decryptAndHash(encStatic);
		const serverStaticXonly32 = elligatorSwift.decode(staticEll64) as Uint8Array;

		const es = ecdhSv2(this.ephemeral.priv, staticEll64, this.ephemeral.pub64, true);
		this.sym.mixKey(es);

		// Throws (bad tag) on any tamper in the signature ciphertext.
		const sigMsg = this.sym.decryptAndHash(encSig);
		const cert = decodeSignatureNoiseMessage(sigMsg);

		const digest = certDigest(cert.version, cert.validFrom, cert.notValidAfter, serverStaticXonly32);
		if (!schnorrVerify(cert.signature, digest, this.authorityXonly32)) {
			throw new NoiseHandshakeError('SV2 certificate signature does not verify against the pinned authority key');
		}
		const t = this.now();
		if (t < cert.validFrom || t > cert.notValidAfter) {
			throw new NoiseHandshakeError(
				`SV2 certificate not valid at t=${t} (validFrom=${cert.validFrom}, notValidAfter=${cert.notValidAfter})`
			);
		}

		this.remoteStaticXonly32Value = serverStaticXonly32;
		this.verifiedCert = cert;
		this.done = true;
	}

	/** After Act-2 verified: derive the transport ciphers. */
	split(): { recv: CipherState; send: CipherState } {
		if (!this.done) throw new NoiseHandshakeError('split() called before readAct2()');
		const { c1, c2 } = this.sym.split();
		// c1 = client→server (client SENDS with it); c2 = server→client (client RECEIVES with it).
		return { recv: c2, send: c1 };
	}

	/** The verified cert from Act-2 (throws if readAct2() has not succeeded). */
	get cert(): SignedCert {
		if (!this.verifiedCert) throw new NoiseHandshakeError('cert accessed before a verified readAct2()');
		return this.verifiedCert;
	}

	/** The server's static x-only pubkey, decoded from Act-2 (throws if not yet verified). */
	get remoteStaticXonly32(): Uint8Array {
		if (!this.remoteStaticXonly32Value) throw new NoiseHandshakeError('remoteStaticXonly32 accessed before a verified readAct2()');
		return this.remoteStaticXonly32Value;
	}

	/** Transcript hash at the current point (test/debug: compare both sides post-handshake). */
	get handshakeHash(): Uint8Array {
		return this.sym.h;
	}
}
