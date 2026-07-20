/**
 * noise.ts tests: full NX self-talk handshake (initiator vs responder over
 * in-memory buffers), transcript-hash equality, c1/c2 direction correctness,
 * tamper/expiry/wrong-authority rejection, and post-handshake frame exchange
 * through frames.ts's sealFrame/EncryptedFrameReader using real CipherStates.
 * Mirrors crypto.test.ts style (describe/it, no shared fixtures beyond a
 * small local handshake-pair builder).
 */
import { describe, expect, it } from 'vitest';
import { randomSecret32, schnorrSign, staticFromSecret } from './crypto';
import {
	ACT1_LEN,
	ACT2_LEN,
	CipherState,
	certDigest,
	decodeSignatureNoiseMessage,
	encodeSignatureNoiseMessage,
	NoiseHandshakeError,
	NoiseInitiator,
	NoiseResponder,
	newCipherState,
	type SignedCert
} from './noise';
import { EncryptedFrameReader, sealFrame } from './frames';

const NOW = 1_800_000_000; // fixed reference time (seconds)

function makeAuthority() {
	const secret32 = randomSecret32();
	const { xonly32 } = staticFromSecret(secret32);
	return { secret32, xonly32 };
}

function issueTestCert(
	staticXonly32: Uint8Array,
	authoritySecret32: Uint8Array,
	opts: { validFrom?: number; notValidAfter?: number; version?: number } = {}
): SignedCert {
	const version = opts.version ?? 0;
	const validFrom = opts.validFrom ?? NOW - 300;
	const notValidAfter = opts.notValidAfter ?? NOW + 24 * 3600;
	const digest = certDigest(version, validFrom, notValidAfter, staticXonly32);
	const signature = schnorrSign(digest, authoritySecret32);
	return { version, validFrom, notValidAfter, signature };
}

/** Builds a fresh server identity (static keypair + cert signed by `authority`). */
function makeServerIdentity(authoritySecret32: Uint8Array, certOpts?: Parameters<typeof issueTestCert>[2]) {
	const staticSecret32 = randomSecret32();
	const { xonly32: staticXonly32, ell64: staticEll64 } = staticFromSecret(staticSecret32);
	const cert = issueTestCert(staticXonly32, authoritySecret32, certOpts);
	return { staticSecret32, staticXonly32, staticEll64, cert };
}

/** Runs a full Act1/Act2 exchange and returns both completed sides. */
function runHandshake(authorityXonly32: Uint8Array, responder: NoiseResponder, now?: () => number) {
	const initiator = new NoiseInitiator({ authorityXonly32, now });
	const act1 = initiator.writeAct1();
	responder.readAct1(act1);
	const act2 = responder.writeAct2();
	initiator.readAct2(act2);
	return { initiator, responder, act1, act2 };
}

