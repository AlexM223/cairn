/**
 * Sv2TestClient — mock Stratum V2 mining client, test-only (plan §g). Real
 * loopback socket, real Noise NX initiator handshake (noise.ts's
 * NoiseInitiator — no shortcuts), real framing (frames.ts's
 * EncryptedFrameReader/sealFrame), real codec (codec.ts). Used by
 * sv2Server.test.ts and any later e2e/regtest suite.
 *
 * Never a second implementation of the wire format: this module imports the
 * exact same crypto.ts/codec.ts/frames.ts/noise.ts the server uses, so a test
 * passing here is a real interop proof, not a self-consistency check against a
 * parallel encoder.
 */
import type { Socket } from 'node:net';
import { applyBranches, buildHeader, headerHashDisplay, internalToDisplay, sha256d } from '../wire';
import {
	MSG,
	decodeOpenExtendedMiningChannelSuccess,
	decodeOpenMiningChannelError,
	decodeOpenStandardMiningChannelSuccess,
	decodeNewExtendedMiningJob,
	decodeNewMiningJob,
	decodeSetNewPrevHash,
	decodeSetTarget,
	decodeSetupConnectionError,
	decodeSetupConnectionSuccess,
	decodeSubmitSharesError,
	decodeSubmitSharesSuccess,
	decodeUpdateChannelError,
	encodeOpenExtendedMiningChannel,
	encodeOpenStandardMiningChannel,
	encodeSetupConnection,
	encodeSubmitSharesExtended,
	encodeSubmitSharesStandard,
	encodeUpdateChannel,
	targetToU256LE,
	u256LEToBigint,
	type NewExtendedMiningJob,
	type NewMiningJob,
	type SetNewPrevHash,
	type SetTarget,
	type SetupConnectionSuccess,
	type UpdateChannelError
} from './codec';
import { ACT2_LEN, NoiseInitiator } from './noise';
import { EncryptedFrameReader, sealFrame, type Frame } from './frames';

const DEFAULT_WAIT_MS = 5_000;
const MAX_TARGET = (1n << 256n) - 1n;

export class Sv2TestClientError extends Error {}

export interface OpenChannelResult {
	readonly channelId: number;
	readonly extranoncePrefix: Uint8Array;
	/** 0 for a standard channel (the server owns the full 8-byte zone). */
	readonly extranonceSize: number;
	readonly target: Uint8Array; // 32-byte LE, as carried on the wire
}

export type JobAnnouncement =
	| { readonly kind: 'extended'; readonly msg: NewExtendedMiningJob }
	| { readonly kind: 'standard'; readonly msg: NewMiningJob };

export type SubmitResult = { readonly ok: true } | { readonly ok: false; readonly errorCode: string };

/** FIFO mailbox: values pushed before anyone awaits are queued; awaiters queue too. */
class Mailbox<T> {
	private readonly queue: T[] = [];
	private readonly waiters: { resolve: (v: T) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

	push(v: T): void {
		const w = this.waiters.shift();
		if (w) {
			clearTimeout(w.timer);
			w.resolve(v);
		} else {
			this.queue.push(v);
		}
	}

	next(timeoutMs = DEFAULT_WAIT_MS): Promise<T> {
		const v = this.queue.shift();
		if (v !== undefined) return Promise.resolve(v);
		return new Promise<T>((resolve, reject) => {
			const entry = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const idx = this.waiters.indexOf(entry);
					if (idx >= 0) this.waiters.splice(idx, 1);
					reject(new Sv2TestClientError(`Mailbox.next timed out after ${timeoutMs}ms`));
				}, timeoutMs)
			};
			this.waiters.push(entry);
		});
	}
}

/** Minimal Noise NX initiator + mining client, driving a real net.Socket. */
export class Sv2TestClient {
	private readonly initiator: NoiseInitiator;
	private socket: Socket | null = null;
	private sendCipher: { seal(ad: Uint8Array, pt: Uint8Array): Uint8Array } | null = null;
	private frameReader: EncryptedFrameReader | null = null;
	private handshakeBuf = Buffer.alloc(0);
	private nextRequestId = 1;
	private nextSequenceNumber = 1;

	private setupWaiters: { resolve: (m: SetupConnectionSuccess) => void; reject: (e: Error) => void }[] = [];
	private readonly openWaiters = new Map<number, { resolve: (r: OpenChannelResult) => void; reject: (e: Error) => void }>();
	private readonly submitWaiters = new Map<string, (r: SubmitResult) => void>();
	private readonly jobsByChannel = new Map<number, Mailbox<JobAnnouncement>>();
	private readonly prevHashByChannel = new Map<number, Mailbox<SetNewPrevHash>>();
	private readonly setTargetByChannel = new Map<number, Mailbox<SetTarget>>();
	private readonly updateChannelErrorByChannel = new Map<number, Mailbox<UpdateChannelError>>();

