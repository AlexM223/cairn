/**
 * SV2 channel registry + per-channel FrozenJob state machine (Phase 3 of
 * docs/SV2-IMPLEMENTATION-PLAN.md §a.6/§b). Pure logic — no sockets, no DB, no
 * imports from noise.ts/authority.ts. Maps a `BuiltJob` (the same job.ts output
 * V1 Stratum consumes) onto per-channel NewMiningJob/NewExtendedMiningJob +
 * SetNewPrevHash messages, and validates SubmitSharesStandard/Extended against
 * the announce-time-frozen job.
 *
 * Two money-path invariants (plan §c), both enforced by FrozenJob:
 *  - FROZEN PAYOUT: `variant = built.personalize({ payoutScript: ch.auth.payoutScript })`
 *    is captured once, at announce time, into the FrozenJob. Validation always
 *    reads that stored variant — a later `authTable` change to the miner's
 *    address can never retroactively move an in-flight job's payout.
 *  - ANNOUNCE-TIME TARGET: `job.target = ch.target` is snapshotted when the
 *    FrozenJob is created. A later SetTarget/vardiff move updates `ch.target`
 *    for FUTURE jobs only; an already-announced job is graded against its own
 *    frozen target forever.
 *
 * Byte-order / consensus math is never reimplemented here — every hash, target
 * comparison, and coinbase reconstruction goes through the existing exported
 * `wire.ts` functions and `job.ts`'s `CoinbaseVariant` closures.
 *
 * Extranonce zone generalization (deviation from the plan's §b.3 pseudocode,
 * documented in the P3 handoff): the plan's `en1 = job.en1PrefixHex` shortcut
 * only works for the DEFAULT 4-byte/4-byte extended split. To support the full
 * `min_extranonce_size` range (0-8, plan §b.1 table), `validateSubmit` instead
 * reconstructs the full 8-byte zone as `ch.extranoncePrefixHex ‖ clientExtranonce`
 * (standard: no client part) and splits it POSITIONALLY into two 4-byte halves
 * for `CoinbaseVariant.headerFor`/`assemble`, which only ever cares about the
 * concatenation being 8 bytes in the right order — not where the server/client
 * boundary falls. This reduces to the plan's simple case when
 * `min_extranonce_size === 4` and is required for `assemble(en1Hex, en2Hex, …)`
 * (job.ts) to accept an arbitrary split at solve time.
 */
import { EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } from '../job';
import type { BuiltJob, CoinbaseVariant, MinerAuth, RejectEvent, ShareEvent, SolveEvent } from '../types';
import { DIFF1_TARGET, applyBranches, bitsToTarget, displayToInternal, hashValueFromDisplay, headerHashDisplay, sha256d } from '../wire';
import type {
	NewExtendedMiningJob,
	NewMiningJob,
	SetNewPrevHash,
	SubmitSharesExtended,
	SubmitSharesStandard
} from './codec';

/** The full server+client extranonce zone job.ts's coinbase reserves (8 bytes). */
export const EXTRANONCE_ZONE_BYTES = EXTRANONCE1_SIZE + EXTRANONCE2_SIZE;

/** Jobs retained per channel (parity with V1 stratum.ts JOB_WINDOW = 4). */
const JOB_RETENTION = 4;

/** ntime window slack beyond `elapsed-since-activation` (wire ref §5, clock/jitter tolerance). */
const NTIME_TOLERANCE_SEC = 30;

/** Consensus 2h-future-block rule, applied as a hard cap regardless of elapsed time. */
const NTIME_MAX_FUTURE_SEC = 2 * 60 * 60;

const VERSION_ROLLING_MASK = 0x1fffe000; // BIP320

export class Sv2ChannelError extends Error {
	constructor(
		readonly code: string,
		message?: string
	) {
		super(message ?? code);
		this.name = 'Sv2ChannelError';
	}
}

export type ChannelKind = 'standard' | 'extended';