describe('NX handshake self-talk', () => {
	it('completes a full handshake and both sides derive matching transcript hashes', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});

		const { initiator } = runHandshake(authority.xonly32, responder, () => NOW);

		expect(Buffer.from(initiator.handshakeHash)).toEqual(Buffer.from(responder.handshakeHash));
	});

	it('Act-1 is exactly 64 bytes and Act-2 is exactly 234 bytes (itemized sum, wire ref §3 erratum note)', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const { act1, act2 } = runHandshake(authority.xonly32, responder, () => NOW);
		expect(act1.length).toBe(ACT1_LEN);
		expect(act1.length).toBe(64);
		expect(act2.length).toBe(ACT2_LEN);
		expect(act2.length).toBe(234);
	});

	it('the initiator recovers the correct server static xonly pubkey and cert', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const { initiator } = runHandshake(authority.xonly32, responder, () => NOW);
		expect(Buffer.from(initiator.remoteStaticXonly32)).toEqual(Buffer.from(server.staticXonly32));
		expect(initiator.cert.version).toBe(server.cert.version);
		expect(initiator.cert.validFrom).toBe(server.cert.validFrom);
		expect(initiator.cert.notValidAfter).toBe(server.cert.notValidAfter);
	});

	it('split() produces distinct recv/send CipherStates on each side, and c1/c2 direction agrees', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const { initiator } = runHandshake(authority.xonly32, responder, () => NOW);

		const clientSide = initiator.split();
		const serverSide = responder.split();

		// Client sends with c1 (client->server); server must RECEIVE with the same key.
		const fromClient = clientSide.send.seal(new Uint8Array(0), new TextEncoder().encode('hello server'));
		const opened = serverSide.recv.open(new Uint8Array(0), fromClient);
		expect(Buffer.from(opened)).toEqual(Buffer.from('hello server'));

		// Server sends with c2 (server->client); client must RECEIVE with the same key.
		const fromServer = serverSide.send.seal(new Uint8Array(0), new TextEncoder().encode('hello client'));
		const openedBack = clientSide.recv.open(new Uint8Array(0), fromServer);
		expect(Buffer.from(openedBack)).toEqual(Buffer.from('hello client'));
	});

	it('split() cross-wired (client send opened by client recv) fails — the two directions use different keys', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const { initiator } = runHandshake(authority.xonly32, responder, () => NOW);
		const clientSide = initiator.split();
		const ct = clientSide.send.seal(new Uint8Array(0), new TextEncoder().encode('x'));
		expect(() => clientSide.recv.open(new Uint8Array(0), ct)).toThrow();
	});
});

describe('NX handshake rejection paths', () => {
	it('a tampered Act-2 byte (static-key ciphertext) causes the initiator to throw', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const initiator = new NoiseInitiator({ authorityXonly32: authority.xonly32, now: () => NOW });
		const act1 = initiator.writeAct1();
		responder.readAct1(act1);
		const act2 = responder.writeAct2();

		const tampered = Uint8Array.from(act2);
		tampered[70] = tampered[70]! ^ 0xff; // inside the encrypted-static region (bytes 64..144)
		expect(() => initiator.readAct2(tampered)).toThrow();
	});

	it('a tampered Act-2 byte (signature ciphertext) causes the initiator to throw', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const initiator = new NoiseInitiator({ authorityXonly32: authority.xonly32, now: () => NOW });
		const act1 = initiator.writeAct1();
		responder.readAct1(act1);
		const act2 = responder.writeAct2();

		const tampered = Uint8Array.from(act2);
		tampered[200] = tampered[200]! ^ 0xff; // inside the encrypted-signature region (bytes 144..234)
		expect(() => initiator.readAct2(tampered)).toThrow();
	});

	it('an expired cert (notValidAfter in the past) is rejected', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32, {
			validFrom: NOW - 10_000,
			notValidAfter: NOW - 5_000
		});
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		expect(() => runHandshake(authority.xonly32, responder, () => NOW)).toThrow(NoiseHandshakeError);
	});

	it('a not-yet-valid cert (validFrom in the future) is rejected', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32, {
			validFrom: NOW + 1000,
			notValidAfter: NOW + 10_000
		});
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		expect(() => runHandshake(authority.xonly32, responder, () => NOW)).toThrow(NoiseHandshakeError);
	});

	it('a cert signed by the wrong authority key is rejected', () => {
		const realAuthority = makeAuthority();
		const impostorAuthority = makeAuthority();
		// Server signs with the impostor key, but the client pins the real authority's pubkey.
		const server = makeServerIdentity(impostorAuthority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		expect(() => runHandshake(realAuthority.xonly32, responder, () => NOW)).toThrow(NoiseHandshakeError);
	});

	it('readAct1/writeAct2/readAct2/split() enforce call ordering', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		expect(() => responder.writeAct2()).toThrow(NoiseHandshakeError);
		expect(() => responder.split()).toThrow(NoiseHandshakeError);

		const initiator = new NoiseInitiator({ authorityXonly32: authority.xonly32, now: () => NOW });
		expect(() => initiator.readAct2(new Uint8Array(ACT2_LEN))).toThrow(NoiseHandshakeError);
		expect(() => initiator.split()).toThrow(NoiseHandshakeError);
	});

	it('rejects wrong-sized Act1/Act2 buffers', () => {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		expect(() => responder.readAct1(new Uint8Array(63))).toThrow(NoiseHandshakeError);

		const initiator = new NoiseInitiator({ authorityXonly32: authority.xonly32, now: () => NOW });
		initiator.writeAct1();
		expect(() => initiator.readAct2(new Uint8Array(233))).toThrow(NoiseHandshakeError);
	});
});

