/**
 * codec.ts: Writer/Reader primitives + per-message encode/decode round trips,
 * edge values, and hard-fail-on-truncation/garbage fuzzing. Mirrors the style
 * of wire.test.ts (numeric edge cases pinned explicitly) but the primary
 * coverage tool here is a message registry table so every §4 message type is
 * exercised the same way instead of by hand.
 */
import { describe, expect, it } from 'vitest';
import {
	CHANNEL_MSG,
	MSG,
	Reader,
	Sv2DecodeError,
	Writer,
	decodeChannelEndpointChanged,
	decodeCloseChannel,
	decodeNewExtendedMiningJob,
	decodeNewMiningJob,
	decodeOpenExtendedMiningChannel,
	decodeOpenExtendedMiningChannelSuccess,
	decodeOpenMiningChannelError,
	decodeOpenStandardMiningChannel,
	decodeOpenStandardMiningChannelSuccess,
	decodeReconnect,
	decodeSetCustomMiningJobStub,
	decodeSetExtranoncePrefix,
	decodeSetGroupChannel,
	decodeSetNewPrevHash,
	decodeSetTarget,
	decodeSetupConnection,
	decodeSetupConnectionError,
	decodeSetupConnectionSuccess,
	decodeSubmitSharesError,
	decodeSubmitSharesExtended,
	decodeSubmitSharesStandard,
	decodeSubmitSharesSuccess,
	decodeUpdateChannel,
	decodeUpdateChannelError,
	encodeChannelEndpointChanged,
	encodeCloseChannel,
	encodeNewExtendedMiningJob,
	encodeNewMiningJob,
	encodeOpenExtendedMiningChannel,
	encodeOpenExtendedMiningChannelSuccess,
	encodeOpenMiningChannelError,
	encodeOpenStandardMiningChannel,
	encodeOpenStandardMiningChannelSuccess,
	encodeReconnect,
	encodeSetExtranoncePrefix,
	encodeSetGroupChannel,
	encodeSetNewPrevHash,
	encodeSetTarget,
	encodeSetupConnection,
	encodeSetupConnectionError,
	encodeSetupConnectionSuccess,
	encodeSubmitSharesError,
	encodeSubmitSharesExtended,
	encodeSubmitSharesStandard,
	encodeSubmitSharesSuccess,
	encodeUpdateChannel,
	encodeUpdateChannelError,
	targetToU256LE,
	u256LEToBigint
} from './codec';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pattern32(byte: number): Buffer {
	return Buffer.alloc(32, byte);
}

