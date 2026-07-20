/**
 * SV2 wire codec: cursor-based Reader/Writer for the primitive serialization
 * types (§2 of docs/SV2-WIRE-REFERENCE.md) plus typed encode/decode for every
 * message in §4. Pure byte math — no I/O, no crypto, no framing (that's
 * frames.ts). Every read is bounds-checked; truncated or malformed input
 * throws Sv2DecodeError rather than over-reading or hanging, mirroring the
 * "never crash the app on a bad peer" rule for the rest of the mining engine.
 *
 * Conventions (per wire reference §2):
 *  - All multi-byte integers are little-endian.
 *  - U256 fields (targets, hashes, merkle roots) are stored/read as raw
 *    32-byte LE buffers — callers pass/receive the same "internal" byte
 *    order wire.ts already uses elsewhere in the mining engine (reversed
 *    from Core's big-endian display hex). targetToU256LE/u256LEToBigint
 *    convert to/from bigint for target-math callers.
 *  - STR0_255 = U8 length prefix (byte length of the UTF-8 encoding) + raw
 *    bytes, no NUL terminator.
 *  - OPTION[T] = SEQ0_1[T]: a 1-byte count (0 or 1) then, if present, T.
 */

export class Sv2DecodeError extends Error {}

const MAX_U8 = 0xff;
const MAX_U16 = 0xffff;
const MAX_U24 = 0xffffff;
const MAX_U32 = 0xffffffff;
const MAX_U64 = (1n << 64n) - 1n;

function bigintToLE(v: bigint, len: number): Buffer {
	if (v < 0n) throw new Sv2DecodeError(`bigint must be non-negative, got ${v}`);
	const buf = Buffer.alloc(len);
	let x = v;
	for (let i = 0; i < len; i++) {
		buf[i] = Number(x & 0xffn);
		x >>= 8n;
	}
	if (x !== 0n) throw new Sv2DecodeError(`bigint does not fit in ${len} bytes: ${v}`);
	return buf;
}

function leToBigint(buf: Uint8Array): bigint {
	let v = 0n;
	for (let i = buf.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[i]!);
	return v;
}

/** bigint target/hash value -> 32-byte LE encoding, for U256 fields. */
export function targetToU256LE(t: bigint): Uint8Array {
	return bigintToLE(t, 32);
}

/** 32-byte LE U256 field -> bigint (target/hash math). */
export function u256LEToBigint(b: Uint8Array): bigint {
	if (b.length !== 32) throw new Sv2DecodeError(`u256LEToBigint expects 32 bytes, got ${b.length}`);
	return leToBigint(b);
}

// ---------------------------------------------------------------------------
// Message type ids (§4). channel_msg is tracked separately in CHANNEL_MSG —
// see frames.ts isChannelMsg/extensionIdOf for the wire-level bit math
// (extension_type & 0x0001 = channel_msg, & 0xFFFE = extension id).
// ---------------------------------------------------------------------------

