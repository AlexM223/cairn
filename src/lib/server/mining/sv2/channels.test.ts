/**
 * channels.ts contract tests (Phase 3, docs/SV2-IMPLEMENTATION-PLAN.md §a.6/§b).
 * Fixture pattern cribbed from job.test.ts: deterministic in-memory GbtTemplate,
 * no real node, merkle root independently re-verified against node:crypto only
 * (never wire.ts's own merkle code, for the standard-channel check).
 */
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from '../address';
import { buildJob } from '../job';
import type { GbtTemplate, MinerAuth } from '../types';
import { applyBranches, bitsToTarget, hashValueFromDisplay, headerHashDisplay, sha256d } from '../wire';
import {
	ChannelRegistry,
	EXTRANONCE_ZONE_BYTES,
	Sv2ChannelError,
	installJob,
	jobMessagesFor,
	targetToDifficulty,
	validateSubmit
} from './channels';
import type { NewExtendedMiningJob, NewMiningJob, SubmitSharesExtended, SubmitSharesStandard } from './codec';

const net = NETWORKS.regtest;
const POOL_TAG = 'heartwood-sv2';

// --- Deterministic fixtures (cribbed from job.test.ts) -----------------------

function sha256dDirect(buf: Buffer): Buffer {
	const a = createHash('sha256').update(buf).digest();
	return createHash('sha256').update(a).digest();
}

function merkleRootDirect(leavesLE: readonly Buffer[]): Buffer {
	let level: Buffer[] = leavesLE.map((b) => Buffer.from(b));
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]!);
		const next: Buffer[] = [];
		for (let i = 0; i < level.length; i += 2) next.push(sha256dDirect(Buffer.concat([level[i]!, level[i + 1]!])));
		level = next;
	}
	return level[0]!;
}

function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, net.bech32);
}

function payout(label: string): Uint8Array {
	return addressToOutputScript(addr(label), net);
}

function fixtureTx(seed: string): { data: string; txid: string; hash: string } {
	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(createHash('sha256').update(`prevout-${seed}`).digest(), 0, 0xffffffff, Buffer.from('51', 'hex'));
	tx.addOutput(Buffer.from(addressToOutputScript(addr(`out-${seed}`), net)), 50_000);
	return { data: tx.toHex(), txid: tx.getId(), hash: tx.getId() };
}

function witnessCommitmentScript(wtxidsDisplay: readonly string[]): string {
	const leaves = [Buffer.alloc(32), ...wtxidsDisplay.map((h) => Buffer.from(h, 'hex').reverse())];
	const witnessRoot = merkleRootDirect(leaves);
	const commitment = sha256dDirect(Buffer.concat([witnessRoot, Buffer.alloc(32)]));
	return '6a24aa21a9ed' + commitment.toString('hex');
}

function prevHash(seed: string): string {
	return createHash('sha256').update(seed).digest('hex');
}

const TX_A = fixtureTx('a');
const TX_B = fixtureTx('b');

const TEMPLATE_A: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: prevHash('prev-block-a'),
	height: 200,
	curtime: 1_753_000_000,
	bits: '207fffff', // regtest-easy: target ~ 2^255, ~50% of random hashes clear it
	coinbasevalue: 5_000_000_000,
	transactions: [TX_A, TX_B],
	default_witness_commitment: witnessCommitmentScript([TX_A.hash, TX_B.hash])
};

const TEMPLATE_B: GbtTemplate = {
	...TEMPLATE_A,
	previousblockhash: prevHash('prev-block-b'),
	height: 201,
	curtime: 1_753_000_600
};

const AUTH_A: MinerAuth = {
	userId: 1,
	miningId: 'alice',
	walletId: 10,
	address: addr('alice-payout'),
	payoutScript: payout('alice-payout')
};

const AUTH_B: MinerAuth = {
	userId: 2,
	miningId: 'bob',
	walletId: 20,
	address: addr('bob-payout'),
	payoutScript: payout('bob-payout')
};

function cfg(jobId: string, cleanJobs: boolean) {
	return { network: net, poolTag: POOL_TAG, jobId, cleanJobs };
}