describe('SIGNATURE_NOISE_MESSAGE encode/decode', () => {
	it('round-trips fields losslessly', () => {
		const cert: SignedCert = {
			version: 7,
			validFrom: 1_000_000,
			notValidAfter: 2_000_000,
			signature: new Uint8Array(64).fill(0xab)
		};
		const encoded = encodeSignatureNoiseMessage(cert);
		expect(encoded.length).toBe(74);
		const decoded = decodeSignatureNoiseMessage(encoded);
		expect(decoded.version).toBe(cert.version);
		expect(decoded.validFrom).toBe(cert.validFrom);
		expect(decoded.notValidAfter).toBe(cert.notValidAfter);
		expect(Buffer.from(decoded.signature)).toEqual(Buffer.from(cert.signature));
	});

	it('rejects a wrong-length buffer', () => {
		expect(() => decodeSignatureNoiseMessage(new Uint8Array(73))).toThrow();
	});
});

describe('certDigest', () => {
	it('is deterministic and sensitive to every field', () => {
		const xonly = randomSecret32().slice(0, 32);
		const d0 = certDigest(0, 100, 200, xonly);
		const d1 = certDigest(0, 100, 200, xonly);
		expect(Buffer.from(d0)).toEqual(Buffer.from(d1));

		const dVersion = certDigest(1, 100, 200, xonly);
		const dFrom = certDigest(0, 101, 200, xonly);
		const dUntil = certDigest(0, 100, 201, xonly);
		expect(Buffer.from(dVersion)).not.toEqual(Buffer.from(d0));
		expect(Buffer.from(dFrom)).not.toEqual(Buffer.from(d0));
		expect(Buffer.from(dUntil)).not.toEqual(Buffer.from(d0));
	});

	it('rejects a non-32-byte xonly key', () => {
		expect(() => certDigest(0, 100, 200, new Uint8Array(31))).toThrow();
	});
});

describe('CipherState', () => {
	it('round-trips seal/open and advances the nonce counter only on success', () => {
		const cs1 = newCipherState(new Uint8Array(32).fill(1));
		const cs2 = new CipherState(new Uint8Array(32).fill(1));
		expect(cs1.nonceCounter).toBe(0n);

		const ct = cs1.seal(new Uint8Array(0), new TextEncoder().encode('payload'));
		expect(cs1.nonceCounter).toBe(1n);

		const pt = cs2.open(new Uint8Array(0), ct);
		expect(Buffer.from(pt)).toEqual(Buffer.from('payload'));
		expect(cs2.nonceCounter).toBe(1n);
	});

	it('a failed open() does NOT advance the nonce counter', () => {
		const sender = new CipherState(new Uint8Array(32).fill(2));
		const receiver = new CipherState(new Uint8Array(32).fill(2));
		const ct = sender.seal(new Uint8Array(0), new TextEncoder().encode('a'));
		const tampered = Uint8Array.from(ct);
		tampered[0] = tampered[0]! ^ 0xff;

		expect(() => receiver.open(new Uint8Array(0), tampered)).toThrow();
		expect(receiver.nonceCounter).toBe(0n);

		// Counter untouched, so the SAME ciphertext (untampered) still opens correctly next.
		expect(Buffer.from(receiver.open(new Uint8Array(0), ct))).toEqual(Buffer.from('a'));
		expect(receiver.nonceCounter).toBe(1n);
	});

	it('rejects a non-32-byte key', () => {
		expect(() => new CipherState(new Uint8Array(31))).toThrow();
	});
});