	/** Raw log of every decoded inbound frame — useful for assertions/debugging. */
	readonly received: Frame[] = [];

	constructor(private readonly authorityXonly32: Uint8Array) {
		this.initiator = new NoiseInitiator({ authorityXonly32 });
	}

	/** Run the Noise handshake (Act1 -> Act2) over an already-connected socket. */
	connect(socket: Socket): Promise<void> {
		this.socket = socket;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (e: Error) => {
				if (settled) return;
				settled = true;
				socket.removeListener('data', onHandshakeData);
				reject(e);
			};
			const onHandshakeData = (chunk: Buffer): void => {
				try {
					this.handshakeBuf = Buffer.concat([this.handshakeBuf, chunk]);
					if (this.handshakeBuf.length < ACT2_LEN) return;
					const act2 = this.handshakeBuf.subarray(0, ACT2_LEN);
					const rest = Buffer.from(this.handshakeBuf.subarray(ACT2_LEN));
					this.initiator.readAct2(act2);
					const { recv, send } = this.initiator.split();
					this.sendCipher = send;
					this.frameReader = new EncryptedFrameReader(recv);
					socket.removeListener('data', onHandshakeData);
					socket.on('data', (c: Buffer) => this.onData(c));
					settled = true;
					resolve();
					if (rest.length > 0) this.onData(rest);
				} catch (err) {
					fail(err instanceof Error ? err : new Error(String(err)));
				}
			};
			socket.on('data', onHandshakeData);
			socket.once('error', fail);
			const act1 = this.initiator.writeAct1();
			socket.write(Buffer.from(act1));
		});
	}

	private onData(chunk: Buffer): void {
		if (!this.frameReader) return;
		try {
			this.frameReader.push(chunk);
			for (const frame of this.frameReader.drain()) {
				this.received.push(frame);
				this.handleFrame(frame);
			}
		} catch {
			// A bad decrypt/decode after the handshake means the session is dead;
			// let pending waiters time out rather than crash the test process.
			this.socket?.destroy();
		}
	}

	private handleFrame(frame: Frame): void {
		switch (frame.msgType) {
			case MSG.SetupConnectionSuccess: {
				const m = decodeSetupConnectionSuccess(frame.payload);
				this.setupWaiters.shift()?.resolve(m);
				return;
			}
			case MSG.SetupConnectionError: {
				const m = decodeSetupConnectionError(frame.payload);
				this.setupWaiters.shift()?.reject(new Sv2TestClientError(`SetupConnection.Error: ${m.errorCode}`));
				return;
			}
			case MSG.OpenStandardMiningChannelSuccess: {
				const m = decodeOpenStandardMiningChannelSuccess(frame.payload);
				this.openWaiters.get(m.requestId)?.resolve({
					channelId: m.channelId,
					extranoncePrefix: m.extranoncePrefix,
					extranonceSize: 0,
					target: m.target
				});
				this.openWaiters.delete(m.requestId);
				return;
			}
			case MSG.OpenExtendedMiningChannelSuccess: {
				const m = decodeOpenExtendedMiningChannelSuccess(frame.payload);
				this.openWaiters.get(m.requestId)?.resolve({
					channelId: m.channelId,
					extranoncePrefix: m.extranoncePrefix,
					extranonceSize: m.extranonceSize,
					target: m.target
				});
				this.openWaiters.delete(m.requestId);
				return;
			}
			case MSG.OpenMiningChannelError: {
				const m = decodeOpenMiningChannelError(frame.payload);
				this.openWaiters.get(m.requestId)?.reject(new Sv2TestClientError(`OpenMiningChannel.Error: ${m.errorCode}`));
				this.openWaiters.delete(m.requestId);
				return;
			}
			case MSG.NewExtendedMiningJob: {
				const m = decodeNewExtendedMiningJob(frame.payload);
				this.jobMailbox(m.channelId).push({ kind: 'extended', msg: m });
				return;
			}
			case MSG.NewMiningJob: {
				const m = decodeNewMiningJob(frame.payload);
				this.jobMailbox(m.channelId).push({ kind: 'standard', msg: m });
				return;
			}
			case MSG.SetNewPrevHash: {
				const m = decodeSetNewPrevHash(frame.payload);
				this.prevHashMailbox(m.channelId).push(m);
				return;
			}
			case MSG.SetTarget: {
				const m = decodeSetTarget(frame.payload);
				this.setTargetMailbox(m.channelId).push(m);
				return;
			}
			case MSG.UpdateChannelError: {
				const m = decodeUpdateChannelError(frame.payload);
				this.updateChannelErrorMailbox(m.channelId).push(m);
				return;
			}
			case MSG.SubmitSharesSuccess: {
				const m = decodeSubmitSharesSuccess(frame.payload);
				this.resolveSubmit(m.channelId, m.lastSequenceNumber, { ok: true });
				return;
			}
			case MSG.SubmitSharesError: {
				const m = decodeSubmitSharesError(frame.payload);
				this.resolveSubmit(m.channelId, m.sequenceNumber, { ok: false, errorCode: m.errorCode });
				return;
			}
			default:
				return;
		}
	}

	private jobMailbox(channelId: number): Mailbox<JobAnnouncement> {
		let mb = this.jobsByChannel.get(channelId);
		if (!mb) {
			mb = new Mailbox<JobAnnouncement>();
			this.jobsByChannel.set(channelId, mb);
		}
		return mb;
	}

	private prevHashMailbox(channelId: number): Mailbox<SetNewPrevHash> {
		let mb = this.prevHashByChannel.get(channelId);
		if (!mb) {
			mb = new Mailbox<SetNewPrevHash>();
			this.prevHashByChannel.set(channelId, mb);
		}
		return mb;
	}

	private setTargetMailbox(channelId: number): Mailbox<SetTarget> {
		let mb = this.setTargetByChannel.get(channelId);
		if (!mb) {
			mb = new Mailbox<SetTarget>();
			this.setTargetByChannel.set(channelId, mb);
		}
		return mb;
	}

	private updateChannelErrorMailbox(channelId: number): Mailbox<UpdateChannelError> {
		let mb = this.updateChannelErrorByChannel.get(channelId);
		if (!mb) {
			mb = new Mailbox<UpdateChannelError>();
			this.updateChannelErrorByChannel.set(channelId, mb);
		}
		return mb;
	}

	private resolveSubmit(channelId: number, sequenceNumber: number, r: SubmitResult): void {
		const key = `${channelId}:${sequenceNumber}`;
		const resolve = this.submitWaiters.get(key);
		if (resolve) {
			resolve(r);
			this.submitWaiters.delete(key);
		}
	}

	private send(msgType: number, channelMsg: boolean, payload: Uint8Array): void {
		if (!this.sendCipher || !this.socket || this.socket.destroyed) {
			throw new Sv2TestClientError('Sv2TestClient.send called before a completed handshake');
		}
		const bytes = sealFrame(this.sendCipher, msgType, channelMsg, payload);
		this.socket.write(Buffer.from(bytes));
	}

	// ------------------------------------------------------------- protocol

	setupConnection(flags = 0): Promise<SetupConnectionSuccess> {
		return new Promise<SetupConnectionSuccess>((resolve, reject) => {
			this.setupWaiters.push({ resolve, reject });
			this.send(
				MSG.SetupConnection,
				false,
				encodeSetupConnection({
					protocol: 0,
					minVersion: 2,
					maxVersion: 2,
					flags,
					endpointHost: '127.0.0.1',
					endpointPort: 0,
					vendor: 'heartwood-sv2-test-client',
					hardwareVersion: 'test',
					firmware: 'test',
					deviceId: 'sv2-test-client'
				})
			);
		});
	}

	openExtendedChannel(
		userIdentity: string,
		opts: { minExtranonceSize?: number; nominalHashRate?: number; maxTarget?: Uint8Array } = {}
	): Promise<OpenChannelResult> {
		const requestId = this.nextRequestId++;
		return new Promise<OpenChannelResult>((resolve, reject) => {
			this.openWaiters.set(requestId, { resolve, reject });
			this.send(
				MSG.OpenExtendedMiningChannel,
				false,
				encodeOpenExtendedMiningChannel({
					requestId,
					userIdentity,
					nominalHashRate: opts.nominalHashRate ?? 1_000_000,
					maxTarget: opts.maxTarget ?? targetToU256LE(MAX_TARGET),
					minExtranonceSize: opts.minExtranonceSize ?? 4
				})
			);
		});
	}

	openStandardChannel(
		userIdentity: string,
		opts: { nominalHashRate?: number; maxTarget?: Uint8Array } = {}
	): Promise<OpenChannelResult> {
		const requestId = this.nextRequestId++;
		return new Promise<OpenChannelResult>((resolve, reject) => {
			this.openWaiters.set(requestId, { resolve, reject });
			this.send(
				MSG.OpenStandardMiningChannel,
				false,
				encodeOpenStandardMiningChannel({
					requestId,
					userIdentity,
					nominalHashRate: opts.nominalHashRate ?? 1_000_000,
					maxTarget: opts.maxTarget ?? targetToU256LE(MAX_TARGET)
				})
			);
		});
	}

	/** Wait for the next job announced on `channelId` (queued if it already arrived). */
	awaitJob(channelId: number, timeoutMs?: number): Promise<JobAnnouncement> {
		return this.jobMailbox(channelId).next(timeoutMs);
	}

	/** Wait for the next SetNewPrevHash on `channelId`. */
	awaitPrevHash(channelId: number, timeoutMs?: number): Promise<SetNewPrevHash> {
		return this.prevHashMailbox(channelId).next(timeoutMs);
	}

	/** Wait for the next SetTarget on `channelId` (cairn-qfez8.28 vardiff retarget / UpdateChannel honor). */
	awaitSetTarget(channelId: number, timeoutMs?: number): Promise<SetTarget> {
		return this.setTargetMailbox(channelId).next(timeoutMs);
	}

	/** Wait for the next UpdateChannel.Error on `channelId`. */
	awaitUpdateChannelError(channelId: number, timeoutMs?: number): Promise<UpdateChannelError> {
		return this.updateChannelErrorMailbox(channelId).next(timeoutMs);
	}

	/**
	 * UpdateChannel (wire ref §4, cairn-qfez8.28): client-declared nominal
	 * hashrate + a self-imposed `maximum_target` ceiling. No direct ack in the
	 * happy path — the server replies with `SetTarget` ONLY when it actually
	 * changes the channel target (honoring a smaller `maximum_target`, spec
	 * MUST), or `UpdateChannel.Error` on invalid input. Use `awaitSetTarget`/
	 * `awaitUpdateChannelError` to observe the outcome.
	 */
	updateChannel(a: { channelId: number; nominalHashRate?: number; maximumTarget?: Uint8Array }): void {
		this.send(
			MSG.UpdateChannel,
			true,
			encodeUpdateChannel({
				channelId: a.channelId,
				nominalHashRate: a.nominalHashRate ?? 1_000_000,
				maximumTarget: a.maximumTarget ?? targetToU256LE(MAX_TARGET)
			})
		);
	}

	submitExtended(a: {
		channelId: number;
		jobId: number;
		nonce: number;
		ntime: number;
		version: number;
		extranonce: Uint8Array;
	}): Promise<SubmitResult> {
		const sequenceNumber = this.nextSequenceNumber++;
		return new Promise<SubmitResult>((resolve) => {
			this.submitWaiters.set(`${a.channelId}:${sequenceNumber}`, resolve);
			this.send(
				MSG.SubmitSharesExtended,
				true,
				encodeSubmitSharesExtended({
					channelId: a.channelId,
					sequenceNumber,
					jobId: a.jobId,
					nonce: a.nonce,
					ntime: a.ntime,
					version: a.version,
					extranonce: a.extranonce
				})
			);
		});
	}

	submitStandard(a: {
		channelId: number;
		jobId: number;
		nonce: number;
		ntime: number;
		version: number;
	}): Promise<SubmitResult> {
		const sequenceNumber = this.nextSequenceNumber++;
		return new Promise<SubmitResult>((resolve) => {
			this.submitWaiters.set(`${a.channelId}:${sequenceNumber}`, resolve);
			this.send(
				MSG.SubmitSharesStandard,
				true,
				encodeSubmitSharesStandard({
					channelId: a.channelId,
					sequenceNumber,
					jobId: a.jobId,
					nonce: a.nonce,
					ntime: a.ntime,
					version: a.version
				})
			);
		});
	}

	/** Send arbitrary already-sealed bytes (test hook for malformed-frame/garbage cases). */
	writeRaw(bytes: Uint8Array): void {
		this.socket?.write(Buffer.from(bytes));
	}

	close(): void {
		this.socket?.destroy();
	}
}