const NETWORK_TARGET = bitsToTarget(TEMPLATE_A.bits);
const MAX_U256 = (1n << 256n) - 1n;
/** Realistic wall-clock ms, roughly matching TEMPLATE_A.curtime — the ntime
 *  window's consensus 2h-future cap compares against real Unix time, so an
 *  arbitrary small `nowMs` (e.g. epoch-relative test counters) would make
 *  every submit look impossibly far in the future. */
const NOW_MS = TEMPLATE_A.curtime * 1000;

/** Find (in a handful of tries — regtest bits clear ~50% of random hashes) a
 *  nonce for which `validateSubmit` returns `wantKind`. Deterministic-enough
 *  for a unit test without hand-rolling compact-target arithmetic. */
function findNonceForKind(
	channel: ReturnType<ChannelRegistry['openExtended']>,
	jobId: number,
	baseMsg: Omit<SubmitSharesExtended, 'nonce'>,
	wantKind: 'accept' | 'solve',
	opts: Parameters<typeof validateSubmit>[2] = {}
): { nonce: number; result: Extract<ReturnType<typeof validateSubmit>, { kind: 'accept' | 'solve' }> } {
	for (let nonce = 0; nonce < 512; nonce++) {
		// Each nonce is a distinct dedupe key, so repeated misses never trip
		// the duplicate-share check while searching.
		const probe = validateSubmit(channel, { ...baseMsg, nonce }, opts);
		if (probe.kind === wantKind) return { nonce, result: probe };
		if (probe.kind === 'reject' && probe.reason !== 'low_difficulty') {
			throw new Error(`unexpected reject while searching for a ${wantKind} nonce: ${probe.errorCode}`);
		}
	}
	throw new Error(`no ${wantKind} nonce found in range — regtest-easy assumption violated`);
}

// --- Channel open + id/prefix allocation -------------------------------------