export const MSG = {
	SetupConnection: 0x00,
	SetupConnectionSuccess: 0x01,
	SetupConnectionError: 0x02,
	ChannelEndpointChanged: 0x03,
	Reconnect: 0x04,
	OpenStandardMiningChannel: 0x10,
	OpenStandardMiningChannelSuccess: 0x11,
	OpenMiningChannelError: 0x12,
	OpenExtendedMiningChannel: 0x13,
	OpenExtendedMiningChannelSuccess: 0x14,
	NewMiningJob: 0x15,
	UpdateChannel: 0x16,
	UpdateChannelError: 0x17,
	CloseChannel: 0x18,
	SetExtranoncePrefix: 0x19,
	SubmitSharesStandard: 0x1a,
	SubmitSharesExtended: 0x1b,
	SubmitSharesSuccess: 0x1c,
	SubmitSharesError: 0x1d,
	// 0x1e reserved
	NewExtendedMiningJob: 0x1f,
	SetNewPrevHash: 0x20,
	SetTarget: 0x21,
	// SetCustomMiningJob family: only relevant with REQUIRES_WORK_SELECTION,
	// out of scope for v1 (wire ref §4). We recognize the ids so a connection
	// that sends one can be rejected cleanly instead of falling through as
	// "unknown message" — see decodeSetCustomMiningJobStub.
	SetCustomMiningJob: 0x22,
	SetCustomMiningJobSuccess: 0x23,
	SetCustomMiningJobError: 0x24,
	SetGroupChannel: 0x25,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/** Message types that carry the channel_msg bit set (extension_type LSB = 1). */
export const CHANNEL_MSG: ReadonlySet<number> = new Set<number>([
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
	MSG.SetTarget,
	MSG.SetCustomMiningJob,
	MSG.SetCustomMiningJobSuccess,
	MSG.SetCustomMiningJobError,
]);

// ---------------------------------------------------------------------------
// Writer / Reader
// ---------------------------------------------------------------------------

export class Writer {
	private chunks: Buffer[] = [];

	private push(b: Buffer): this {
		this.chunks.push(b);
		return this;
	}

	u8(n: number): this {
		if (!Number.isInteger(n) || n < 0 || n > MAX_U8) throw new Sv2DecodeError(`u8 out of range: ${n}`);
		const b = Buffer.alloc(1);
		b.writeUInt8(n, 0);
		return this.push(b);
	}

	u16(n: number): this {
		if (!Number.isInteger(n) || n < 0 || n > MAX_U16) throw new Sv2DecodeError(`u16 out of range: ${n}`);
		const b = Buffer.alloc(2);
		b.writeUInt16LE(n, 0);
		return this.push(b);
	}

	u24(n: number): this {
		if (!Number.isInteger(n) || n < 0 || n > MAX_U24) throw new Sv2DecodeError(`u24 out of range: ${n}`);
		const b = Buffer.alloc(3);
		b.writeUIntLE(n, 0, 3);
		return this.push(b);
	}

	u32(n: number): this {
		if (!Number.isInteger(n) || n < 0 || n > MAX_U32) throw new Sv2DecodeError(`u32 out of range: ${n}`);
		const b = Buffer.alloc(4);
		b.writeUInt32LE(n, 0);
		return this.push(b);
	}

	u64(n: bigint): this {
		if (typeof n !== 'bigint' || n < 0n || n > MAX_U64) throw new Sv2DecodeError(`u64 out of range: ${n}`);
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(n, 0);
		return this.push(b);
	}

	f32(n: number): this {
		if (typeof n !== 'number' || !Number.isFinite(n)) throw new Sv2DecodeError(`f32 must be finite: ${n}`);
		const b = Buffer.alloc(4);
		b.writeFloatLE(n, 0);
		return this.push(b);
	}

	bool(v: boolean): this {
		return this.u8(v ? 1 : 0);
	}

	/** Raw bytes, no length prefix (caller-managed length, e.g. fixed-size fields). */
	bytesRaw(b: Uint8Array): this {
		return this.push(Buffer.from(b));
	}

	/** U256: 32-byte LE. Uint8Array input must already be 32 bytes. */
	u256(v: Uint8Array | bigint): this {
		if (typeof v === 'bigint') return this.push(bigintToLE(v, 32));
		if (v.length !== 32) throw new Sv2DecodeError(`u256 must be 32 bytes, got ${v.length}`);
		return this.push(Buffer.from(v));
	}

	str0_255(s: string): this {
		const b = Buffer.from(s, 'utf8');
		if (b.length > 255) throw new Sv2DecodeError(`str0_255 too long: ${b.length} bytes`);
		this.u8(b.length);
		return this.push(b);
	}

	private lenPrefixed(b: Uint8Array, max: number, lenBytes: 1 | 2): this {
		if (b.length > max) throw new Sv2DecodeError(`bytes field too long: ${b.length} > ${max}`);
		if (lenBytes === 1) this.u8(b.length);
		else this.u16(b.length);
		return this.push(Buffer.from(b));
	}

	b0_32(b: Uint8Array): this {
		return this.lenPrefixed(b, 32, 1);
	}

	b0_255(b: Uint8Array): this {
		return this.lenPrefixed(b, 255, 1);
	}

	b0_64k(b: Uint8Array): this {
		return this.lenPrefixed(b, 65535, 2);
	}

	/** OPTION[U32] = SEQ0_1[U32]: 1-byte count (0/1) then the value if present. */
	optU32(v: number | null): this {
		if (v === null) return this.u8(0);
		this.u8(1);
		return this.u32(v);
	}

	/** SEQ0_255[U256]: U8 count then n*32 bytes. */
	seqU256(items: Uint8Array[]): this {
		if (items.length > 255) throw new Sv2DecodeError(`seqU256 too many items: ${items.length}`);
		this.u8(items.length);
		for (const it of items) this.u256(it);
		return this;
	}

	/** SEQ0_64K[U32]: U16 LE count then n*4 bytes. */
	seqU32_64k(items: number[]): this {
		if (items.length > 65535) throw new Sv2DecodeError(`seqU32_64k too many items: ${items.length}`);
		this.u16(items.length);
		for (const it of items) this.u32(it);
		return this;
	}

	finish(): Uint8Array {
		return Buffer.concat(this.chunks);
	}
}

export class Reader {
	private buf: Buffer;
	private pos = 0;

	constructor(buf: Uint8Array) {
		this.buf = Buffer.from(buf);
	}

	private need(n: number): void {
		if (this.pos + n > this.buf.length) {
			throw new Sv2DecodeError(`truncated: need ${n} bytes at pos ${this.pos}, have ${this.buf.length - this.pos}`);
		}
	}

	u8(): number {
		this.need(1);
		const v = this.buf.readUInt8(this.pos);
		this.pos += 1;
		return v;
	}

	u16(): number {
		this.need(2);
		const v = this.buf.readUInt16LE(this.pos);
		this.pos += 2;
		return v;
	}

	u24(): number {
		this.need(3);
		const v = this.buf.readUIntLE(this.pos, 3);
		this.pos += 3;
		return v;
	}

	u32(): number {
		this.need(4);
		const v = this.buf.readUInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	u64(): bigint {
		this.need(8);
		const v = this.buf.readBigUInt64LE(this.pos);
		this.pos += 8;
		return v;
	}

	f32(): number {
		this.need(4);
		const v = this.buf.readFloatLE(this.pos);
		this.pos += 4;
		return v;
	}

	bool(): boolean {
		return (this.u8() & 1) === 1;
	}

	/** Raw fixed-size read, caller-managed length. */
	bytesRaw(n: number): Uint8Array {
		this.need(n);
		const v = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
		this.pos += n;
		return v;
	}

	u256(): Uint8Array {
		return this.bytesRaw(32);
	}

	str0_255(): string {
		const len = this.u8();
		this.need(len);
		const v = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
		this.pos += len;
		return v;
	}

	private bytesLenPrefixed(lenBytes: 1 | 2, max: number): Uint8Array {
		const len = lenBytes === 1 ? this.u8() : this.u16();
		if (len > max) throw new Sv2DecodeError(`length prefix exceeds max: ${len} > ${max}`);
		return this.bytesRaw(len);
	}

	b0_32(): Uint8Array {
		return this.bytesLenPrefixed(1, 32);
	}

	b0_255(): Uint8Array {
		return this.bytesLenPrefixed(1, 255);
	}

	b0_64k(): Uint8Array {
		return this.bytesLenPrefixed(2, 65535);
	}

	optU32(): number | null {
		const present = this.u8();
		if (present === 0) return null;
		if (present !== 1) throw new Sv2DecodeError(`invalid OPTION count byte: ${present}`);
		return this.u32();
	}

	seqU256(): Uint8Array[] {
		const n = this.u8();
		const out: Uint8Array[] = [];
		for (let i = 0; i < n; i++) out.push(this.u256());
		return out;
	}

	seqU32_64k(): number[] {
		const n = this.u16();
		const out: number[] = [];
		for (let i = 0; i < n; i++) out.push(this.u32());
		return out;
	}

	rest(): Uint8Array {
		const v = Buffer.from(this.buf.subarray(this.pos));
		this.pos = this.buf.length;
		return v;
	}

	get eof(): boolean {
		return this.pos >= this.buf.length;
	}
}

// ---------------------------------------------------------------------------
// Common messages (§4)
// ---------------------------------------------------------------------------

export interface SetupConnection {
	protocol: number;
	minVersion: number;
	maxVersion: number;
	flags: number;
	endpointHost: string;
	endpointPort: number;
	vendor: string;
	hardwareVersion: string;
	firmware: string;
	deviceId: string;
}

export function encodeSetupConnection(m: SetupConnection): Uint8Array {
	return new Writer()
		.u8(m.protocol)
		.u16(m.minVersion)
		.u16(m.maxVersion)
		.u32(m.flags)
		.str0_255(m.endpointHost)
		.u16(m.endpointPort)
		.str0_255(m.vendor)
		.str0_255(m.hardwareVersion)
		.str0_255(m.firmware)
		.str0_255(m.deviceId)
		.finish();
}

export function decodeSetupConnection(p: Uint8Array): SetupConnection {
	const r = new Reader(p);
	return {
		protocol: r.u8(),
		minVersion: r.u16(),
		maxVersion: r.u16(),
		flags: r.u32(),
		endpointHost: r.str0_255(),
		endpointPort: r.u16(),
		vendor: r.str0_255(),
		hardwareVersion: r.str0_255(),
		firmware: r.str0_255(),
		deviceId: r.str0_255()
	};
}

export interface SetupConnectionSuccess {
	usedVersion: number;
	flags: number;
}

export function encodeSetupConnectionSuccess(m: SetupConnectionSuccess): Uint8Array {
	return new Writer().u16(m.usedVersion).u32(m.flags).finish();
}

export function decodeSetupConnectionSuccess(p: Uint8Array): SetupConnectionSuccess {
	const r = new Reader(p);
	return { usedVersion: r.u16(), flags: r.u32() };
}

export interface SetupConnectionError {
	flags: number;
	errorCode: string;
}

export function encodeSetupConnectionError(m: SetupConnectionError): Uint8Array {
	return new Writer().u32(m.flags).str0_255(m.errorCode).finish();
}

export function decodeSetupConnectionError(p: Uint8Array): SetupConnectionError {
	const r = new Reader(p);
	return { flags: r.u32(), errorCode: r.str0_255() };
}

export interface ChannelEndpointChanged {
	channelId: number;
}

export function encodeChannelEndpointChanged(m: ChannelEndpointChanged): Uint8Array {
	return new Writer().u32(m.channelId).finish();
}

export function decodeChannelEndpointChanged(p: Uint8Array): ChannelEndpointChanged {
	const r = new Reader(p);
	return { channelId: r.u32() };
}

export interface Reconnect {
	newHost: string;
	newPort: number;
}

export function encodeReconnect(m: Reconnect): Uint8Array {
	return new Writer().str0_255(m.newHost).u16(m.newPort).finish();
}

export function decodeReconnect(p: Uint8Array): Reconnect {
	const r = new Reader(p);
	return { newHost: r.str0_255(), newPort: r.u16() };
}

// ---------------------------------------------------------------------------
// Mining messages (§4)
// ---------------------------------------------------------------------------

export interface OpenStandardMiningChannel {
	requestId: number;
	userIdentity: string;
	nominalHashRate: number;
	maxTarget: Uint8Array;
}

export function encodeOpenStandardMiningChannel(m: OpenStandardMiningChannel): Uint8Array {
	return new Writer().u32(m.requestId).str0_255(m.userIdentity).f32(m.nominalHashRate).u256(m.maxTarget).finish();
}

export function decodeOpenStandardMiningChannel(p: Uint8Array): OpenStandardMiningChannel {
	const r = new Reader(p);
	return {
		requestId: r.u32(),
		userIdentity: r.str0_255(),
		nominalHashRate: r.f32(),
		maxTarget: r.u256()
	};
}

export interface OpenStandardMiningChannelSuccess {
	requestId: number;
	channelId: number;
	target: Uint8Array;
	extranoncePrefix: Uint8Array;
	groupChannelId: number;
}

export function encodeOpenStandardMiningChannelSuccess(m: OpenStandardMiningChannelSuccess): Uint8Array {
	return new Writer()
		.u32(m.requestId)
		.u32(m.channelId)
		.u256(m.target)
		.b0_32(m.extranoncePrefix)
		.u32(m.groupChannelId)
		.finish();
}

export function decodeOpenStandardMiningChannelSuccess(p: Uint8Array): OpenStandardMiningChannelSuccess {
	const r = new Reader(p);
	return {
		requestId: r.u32(),
		channelId: r.u32(),
		target: r.u256(),
		extranoncePrefix: r.b0_32(),
		groupChannelId: r.u32()
	};
}

export interface OpenMiningChannelError {
	requestId: number;
	errorCode: string;
}

export function encodeOpenMiningChannelError(m: OpenMiningChannelError): Uint8Array {
	return new Writer().u32(m.requestId).str0_255(m.errorCode).finish();
}

export function decodeOpenMiningChannelError(p: Uint8Array): OpenMiningChannelError {
	const r = new Reader(p);
	return { requestId: r.u32(), errorCode: r.str0_255() };
}

export interface OpenExtendedMiningChannel extends OpenStandardMiningChannel {
	minExtranonceSize: number;
}

export function encodeOpenExtendedMiningChannel(m: OpenExtendedMiningChannel): Uint8Array {
	return new Writer()
		.u32(m.requestId)
		.str0_255(m.userIdentity)
		.f32(m.nominalHashRate)
		.u256(m.maxTarget)
		.u16(m.minExtranonceSize)
		.finish();
}

export function decodeOpenExtendedMiningChannel(p: Uint8Array): OpenExtendedMiningChannel {
	const r = new Reader(p);
	return {
		requestId: r.u32(),
		userIdentity: r.str0_255(),
		nominalHashRate: r.f32(),
		maxTarget: r.u256(),
		minExtranonceSize: r.u16()
	};
}

export interface OpenExtendedMiningChannelSuccess {
	requestId: number;
	channelId: number;
	target: Uint8Array;
	extranonceSize: number;
	extranoncePrefix: Uint8Array;
	groupChannelId: number;
}

export function encodeOpenExtendedMiningChannelSuccess(m: OpenExtendedMiningChannelSuccess): Uint8Array {
	return new Writer()
		.u32(m.requestId)
		.u32(m.channelId)
		.u256(m.target)
		.u16(m.extranonceSize)
		.b0_32(m.extranoncePrefix)
		.u32(m.groupChannelId)
		.finish();
}

export function decodeOpenExtendedMiningChannelSuccess(p: Uint8Array): OpenExtendedMiningChannelSuccess {
	const r = new Reader(p);
	return {
		requestId: r.u32(),
		channelId: r.u32(),
		target: r.u256(),
		extranonceSize: r.u16(),
		extranoncePrefix: r.b0_32(),
		groupChannelId: r.u32()
	};
}

export interface UpdateChannel {
	channelId: number;
	nominalHashRate: number;
	maximumTarget: Uint8Array;
}

export function encodeUpdateChannel(m: UpdateChannel): Uint8Array {
	return new Writer().u32(m.channelId).f32(m.nominalHashRate).u256(m.maximumTarget).finish();
}

export function decodeUpdateChannel(p: Uint8Array): UpdateChannel {
	const r = new Reader(p);
	return { channelId: r.u32(), nominalHashRate: r.f32(), maximumTarget: r.u256() };
}

export interface UpdateChannelError {
	channelId: number;
	errorCode: string;
}

export function encodeUpdateChannelError(m: UpdateChannelError): Uint8Array {
	return new Writer().u32(m.channelId).str0_255(m.errorCode).finish();
}

export function decodeUpdateChannelError(p: Uint8Array): UpdateChannelError {
	const r = new Reader(p);
	return { channelId: r.u32(), errorCode: r.str0_255() };
}

export interface CloseChannel {
	channelId: number;
	reasonCode: string;
}

export function encodeCloseChannel(m: CloseChannel): Uint8Array {
	return new Writer().u32(m.channelId).str0_255(m.reasonCode).finish();
}

export function decodeCloseChannel(p: Uint8Array): CloseChannel {
	const r = new Reader(p);
	return { channelId: r.u32(), reasonCode: r.str0_255() };
}

export interface SetExtranoncePrefix {
	channelId: number;
	extranoncePrefix: Uint8Array;
}

export function encodeSetExtranoncePrefix(m: SetExtranoncePrefix): Uint8Array {
	return new Writer().u32(m.channelId).b0_32(m.extranoncePrefix).finish();
}

export function decodeSetExtranoncePrefix(p: Uint8Array): SetExtranoncePrefix {
	const r = new Reader(p);
	return { channelId: r.u32(), extranoncePrefix: r.b0_32() };
}

export interface SubmitSharesStandard {
	channelId: number;
	sequenceNumber: number;
	jobId: number;
	nonce: number;
	ntime: number;
	version: number;
}

export function encodeSubmitSharesStandard(m: SubmitSharesStandard): Uint8Array {
	return new Writer()
		.u32(m.channelId)
		.u32(m.sequenceNumber)
		.u32(m.jobId)
		.u32(m.nonce)
		.u32(m.ntime)
		.u32(m.version)
		.finish();
}

export function decodeSubmitSharesStandard(p: Uint8Array): SubmitSharesStandard {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		sequenceNumber: r.u32(),
		jobId: r.u32(),
		nonce: r.u32(),
		ntime: r.u32(),
		version: r.u32()
	};
}

export interface SubmitSharesExtended extends SubmitSharesStandard {
	extranonce: Uint8Array;
}

export function encodeSubmitSharesExtended(m: SubmitSharesExtended): Uint8Array {
	return new Writer()
		.u32(m.channelId)
		.u32(m.sequenceNumber)
		.u32(m.jobId)
		.u32(m.nonce)
		.u32(m.ntime)
		.u32(m.version)
		.b0_32(m.extranonce)
		.finish();
}

export function decodeSubmitSharesExtended(p: Uint8Array): SubmitSharesExtended {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		sequenceNumber: r.u32(),
		jobId: r.u32(),
		nonce: r.u32(),
		ntime: r.u32(),
		version: r.u32(),
		extranonce: r.b0_32()
	};
}