// ---------------------------------------------------------------------------
// Grind helper (plan §g `mineOnce`): proves the client-side coinbase
// reconstruction (prefix ‖ extranonce_prefix ‖ extranonce ‖ suffix, merkle
// fold, header assembly) matches the server's — the core interop guarantee.
// Reuses ONLY wire.ts math, exactly like channels.ts does server-side.
// ---------------------------------------------------------------------------

export interface MineParams {
	readonly job: NewExtendedMiningJob;
	readonly prevHash: SetNewPrevHash;
	/** Server-owned bytes from Open*ChannelSuccess.extranoncePrefix. */
	readonly extranoncePrefix: Uint8Array;
	/** Client-owned bytes (length == the negotiated extranonce_size; empty for standard/full-prefix channels). */
	readonly extranonce: Uint8Array;
	/** Share (or solve) target to grind for. */
	readonly target: bigint;
	readonly maxTries?: number;
	/**
	 * Grind at a ROLLED version instead of `job.version` (cairn-qfez8.29 version
	 * rolling e2e coverage). Additive-optional — absent = `job.version` (byte-
	 * identical to before this field existed). Caller is responsible for keeping
	 * it within the BIP320 mask (0x1fffe000) when the channel negotiated rolling.
	 */
	readonly versionOverride?: number;
}