describe('ChannelRegistry allocation', () => {
	it('assigns unique, increasing channel ids across standard + extended channels', () => {
		const reg = new ChannelRegistry();
		const ch1 = reg.openExtended(AUTH_A, 'alice.rig1', 4, 1n, false);
		const ch2 = reg.openStandard(AUTH_A, 'alice.rig2', 1n, false);
		const ch3 = reg.openExtended(AUTH_B, 'bob.rig1', 4, 1n, false);
		expect(new Set([ch1.id, ch2.id, ch3.id]).size).toBe(3);
		expect(ch2.id).toBeGreaterThan(ch1.id);
		expect(ch3.id).toBeGreaterThan(ch2.id);
		expect(reg.count()).toBe(3);
		expect(reg.all().map((c) => c.id).sort()).toEqual([ch1.id, ch2.id, ch3.id].sort());
		expect(reg.get(ch1.id)).toBe(ch1);
		reg.close(ch1.id);
		expect(reg.get(ch1.id)).toBeUndefined();
		expect(reg.count()).toBe(2);
	});

	it('extranonce_prefix is unique across channels of the same length', () => {
		const reg = new ChannelRegistry();
		const standards = Array.from({ length: 5 }, (_, i) => reg.openStandard(AUTH_A, `alice.${i}`, 1n, false));
		const prefixes = standards.map((c) => c.extranoncePrefixHex);
		expect(new Set(prefixes).size).toBe(prefixes.length);
		for (const p of prefixes) expect(p).toHaveLength(EXTRANONCE_ZONE_BYTES * 2);
	});

	it('min_extranonce_size 0/4/8 -> correct prefix length / extranonce_size split; >8 throws', () => {
		const reg = new ChannelRegistry();
		const m0 = reg.openExtended(AUTH_A, 'a', 0, 1n, false);
		expect(m0.extranonceSize).toBe(0);
		expect(m0.extranoncePrefixHex).toHaveLength(16); // 8 bytes

		const m4 = reg.openExtended(AUTH_A, 'a', 4, 1n, false);
		expect(m4.extranonceSize).toBe(4);
		expect(m4.extranoncePrefixHex).toHaveLength(8); // 4 bytes

		const m8 = reg.openExtended(AUTH_A, 'a', 8, 1n, false);
		expect(m8.extranonceSize).toBe(8);
		expect(m8.extranoncePrefixHex).toHaveLength(0); // 0 bytes

		expect(() => reg.openExtended(AUTH_A, 'a', 9, 1n, false)).toThrow(Sv2ChannelError);
		try {
			reg.openExtended(AUTH_A, 'a', 9, 1n, false);
			throw new Error('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(Sv2ChannelError);
			expect((e as Sv2ChannelError).code).toBe('max-extranonce-too-large');
		}
	});

	it('per-channel sv2JobId allocation is monotonic and starts independently per channel', () => {
		const reg = new ChannelRegistry();
		const chA = reg.openExtended(AUTH_A, 'a', 4, 1n, false);
		const chB = reg.openExtended(AUTH_B, 'b', 4, 1n, false);
		const idsA = [chA.nextSv2JobId(), chA.nextSv2JobId(), chA.nextSv2JobId()];
		const idsB = [chB.nextSv2JobId(), chB.nextSv2JobId()];
		expect(idsA).toEqual([1, 2, 3]);
		expect(idsB).toEqual([1, 2]); // independent counter — cross-channel collisions are fine
		expect(new Set(idsA).size).toBe(3);
	});
});

// --- jobMessagesFor: extended channel byte-match -----------------------------

describe('jobMessagesFor — extended channel', () => {
	it('coinbase_tx_prefix/suffix byte-match an independent personalize() call', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, 1n, false);
		const built = buildJob(TEMPLATE_A, cfg('j1', true));
		const { frozen, newJob, setPrevHash } = jobMessagesFor(ch, built);

		expect(newJob.kind).toBe('extended');
		const msg = (newJob as { kind: 'extended'; msg: NewExtendedMiningJob }).msg;

		const direct = built.personalize({ payoutScript: AUTH_A.payoutScript });
		expect(Buffer.from(msg.coinbaseTxPrefix).toString('hex')).toBe(direct.coinb1Hex);
		expect(Buffer.from(msg.coinbaseTxSuffix).toString('hex')).toBe(direct.coinb2Hex);
		expect(frozen.variant.coinb1Hex).toBe(direct.coinb1Hex);
		expect(frozen.variant.coinb2Hex).toBe(direct.coinb2Hex);

		// merkle_path == merkleBranchesInternalHex, deepest-first, byte-for-byte.
		expect(msg.merklePath.map((b) => Buffer.from(b).toString('hex'))).toEqual(built.job.merkleBranchesInternalHex);

		expect(msg.channelId).toBe(ch.id);
		expect(msg.version).toBe(TEMPLATE_A.version);
		expect(msg.versionRollingAllowed).toBe(false);

		// clean job: future job (min_ntime unset) + a SetNewPrevHash activating it.
		expect(msg.minNtime).toBeNull();
		expect(setPrevHash).toBeDefined();
		expect(setPrevHash!.channelId).toBe(ch.id);
		expect(setPrevHash!.jobId).toBe(frozen.sv2JobId);
		expect(setPrevHash!.minNtime).toBe(parseInt(built.job.ntimeHex, 16));
		expect(setPrevHash!.nbits).toBe(parseInt(built.job.nbitsHex, 16));
	});

	it('refresh job (cleanJobs=false): min_ntime is immediately valid, no SetNewPrevHash', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, 1n, false);
		const built = buildJob(TEMPLATE_A, cfg('j2', false));
		const { newJob, setPrevHash } = jobMessagesFor(ch, built);
		const msg = (newJob as { kind: 'extended'; msg: NewExtendedMiningJob }).msg;
		expect(msg.minNtime).toBe(parseInt(built.job.ntimeHex, 16));
		expect(setPrevHash).toBeUndefined();
	});
});

// --- jobMessagesFor: standard channel merkle root ----------------------------