/** One announced job on one channel — the FROZEN unit (payout + target fixed at announce). */
export interface FrozenJob {
	readonly sv2JobId: number; // channel-scoped U32 we assigned
	readonly poolJobId: string; // built.job.jobId — the key MiningPool.handleSolve looks up
	readonly variant: CoinbaseVariant; // personalized to THIS channel's payoutScript (frozen)
	readonly target: bigint; // announce-time share target (announce-time-difficulty invariant)
	readonly prevHashDisplay: string;
	readonly ntimeHex: string; // also doubles as SetNewPrevHash.min_ntime for this job
	readonly baseVersionHex: string;
	readonly nbitsHex: string;
	readonly height: number;
	readonly coinbaseValueSats: bigint;
	readonly en1PrefixHex: string; // server extranonce_prefix in force when this job was announced
	merkleRootLE?: Uint8Array; // standard channels only (server-computed, sent in NewMiningJob)
	/** Wall-clock ms when this job became submittable (activation time for the ntime window). */
	activatedAtMs: number;
}

export interface Channel {
	readonly id: number;
	readonly kind: ChannelKind;
	readonly auth: MinerAuth;
	readonly userIdentity: string;
	readonly extranoncePrefixHex: string; // server-owned bytes (extended: 8-m; standard: full 8)
	readonly extranonceSize: number; // client-owned bytes (extended: m). standard: 0
	target: bigint; // current channel target (moves with vardiff SetTarget)
	versionRollingAllowed: boolean;
	readonly jobs: Map<number, FrozenJob>; // keyed by sv2JobId, capped (JOB_RETENTION)
	/** Per-job accepted-share dedupe sets, pruned in lockstep with `jobs`. */
	readonly seenShares: Map<number, Set<string>>;
	nextSv2JobId(): number;
}

class ChannelImpl implements Channel {
	readonly jobs = new Map<number, FrozenJob>();
	readonly seenShares = new Map<number, Set<string>>();
	private jobIdCounter = 1;

	constructor(
		readonly id: number,
		readonly kind: ChannelKind,
		readonly auth: MinerAuth,
		readonly userIdentity: string,
		readonly extranoncePrefixHex: string,
		readonly extranonceSize: number,
		public target: bigint,
		public versionRollingAllowed: boolean
	) {}

	nextSv2JobId(): number {
		const id = this.jobIdCounter;
		this.jobIdCounter = (this.jobIdCounter + 1) >>> 0;
		if (this.jobIdCounter === 0) this.jobIdCounter = 1; // never hand out 0 after wraparound
		return id;
	}
}

export class ChannelRegistry {
	private readonly channels = new Map<number, Channel>();
	private channelIdCounter = 1;
	private prefixCounter = 0;

	private nextChannelId(): number {
		const id = this.channelIdCounter;
		this.channelIdCounter = (this.channelIdCounter + 1) >>> 0;
		if (this.channelIdCounter === 0) this.channelIdCounter = 1;
		return id;
	}

	/**
	 * A server-assigned extranonce_prefix, unique per channel (running counter
	 * encoded into the low-order bytes of a `len`-byte buffer). Per plan §b.1:
	 * "defense-in-depth, not correctness-critical" — coinbase already differs
	 * per channel via the personalized payout.
	 */
	private nextPrefix(len: number): Buffer {
		const counter = this.prefixCounter++;
		const full = Buffer.alloc(4);
		full.writeUInt32BE(counter >>> 0, 0);
		if (len <= 4) return Buffer.from(full.subarray(4 - len));
		const out = Buffer.alloc(len);
		full.copy(out, len - 4);
		return out;
	}

	openExtended(
		auth: MinerAuth,
		userIdentity: string,
		minExtranonceSize: number,
		target: bigint,
		versionRolling: boolean
	): Channel {
		if (!Number.isInteger(minExtranonceSize) || minExtranonceSize < 0 || minExtranonceSize > EXTRANONCE_ZONE_BYTES) {
			throw new Sv2ChannelError(
				'max-extranonce-too-large',
				`min_extranonce_size ${minExtranonceSize} outside [0, ${EXTRANONCE_ZONE_BYTES}]`
			);
		}
		const prefixLen = EXTRANONCE_ZONE_BYTES - minExtranonceSize;
		const id = this.nextChannelId();
		const prefix = this.nextPrefix(prefixLen);
		const ch = new ChannelImpl(
			id,
			'extended',
			auth,
			userIdentity,
			prefix.toString('hex'),
			minExtranonceSize,
			target,
			versionRolling
		);
		this.channels.set(id, ch);
		return ch;
	}

