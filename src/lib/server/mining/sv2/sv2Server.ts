/**
 * Sv2Server — the native Stratum V2 TCP listener (Phase 4,
 * docs/SV2-IMPLEMENTATION-PLAN.md §a.7/§b/§e.3). Implements the SAME
 * listener contract shape as StratumServer (stratum.ts) so MiningPool treats
 * it identically to `server`/`asicServer` — a third listener sharing the same
 * job pipeline, AuthProvider, and share/solve/reject sinks.
 *
 * Per-connection flow:
 *   TCP accept -> Noise responder handshake (Act1/Act2, wire ref §3) with a
 *   handshake timeout + pre-auth byte cap -> encrypted transport
 *   (EncryptedFrameReader) -> SetupConnection -> Open*MiningChannel (auth via
 *   AuthProvider) -> announce the current job immediately -> SubmitShares* ->
 *   validateSubmit (channels.ts) -> SubmitShares.Success/Error, onShare/
 *   onSolve/onReject.
 *
 * Every handler is wrapped so a malformed frame, a bad decrypt, or any other
 * parser throw NEVER escapes into the socket 'data' listener chain — it
 * terminates only that connection (mirrors stratum.ts's "never crash the
 * app" rule). All consensus/byte-order math is inherited from wire.ts/job.ts
 * via channels.ts — nothing is reimplemented here.
 *
 * Deviation from the plan's default `blockPolicyShift: 4` in Sv2ServerOptions:
 * the caller (MiningPool, mirroring its V1 config) always passes an explicit
 * `blockPolicyShift`, and this module's own default is 0 (production —
 * requires clearing the real network target), matching channels.ts's
 * `validateSubmit` default and V1's engine-level `BLOCK_POLICY_SHIFT = 0`
 * (mining/index.ts). Only regtest/test callers opt into a shift explicitly.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { validateAddressEncodable } from '../address';
import type {
	AuthProvider,
	BuiltJob,
	ConnectionInfo,
	Network,
	RejectEvent,
	ShareEvent,
	SolveEvent
} from '../types';
import { difficultyToTarget } from '../wire';
import {
	ChannelRegistry,
	Sv2ChannelError,
	installJob,
	targetToDifficulty,
	validateSubmit,
	type Channel,
	type JobMessages
} from './channels';
import {
	MSG,
	Sv2DecodeError,
	decodeCloseChannel,
	decodeOpenExtendedMiningChannel,
	decodeOpenStandardMiningChannel,
	decodeSetupConnection,
	decodeSubmitSharesExtended,
	decodeSubmitSharesStandard,
	encodeNewExtendedMiningJob,
	encodeNewMiningJob,
	encodeOpenExtendedMiningChannelSuccess,
	encodeOpenMiningChannelError,
	encodeOpenStandardMiningChannelSuccess,
	encodeSetNewPrevHash,
	encodeSetupConnectionError,
	encodeSetupConnectionSuccess,
	encodeSubmitSharesError,
	encodeSubmitSharesSuccess,
	targetToU256LE
} from './codec';
import { ACT1_LEN, NoiseHandshakeError, NoiseResponder, type SignedCert } from './noise';
import { EncryptedFrameReader, Sv2FrameError, sealFrame, type Frame } from './frames';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_BLOCK_POLICY_SHIFT = 0;
/** Generous cap over ACT1_LEN (64B) — guards a peer that floods bytes before
 *  ever completing the fixed-size Act-1 exchange (risk register #6, pre-auth DoS). */
const HANDSHAKE_PRE_AUTH_MAX_BYTES = 4096;
/** SetupConnection.flags bit1 (wire ref §4): REQUIRES_WORK_SELECTION — SetCustomMiningJob
 *  family is out of scope for v1 (channels.ts/codec.ts never implement it). */
const REQUIRES_WORK_SELECTION = 1 << 1;
const SV2_MINING_PROTOCOL = 0;
const SV2_VERSION = 2;

export interface Sv2AuthorityMaterial {
	readonly staticPriv32: Uint8Array;
	/** 64-byte EllSwift wire encoding of the same static key (crypto.ts staticFromSecret). */
	readonly staticEll64: Uint8Array;
	readonly cert: SignedCert;
	/** Re-issue a fresh cert for the SAME static key (plan §d.3's 12h cadence).
	 *  Absent = no background re-issue timer (fine for short-lived/test servers). */
	readonly reissueCert?: () => SignedCert;
}