describe('jobMessagesFor — standard channel', () => {
	it('merkle_root matches an independently-computed sha256d/applyBranches root', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openStandard(AUTH_A, 'alice.rig1', 1n, false);
		const built = buildJob(TEMPLATE_A, cfg('j3', true));
		const { frozen, newJob } = jobMessagesFor(ch, built);
		expect(newJob.kind).toBe('standard');
		const msg = (newJob as { kind: 'standard'; msg: NewMiningJob }).msg;

		const variant = built.personalize({ payoutScript: AUTH_A.payoutScript });
		const fullPrefix = Buffer.from(ch.extranoncePrefixHex, 'hex');
		expect(fullPrefix).toHaveLength(8);
		const coinbase = Buffer.concat([Buffer.from(variant.coinb1Hex, 'hex'), fullPrefix, Buffer.from(variant.coinb2Hex, 'hex')]);
		const branches = built.job.merkleBranchesInternalHex.map((h) => Buffer.from(h, 'hex'));
		const independentRoot = applyBranches(sha256d(coinbase), branches);

		expect(Buffer.from(msg.merkleRoot)).toEqual(independentRoot);
		expect(frozen.merkleRootLE).toEqual(independentRoot);
	});
});

// --- Share validation: accept / reject / solve --------------------------------

describe('validateSubmit — accept / reject / solve (extended channel)', () => {
	function setup(target: bigint) {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, target, false);
		const built = buildJob(TEMPLATE_A, cfg('solve-job', true));
		const { frozen } = installJob(ch, built, NOW_MS);
		return { reg, ch, built, frozen };
	}

	it('rejects a share that misses the frozen (announce-time) target', () => {
		const { ch, frozen } = setup(1n); // effectively impossible target
		const base: Omit<SubmitSharesExtended, 'nonce'> = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			extranonce: Buffer.from('00000000', 'hex')
		};
		const result = validateSubmit(ch, { ...base, nonce: 0 }, { nowMs: NOW_MS });
		expect(result.kind).toBe('reject');
		if (result.kind === 'reject') {
			expect(result.reason).toBe('low_difficulty');
			expect(result.errorCode).toBe('difficulty-too-low');
		}
	});

	it('accepts a share that clears the frozen target but misses the network target (no solve)', () => {
		const { ch, frozen } = setup(MAX_U256); // channel difficulty trivially easy
		const base: Omit<SubmitSharesExtended, 'nonce'> = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			extranonce: Buffer.from('00000000', 'hex')
		};
		const { result } = findNonceForKind(ch, frozen.sv2JobId, base, 'accept', { nowMs: NOW_MS });
		expect(result.kind).toBe('accept');
		if (result.kind === 'accept') {
			expect(result.shareEvent.userId).toBe(AUTH_A.userId);
			expect(result.shareEvent.miningId).toBe(AUTH_A.miningId);
			expect(result.shareEvent.worker).toBe('alice.rig1');
			expect(result.shareEvent.difficulty).toBeCloseTo(targetToDifficulty(MAX_U256), 5);
		}
	});

	it('emits a SolveEvent when the share also clears the network (nbits) target', () => {
		const { ch, frozen } = setup(NETWORK_TARGET); // channel target == network target
		const base: Omit<SubmitSharesExtended, 'nonce'> = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			extranonce: Buffer.from('cafebabe', 'hex')
		};
		const { nonce, result } = findNonceForKind(ch, frozen.sv2JobId, base, 'solve', { nowMs: NOW_MS });
		expect(result.kind).toBe('solve');
		if (result.kind === 'solve') {
			expect(result.solveEvent.jobId).toBe(frozen.poolJobId); // pool jobId, not the sv2 job id
			expect(result.solveEvent.height).toBe(TEMPLATE_A.height);
			expect(result.solveEvent.userId).toBe(AUTH_A.userId);
			expect(result.solveEvent.walletId).toBe(AUTH_A.walletId);
			expect(result.solveEvent.payoutScriptHex).toBe(Buffer.from(AUTH_A.payoutScript).toString('hex'));
			expect(result.solveEvent.extranonce2Hex).toBe('cafebabe');
			// hashDisplay independently reproducible from the frozen variant.
			const header = frozen.variant.headerFor(
				frozen.en1PrefixHex,
				'cafebabe',
				result.solveEvent.ntimeHex,
				result.solveEvent.nonceHex
			);
			expect(headerHashDisplay(header)).toBe(result.solveEvent.hashDisplay);
			expect(hashValueFromDisplay(result.solveEvent.hashDisplay)).toBeLessThanOrEqual(NETWORK_TARGET);
			void nonce;
		}
	});

	it('rejects extranonce of the wrong length', () => {
		const { ch, frozen } = setup(MAX_U256);
		const bad = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			nonce: 0,
			extranonce: Buffer.from('aabb', 'hex') // 2 bytes, channel expects 4
		};
		const result = validateSubmit(ch, bad, { nowMs: NOW_MS });
		expect(result).toEqual({ kind: 'reject', reason: 'other', errorCode: 'extranonce-size-mismatch' });
	});

	it('rejects an unknown/stale job id', () => {
		const { ch, frozen } = setup(MAX_U256);
		const result = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId + 999,
				ntime: parseInt(frozen.ntimeHex, 16),
				version: parseInt(frozen.baseVersionHex, 16),
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS }
		);
		expect(result).toEqual({ kind: 'reject', reason: 'stale', errorCode: 'stale-job' });
	});

	it('duplicate submit of the same (ntime, version, nonce, extranonce) is rejected on resubmit', () => {
		const { ch, frozen } = setup(MAX_U256);
		const msg: SubmitSharesExtended = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			nonce: 7,
			extranonce: Buffer.from('01020304', 'hex')
		};
		const first = validateSubmit(ch, msg, { nowMs: NOW_MS });
		expect(first.kind).not.toBe('reject');
		const second = validateSubmit(ch, msg, { nowMs: NOW_MS + 1 });
		expect(second).toEqual({ kind: 'reject', reason: 'duplicate', errorCode: 'duplicate-share' });
	});

	it('ntime window: rejects too-old and too-new submits', () => {
		const { ch, frozen } = setup(MAX_U256);
		const minNtime = parseInt(frozen.ntimeHex, 16);
		const tooOld = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId,
				ntime: minNtime - 1,
				version: parseInt(frozen.baseVersionHex, 16),
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS }
		);
		expect(tooOld).toEqual({ kind: 'reject', reason: 'other', errorCode: 'ntime-too-old' });

		// activatedAtMs was pinned to NOW_MS by installJob; evaluate "now" at
		// the same instant (elapsed = 0s) so the window is exactly [min, min+30].
		const tooNew = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId,
				ntime: minNtime + 31,
				version: parseInt(frozen.baseVersionHex, 16),
				nonce: 1,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS }
		);
		expect(tooNew).toEqual({ kind: 'reject', reason: 'other', errorCode: 'ntime-too-new' });
	});
});