export interface MineResult {
	readonly nonce: number;
	readonly ntime: number;
	readonly version: number;
}

/** Grind coinbase/header/hash exactly as the server would validate it; return
 *  the first nonce whose hash clears `target`, or null if none found within `maxTries`. */
export function mineOnce(p: MineParams): MineResult | null {
	const en = Buffer.concat([Buffer.from(p.extranoncePrefix), Buffer.from(p.extranonce)]);
	const coinbase = Buffer.concat([Buffer.from(p.job.coinbaseTxPrefix), en, Buffer.from(p.job.coinbaseTxSuffix)]);
	const merkleRoot = applyBranches(
		sha256d(coinbase),
		p.job.merklePath.map((b) => Buffer.from(b))
	);
	const prevHashDisplay = internalToDisplay(Buffer.from(p.prevHash.prevHash));
	const ntime = p.prevHash.minNtime;
	const version = p.versionOverride ?? p.job.version;
	const versionHex = hex8(version);
	const ntimeHex = hex8(ntime);
	const nbitsHex = hex8(p.prevHash.nbits);
	const maxTries = p.maxTries ?? 2_000_000;
	for (let nonce = 0; nonce < maxTries; nonce++) {
		const header = buildHeader(versionHex, prevHashDisplay, merkleRoot, ntimeHex, nbitsHex, hex8(nonce));
		const value = BigInt('0x' + headerHashDisplay(header));
		if (value <= p.target) return { nonce, ntime, version };
	}
	return null;
}