	openStandard(auth: MinerAuth, userIdentity: string, target: bigint, versionRolling: boolean): Channel {
		const id = this.nextChannelId();
		const prefix = this.nextPrefix(EXTRANONCE_ZONE_BYTES);
		const ch = new ChannelImpl(id, 'standard', auth, userIdentity, prefix.toString('hex'), 0, target, versionRolling);
		this.channels.set(id, ch);
		return ch;
	}

	get(channelId: number): Channel | undefined {
		return this.channels.get(channelId);
	}

	close(channelId: number): void {
		this.channels.delete(channelId);
	}

	all(): Channel[] {
		return [...this.channels.values()];
	}

	count(): number {
		return this.channels.size;
	}

	/**
	 * Convenience fan-out of `installJob` over every open channel — the
	 * registry-level expression of the plan's `onNewBuiltJob(built)` flow.
	 */
	announceJob(built: BuiltJob, nowMs: number = Date.now()): Map<number, JobMessages> {
		const out = new Map<number, JobMessages>();
		for (const ch of this.all()) out.set(ch.id, installJob(ch, built, nowMs));
		return out;
	}
}

/** Map a BuiltJob → the messages to send on one channel. Pure (no I/O, no channel-state mutation
 *  beyond the per-channel job-id counter), fully unit-testable. */
export interface JobMessages {
	frozen: FrozenJob;
	newJob: { kind: 'extended'; msg: NewExtendedMiningJob } | { kind: 'standard'; msg: NewMiningJob };
	setPrevHash?: SetNewPrevHash; // present when built.job.cleanJobs
}

export function jobMessagesFor(ch: Channel, built: BuiltJob): JobMessages {
	const clean = built.job.cleanJobs;
	const variant = built.personalize({ payoutScript: ch.auth.payoutScript });
	const sv2JobId = ch.nextSv2JobId();
	const ntime = parseInt(built.job.ntimeHex, 16);
	const version = parseInt(built.job.versionHex, 16);
	const nbits = parseInt(built.job.nbitsHex, 16);
	const prevHash = displayToInternal(built.job.prevHashDisplay);

	const frozen: FrozenJob = {
		sv2JobId,
		poolJobId: built.job.jobId,
		variant,
		target: ch.target,
		prevHashDisplay: built.job.prevHashDisplay,
		ntimeHex: built.job.ntimeHex,
		baseVersionHex: built.job.versionHex,
		nbitsHex: built.job.nbitsHex,
		height: built.job.height,
		coinbaseValueSats: built.job.coinbaseValueSats,
		en1PrefixHex: ch.extranoncePrefixHex,
		activatedAtMs: Date.now()
	};

	const setPrevHash: SetNewPrevHash | undefined = clean
		? { channelId: ch.id, jobId: sv2JobId, prevHash, minNtime: ntime, nbits }
		: undefined;

	if (ch.kind === 'extended') {
		const msg: NewExtendedMiningJob = {
			channelId: ch.id,
			jobId: sv2JobId,
			minNtime: clean ? null : ntime,
			version,
			versionRollingAllowed: ch.versionRollingAllowed,
			merklePath: built.job.merkleBranchesInternalHex.map((h) => Buffer.from(h, 'hex')),
			coinbaseTxPrefix: Buffer.from(variant.coinb1Hex, 'hex'),
			coinbaseTxSuffix: Buffer.from(variant.coinb2Hex, 'hex')
		};
		return { frozen, newJob: { kind: 'extended', msg }, setPrevHash };
	}

	// standard: server computes merkle_root from the full server-owned 8-byte zone
	// (no client extranonce). Only exported wire.ts functions are used here — no
	// new consensus math (plan §b.2 footer).
	const en = Buffer.from(ch.extranoncePrefixHex, 'hex'); // full 8 bytes for a standard channel
	const coinbase = Buffer.concat([Buffer.from(variant.coinb1Hex, 'hex'), en, Buffer.from(variant.coinb2Hex, 'hex')]);
	const branches = built.job.merkleBranchesInternalHex.map((h) => Buffer.from(h, 'hex'));
	const rootLE = applyBranches(sha256d(coinbase), branches);
	frozen.merkleRootLE = rootLE;

	const msg: NewMiningJob = {
		channelId: ch.id,
		jobId: sv2JobId,
		minNtime: clean ? null : ntime,
		version,
		merkleRoot: rootLE
	};
	return { frozen, newJob: { kind: 'standard', msg }, setPrevHash };
}