// --- Version rolling (cairn-qfez8.29, BIP320 mask 0x1fffe000) ----------------

describe('validateSubmit — version rolling', () => {
	function setupRolling(target: bigint, versionRollingAllowed: boolean) {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, target, versionRollingAllowed);
		const built = buildJob(TEMPLATE_A, cfg('vr-job', true));
		const { frozen } = installJob(ch, built, NOW_MS);
		return { reg, ch, built, frozen };
	}

	it('rolling disallowed: a version different from the base version is rejected version-rolling-not-allowed', () => {
		const { ch, frozen } = setupRolling(MAX_U256, false);
		const baseVersion = parseInt(frozen.baseVersionHex, 16);
		const result = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId,
				ntime: parseInt(frozen.ntimeHex, 16),
				version: (baseVersion ^ 0x00002000) >>> 0, // inside the BIP320 mask — still rejected when rolling is off
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS }
		);
		expect(result).toEqual({ kind: 'reject', reason: 'other', errorCode: 'version-rolling-not-allowed' });
	});

	it('rolling allowed: a version with bits outside the BIP320 mask (0x1fffe000) is rejected version-rolling-not-allowed', () => {
		const { ch, frozen } = setupRolling(MAX_U256, true);
		const baseVersion = parseInt(frozen.baseVersionHex, 16);
		const result = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId,
				ntime: parseInt(frozen.ntimeHex, 16),
				version: (baseVersion ^ 0x00000001) >>> 0, // bit 0 is OUTSIDE the mask
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS }
		);
		expect(result).toEqual({ kind: 'reject', reason: 'other', errorCode: 'version-rolling-not-allowed' });
	});

	/**
	 * The cairn-qfez8.29 regression this whole suite exists to catch: BEFORE the
	 * fix, `validateSubmit` decoded+validated `msg.version` but always hashed the
	 * header at the job's closure-captured BASE version (job.ts's `headerFor` had
	 * no version param) — so a rolled-version share would grade against the WRONG
	 * hash. This test picks a channel target sitting EXACTLY between the
	 * base-version hash and the rolled-version hash for one fixed (nonce,
	 * extranonce): the two versions are on OPPOSITE sides of the accept/reject
	 * line, so whichever version `validateSubmit` actually hashes with is
	 * unambiguous from the accept/reject outcome alone.
	 */
	it('rolling allowed: validateSubmit hashes the SUBMITTED (rolled) version, not the job base version', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, 1n, true); // placeholder target, set precisely below
		const built = buildJob(TEMPLATE_A, cfg('vr-precise', true));
		const variant = built.personalize({ payoutScript: AUTH_A.payoutScript });
		const baseVersionHex = built.job.versionHex;
		const baseVersion = parseInt(baseVersionHex, 16);
		const rolledVersion = (baseVersion ^ 0x00002000) >>> 0; // one bit inside the mask
		const rolledVersionHex = rolledVersion.toString(16).padStart(8, '0');
		const nonceHex = '00000007';
		const en2Hex = '30303030';
		// extended channel, min_extranonce_size 4: server prefix IS en1 (4 bytes),
		// the submitted extranonce IS en2 — exactly what validateSubmit reconstructs.
		const en1Hex = ch.extranoncePrefixHex;
		expect(en1Hex).toHaveLength(8);

		const baseHeader = variant.headerFor(en1Hex, en2Hex, built.job.ntimeHex, nonceHex); // default = base version
		const rolledHeader = variant.headerFor(en1Hex, en2Hex, built.job.ntimeHex, nonceHex, rolledVersionHex);
		const hashA = hashValueFromDisplay(headerHashDisplay(baseHeader));
		const hashB = hashValueFromDisplay(headerHashDisplay(rolledHeader));
		expect(hashA).not.toBe(hashB); // sanity: version really does change the hash

		// Target = the SMALLER of the two hashes: exactly one version's hash
		// clears it, the other doesn't.
		const target = hashA < hashB ? hashA : hashB;
		ch.target = target;
		const { frozen } = installJob(ch, built, NOW_MS);

		const result = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen.sv2JobId,
				ntime: parseInt(frozen.ntimeHex, 16),
				version: rolledVersion,
				nonce: 7,
				extranonce: Buffer.from(en2Hex, 'hex')
			},
			{ nowMs: NOW_MS }
		);
		if (hashB <= target) {
			// The rolled version's hash is the one that clears the target — the
			// FIX accepts here; the pre-fix bug (always hashing at baseVersion,
			// hashA > target in this branch) would have rejected.
			expect(result.kind).not.toBe('reject');
		} else {
			// The rolled version's hash MISSES the target — the FIX rejects
			// low_difficulty here; the pre-fix bug (always hashing at baseVersion,
			// hashA == target in this branch, which clears it) would have
			// WRONGLY accepted.
			expect(result.kind).toBe('reject');
			if (result.kind === 'reject') expect(result.errorCode).toBe('difficulty-too-low');
		}
	});

	it('rolling allowed: a solve carries the SUBMITTED (rolled) version on the SolveEvent, and re-`assemble`ing at that version reproduces the exact solved block hash', () => {
		const { ch, frozen, built } = setupRolling(NETWORK_TARGET, true); // channel target == network target: easy solve
		const baseVersion = parseInt(frozen.baseVersionHex, 16);
		const rolledVersion = (baseVersion ^ 0x00004000) >>> 0;
		const base: Omit<SubmitSharesExtended, 'nonce'> = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: rolledVersion,
			extranonce: Buffer.from('cafed00d', 'hex')
		};
		const { result } = findNonceForKind(ch, frozen.sv2JobId, base, 'solve', { nowMs: NOW_MS });
		expect(result.kind).toBe('solve');
		if (result.kind !== 'solve') return;
		expect(result.solveEvent.versionHex).toBe(rolledVersion.toString(16).padStart(8, '0'));
		// Mirrors MiningPool.handleSolve exactly: re-personalize + assemble with
		// the SolveEvent's own (rolled) versionHex.
		const variant = built.personalize({ payoutScript: AUTH_A.payoutScript });
		const assembled = variant.assemble(
			result.solveEvent.extranonce1Hex,
			result.solveEvent.extranonce2Hex,
			result.solveEvent.ntimeHex,
			result.solveEvent.nonceHex,
			result.solveEvent.versionHex
		);
		expect(assembled.blockHashDisplay).toBe(result.solveEvent.hashDisplay);
		// Assembling at the BASE version instead would NOT reproduce the same
		// hash — proving the versionHex plumbing is load-bearing, not a no-op.
		const assembledAtBase = variant.assemble(
			result.solveEvent.extranonce1Hex,
			result.solveEvent.extranonce2Hex,
			result.solveEvent.ntimeHex,
			result.solveEvent.nonceHex
		);
		expect(assembledAtBase.blockHashDisplay).not.toBe(result.solveEvent.hashDisplay);
	});
});