export interface SubmitSharesSuccess {
	channelId: number;
	lastSequenceNumber: number;
	newSubmitsAcceptedCount: number;
	newSharesSum: bigint;
}

export function encodeSubmitSharesSuccess(m: SubmitSharesSuccess): Uint8Array {
	return new Writer()
		.u32(m.channelId)
		.u32(m.lastSequenceNumber)
		.u32(m.newSubmitsAcceptedCount)
		.u64(m.newSharesSum)
		.finish();
}

export function decodeSubmitSharesSuccess(p: Uint8Array): SubmitSharesSuccess {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		lastSequenceNumber: r.u32(),
		newSubmitsAcceptedCount: r.u32(),
		newSharesSum: r.u64()
	};
}

export interface SubmitSharesError {
	channelId: number;
	sequenceNumber: number;
	errorCode: string;
}

export function encodeSubmitSharesError(m: SubmitSharesError): Uint8Array {
	return new Writer().u32(m.channelId).u32(m.sequenceNumber).str0_255(m.errorCode).finish();
}

export function decodeSubmitSharesError(p: Uint8Array): SubmitSharesError {
	const r = new Reader(p);
	return { channelId: r.u32(), sequenceNumber: r.u32(), errorCode: r.str0_255() };
}

export interface NewMiningJob {
	channelId: number;
	jobId: number;
	minNtime: number | null;
	version: number;
	merkleRoot: Uint8Array;
}