export interface Sv2ServerOptions {
	readonly port: number;
	/** Bind host. Default '127.0.0.1' (loopback only). */
	readonly host?: string;
	readonly shareDifficulty: number;
	readonly network: Network;
	readonly authProvider: AuthProvider;
	readonly onShare: (e: ShareEvent) => void;
	readonly onSolve: (e: SolveEvent) => void;
	readonly onReject?: (e: RejectEvent) => void;
	readonly log?: (msg: string) => void;
	/** min(networkTarget, shareTarget >> shift). Default 0 (production — see module doc). */
	readonly blockPolicyShift?: number;
	/** Simultaneous-connection cap. Default 64. */
	readonly maxConnections?: number;
	/** Server-wide version-rolling advertisement for every channel. Default false. */
	readonly versionRollingAllowed?: boolean;
	/** Noise static key + authority-signed cert this server presents to clients. */
	readonly authority: Sv2AuthorityMaterial;
	/** Handshake (Act1 -> Act2 -> SetupConnection) must complete within this window. Default 10s. */
	readonly handshakeTimeoutMs?: number;
	/** Cadence for `authority.reissueCert` (only relevant when it's provided). Default 12h. */
	readonly certReissueIntervalMs?: number;
}

type ConnPhase = 'handshake' | 'ready';

interface ChannelMeta {
	sharesAccepted: number;
	lastShareAt: number | null;
}

interface ConnState {
	readonly socket: Socket;
	phase: ConnPhase;
	handshakeBuf: Buffer;
	responder: NoiseResponder | null;
	sendCipher: { seal(ad: Uint8Array, pt: Uint8Array): Uint8Array } | null;
	frameReader: EncryptedFrameReader | null;
	setupDone: boolean;
	handshakeTimer: NodeJS.Timeout | null;
	readonly channelIds: Set<number>;
}

/** Stratum V2 error-code strings this server emits (free-form ASCII per wire ref §4 — no canonical enum). */
export const SV2_ERRORS = {
	UNSUPPORTED_PROTOCOL: 'unsupported-protocol',
	UNSUPPORTED_VERSION: 'unsupported-protocol-version',
	WORK_SELECTION_NOT_SUPPORTED: 'requires-work-selection-not-supported',
	UNKNOWN_USER: 'unknown-user',
	INVALID_PAYOUT_ADDRESS: 'invalid-payout-address',
	UNKNOWN_CHANNEL: 'unknown-channel'
} as const;

export class Sv2Server {
	private readonly opts: Sv2ServerOptions;
	private readonly server: Server;
	private readonly registry = new ChannelRegistry();
	private readonly channelConn = new Map<number, ConnState>();
	private readonly channelMeta = new Map<number, ChannelMeta>();
	private readonly conns = new Set<ConnState>();
	private readonly channelTarget: bigint;
	private readonly versionRollingAllowed: boolean;
	private readonly maxConnections: number;
	private readonly handshakeTimeoutMs: number;
	private readonly log: (msg: string) => void;
	private currentCert: SignedCert;
	private currentBuilt: BuiltJob | null = null;
	private certReissueTimer: NodeJS.Timeout | null = null;
	private closed = false;

	constructor(opts: Sv2ServerOptions) {
		// Fail fast on a non-positive/zero-rounding difficulty (matches V1's ctor guard).
		this.channelTarget = difficultyToTarget(opts.shareDifficulty);
		if (opts.host !== undefined && opts.host.length === 0) {
			throw new Error('host must be a non-empty bind address');
		}
		const shift = opts.blockPolicyShift ?? DEFAULT_BLOCK_POLICY_SHIFT;
		if (!Number.isInteger(shift) || shift < 0 || shift > 255) {
			throw new Error(`blockPolicyShift must be an integer in [0, 255], got ${shift}`);
		}
		this.opts = opts;
		this.versionRollingAllowed = opts.versionRollingAllowed ?? false;
		this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
		this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.log = opts.log ?? (() => {});
		this.currentCert = opts.authority.cert;
		this.server = createServer((socket) => this.onConnection(socket));
	}