// --- Standard-channel submit path --------------------------------------------

describe('validateSubmit — standard channel', () => {
	it('validates SubmitSharesStandard (no extranonce field) against the server-computed merkle root', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openStandard(AUTH_A, 'alice.rig1', MAX_U256, false);
		const built = buildJob(TEMPLATE_A, cfg('std-job', true));
		const { frozen } = installJob(ch, built, NOW_MS);

		const msg: SubmitSharesStandard = {
			channelId: ch.id,
			sequenceNumber: 1,
			jobId: frozen.sv2JobId,
			ntime: parseInt(frozen.ntimeHex, 16),
			version: parseInt(frozen.baseVersionHex, 16),
			nonce: 12345
		};
		const result = validateSubmit(ch, msg, { nowMs: NOW_MS });
		expect(result.kind).not.toBe('reject');
	});
});

// --- Money-path invariants -----------------------------------------------------

describe('frozen-payout invariant', () => {
	it('every job announced on a channel pays that channel’s auth, immutably — a differently-authed channel never affects it', () => {
		const reg = new ChannelRegistry();
		const chA = reg.openExtended(AUTH_A, 'alice.rig1', 4, 1n, false);
		const builtClean = buildJob(TEMPLATE_A, cfg('pay-1', true));
		const { frozen: frozen1 } = installJob(chA, builtClean, NOW_MS);

		// A "wallet change" in the real system re-resolves auth for NEW
		// connections/channels only — simulate it by opening a second channel
		// with a different MinerAuth for the same underlying template.
		const chB = reg.openExtended(AUTH_B, 'alice.rig1-after-change', 4, 1n, false);
		const { frozen: frozen2 } = installJob(chB, builtClean, NOW_MS + 100);

		expect(frozen1.variant.coinb2Hex).not.toBe(frozen2.variant.coinb2Hex);
		const parsed1 = bitcoin.Transaction.fromHex(
			frozen1.variant.coinb1Hex + frozen1.en1PrefixHex + '00000000' + frozen1.variant.coinb2Hex
		);
		expect(parsed1.outs[0]!.script.equals(Buffer.from(AUTH_A.payoutScript))).toBe(true);

		// A second job on chA (refresh — same channel, same auth) still pays A,
		// proving the payout never drifts within a channel's lifetime.
		const builtRefresh = buildJob(TEMPLATE_A, cfg('pay-2', false));
		const { frozen: frozen3 } = installJob(chA, builtRefresh, NOW_MS + 200);
		const parsed3 = bitcoin.Transaction.fromHex(
			frozen3.variant.coinb1Hex + frozen3.en1PrefixHex + '00000000' + frozen3.variant.coinb2Hex
		);
		expect(parsed3.outs[0]!.script.equals(Buffer.from(AUTH_A.payoutScript))).toBe(true);
		expect(chA.auth).toBe(AUTH_A); // channel auth identity never silently changes
	});
});

