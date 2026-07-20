/**
 * frames.ts: header codec, channel_msg bit masking, the plaintext<->ciphertext
 * length conversion (known-answer table from wire ref §1.2), chunked
 * seal/reassemble round trips against a mock AEAD, and the incremental
 * stream decoders under partial/byte-at-a-time delivery + DoS bounds.
 */
import { describe, expect, it } from 'vitest';
import {
	EncryptedFrameReader,
	HEADER_LEN,
	MAX_CT_LEN,
	MAX_MSG_LEN,
	MAX_PT_LEN,
	NOISE_HEADER_CT_LEN,
	PlaintextFrameReader,
	Sv2FrameError,
	buildFrame,
	decodeHeader,
	encodeHeader,
	extensionIdOf,
	isChannelMsg,
	ptLenToCtLen,
	sealFrame,
	type Frame,
	type SealOpen
} from './frames';

// ---------------------------------------------------------------------------
// header codec + channel_msg bit
// ---------------------------------------------------------------------------

describe('encodeHeader/decodeHeader', () => {
	it('round-trips extType/msgType/payloadLen', () => {
		const h = encodeHeader(0x0001, 0x1f, 12345);
		expect(h.length).toBe(HEADER_LEN);
		expect(decodeHeader(h)).toEqual({ extType: 0x0001, msgType: 0x1f, msgLen: 12345 });
	});

	it('round-trips the zero/min values', () => {
		const h = encodeHeader(0, 0, 0);
		expect(decodeHeader(h)).toEqual({ extType: 0, msgType: 0, msgLen: 0 });
	});

	it('round-trips max values (U16 extType, U8 msgType, U24 payloadLen)', () => {
		const h = encodeHeader(0xffff, 0xff, 0xffffff);
		expect(decodeHeader(h)).toEqual({ extType: 0xffff, msgType: 0xff, msgLen: 0xffffff });
	});

	it('rejects out-of-range fields', () => {
		expect(() => encodeHeader(0x10000, 0, 0)).toThrow(Sv2FrameError);
		expect(() => encodeHeader(0, 0x100, 0)).toThrow(Sv2FrameError);
		expect(() => encodeHeader(0, 0, 0x1000000)).toThrow(Sv2FrameError);
		expect(() => encodeHeader(-1, 0, 0)).toThrow(Sv2FrameError);
	});

	it('decodeHeader rejects anything other than exactly 6 bytes', () => {
		expect(() => decodeHeader(Buffer.alloc(5))).toThrow(Sv2FrameError);
		expect(() => decodeHeader(Buffer.alloc(7))).toThrow(Sv2FrameError);
	});
});

describe('channel_msg bit (extension_type LSB) + extension id mask', () => {
	it('core-protocol values: 0x0000 non-channel, 0x0001 channel', () => {
		expect(isChannelMsg(0x0000)).toBe(false);
		expect(isChannelMsg(0x0001)).toBe(true);
		expect(extensionIdOf(0x0000)).toBe(0);
		expect(extensionIdOf(0x0001)).toBe(0);
	});

	it('tolerates SRI-style 0x8000-range extension values: mask with 0xFFFE for lookup', () => {
		expect(isChannelMsg(0x8000)).toBe(false);
		expect(isChannelMsg(0x8001)).toBe(true);
		expect(extensionIdOf(0x8000)).toBe(0x8000);
		expect(extensionIdOf(0x8001)).toBe(0x8000);
	});
});

// ---------------------------------------------------------------------------
// buildFrame (plaintext)
// ---------------------------------------------------------------------------

describe('buildFrame', () => {
	it('produces header ‖ payload with the channel_msg bit reflected in extType', () => {
		const payload = Buffer.from('hello');
		const framed = Buffer.from(buildFrame(0x15, true, payload));
		const { extType, msgType, msgLen } = decodeHeader(framed.subarray(0, HEADER_LEN));
		expect(extType).toBe(0x0001);
		expect(msgType).toBe(0x15);
		expect(msgLen).toBe(payload.length);
		expect(framed.subarray(HEADER_LEN)).toEqual(payload);
	});

	it('non-channel message uses extType 0x0000', () => {
		const framed = Buffer.from(buildFrame(0x00, false, Buffer.alloc(0)));
		expect(decodeHeader(framed.subarray(0, HEADER_LEN)).extType).toBe(0x0000);
	});
});

// ---------------------------------------------------------------------------
// ptLenToCtLen — known-answer table (wire ref §1.2 exact C algorithm)
// ---------------------------------------------------------------------------

