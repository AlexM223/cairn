/**
 * SV2 wire framing: the 6-byte plaintext header codec, the plaintext-length ->
 * ciphertext-length conversion for Noise transport frames (wire ref §1.2), and
 * length-bounded incremental stream decoders for both the pre-handshake
 * plaintext phase and the post-handshake encrypted transport.
 *
 * This module knows byte layout and chunking math only — no message field
 * knowledge (codec.ts) and no real crypto (crypto.ts/noise.ts, built in a
 * parallel phase). The encrypted-frame helpers take a minimal seal/open
 * interface (SealOpen) so they are fully unit-testable with a mock AEAD.
 *
 * DoS posture (risk register #6): every stream reader enforces a max
 * buffered-bytes cap AND a max declared msg_length, and rejects the latter as
 * soon as the (decrypted) header is available — before ever buffering a
 * claimed-huge payload.
 */

export const HEADER_LEN = 6;
export const MAC_LEN = 16;
export const MAX_CT_LEN = 65535;
export const MAX_PT_LEN = MAX_CT_LEN - MAC_LEN; // 65519
export const NOISE_HEADER_CT_LEN = HEADER_LEN + MAC_LEN; // 22

/** DoS cap on a single message's declared length. Generous for any real SV2
 *  mining message, far below the U24 wire ceiling (16 MiB) it guards against. */
export const MAX_MSG_LEN = 1_048_576; // 1 MiB

/** Default cap on bytes buffered awaiting a complete frame. */
const DEFAULT_MAX_BUFFER = 1 << 20; // 1 MiB

export class Sv2FrameError extends Error {}

export interface FrameHeader {
	extType: number;
	msgType: number;
	msgLen: number;
}

export function encodeHeader(extType: number, msgType: number, payloadLen: number): Uint8Array {
	if (!Number.isInteger(extType) || extType < 0 || extType > 0xffff) {
		throw new Sv2FrameError(`extType out of range: ${extType}`);
	}
	if (!Number.isInteger(msgType) || msgType < 0 || msgType > 0xff) {
		throw new Sv2FrameError(`msgType out of range: ${msgType}`);
	}
	if (!Number.isInteger(payloadLen) || payloadLen < 0 || payloadLen > 0xffffff) {
		throw new Sv2FrameError(`payloadLen out of range: ${payloadLen}`);
	}
	const b = Buffer.alloc(HEADER_LEN);
	b.writeUInt16LE(extType, 0);
	b.writeUInt8(msgType, 2);
	b.writeUIntLE(payloadLen, 3, 3);
	return b;
}

export function decodeHeader(buf6: Uint8Array): FrameHeader {
	if (buf6.length !== HEADER_LEN) {
		throw new Sv2FrameError(`header must be exactly ${HEADER_LEN} bytes, got ${buf6.length}`);
	}
	const b = Buffer.from(buf6);
	return {
		extType: b.readUInt16LE(0),
		msgType: b.readUInt8(2),
		msgLen: b.readUIntLE(3, 3)
	};
}

/** channel_msg bit = least significant bit of extension_type (wire ref §1.1). */
export function isChannelMsg(extType: number): boolean {
	return (extType & 0x0001) === 1;
}

/** Extension id for lookup: mask off the channel_msg bit. Tolerates SRI's
 *  0x8000-style extension values on receive per the wire reference note. */
export function extensionIdOf(extType: number): number {
	return extType & 0xfffe;
}

/** Exact C algorithm from wire-reference §1.2. */
export function ptLenToCtLen(ptLen: number): number {
	if (!Number.isInteger(ptLen) || ptLen < 0) throw new Sv2FrameError(`ptLen out of range: ${ptLen}`);
	let remainder = ptLen % MAX_PT_LEN;
	if (remainder > 0) remainder += MAC_LEN;
	return Math.floor(ptLen / MAX_PT_LEN) * MAX_CT_LEN + remainder;
}

export interface Frame {
	extType: number;
	msgType: number;
	channelMsg: boolean;
	payload: Uint8Array;
}

/** Build a full plaintext frame (header ‖ payload) for a server→client message. */
export function buildFrame(msgType: number, channelMsg: boolean, payload: Uint8Array): Uint8Array {
	const extType = channelMsg ? 0x0001 : 0x0000;
	const header = encodeHeader(extType, msgType, payload.length);
	return Buffer.concat([Buffer.from(header), Buffer.from(payload)]);
}

/**
 * Streaming plaintext parser (handshake phase only — post-handshake frames go
 * through EncryptedFrameReader). Accumulates partial TCP chunks and yields
 * whatever frames are now complete; enforces MAX_MSG_LEN as soon as a header
 * is readable and a max buffered-bytes cap so a peer that never completes a
 * frame cannot grow the buffer unbounded (DoS, risk register #6).
 */
export class PlaintextFrameReader {
	private buf: Buffer = Buffer.alloc(0);
	private readonly maxBuffer: number;

	constructor(maxBuffer = DEFAULT_MAX_BUFFER) {
		this.maxBuffer = maxBuffer;
	}

	push(chunk: Uint8Array): void {
		this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
		if (this.buf.length > this.maxBuffer) {
			throw new Sv2FrameError(`PlaintextFrameReader buffer exceeded max ${this.maxBuffer} bytes`);
		}
	}