describe('announce-time-target invariant', () => {
	it('a later channel-target change (SetTarget-style) never retroactively alters an already-announced job', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, 100n, false);
		const built1 = buildJob(TEMPLATE_A, cfg('tgt-1', true));
		const { frozen: frozen1 } = installJob(ch, built1, NOW_MS);
		expect(frozen1.target).toBe(100n);

		// Vardiff/SetTarget: bump the channel's live target upward.
		ch.target = 999_999n;

		// A refresh job (same channel, same prevhash) picks up the NEW target...
		const built2 = buildJob(TEMPLATE_A, cfg('tgt-2', false));
		const { frozen: frozen2 } = installJob(ch, built2, NOW_MS + 100);
		expect(frozen2.target).toBe(999_999n);

		// ...but the first job's frozen target is untouched, and still governs
		// validation for shares submitted against it.
		expect(ch.jobs.get(frozen1.sv2JobId)?.target).toBe(100n);

		const submitAgainstOld = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen1.sv2JobId,
				ntime: parseInt(frozen1.ntimeHex, 16),
				version: parseInt(frozen1.baseVersionHex, 16),
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS + 200 }
		);
		// 100n is an all-but-impossible target — expect a difficulty rejection,
		// never anything that would imply the share was graded at 999_999n.
		expect(submitAgainstOld).toEqual({ kind: 'reject', reason: 'low_difficulty', errorCode: 'difficulty-too-low' });
	});
});