describe('post-handshake transport via frames.ts (real CipherStates)', () => {
	function handshakePair() {
		const authority = makeAuthority();
		const server = makeServerIdentity(authority.secret32);
		const responder = new NoiseResponder({
			staticPriv32: server.staticSecret32,
			staticEll64: server.staticEll64,
			cert: server.cert
		});
		const { initiator } = runHandshake(authority.xonly32, responder, () => NOW);
		const client = initiator.split(); // { recv: c2, send: c1 }
		const srv = responder.split(); // { recv: c1, send: c2 }
		return { client, srv };
	}

	it('round-trips a small message client->server', () => {
		const { client, srv } = handshakePair();
		const frame = sealFrame(client.send, 0x00, false, new TextEncoder().encode('SetupConnection payload'));
		const reader = new EncryptedFrameReader(srv.recv);
		reader.push(frame);
		const frames = [...reader.drain()];
		expect(frames).toHaveLength(1);
		expect(Buffer.from(frames[0]!.payload)).toEqual(Buffer.from('SetupConnection payload'));
	});

	it('round-trips a large (>65519B) chunked payload server->client', () => {
		const { client, srv } = handshakePair();
		const big = new Uint8Array(65519 * 2 + 1000);
		for (let i = 0; i < big.length; i++) big[i] = i % 256;

		const frame = sealFrame(srv.send, 0x1f, true, big);
		const reader = new EncryptedFrameReader(client.recv, { maxMsgLen: big.length });
		reader.push(frame);
		const frames = [...reader.drain()];
		expect(frames).toHaveLength(1);
		expect(frames[0]!.channelMsg).toBe(true);
		expect(Buffer.from(frames[0]!.payload)).toEqual(Buffer.from(big));
	});

	it('handles partial-chunk delivery across multiple push() calls', () => {
		const { client, srv } = handshakePair();
		const payload = new TextEncoder().encode('split across TCP chunks');
		const frame = sealFrame(client.send, 0x01, false, payload);
		const reader = new EncryptedFrameReader(srv.recv);

		const mid = Math.floor(frame.length / 2);
		reader.push(frame.subarray(0, mid));
		expect([...reader.drain()]).toHaveLength(0);
		reader.push(frame.subarray(mid));
		const frames = [...reader.drain()];
		expect(frames).toHaveLength(1);
		expect(Buffer.from(frames[0]!.payload)).toEqual(Buffer.from(payload));
	});

	it('nonce desync: dropping one frame makes the next frame fail to open', () => {
		const { client, srv } = handshakePair();
		const frame1 = sealFrame(client.send, 0x00, false, new TextEncoder().encode('first'));
		const frame2 = sealFrame(client.send, 0x00, false, new TextEncoder().encode('second'));

		// Drop frame1 entirely — feed only frame2. srv.recv's nonce counter is
		// still at 0 (expects frame1's header), but frame2's ciphertext was
		// sealed at nonce 2 (header) — mismatched key stream -> AEAD failure.
		const reader = new EncryptedFrameReader(srv.recv);
		reader.push(frame2);
		expect(() => [...reader.drain()]).toThrow();
	});

	it('multiple sequential frames in one direction all round-trip in order', () => {
		const { client, srv } = handshakePair();
		const reader = new EncryptedFrameReader(srv.recv);
		const messages = ['one', 'two', 'three'];
		for (const m of messages) {
			reader.push(sealFrame(client.send, 0x00, false, new TextEncoder().encode(m)));
		}
		const frames = [...reader.drain()];
		expect(frames.map((f) => Buffer.from(f.payload).toString())).toEqual(messages);
	});
});