	// ------------------------------------------------------------- accessors

	get minerCount(): number {
		return this.registry.count();
	}

	connections(): ConnectionInfo[] {
		const out: ConnectionInfo[] = [];
		for (const ch of this.registry.all()) {
			const meta = this.channelMeta.get(ch.id);
			out.push({
				miningId: ch.auth.miningId,
				userId: ch.auth.userId,
				worker: ch.userIdentity || ch.auth.miningId,
				address: ch.auth.address,
				difficulty: targetToDifficulty(ch.target),
				sharesAccepted: meta?.sharesAccepted ?? 0,
				lastShareAt: meta?.lastShareAt ?? null,
				protocol: 'sv2'
			});
		}
		return out;
	}

	get port(): number {
		const a = this.server.address();
		return a !== null && typeof a === 'object' ? a.port : this.opts.port;
	}

	get boundAddress(): string | null {
		const a = this.server.address();
		return a !== null && typeof a === 'object' ? a.address : null;
	}

	get listening(): boolean {
		return this.server.listening;
	}

	// ---------------------------------------------------------------- lifecycle

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server.once('error', onError);
			this.server.listen(this.opts.port, this.opts.host ?? DEFAULT_HOST, () => {
				this.server.removeListener('error', onError);
				if (this.opts.authority.reissueCert) {
					const intervalMs = this.opts.certReissueIntervalMs ?? 12 * 3600 * 1000;
					this.certReissueTimer = setInterval(() => {
						try {
							this.currentCert = this.opts.authority.reissueCert!();
						} catch (err) {
							this.log(`sv2 cert reissue failed (keeping previous cert): ${String(err)}`);
						}
					}, intervalMs);
					this.certReissueTimer.unref?.();
				}
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.certReissueTimer) {
			clearInterval(this.certReissueTimer);
			this.certReissueTimer = null;
		}
		for (const conn of [...this.conns]) conn.socket.destroy();
		await new Promise<void>((resolve, reject) => {
			if (!this.server.listening) return resolve();
			this.server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	/** Install a new current job and fan it out (installJob) to every open channel. */
	setJob(built: BuiltJob): void {
		this.currentBuilt = built;
		for (const ch of this.registry.all()) {
			const conn = this.channelConn.get(ch.id);
			if (!conn || conn.socket.destroyed) continue;
			const jm = installJob(ch, built);
			this.sendJobMessages(conn, jm);
		}
	}

	// ---------------------------------------------------------------- wire IO

	private onConnection(socket: Socket): void {
		if (this.closed || this.conns.size >= this.maxConnections) {
			socket.destroy();
			return;
		}
		socket.setNoDelay(true);
		const conn: ConnState = {
			socket,
			phase: 'handshake',
			handshakeBuf: Buffer.alloc(0),
			responder: new NoiseResponder({
				staticPriv32: this.opts.authority.staticPriv32,
				staticEll64: this.opts.authority.staticEll64,
				cert: this.currentCert
			}),
			sendCipher: null,
			frameReader: null,
			setupDone: false,
			handshakeTimer: null,
			channelIds: new Set()
		};
		this.conns.add(conn);
		conn.handshakeTimer = setTimeout(() => {
			this.log('sv2 handshake timed out — closing connection');
			socket.destroy();
		}, this.handshakeTimeoutMs);
		conn.handshakeTimer.unref?.();

		socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
		socket.on('error', () => socket.destroy());
		socket.on('close', () => this.onSocketClose(conn));
	}

	private onSocketClose(conn: ConnState): void {
		this.conns.delete(conn);
		if (conn.handshakeTimer) {
			clearTimeout(conn.handshakeTimer);
			conn.handshakeTimer = null;
		}
		for (const id of conn.channelIds) {
			this.registry.close(id);
			this.channelConn.delete(id);
			this.channelMeta.delete(id);
		}
		conn.channelIds.clear();
	}

	/**
	 * Every byte handled here is wrapped: a bad Noise decrypt, a malformed
	 * frame, or any decode throw destroys ONLY this connection (never escapes
	 * into the 'data' listener chain — mirrors stratum.ts's handler wrapping).
	 */
	private onData(conn: ConnState, chunk: Buffer): void {
		try {
			if (conn.phase === 'handshake') {
				conn.handshakeBuf = Buffer.concat([conn.handshakeBuf, chunk]);
				if (conn.handshakeBuf.length > HANDSHAKE_PRE_AUTH_MAX_BYTES) {
					conn.socket.destroy();
					return;
				}
				if (conn.handshakeBuf.length < ACT1_LEN) return; // wait for the rest of Act1
				const act1 = conn.handshakeBuf.subarray(0, ACT1_LEN);
				const rest = Buffer.from(conn.handshakeBuf.subarray(ACT1_LEN));
				conn.responder!.readAct1(act1);
				const act2 = conn.responder!.writeAct2();
				conn.socket.write(Buffer.from(act2));
				const { recv, send } = conn.responder!.split();
				conn.sendCipher = send;
				conn.frameReader = new EncryptedFrameReader(recv);
				conn.phase = 'ready';
				if (conn.handshakeTimer) {
					clearTimeout(conn.handshakeTimer);
					conn.handshakeTimer = null;
				}
				if (rest.length > 0) conn.frameReader.push(rest);
			} else {
				conn.frameReader!.push(chunk);
			}

			if (conn.phase === 'ready' && conn.frameReader) {
				for (const frame of conn.frameReader.drain()) this.dispatch(conn, frame);
			}
		} catch (err) {
			if (err instanceof NoiseHandshakeError || err instanceof Sv2FrameError || err instanceof Sv2DecodeError) {
				this.log(`sv2 protocol error (connection dropped): ${String(err)}`);
			} else {
				this.log(`sv2 handler error (connection dropped): ${String(err)}`);
			}
			conn.socket.destroy();
		}
	}

	private sendMsg(conn: ConnState, msgType: number, channelMsg: boolean, payload: Uint8Array): void {
		if (conn.socket.destroyed || !conn.socket.writable || !conn.sendCipher) return;
		const bytes = sealFrame(conn.sendCipher, msgType, channelMsg, payload);
		conn.socket.write(Buffer.from(bytes));
	}

	private sendMsgThenClose(conn: ConnState, msgType: number, channelMsg: boolean, payload: Uint8Array): void {
		if (conn.socket.destroyed || !conn.socket.writable || !conn.sendCipher) {
			conn.socket.destroy();
			return;
		}
		const bytes = sealFrame(conn.sendCipher, msgType, channelMsg, payload);
		conn.socket.write(Buffer.from(bytes), () => conn.socket.destroy());
	}

	private emitReject(reason: RejectEvent['reason'], userId?: number, worker?: string): void {
		if (this.opts.onReject === undefined) return;
		const e: RejectEvent = { reason };
		if (userId !== undefined) (e as { userId?: number }).userId = userId;
		if (worker !== undefined) (e as { worker?: string }).worker = worker;
		this.opts.onReject(e);
	}

	// ------------------------------------------------------------- dispatch

	private dispatch(conn: ConnState, frame: Frame): void {
		if (!conn.setupDone) {
			if (frame.msgType === MSG.SetupConnection) {
				this.handleSetupConnection(conn, frame.payload);
				return;
			}
			// Any message before a successful SetupConnection is a protocol violation.
			conn.socket.destroy();
			return;
		}
		switch (frame.msgType) {
			case MSG.OpenStandardMiningChannel:
				this.handleOpenStandard(conn, frame.payload);
				return;
			case MSG.OpenExtendedMiningChannel:
				this.handleOpenExtended(conn, frame.payload);
				return;
			case MSG.SubmitSharesStandard:
				this.handleSubmit(conn, frame.payload, 'standard');
				return;
			case MSG.SubmitSharesExtended:
				this.handleSubmit(conn, frame.payload, 'extended');
				return;
			case MSG.CloseChannel:
				this.handleCloseChannel(conn, frame.payload);
				return;
			default:
				// Unknown/unsupported message type: log and ignore (wire ref §5 —
				// "unknown extension_type ... discard/ignore"), never crash.
				this.log(`sv2: ignoring unsupported msgType 0x${frame.msgType.toString(16)}`);
		}
	}

	private handleSetupConnection(conn: ConnState, payload: Uint8Array): void {
		const msg = decodeSetupConnection(payload);
		if (msg.protocol !== SV2_MINING_PROTOCOL) {
			this.sendMsgThenClose(
				conn,
				MSG.SetupConnectionError,
				false,
				encodeSetupConnectionError({ flags: msg.flags, errorCode: SV2_ERRORS.UNSUPPORTED_PROTOCOL })
			);
			return;
		}
		if ((msg.flags & REQUIRES_WORK_SELECTION) !== 0) {
			this.sendMsgThenClose(
				conn,
				MSG.SetupConnectionError,
				false,
				encodeSetupConnectionError({
					flags: msg.flags & REQUIRES_WORK_SELECTION,
					errorCode: SV2_ERRORS.WORK_SELECTION_NOT_SUPPORTED
				})
			);
			return;
		}
		if (msg.minVersion > SV2_VERSION || msg.maxVersion < SV2_VERSION) {
			this.sendMsgThenClose(
				conn,
				MSG.SetupConnectionError,
				false,
				encodeSetupConnectionError({ flags: msg.flags, errorCode: SV2_ERRORS.UNSUPPORTED_VERSION })
			);
			return;
		}
		conn.setupDone = true;
		this.sendMsg(
			conn,
			MSG.SetupConnectionSuccess,
			false,
			encodeSetupConnectionSuccess({ usedVersion: SV2_VERSION, flags: 0 })
		);
	}

	private registerChannel(conn: ConnState, ch: Channel): void {
		conn.channelIds.add(ch.id);
		this.channelConn.set(ch.id, conn);
		this.channelMeta.set(ch.id, { sharesAccepted: 0, lastShareAt: null });
		if (this.currentBuilt) {
			const jm = installJob(ch, this.currentBuilt);
			this.sendJobMessages(conn, jm);
		}
	}

	private handleOpenStandard(conn: ConnState, payload: Uint8Array): void {
		const msg = decodeOpenStandardMiningChannel(payload);
		const auth = this.opts.authProvider.resolve(msg.userIdentity);
		if (auth === null) {
			this.emitReject('unauthorized');
			this.sendMsg(
				conn,
				MSG.OpenMiningChannelError,
				false,
				encodeOpenMiningChannelError({ requestId: msg.requestId, errorCode: SV2_ERRORS.UNKNOWN_USER })
			);
			return;
		}
		if (!validateAddressEncodable(auth.address, this.opts.network)) {
			this.emitReject('unauthorized');
			this.sendMsg(
				conn,
				MSG.OpenMiningChannelError,
				false,
				encodeOpenMiningChannelError({ requestId: msg.requestId, errorCode: SV2_ERRORS.INVALID_PAYOUT_ADDRESS })
			);
			return;
		}
		const ch = this.registry.openStandard(auth, msg.userIdentity, this.channelTarget, this.versionRollingAllowed);
		this.registerChannel(conn, ch);
		this.sendMsg(
			conn,
			MSG.OpenStandardMiningChannelSuccess,
			false,
			encodeOpenStandardMiningChannelSuccess({
				requestId: msg.requestId,
				channelId: ch.id,
				target: targetToU256LE(ch.target),
				extranoncePrefix: Buffer.from(ch.extranoncePrefixHex, 'hex'),
				groupChannelId: 0
			})
		);
	}

	private handleOpenExtended(conn: ConnState, payload: Uint8Array): void {
		const msg = decodeOpenExtendedMiningChannel(payload);
		const auth = this.opts.authProvider.resolve(msg.userIdentity);
		if (auth === null) {
			this.emitReject('unauthorized');
			this.sendMsg(
				conn,
				MSG.OpenMiningChannelError,
				false,
				encodeOpenMiningChannelError({ requestId: msg.requestId, errorCode: SV2_ERRORS.UNKNOWN_USER })
			);
			return;
		}
		if (!validateAddressEncodable(auth.address, this.opts.network)) {
			this.emitReject('unauthorized');
			this.sendMsg(
				conn,
				MSG.OpenMiningChannelError,
				false,
				encodeOpenMiningChannelError({ requestId: msg.requestId, errorCode: SV2_ERRORS.INVALID_PAYOUT_ADDRESS })
			);
			return;
		}
		let ch: Channel;
		try {
			ch = this.registry.openExtended(
				auth,
				msg.userIdentity,
				msg.minExtranonceSize,
				this.channelTarget,
				this.versionRollingAllowed
			);
		} catch (e) {
			const code = e instanceof Sv2ChannelError ? e.code : 'other';
			this.sendMsg(
				conn,
				MSG.OpenMiningChannelError,
				false,
				encodeOpenMiningChannelError({ requestId: msg.requestId, errorCode: code })
			);
			return;
		}
		this.registerChannel(conn, ch);
		this.sendMsg(
			conn,
			MSG.OpenExtendedMiningChannelSuccess,
			false,
			encodeOpenExtendedMiningChannelSuccess({
				requestId: msg.requestId,
				channelId: ch.id,
				target: targetToU256LE(ch.target),
				extranonceSize: ch.extranonceSize,
				extranoncePrefix: Buffer.from(ch.extranoncePrefixHex, 'hex'),
				groupChannelId: 0
			})
		);
	}

	private handleCloseChannel(conn: ConnState, payload: Uint8Array): void {
		const msg = decodeCloseChannel(payload);
		if (this.channelConn.get(msg.channelId) !== conn) return; // not this connection's channel — ignore
		this.registry.close(msg.channelId);
		this.channelConn.delete(msg.channelId);
		this.channelMeta.delete(msg.channelId);
		conn.channelIds.delete(msg.channelId);
	}

	private sendJobMessages(conn: ConnState, jm: JobMessages): void {
		if (jm.newJob.kind === 'extended') {
			this.sendMsg(conn, MSG.NewExtendedMiningJob, true, encodeNewExtendedMiningJob(jm.newJob.msg));
		} else {
			this.sendMsg(conn, MSG.NewMiningJob, true, encodeNewMiningJob(jm.newJob.msg));
		}
		if (jm.setPrevHash) {
			this.sendMsg(conn, MSG.SetNewPrevHash, true, encodeSetNewPrevHash(jm.setPrevHash));
		}
	}

	private handleSubmit(conn: ConnState, payload: Uint8Array, kind: 'standard' | 'extended'): void {
		const msg = kind === 'standard' ? decodeSubmitSharesStandard(payload) : decodeSubmitSharesExtended(payload);
		const ch = this.registry.get(msg.channelId);
		const owner = this.channelConn.get(msg.channelId);
		if (ch === undefined || owner !== conn) {
			this.sendMsg(
				conn,
				MSG.SubmitSharesError,
				true,
				encodeSubmitSharesError({
					channelId: msg.channelId,
					sequenceNumber: msg.sequenceNumber,
					errorCode: SV2_ERRORS.UNKNOWN_CHANNEL
				})
			);
			this.emitReject('other');
			return;
		}

		const result = validateSubmit(ch, msg, { blockPolicyShift: this.opts.blockPolicyShift ?? DEFAULT_BLOCK_POLICY_SHIFT });
		if (result.kind === 'reject') {
			this.sendMsg(
				conn,
				MSG.SubmitSharesError,
				true,
				encodeSubmitSharesError({ channelId: ch.id, sequenceNumber: msg.sequenceNumber, errorCode: result.errorCode })
			);
			this.emitReject(result.reason, ch.auth.userId, ch.userIdentity || ch.auth.miningId);
			return;
		}

		const meta = this.channelMeta.get(ch.id);
		const nowMs = Date.now();
		if (meta) {
			meta.sharesAccepted++;
			meta.lastShareAt = nowMs;
		}
		this.sendMsg(
			conn,
			MSG.SubmitSharesSuccess,
			true,
			encodeSubmitSharesSuccess({
				channelId: ch.id,
				lastSequenceNumber: msg.sequenceNumber,
				newSubmitsAcceptedCount: 1,
				newSharesSum: BigInt(Math.max(0, Math.round(result.shareEvent.difficulty)))
			})
		);
		this.opts.onShare(result.shareEvent);
		if (result.kind === 'solve') this.opts.onSolve(result.solveEvent);
	}
}