describe('ptLenToCtLen', () => {
	it.each([
		[0, 0],
		[1, 17],
		[65519, 65535], // = MAX_PT_LEN -> exactly one full block, no remainder
		[65520, 65552], // one full block + 1-byte remainder chunk (+16 MAC)
		[131038, 131070], // = 2*MAX_PT_LEN -> exactly two full blocks
		[131039, 131087] // 2 full blocks + 1-byte remainder chunk
	])('ptLenToCtLen(%i) === %i', (pt, ct) => {
		expect(ptLenToCtLen(pt)).toBe(ct);
	});

	it('sanity: MAX_PT_LEN + MAC_LEN(16) === MAX_CT_LEN', () => {
		expect(MAX_PT_LEN + 16).toBe(MAX_CT_LEN);
	});

	it('rejects negative / non-integer input', () => {
		expect(() => ptLenToCtLen(-1)).toThrow(Sv2FrameError);
		expect(() => ptLenToCtLen(1.5)).toThrow(Sv2FrameError);
	});
});

// ---------------------------------------------------------------------------
// PlaintextFrameReader
// ---------------------------------------------------------------------------

describe('PlaintextFrameReader', () => {
	it('yields nothing until a full frame has been pushed', () => {
		const r = new PlaintextFrameReader();
		r.push(Buffer.from(buildFrame(0x00, false, Buffer.from('abc'))).subarray(0, 4));
		expect([...r.drain()]).toEqual([]);
	});

	it('round-trips a single frame delivered whole', () => {
		const r = new PlaintextFrameReader();
		const payload = Buffer.from('hello world');
		r.push(buildFrame(0x01, false, payload));
		const frames = [...r.drain()];
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual<Frame>({ extType: 0, msgType: 0x01, channelMsg: false, payload });
	});

	it('round-trips two frames concatenated in one push, in order', () => {
		const r = new PlaintextFrameReader();
		const p1 = Buffer.from('first');
		const p2 = Buffer.from('second-payload');
		r.push(Buffer.concat([Buffer.from(buildFrame(0x02, true, p1)), Buffer.from(buildFrame(0x03, false, p2))]));
		const frames = [...r.drain()];
		expect(frames).toHaveLength(2);
		expect(frames[0]!.payload).toEqual(p1);
		expect(frames[0]!.channelMsg).toBe(true);
		expect(frames[1]!.payload).toEqual(p2);
		expect(frames[1]!.channelMsg).toBe(false);
	});

	it('reassembles a frame delivered one byte at a time', () => {
		const r = new PlaintextFrameReader();
		const payload = Buffer.from('byte-at-a-time payload, a bit longer than the header');
		const framed = Buffer.from(buildFrame(0x1a, true, payload));
		const collected: Frame[] = [];
		for (let i = 0; i < framed.length; i++) {
			r.push(framed.subarray(i, i + 1));
			collected.push(...r.drain());
		}
		expect(collected).toHaveLength(1);
		expect(collected[0]!.payload).toEqual(payload);
		expect(collected[0]!.msgType).toBe(0x1a);
	});

	it('rejects a header claiming a payload larger than MAX_MSG_LEN before buffering any payload bytes', () => {
		const r = new PlaintextFrameReader();
		const header = encodeHeader(0, 0x15, MAX_MSG_LEN + 1);
		r.push(header);
		expect(() => [...r.drain()]).toThrow(Sv2FrameError);
	});

	it('enforces the max buffered-bytes cap (DoS) when a frame never completes', () => {
		const r = new PlaintextFrameReader(16);
		expect(() => r.push(Buffer.alloc(17))).toThrow(Sv2FrameError);
	});
});

// ---------------------------------------------------------------------------
// EncryptedFrameReader / sealFrame — mock AEAD (structural correctness only,
// no real cryptographic properties asserted; real Noise crypto is noise.ts's
// job in a parallel phase).
// ---------------------------------------------------------------------------

/** A minimal reversible "AEAD": ct = pt XOR counter-keystream, 16-byte checksum
 *  tag over (counter, ct). Deliberately NOT real crypto — only exercises that
 *  frames.ts calls seal/open exactly once per logical block, in order, and
 *  reacts to a bad tag by throwing. */
function mockCipher(): SealOpen {
	let sealCounter = 0;
	let openCounter = 0;

	function keystream(counter: number, len: number): Buffer {
		const b = Buffer.alloc(len);
		for (let i = 0; i < len; i++) b[i] = (counter * 31 + i * 7) & 0xff;
		return b;
	}

	function tagFor(counter: number, ct: Buffer): Buffer {
		const t = Buffer.alloc(16);
		let acc = counter >>> 0;
		for (const byte of ct) acc = (Math.imul(acc, 33) + byte) >>> 0;
		t.writeUInt32LE(acc, 0);
		t.writeUInt32LE((counter ^ 0x9e3779b9) >>> 0, 4);
		return t;
	}

	return {
		seal(_ad: Uint8Array, pt: Uint8Array): Uint8Array {
			const ptBuf = Buffer.from(pt);
			const ks = keystream(sealCounter, ptBuf.length);
			const ct = Buffer.alloc(ptBuf.length);
			for (let i = 0; i < ptBuf.length; i++) ct[i] = ptBuf[i]! ^ ks[i]!;
			const tag = tagFor(sealCounter, ct);
			sealCounter++;
			return Buffer.concat([ct, tag]);
		},
		open(_ad: Uint8Array, ctTag: Uint8Array): Uint8Array {
			const buf = Buffer.from(ctTag);
			if (buf.length < 16) throw new Error('ciphertext too short for tag');
			const ct = buf.subarray(0, buf.length - 16);
			const tag = buf.subarray(buf.length - 16);
			const expected = tagFor(openCounter, ct);
			if (!tag.equals(expected)) {
				openCounter++;
				throw new Error('bad tag');
			}
			const ks = keystream(openCounter, ct.length);
			const pt = Buffer.alloc(ct.length);
			for (let i = 0; i < ct.length; i++) pt[i] = ct[i]! ^ ks[i]!;
			openCounter++;
			return pt;
		}
	};
}