/**
 * Standard-channel counterpart of {@link mineOnce}: the server already folded
 * the merkle root (it owns the full 8-byte extranonce zone), so the client
 * only assembles the header and grinds the nonce — no coinbase reconstruction.
 */
export function mineOnceStandard(job: NewMiningJob, prevHash: SetNewPrevHash, target: bigint, maxTries = 2_000_000): MineResult | null {
	const prevHashDisplay = internalToDisplay(Buffer.from(prevHash.prevHash));
	const ntime = prevHash.minNtime;
	const versionHex = hex8(job.version);
	const ntimeHex = hex8(ntime);
	const nbitsHex = hex8(prevHash.nbits);
	for (let nonce = 0; nonce < maxTries; nonce++) {
		const header = buildHeader(versionHex, prevHashDisplay, Buffer.from(job.merkleRoot), ntimeHex, nbitsHex, hex8(nonce));
		const value = BigInt('0x' + headerHashDisplay(header));
		if (value <= target) return { nonce, ntime, version: job.version };
	}
	return null;
}

/** Independently recompute a header's hash value — used to cross-check `mineOnce`'s result
 *  without re-deriving it from the same code path (defense-in-depth for test assertions). */
export function hashValueForMine(p: MineParams, nonce: number): bigint {
	const en = Buffer.concat([Buffer.from(p.extranoncePrefix), Buffer.from(p.extranonce)]);
	const coinbase = Buffer.concat([Buffer.from(p.job.coinbaseTxPrefix), en, Buffer.from(p.job.coinbaseTxSuffix)]);
	const merkleRoot = applyBranches(
		sha256d(coinbase),
		p.job.merklePath.map((b) => Buffer.from(b))
	);
	const prevHashDisplay = internalToDisplay(Buffer.from(p.prevHash.prevHash));
	const header = buildHeader(
		hex8(p.versionOverride ?? p.job.version),
		prevHashDisplay,
		merkleRoot,
		hex8(p.prevHash.minNtime),
		hex8(p.prevHash.nbits),
		hex8(nonce)
	);
	return BigInt('0x' + headerHashDisplay(header));
}

function hex8(n: number): string {
	return (n >>> 0).toString(16).padStart(8, '0');
}

// u256LEToBigint is re-exported for test convenience (targets are LE on the wire).
export { u256LEToBigint };