export function encodeNewMiningJob(m: NewMiningJob): Uint8Array {
	return new Writer().u32(m.channelId).u32(m.jobId).optU32(m.minNtime).u32(m.version).u256(m.merkleRoot).finish();
}

export function decodeNewMiningJob(p: Uint8Array): NewMiningJob {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		jobId: r.u32(),
		minNtime: r.optU32(),
		version: r.u32(),
		merkleRoot: r.u256()
	};
}

export interface NewExtendedMiningJob {
	channelId: number;
	jobId: number;
	minNtime: number | null;
	version: number;
	versionRollingAllowed: boolean;
	merklePath: Uint8Array[];
	coinbaseTxPrefix: Uint8Array;
	coinbaseTxSuffix: Uint8Array;
}

export function encodeNewExtendedMiningJob(m: NewExtendedMiningJob): Uint8Array {
	return new Writer()
		.u32(m.channelId)
		.u32(m.jobId)
		.optU32(m.minNtime)
		.u32(m.version)
		.bool(m.versionRollingAllowed)
		.seqU256(m.merklePath)
		.b0_64k(m.coinbaseTxPrefix)
		.b0_64k(m.coinbaseTxSuffix)
		.finish();
}

export function decodeNewExtendedMiningJob(p: Uint8Array): NewExtendedMiningJob {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		jobId: r.u32(),
		minNtime: r.optU32(),
		version: r.u32(),
		versionRollingAllowed: r.bool(),
		merklePath: r.seqU256(),
		coinbaseTxPrefix: r.b0_64k(),
		coinbaseTxSuffix: r.b0_64k()
	};
}