describe('sealFrame / EncryptedFrameReader round trip', () => {
	it('round-trips a small message', () => {
		const cs = mockCipher();
		const payload = Buffer.from('a small mining message payload');
		const sealed = sealFrame(cs, 0x1c, true, payload);
		const r = new EncryptedFrameReader(cs);
		r.push(sealed);
		const frames = [...r.drain()];
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual<Frame>({ extType: 0x0001, msgType: 0x1c, channelMsg: true, payload });
	});

	it('round-trips a zero-length payload (no payload AEAD block emitted)', () => {
		const cs = mockCipher();
		const sealed = Buffer.from(sealFrame(cs, 0x18, true, Buffer.alloc(0)));
		expect(sealed.length).toBe(NOISE_HEADER_CT_LEN); // header block only
		const r = new EncryptedFrameReader(cs);
		r.push(sealed);
		const frames = [...r.drain()];
		expect(frames).toHaveLength(1);
		expect(frames[0]!.payload).toEqual(Buffer.alloc(0));
	});

	it.each([MAX_PT_LEN, MAX_PT_LEN + 1, 2 * MAX_PT_LEN, 2 * MAX_PT_LEN + 1])(
		'round-trips a payload of exactly %i bytes across the chunk boundary',
		(len) => {
			const cs = mockCipher();
			const payload = Buffer.alloc(len);
			for (let i = 0; i < len; i++) payload[i] = i & 0xff;
			const sealed = sealFrame(cs, 0x1f, true, payload);
			const r = new EncryptedFrameReader(cs);
			r.push(sealed);
			const frames = [...r.drain()];
			expect(frames).toHaveLength(1);
			expect(frames[0]!.payload).toEqual(payload);
		}
	);

	it('reassembles a small encrypted frame delivered one byte at a time (header must be decrypted exactly once)', () => {
		const cs = mockCipher();
		const payload = Buffer.from('drip fed encrypted frame payload');
		const sealed = Buffer.from(sealFrame(cs, 0x1a, true, payload));
		const r = new EncryptedFrameReader(cs);
		const collected: Frame[] = [];
		for (let i = 0; i < sealed.length; i++) {
			r.push(sealed.subarray(i, i + 1));
			collected.push(...r.drain());
		}
		expect(collected).toHaveLength(1);
		expect(collected[0]!.payload).toEqual(payload);
	});

	it('reassembles two frames delivered back-to-back in one push', () => {
		const cs = mockCipher();
		const p1 = Buffer.from('frame one');
		const p2 = Buffer.from('frame two, a little longer');
		const sealed = Buffer.concat([
			Buffer.from(sealFrame(cs, 0x1a, true, p1)),
			Buffer.from(sealFrame(cs, 0x1c, true, p2))
		]);
		const r = new EncryptedFrameReader(cs);
		r.push(sealed);
		const frames = [...r.drain()];
		expect(frames).toHaveLength(2);
		expect(frames[0]!.payload).toEqual(p1);
		expect(frames[1]!.payload).toEqual(p2);
	});

	it('propagates a decrypt failure (bad tag) and never returns a forged frame', () => {
		const cs = mockCipher();
		const sealed = Buffer.from(sealFrame(cs, 0x1a, true, Buffer.from('tamper me')));
		sealed[sealed.length - 1] ^= 0xff; // corrupt the tag of the payload block
		const r = new EncryptedFrameReader(cs);
		r.push(sealed);
		expect(() => [...r.drain()]).toThrow();
	});

	it('rejects a header claiming a payload larger than the configured max before waiting for payload bytes', () => {
		const cs = mockCipher();
		// Build a header-only ciphertext claiming an oversize msg_length.
		const header = encodeHeader(0x0001, 0x1f, 10_000);
		const headerCt = Buffer.from(cs.seal(new Uint8Array(0), header));
		const r = new EncryptedFrameReader(cs, { maxMsgLen: 1000 });
		r.push(headerCt);
		expect(() => [...r.drain()]).toThrow(Sv2FrameError);
	});

	it('enforces the max buffered-bytes cap (DoS) when a header never fully arrives', () => {
		const cs = mockCipher();
		const r = new EncryptedFrameReader(cs, { maxBuffer: 8 });
		expect(() => r.push(Buffer.alloc(9))).toThrow(Sv2FrameError);
	});
});