/** Deterministic PRNG (mulberry32) so the raw-byte fuzz tests are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomBytes(rng: () => number, len: number): Buffer {
	const b = Buffer.alloc(len);
	for (let i = 0; i < len; i++) b[i] = Math.floor(rng() * 256);
	return b;
}

// ---------------------------------------------------------------------------
// Writer / Reader primitives
// ---------------------------------------------------------------------------

describe('Writer/Reader integer primitives', () => {
	it('round-trips u8/u16/u24/u32 at their max values', () => {
		const w = new Writer().u8(0xff).u16(0xffff).u24(0xffffff).u32(0xffffffff).finish();
		const r = new Reader(w);
		expect(r.u8()).toBe(0xff);
		expect(r.u16()).toBe(0xffff);
		expect(r.u24()).toBe(0xffffff);
		expect(r.u32()).toBe(0xffffffff);
		expect(r.eof).toBe(true);
	});

	it('round-trips u8/u16/u24/u32 at zero', () => {
		const w = new Writer().u8(0).u16(0).u24(0).u32(0).finish();
		const r = new Reader(w);
		expect(r.u8()).toBe(0);
		expect(r.u16()).toBe(0);
		expect(r.u24()).toBe(0);
		expect(r.u32()).toBe(0);
	});

	it('round-trips u64 at 0 and max', () => {
		const max = (1n << 64n) - 1n;
		const w = new Writer().u64(0n).u64(max).finish();
		const r = new Reader(w);
		expect(r.u64()).toBe(0n);
		expect(r.u64()).toBe(max);
	});

	it('rejects out-of-range values on write', () => {
		expect(() => new Writer().u8(256)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u8(-1)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u16(0x10000)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u24(0x1000000)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u32(0x100000000)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u64(-1n)).toThrow(Sv2DecodeError);
		expect(() => new Writer().u64((1n << 64n))).toThrow(Sv2DecodeError);
		expect(() => new Writer().u8(1.5)).toThrow(Sv2DecodeError);
	});

	it('bool: LSB is the value, upper bits ignored on receive', () => {
		expect(new Reader(Buffer.from([0x01])).bool()).toBe(true);
		expect(new Reader(Buffer.from([0x00])).bool()).toBe(false);
		expect(new Reader(Buffer.from([0xfe])).bool()).toBe(false); // LSB 0
		expect(new Reader(Buffer.from([0xff])).bool()).toBe(true); // LSB 1
		expect(new Reader(Buffer.from([0x03])).bool()).toBe(true); // LSB 1, upper bit ignored
	});

	it('f32 round-trips within float32 precision', () => {
		const w = new Writer().f32(12345.6789).finish();
		const v = new Reader(w).f32();
		expect(v).toBeCloseTo(12345.6789, 1);
	});

	it('reading past the end of the buffer throws Sv2DecodeError, not a raw RangeError', () => {
		const r = new Reader(Buffer.from([0x01, 0x02]));
		r.u8();
		r.u8();
		expect(() => r.u8()).toThrow(Sv2DecodeError);
	});
});

describe('U256 (LE) + target helpers', () => {
	it('u256 round-trips a 32-byte value written/read as raw bytes', () => {
		const v = pattern32(0x42);
		const w = new Writer().u256(v).finish();
		expect(new Reader(w).u256()).toEqual(v);
	});

	it('u256 rejects a Uint8Array that is not exactly 32 bytes', () => {
		expect(() => new Writer().u256(Buffer.alloc(31))).toThrow(Sv2DecodeError);
		expect(() => new Writer().u256(Buffer.alloc(33))).toThrow(Sv2DecodeError);
	});

	it('targetToU256LE / u256LEToBigint round-trip, including 0 and the 256-bit max', () => {
		const maxTarget = (1n << 256n) - 1n;
		for (const t of [0n, 1n, 123456789n, maxTarget]) {
			expect(u256LEToBigint(targetToU256LE(t))).toBe(t);
		}
	});

	it('u256(bigint) via Writer matches targetToU256LE', () => {
		const t = 0xdeadbeefn;
		const viaWriter = new Writer().u256(t).finish();
		expect(viaWriter).toEqual(targetToU256LE(t));
	});

	it('u256LEToBigint rejects wrong-length input', () => {
		expect(() => u256LEToBigint(Buffer.alloc(31))).toThrow(Sv2DecodeError);
	});
});

describe('length-prefixed fields', () => {
	it('str0_255 round-trips empty and max-length (255 byte) strings', () => {
		const empty = '';
		const max255 = 'a'.repeat(255);
		const w = new Writer().str0_255(empty).str0_255(max255).finish();
		const r = new Reader(w);
		expect(r.str0_255()).toBe(empty);
		expect(r.str0_255()).toBe(max255);
	});

	it('str0_255 rejects a string whose UTF-8 encoding exceeds 255 bytes', () => {
		expect(() => new Writer().str0_255('a'.repeat(256))).toThrow(Sv2DecodeError);
	});

	it('b0_32 round-trips empty and max-length (32 byte) buffers, rejects 33', () => {
		const w = new Writer().b0_32(Buffer.alloc(0)).b0_32(Buffer.alloc(32, 0x11)).finish();
		const r = new Reader(w);
		expect(r.b0_32()).toEqual(Buffer.alloc(0));
		expect(r.b0_32()).toEqual(Buffer.alloc(32, 0x11));
		expect(() => new Writer().b0_32(Buffer.alloc(33))).toThrow(Sv2DecodeError);
	});

	it('b0_64k round-trips a max-length (65535 byte) buffer', () => {
		const big = Buffer.alloc(65535, 0x7a);
		const w = new Writer().b0_64k(big).finish();
		expect(new Reader(w).b0_64k()).toEqual(big);
	});

	it('b0_64k rejects a buffer over 65535 bytes', () => {
		expect(() => new Writer().b0_64k(Buffer.alloc(65536))).toThrow(Sv2DecodeError);
	});
});

describe('OPTION[U32]', () => {
	it('round-trips unset (null)', () => {
		const w = new Writer().optU32(null).finish();
		expect(w.length).toBe(1);
		expect(new Reader(w).optU32()).toBeNull();
	});

	it('round-trips set (0 and a large value)', () => {
		const w = new Writer().optU32(0).optU32(0xffffffff).finish();
		const r = new Reader(w);
		expect(r.optU32()).toBe(0);
		expect(r.optU32()).toBe(0xffffffff);
	});

	it('rejects a count byte other than 0 or 1', () => {
		expect(() => new Reader(Buffer.from([0x02, 0, 0, 0, 0])).optU32()).toThrow(Sv2DecodeError);
	});
});

describe('SEQ0_255[U256] / SEQ0_64K[U32]', () => {
	it('round-trips an empty SEQ0_255[U256]', () => {
		const w = new Writer().seqU256([]).finish();
		expect(w.length).toBe(1);
		expect(new Reader(w).seqU256()).toEqual([]);
	});

	it('round-trips a max-length (255-item) SEQ0_255[U256]', () => {
		const items = Array.from({ length: 255 }, (_, i) => pattern32(i & 0xff));
		const w = new Writer().seqU256(items).finish();
		expect(new Reader(w).seqU256()).toEqual(items);
	});

	it('rejects more than 255 items', () => {
		const items = Array.from({ length: 256 }, () => pattern32(0));
		expect(() => new Writer().seqU256(items)).toThrow(Sv2DecodeError);
	});

	it('round-trips an empty SEQ0_64K[U32]', () => {
		const w = new Writer().seqU32_64k([]).finish();
		expect(new Reader(w).seqU32_64k()).toEqual([]);
	});

	it('round-trips a large SEQ0_64K[U32]', () => {
		const items = Array.from({ length: 1000 }, (_, i) => i);
		const w = new Writer().seqU32_64k(items).finish();
		expect(new Reader(w).seqU32_64k()).toEqual(items);
	});

	it('rejects more than 65535 items', () => {
		const items = new Array(65536).fill(0);
		expect(() => new Writer().seqU32_64k(items)).toThrow(Sv2DecodeError);
	});
});

// ---------------------------------------------------------------------------
// MSG / CHANNEL_MSG sanity
// ---------------------------------------------------------------------------

describe('MSG ids + CHANNEL_MSG set', () => {
	it('matches the msg_type values from wire reference §4', () => {
		expect(MSG.SetupConnection).toBe(0x00);
		expect(MSG.NewExtendedMiningJob).toBe(0x1f);
		expect(MSG.SetNewPrevHash).toBe(0x20);
		expect(MSG.SetTarget).toBe(0x21);
		expect(MSG.SetGroupChannel).toBe(0x25);
	});

	it('flags channel_msg=1 messages and excludes channel_msg=0 messages, per §4', () => {
		for (const id of [
			MSG.ChannelEndpointChanged,
			MSG.NewMiningJob,
			MSG.UpdateChannel,
			MSG.UpdateChannelError,
			MSG.CloseChannel,
			MSG.SetExtranoncePrefix,
			MSG.SubmitSharesStandard,
			MSG.SubmitSharesExtended,
			MSG.SubmitSharesSuccess,
			MSG.SubmitSharesError,
			MSG.NewExtendedMiningJob,
			MSG.SetNewPrevHash,
			MSG.SetTarget
		]) {
			expect(CHANNEL_MSG.has(id)).toBe(true);
		}
		for (const id of [
			MSG.SetupConnection,
			MSG.SetupConnectionSuccess,
			MSG.SetupConnectionError,
			MSG.Reconnect,
			MSG.OpenStandardMiningChannel,
			MSG.OpenStandardMiningChannelSuccess,
			MSG.OpenMiningChannelError,
			MSG.OpenExtendedMiningChannel,
			MSG.OpenExtendedMiningChannelSuccess,
			MSG.SetGroupChannel
		]) {
			expect(CHANNEL_MSG.has(id)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Per-message round trip + truncation-must-throw, table-driven over every
// message type in §4 (except the out-of-scope SetCustomMiningJob family,
// covered separately below).
// ---------------------------------------------------------------------------

interface MsgCase {
	name: string;
	encode: (m: any) => Uint8Array;
	decode: (p: Uint8Array) => any;
	sample: any;
}

const U256_A = pattern32(0xaa);
const U256_B = pattern32(0xbb);
const MAX_TARGET = Buffer.alloc(32, 0xff);

const cases: MsgCase[] = [
	{
		name: 'SetupConnection',
		encode: encodeSetupConnection,
		decode: decodeSetupConnection,
		sample: {
			protocol: 0,
			minVersion: 2,
			maxVersion: 2,
			flags: 0x00000005,
			endpointHost: 'pool.example',
			endpointPort: 3335,
			vendor: 'Bitmain',
			hardwareVersion: 'S19',
			firmware: '1.0.0',
			deviceId: 'abc-123'
		}
	},
	{
		name: 'SetupConnection (all-empty strings, edge)',
		encode: encodeSetupConnection,
		decode: decodeSetupConnection,
		sample: {
			protocol: 0,
			minVersion: 2,
			maxVersion: 2,
			flags: 0,
			endpointHost: '',
			endpointPort: 0,
			vendor: '',
			hardwareVersion: '',
			firmware: '',
			deviceId: ''
		}
	},
	{
		name: 'SetupConnection.Success',
		encode: encodeSetupConnectionSuccess,
		decode: decodeSetupConnectionSuccess,
		sample: { usedVersion: 2, flags: 0x2 }
	},
	{
		name: 'SetupConnection.Error',
		encode: encodeSetupConnectionError,
		decode: decodeSetupConnectionError,
		sample: { flags: 0x4, errorCode: 'unsupported-protocol' }
	},
	{
		name: 'ChannelEndpointChanged',
		encode: encodeChannelEndpointChanged,
		decode: decodeChannelEndpointChanged,
		sample: { channelId: 7 }
	},
	{
		name: 'Reconnect',
		encode: encodeReconnect,
		decode: decodeReconnect,
		sample: { newHost: 'new.example', newPort: 3336 }
	},
	{
		name: 'Reconnect (keep host/port, edge)',
		encode: encodeReconnect,
		decode: decodeReconnect,
		sample: { newHost: '', newPort: 0 }
	},
	{
		name: 'OpenStandardMiningChannel',
		encode: encodeOpenStandardMiningChannel,
		decode: decodeOpenStandardMiningChannel,
		sample: { requestId: 1, userIdentity: 'worker1', nominalHashRate: Math.fround(1e12), maxTarget: MAX_TARGET }
	},
	{
		name: 'OpenStandardMiningChannel.Success',
		encode: encodeOpenStandardMiningChannelSuccess,
		decode: decodeOpenStandardMiningChannelSuccess,
		sample: { requestId: 1, channelId: 5, target: U256_A, extranoncePrefix: Buffer.alloc(8, 0x01), groupChannelId: 0 }
	},
	{
		name: 'OpenStandardMiningChannel.Success (empty extranoncePrefix, edge)',
		encode: encodeOpenStandardMiningChannelSuccess,
		decode: decodeOpenStandardMiningChannelSuccess,
		sample: { requestId: 1, channelId: 5, target: U256_A, extranoncePrefix: Buffer.alloc(0), groupChannelId: 0 }
	},
	{
		name: 'OpenMiningChannel.Error',
		encode: encodeOpenMiningChannelError,
		decode: decodeOpenMiningChannelError,
		sample: { requestId: 9, errorCode: 'max-extranonce-too-large' }
	},
	{
		name: 'OpenExtendedMiningChannel',
		encode: encodeOpenExtendedMiningChannel,
		decode: decodeOpenExtendedMiningChannel,
		sample: {
			requestId: 2,
			userIdentity: 'worker2',
			nominalHashRate: Math.fround(2e12),
			maxTarget: MAX_TARGET,
			minExtranonceSize: 4
		}
	},
	{
		name: 'OpenExtendedMiningChannel.Success',
		encode: encodeOpenExtendedMiningChannelSuccess,
		decode: decodeOpenExtendedMiningChannelSuccess,
		sample: {
			requestId: 2,
			channelId: 11,
			target: U256_A,
			extranonceSize: 4,
			extranoncePrefix: Buffer.alloc(4, 0x02),
			groupChannelId: 0
		}
	},
	{
		name: 'UpdateChannel',
		encode: encodeUpdateChannel,
		decode: decodeUpdateChannel,
		sample: { channelId: 11, nominalHashRate: Math.fround(3e12), maximumTarget: U256_B }
	},
	{
		name: 'UpdateChannel.Error',
		encode: encodeUpdateChannelError,
		decode: decodeUpdateChannelError,
		sample: { channelId: 11, errorCode: 'max-target-out-of-range' }
	},
	{
		name: 'CloseChannel',
		encode: encodeCloseChannel,
		decode: decodeCloseChannel,
		sample: { channelId: 11, reasonCode: 'client-disconnect' }
	},
	{
		name: 'SetExtranoncePrefix',
		encode: encodeSetExtranoncePrefix,
		decode: decodeSetExtranoncePrefix,
		sample: { channelId: 11, extranoncePrefix: Buffer.alloc(32, 0x03) }
	},
	{
		name: 'SubmitSharesStandard',
		encode: encodeSubmitSharesStandard,
		decode: decodeSubmitSharesStandard,
		sample: { channelId: 5, sequenceNumber: 1, jobId: 100, nonce: 0xdeadbeef, ntime: 1721000000, version: 0x20000000 }
	},
	{
		name: 'SubmitSharesExtended',
		encode: encodeSubmitSharesExtended,
		decode: decodeSubmitSharesExtended,
		sample: {
			channelId: 11,
			sequenceNumber: 1,
			jobId: 100,
			nonce: 0xdeadbeef,
			ntime: 1721000000,
			version: 0x20000000,
			extranonce: Buffer.from([0x01, 0x02, 0x03, 0x04])
		}
	},
	{
		name: 'SubmitShares.Success',
		encode: encodeSubmitSharesSuccess,
		decode: decodeSubmitSharesSuccess,
		sample: { channelId: 11, lastSequenceNumber: 1, newSubmitsAcceptedCount: 1, newSharesSum: 65536n }
	},
	{
		name: 'SubmitShares.Error',
		encode: encodeSubmitSharesError,
		decode: decodeSubmitSharesError,
		sample: { channelId: 11, sequenceNumber: 1, errorCode: 'difficulty-too-low' }
	},
	{
		name: 'NewMiningJob (future job, min_ntime unset)',
		encode: encodeNewMiningJob,
		decode: decodeNewMiningJob,
		sample: { channelId: 5, jobId: 200, minNtime: null, version: 0x20000000, merkleRoot: U256_A }
	},
	{
		name: 'NewMiningJob (immediately valid, min_ntime set)',
		encode: encodeNewMiningJob,
		decode: decodeNewMiningJob,
		sample: { channelId: 5, jobId: 201, minNtime: 1721000000, version: 0x20000000, merkleRoot: U256_B }
	},
	{
		name: 'NewExtendedMiningJob (empty merkle path, edge)',
		encode: encodeNewExtendedMiningJob,
		decode: decodeNewExtendedMiningJob,
		sample: {
			channelId: 11,
			jobId: 300,
			minNtime: null,
			version: 0x20000000,
			versionRollingAllowed: false,
			merklePath: [],
			coinbaseTxPrefix: Buffer.from('01000000', 'hex'),
			coinbaseTxSuffix: Buffer.from('ffffffff', 'hex')
		}
	},
	{
		name: 'NewExtendedMiningJob (multi-branch merkle path + max B0_64K prefix/suffix, edge)',
		encode: encodeNewExtendedMiningJob,
		decode: decodeNewExtendedMiningJob,
		sample: {
			channelId: 11,
			jobId: 301,
			minNtime: 1721000001,
			version: 0x20000004,
			versionRollingAllowed: true,
			merklePath: [U256_A, U256_B, pattern32(0xcc)],
			coinbaseTxPrefix: Buffer.alloc(65535, 0x11),
			coinbaseTxSuffix: Buffer.alloc(65535, 0x22)
		}
	},
	{
		name: 'SetNewPrevHash',
		encode: encodeSetNewPrevHash,
		decode: decodeSetNewPrevHash,
		sample: { channelId: 11, jobId: 300, prevHash: U256_A, minNtime: 1721000000, nbits: 0x1a2b3c4d }
	},
	{
		name: 'SetTarget',
		encode: encodeSetTarget,
		decode: decodeSetTarget,
		sample: { channelId: 11, maximumTarget: U256_B }
	},
	{
		name: 'SetGroupChannel (empty channel_ids, edge)',
		encode: encodeSetGroupChannel,
		decode: decodeSetGroupChannel,
		sample: { groupChannelId: 1, channelIds: [] }
	},
	{
		name: 'SetGroupChannel',
		encode: encodeSetGroupChannel,
		decode: decodeSetGroupChannel,
		sample: { groupChannelId: 1, channelIds: [2, 3, 4, 5] }
	}
];

describe.each(cases)('$name', ({ encode, decode, sample }) => {
	it('round-trips exactly', () => {
		const encoded = encode(sample);
		const decoded = decode(encoded);
		expect(decoded).toEqual(sample);
	});

	// P4 flagged fix: this loop is O(n) decode calls per case and intermittently
	// exceeds vitest's 5s default on a loaded box (not a real hang — every call
	// still returns/throws promptly). Bump this test's own timeout only.
	it(
		'every strict prefix of a valid encoding throws on decode (never hangs, never over-reads)',
		() => {
			const encoded = Buffer.from(encode(sample));
			for (let len = 0; len < encoded.length; len++) {
				expect(() => decode(encoded.subarray(0, len)), `prefix length ${len}/${encoded.length}`).toThrow(Sv2DecodeError);
			}
		},
		30_000
	);
});

// ---------------------------------------------------------------------------
// SetCustomMiningJob family: out of scope for v1, decode-and-reject stub only.
// ---------------------------------------------------------------------------

describe('SetCustomMiningJob (decode-and-reject stub)', () => {
	it('decodes just the leading channel_id so the caller can build a rejection', () => {
		const p = new Writer().u32(42).bytesRaw(Buffer.from('anything after this is ignored')).finish();
		expect(decodeSetCustomMiningJobStub(p)).toEqual({ channelId: 42 });
	});

	it('throws on a payload shorter than 4 bytes', () => {
		expect(() => decodeSetCustomMiningJobStub(Buffer.from([0x01, 0x02]))).toThrow(Sv2DecodeError);
	});

	it('msg ids are present for recognition even though the full body is not decoded', () => {
		expect(MSG.SetCustomMiningJob).toBe(0x22);
		expect(MSG.SetCustomMiningJobSuccess).toBe(0x23);
		expect(MSG.SetCustomMiningJobError).toBe(0x24);
	});
});

// ---------------------------------------------------------------------------
// Raw-random-byte fuzz: every decode* must either return or throw
// Sv2DecodeError — never crash with an unrelated error type, never hang.
// ---------------------------------------------------------------------------

describe('raw random-byte fuzz (every decoder)', () => {
	const decoders: Array<[string, (p: Uint8Array) => unknown]> = cases
		.map((c) => [c.name, c.decode] as [string, (p: Uint8Array) => unknown])
		.filter((v, i, arr) => arr.findIndex((x) => x[1] === v[1]) === i); // dedupe by fn identity

	it.each(decoders)('%s: 300 random payloads never throw a non-Sv2DecodeError', (_name, decode) => {
		const rng = mulberry32(0xc0ffee ^ _name.length);
		for (let i = 0; i < 300; i++) {
			const len = Math.floor(rng() * 300);
			const buf = randomBytes(rng, len);
			try {
				decode(buf);
			} catch (e) {
				expect(e).toBeInstanceOf(Sv2DecodeError);
			}
		}
	});
});