	*drain(): IterableIterator<Frame> {
		for (;;) {
			if (this.buf.length < HEADER_LEN) return;
			const { extType, msgType, msgLen } = decodeHeader(this.buf.subarray(0, HEADER_LEN));
			if (msgLen > MAX_MSG_LEN) {
				throw new Sv2FrameError(`frame payload too large: ${msgLen} > ${MAX_MSG_LEN}`);
			}
			const total = HEADER_LEN + msgLen;
			if (this.buf.length < total) return;
			const payload = Buffer.from(this.buf.subarray(HEADER_LEN, total));
			this.buf = Buffer.from(this.buf.subarray(total));
			yield { extType, msgType, channelMsg: isChannelMsg(extType), payload };
		}
	}
}

/**
 * Minimal AEAD surface the encrypted-frame helpers need. Structurally
 * compatible with noise.ts's CipherState ({encrypt,decrypt}) — tests here
 * use plain mocks (e.g. XOR or identity) so framing/chunking logic is
 * verified without any real Noise/crypto dependency.
 */
export interface SealOpen {
	/** Encrypt-with-associated-data: returns ciphertext‖tag. */
	seal(ad: Uint8Array, pt: Uint8Array): Uint8Array;
	/** Decrypt-with-associated-data: returns plaintext; throws on a bad tag. */
	open(ad: Uint8Array, ct: Uint8Array): Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Seal a plaintext frame (header ‖ payload) for the encrypted transport: the
 * 6-byte header is its own AEAD call (fixed 22-byte ciphertext); the payload
 * is split into ≤MAX_PT_LEN-byte pieces, each its own AEAD call, per wire
 * reference §1.2. A zero-length payload has no payload chunk (matches
 * ptLenToCtLen(0) === 0 — no AEAD call for an empty message body).
 */
export function sealFrame(cs: Pick<SealOpen, 'seal'>, msgType: number, channelMsg: boolean, payload: Uint8Array): Uint8Array {
	const extType = channelMsg ? 0x0001 : 0x0000;
	const header = encodeHeader(extType, msgType, payload.length);
	const parts: Buffer[] = [Buffer.from(cs.seal(EMPTY, header))];
	const buf = Buffer.from(payload);
	let offset = 0;
	while (offset < buf.length) {
		const end = Math.min(offset + MAX_PT_LEN, buf.length);
		parts.push(Buffer.from(cs.seal(EMPTY, buf.subarray(offset, end))));
		offset = end;
	}
	return Buffer.concat(parts);
}

type ReaderState =
	| { phase: 'header' }
	| { phase: 'payload'; extType: number; msgType: number; ptRemaining: number; chunks: Buffer[] };

/**
 * Stateful transport decryptor: feed ciphertext, get complete plaintext
 * frames. Reads the 22-byte encrypted header exactly once per frame (a
 * CipherState's AEAD counter advances per call, so the header must never be
 * re-decrypted while waiting for more payload bytes), converts msg_length to
 * ciphertext length via ptLenToCtLen, then decrypts payload chunks as they
 * arrive. A decrypt failure propagates out of drain() (generator throw) —
 * callers must terminate the session, never retry or fall back.
 */
export class EncryptedFrameReader {
	private buf: Buffer = Buffer.alloc(0);
	private state: ReaderState = { phase: 'header' };
	private readonly maxBuffer: number;
	private readonly maxMsgLen: number;
	private readonly cs: Pick<SealOpen, 'open'>;

	constructor(cs: Pick<SealOpen, 'open'>, opts: { maxBuffer?: number; maxMsgLen?: number } = {}) {
		this.cs = cs;
		this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
		this.maxMsgLen = opts.maxMsgLen ?? MAX_MSG_LEN;
	}

	push(chunk: Uint8Array): void {
		this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
		if (this.buf.length > this.maxBuffer) {
			throw new Sv2FrameError(`EncryptedFrameReader buffer exceeded max ${this.maxBuffer} bytes`);
		}
	}

	private consume(n: number): Buffer {
		const v = Buffer.from(this.buf.subarray(0, n));
		this.buf = Buffer.from(this.buf.subarray(n));
		return v;
	}

	*drain(): IterableIterator<Frame> {
		for (;;) {
			if (this.state.phase === 'header') {
				if (this.buf.length < NOISE_HEADER_CT_LEN) return;
				const headerCt = this.consume(NOISE_HEADER_CT_LEN);
				const headerPt = Buffer.from(this.cs.open(EMPTY, headerCt));
				const { extType, msgType, msgLen } = decodeHeader(headerPt);
				if (msgLen > this.maxMsgLen) {
					throw new Sv2FrameError(`frame payload too large: ${msgLen} > ${this.maxMsgLen}`);
				}
				if (msgLen === 0) {
					yield { extType, msgType, channelMsg: isChannelMsg(extType), payload: Buffer.alloc(0) };
					this.state = { phase: 'header' };
					continue;
				}
				this.state = { phase: 'payload', extType, msgType, ptRemaining: msgLen, chunks: [] };
				continue;
			}

			// phase === 'payload'
			const st = this.state;
			const chunkPt = Math.min(st.ptRemaining, MAX_PT_LEN);
			const chunkCt = ptLenToCtLen(chunkPt);
			if (this.buf.length < chunkCt) return;
			const ct = this.consume(chunkCt);
			const pt = Buffer.from(this.cs.open(EMPTY, ct));
			st.chunks.push(pt);
			st.ptRemaining -= chunkPt;
			if (st.ptRemaining === 0) {
				const payload = Buffer.concat(st.chunks);
				yield { extType: st.extType, msgType: st.msgType, channelMsg: isChannelMsg(st.extType), payload };
				this.state = { phase: 'header' };
			}
		}
	}
}