export interface SetNewPrevHash {
	channelId: number;
	jobId: number;
	prevHash: Uint8Array;
	minNtime: number;
	nbits: number;
}

export function encodeSetNewPrevHash(m: SetNewPrevHash): Uint8Array {
	return new Writer().u32(m.channelId).u32(m.jobId).u256(m.prevHash).u32(m.minNtime).u32(m.nbits).finish();
}

export function decodeSetNewPrevHash(p: Uint8Array): SetNewPrevHash {
	const r = new Reader(p);
	return {
		channelId: r.u32(),
		jobId: r.u32(),
		prevHash: r.u256(),
		minNtime: r.u32(),
		nbits: r.u32()
	};
}

export interface SetTarget {
	channelId: number;
	maximumTarget: Uint8Array;
}

export function encodeSetTarget(m: SetTarget): Uint8Array {
	return new Writer().u32(m.channelId).u256(m.maximumTarget).finish();
}

export function decodeSetTarget(p: Uint8Array): SetTarget {
	const r = new Reader(p);
	return { channelId: r.u32(), maximumTarget: r.u256() };
}

export interface SetGroupChannel {
	groupChannelId: number;
	channelIds: number[];
}

export function encodeSetGroupChannel(m: SetGroupChannel): Uint8Array {
	return new Writer().u32(m.groupChannelId).seqU32_64k(m.channelIds).finish();
}

export function decodeSetGroupChannel(p: Uint8Array): SetGroupChannel {
	const r = new Reader(p);
	return { groupChannelId: r.u32(), channelIds: r.seqU32_64k() };
}

/**
 * SetCustomMiningJob family (0x22-0x24): only relevant to connections that
 * negotiate REQUIRES_WORK_SELECTION, which we never advertise support for
 * (wire ref §4/§5). We don't implement the full (unspecified-here) field
 * layout — a connection that sends one is out of protocol for v1. This stub
 * decodes just enough (channel_id, the first field of every variant per the
 * wire ref's general channel_msg=1 convention) to build an UpdateChannel-style
 * error/rejection response without guessing at the rest of the payload.
 */
export interface SetCustomMiningJobStub {
	channelId: number;
}

export function decodeSetCustomMiningJobStub(p: Uint8Array): SetCustomMiningJobStub {
	const r = new Reader(p);
	return { channelId: r.u32() };
}