/**
 * Stateful wrapper around `jobMessagesFor`: registers the FrozenJob into the
 * channel, applies the plan §b.2 clean-job invalidation ("SetNewPrevHash …
 * invalidates all other queued jobs", wire ref §4), and enforces the
 * JOB_RETENTION cap on refresh (non-clean) chains. This is the SV2 expression
 * of the plan's `onNewBuiltJob(built)` per-channel flow.
 */
export function installJob(ch: Channel, built: BuiltJob, nowMs: number = Date.now()): JobMessages {
	const result = jobMessagesFor(ch, built);
	result.frozen.activatedAtMs = nowMs;

	if (built.job.cleanJobs) {
		// New prevhash: the newly-activated job supersedes every job previously
		// queued on this channel (wire ref §4 SetNewPrevHash semantics).
		ch.jobs.clear();
		ch.seenShares.clear();
	}
	ch.jobs.set(result.frozen.sv2JobId, result.frozen);
	ch.seenShares.set(result.frozen.sv2JobId, new Set());

	while (ch.jobs.size > JOB_RETENTION) {
		const oldestId = ch.jobs.keys().next().value as number;
		ch.jobs.delete(oldestId);
		ch.seenShares.delete(oldestId);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Share validation
// ---------------------------------------------------------------------------

export interface ValidateSubmitOptions {
	/** Clock hook for the ntime window + ShareEvent.timestampMs. Default Date.now(). */
	readonly nowMs?: number;
	/** REGTEST_POLICY_SHIFT-style solve gate: min(networkTarget, frozenTarget >> shift).
	 *  Default 0 (production semantics — solve requires clearing the real network target). */
	readonly blockPolicyShift?: number;
}

export type ValidateSubmitResult =
	| { readonly kind: 'accept'; readonly shareEvent: ShareEvent }
	| { readonly kind: 'solve'; readonly shareEvent: ShareEvent; readonly solveEvent: SolveEvent }
	| { readonly kind: 'reject'; readonly reason: RejectEvent['reason']; readonly errorCode: string };

function hex8(n: number): string {
	return (n >>> 0).toString(16).padStart(8, '0');
}

function withinVersionMask(version: number, base: number): boolean {
	return ((version ^ base) & ~VERSION_ROLLING_MASK) === 0;
}

/** Inverse of wire.ts's difficultyToTarget (never exported there — kept local to
 *  avoid touching wire.ts). Matches its 1e6 fixed-point scale. */
export function targetToDifficulty(target: bigint): number {
	if (target <= 0n) throw new Sv2ChannelError('invalid-target', `target must be positive, got ${target}`);
	return Number((DIFF1_TARGET * 1_000_000n) / target) / 1_000_000;
}

/**
 * Validate one SubmitSharesStandard/Extended against the channel's frozen job
 * state. Reuses `wire.ts`/`job.ts` exclusively for header/hash/target math —
 * see the module doc comment for the extranonce-zone reconstruction rationale.
 */
export function validateSubmit(
	ch: Channel,
	msg: SubmitSharesStandard | SubmitSharesExtended,
	opts: ValidateSubmitOptions = {}
): ValidateSubmitResult {
	const nowMs = opts.nowMs ?? Date.now();
	const shift = opts.blockPolicyShift ?? 0;

	const job = ch.jobs.get(msg.jobId);
	if (job === undefined) {
		return { kind: 'reject', reason: 'stale', errorCode: 'stale-job' };
	}

	const baseVersion = parseInt(job.baseVersionHex, 16);
	if (!ch.versionRollingAllowed) {
		if (msg.version !== baseVersion) {
			return { kind: 'reject', reason: 'other', errorCode: 'version-rolling-not-allowed' };
		}
	} else if (!withinVersionMask(msg.version, baseVersion)) {
		return { kind: 'reject', reason: 'other', errorCode: 'version-rolling-not-allowed' };
	}

	// Full 8-byte extranonce zone = server-owned prefix (‖ client extranonce for
	// extended channels). See module doc comment: split positionally, not by the
	// server/client boundary, so headerFor/assemble's fixed 4B+4B contract holds
	// for every negotiated min_extranonce_size.
	const serverPrefix = Buffer.from(ch.extranoncePrefixHex, 'hex');
	let fullExtranonce: Buffer;
	let clientExtranonceHex = '';
	if (ch.kind === 'extended') {
		const ext = msg as SubmitSharesExtended;
		if (ext.extranonce === undefined) {
			return { kind: 'reject', reason: 'other', errorCode: 'missing-extranonce' };
		}
		if (ext.extranonce.length !== ch.extranonceSize) {
			return { kind: 'reject', reason: 'other', errorCode: 'extranonce-size-mismatch' };
		}
		clientExtranonceHex = Buffer.from(ext.extranonce).toString('hex');
		fullExtranonce = Buffer.concat([serverPrefix, Buffer.from(ext.extranonce)]);
	} else {
		fullExtranonce = serverPrefix;
	}
	if (fullExtranonce.length !== EXTRANONCE_ZONE_BYTES) {
		return { kind: 'reject', reason: 'other', errorCode: 'extranonce-size-mismatch' };
	}

	// ntime window (wire ref §5): min_ntime <= ntime <= min_ntime + elapsed + tolerance,
	// capped by the consensus 2h-future rule.
	const minNtime = parseInt(job.ntimeHex, 16);
	if (msg.ntime < minNtime) {
		return { kind: 'reject', reason: 'other', errorCode: 'ntime-too-old' };
	}
	const elapsedSec = Math.max(0, Math.floor((nowMs - job.activatedAtMs) / 1000));
	const maxNtime = minNtime + elapsedSec + NTIME_TOLERANCE_SEC;
	const consensusCapNtime = Math.floor(nowMs / 1000) + NTIME_MAX_FUTURE_SEC;
	if (msg.ntime > maxNtime || msg.ntime > consensusCapNtime) {
		return { kind: 'reject', reason: 'other', errorCode: 'ntime-too-new' };
	}

	// Duplicate detection, per plan §b.3 key (jobId implicit via the per-job Set;
	// extranonce/ntime/version/nonce carried in the key).
	const seen = ch.seenShares.get(job.sv2JobId);
	const dedupeKey = `${msg.ntime}:${msg.version}:${msg.nonce}:${clientExtranonceHex}`;
	if (seen !== undefined && seen.has(dedupeKey)) {
		return { kind: 'reject', reason: 'duplicate', errorCode: 'duplicate-share' };
	}

	const en1Hex = fullExtranonce.subarray(0, 4).toString('hex');
	const en2Hex = fullExtranonce.subarray(4, 8).toString('hex');
	const ntimeHex = hex8(msg.ntime);
	const nonceHex = hex8(msg.nonce);
	const header = job.variant.headerFor(en1Hex, en2Hex, ntimeHex, nonceHex);
	const hashDisplay = headerHashDisplay(header);
	const hashValue = hashValueFromDisplay(hashDisplay);

	if (hashValue > job.target) {
		// Low-difficulty shares are NOT recorded in the dedupe set (mirrors V1 —
		// bounds set growth by real accepted hashrate).
		return { kind: 'reject', reason: 'low_difficulty', errorCode: 'difficulty-too-low' };
	}
	seen?.add(dedupeKey);

	const shareEvent: ShareEvent = {
		userId: ch.auth.userId,
		miningId: ch.auth.miningId,
		worker: ch.userIdentity || ch.auth.miningId,
		difficulty: targetToDifficulty(job.target),
		timestampMs: nowMs
	};

	// Solve gate: parity with V1 stratum.ts's min(networkTarget, shareTarget >> shift);
	// shift defaults to 0 (no shift) here — callers that want the regtest-easy
	// policy shift pass blockPolicyShift explicitly (plan §a.7 default 4).
	const networkTarget = bitsToTarget(job.nbitsHex);
	const shifted = job.target >> BigInt(shift);
	const solveTarget = networkTarget < shifted ? networkTarget : shifted;

	if (hashValue <= solveTarget) {
		const solveEvent: SolveEvent = {
			jobId: job.poolJobId,
			extranonce1Hex: en1Hex,
			extranonce2Hex: en2Hex,
			ntimeHex,
			nonceHex,
			hashDisplay,
			height: job.height,
			userId: ch.auth.userId,
			miningId: ch.auth.miningId,
			worker: ch.userIdentity || ch.auth.miningId,
			walletId: ch.auth.walletId,
			address: ch.auth.address,
			payoutScriptHex: Buffer.from(ch.auth.payoutScript).toString('hex'),
			coinbaseValueSats: job.coinbaseValueSats
		};
		return { kind: 'solve', shareEvent, solveEvent };
	}

	return { kind: 'accept', shareEvent };
}