describe('job invalidation on new prevhash', () => {
	it('a clean (new-prevhash) install invalidates every job previously queued on the channel', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, MAX_U256, false);
		const built1 = buildJob(TEMPLATE_A, cfg('inv-1', true));
		const { frozen: frozen1 } = installJob(ch, built1, NOW_MS);
		expect(ch.jobs.has(frozen1.sv2JobId)).toBe(true);

		const built2 = buildJob(TEMPLATE_B, cfg('inv-2', true)); // new prevhash, cleanJobs=true
		const { frozen: frozen2 } = installJob(ch, built2, NOW_MS + 100);
		expect(ch.jobs.has(frozen1.sv2JobId)).toBe(false);
		expect(ch.jobs.has(frozen2.sv2JobId)).toBe(true);

		const staleSubmit = validateSubmit(
			ch,
			{
				channelId: ch.id,
				sequenceNumber: 1,
				jobId: frozen1.sv2JobId,
				ntime: parseInt(frozen1.ntimeHex, 16),
				version: parseInt(frozen1.baseVersionHex, 16),
				nonce: 0,
				extranonce: Buffer.from('00000000', 'hex')
			},
			{ nowMs: NOW_MS + 200 }
		);
		expect(staleSubmit).toEqual({ kind: 'reject', reason: 'stale', errorCode: 'stale-job' });
	});

	it('refresh (cleanJobs=false) installs keep prior jobs valid', () => {
		const reg = new ChannelRegistry();
		const ch = reg.openExtended(AUTH_A, 'alice.rig1', 4, MAX_U256, false);
		const built1 = buildJob(TEMPLATE_A, cfg('r-1', true));
		const { frozen: frozen1 } = installJob(ch, built1, NOW_MS);
		const built2 = buildJob(TEMPLATE_A, cfg('r-2', false)); // fee-bump refresh, same prevhash
		installJob(ch, built2, NOW_MS + 100);
		expect(ch.jobs.has(frozen1.sv2JobId)).toBe(true);
	});
});
