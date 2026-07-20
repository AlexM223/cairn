/**
 * Sv2Server contract tests (Phase 4, docs/SV2-IMPLEMENTATION-PLAN.md §a.7).
 * Real loopback TCP sockets, real Noise handshake, real framing/codec — driven
 * by testClient.ts's Sv2TestClient (the exact same wire modules the server
 * uses). Mirrors stratum.test.ts's scope for the V2 listener: handshake,
 * SetupConnection, Open*Channel (auth via AuthProvider), job announce,
 * SubmitShares* accept/reject/solve, malformed-frame/garbage/timeout/
 * maxConnections DoS guards, setJob fan-out, and clean close().
 */
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as bitcoin from 'bitcoinjs-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from '../address';
import { buildJob } from '../job';
import { MapAuthProvider, type BuiltJob, type GbtTemplate, type MinerAuth, type RejectEvent, type ShareEvent, type SolveEvent } from '../types';
import { bitsToTarget } from '../wire';
import { issueCert } from './authority';
import { randomSecret32, staticFromSecret } from './crypto';
import { Sv2Server, type Sv2ServerOptions } from './sv2Server';
import { Sv2TestClient, hashValueForMine, mineOnce, mineOnceStandard, u256LEToBigint, type MineParams } from './testClient';

const REGTEST = NETWORKS.regtest;
const POOL_TAG = 'heartwood-sv2';
const EASY_NBITS = '207fffff'; // regtest-easy: ~50% of random hashes clear it

function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, REGTEST.bech32);
}

let nextUser = 1;
function makeMiner(label: string): MinerAuth {
	const address = addr(label);
	return {
		userId: nextUser++,
		miningId: `mid-${label}`,
		walletId: 1000 + nextUser,
		address,
		payoutScript: addressToOutputScript(address, REGTEST)
	};
}

function prevHashSeed(seed: string): string {
	return createHash('sha256').update(seed).digest('hex');
}

function makeTemplate(seed: string, height = 500): GbtTemplate {
	return {
		version: 0x20000000,
		previousblockhash: prevHashSeed(seed),
		height,
		curtime: 1_753_000_000,
		bits: EASY_NBITS,
		coinbasevalue: 5_000_000_000,
		transactions: []
	};
}

function makeBuilt(template: GbtTemplate, jobId: string, cleanJobs = true): BuiltJob {
	return buildJob(template, { network: REGTEST, poolTag: POOL_TAG, jobId, cleanJobs });
}

/** Fresh authority + per-server static key/cert, no DB — full control for unit tests. */
function makeAuthority(): { authorityXonly32: Uint8Array; material: Sv2ServerOptions['authority'] } {
	const authoritySecret32 = randomSecret32();
	const { xonly32: authorityXonly32 } = staticFromSecret(authoritySecret32);
	const staticSecret32 = randomSecret32();
	const { xonly32: staticXonly32, ell64: staticEll64 } = staticFromSecret(staticSecret32);
	const cert = issueCert(staticXonly32, authoritySecret32);
	return {
		authorityXonly32,
		material: {
			staticPriv32: staticSecret32,
			staticEll64,
			cert,
			reissueCert: () => issueCert(staticXonly32, authoritySecret32)
		}
	};
}

interface Harness {
	server: Sv2Server;
	authorityXonly32: Uint8Array;
	shares: ShareEvent[];
	solves: SolveEvent[];
	rejects: RejectEvent[];
	authProvider: MapAuthProvider;
}

function makeServer(overrides: Partial<Sv2ServerOptions> = {}): Harness {
	const { authorityXonly32, material } = makeAuthority();
	const shares: ShareEvent[] = [];
	const solves: SolveEvent[] = [];
	const rejects: RejectEvent[] = [];
	const authProvider = new MapAuthProvider();
	const server = new Sv2Server({
		port: 0,
		host: '127.0.0.1',
		shareDifficulty: 0.000001,
		network: REGTEST,
		authProvider,
		onShare: (e) => shares.push(e),
		onSolve: (e) => solves.push(e),
		onReject: (e) => rejects.push(e),
		blockPolicyShift: 0,
		authority: material,
		log: () => {},
		...overrides
	});
	return { server, authorityXonly32, shares, solves, rejects, authProvider };
}

async function connectClient(h: Harness): Promise<{ client: Sv2TestClient; socket: net.Socket }> {
	const socket = net.connect(h.server.port, '127.0.0.1');
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('error', reject);
	});
	socket.on('error', () => {}); // tests intentionally destroy sockets; don't crash on ECONNRESET
	const client = new Sv2TestClient(h.authorityXonly32);
	await client.connect(socket);
	return { client, socket };
}

const openServers: Sv2Server[] = [];
afterEach(async () => {
	for (const s of openServers.splice(0)) {
		try {
			await s.close();
		} catch {
			/* best-effort */
		}
	}
});

function track(h: Harness): Harness {
	openServers.push(h.server);
	return h;
}

describe('Sv2Server — handshake + SetupConnection + extended channel happy path', () => {
	it('handshake -> setup -> open extended -> receives job -> submits an accepted share -> Success ack', async () => {
		const h = track(makeServer());
		const miner = makeMiner('alice');
		h.authProvider.set(miner);
		await h.server.listen();

		const template = makeTemplate('tip-a');
		const built = makeBuilt(template, 'job-1', true);
		h.server.setJob(built);

		const { client, socket } = await connectClient(h);
		try {
			const setup = await client.setupConnection();
			expect(setup.usedVersion).toBe(2);

			const open = await client.openExtendedChannel(miner.miningId);
			expect(open.channelId).toBeGreaterThan(0);
			expect(open.extranonceSize).toBe(4);
			expect(open.extranoncePrefix).toHaveLength(4);

			const job = await client.awaitJob(open.channelId);
			expect(job.kind).toBe('extended');
			const prevHash = await client.awaitPrevHash(open.channelId);
			expect(prevHash.jobId).toBe((job as { kind: 'extended'; msg: { jobId: number } }).msg.jobId);

			const extendedJob = job.kind === 'extended' ? job.msg : (() => { throw new Error('expected extended'); })();
			const channelTarget = u256LEToBigint(open.target);
			const base: MineParams = {
				job: extendedJob,
				prevHash,
				extranoncePrefix: open.extranoncePrefix,
				extranonce: Buffer.from('00000001', 'hex'),
				target: channelTarget
			};
			const found = mineOnce(base);
			expect(found).not.toBeNull();

			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId,
				nonce: found!.nonce,
				ntime: found!.ntime,
				version: found!.version,
				extranonce: base.extranonce
			});
			expect(result.ok).toBe(true);
			expect(h.shares).toHaveLength(1);
			expect(h.shares[0]!.userId).toBe(miner.userId);
			expect(h.server.connections()).toHaveLength(1);
			expect(h.server.connections()[0]!.protocol).toBe('sv2');
			expect(h.server.minerCount).toBe(1);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);

	it('handshake -> setup -> open standard -> receives NewMiningJob with server-computed merkle root -> submits an accepted share', async () => {
		const h = track(makeServer());
		const miner = makeMiner('bob');
		h.authProvider.set(miner);
		await h.server.listen();

		const built = makeBuilt(makeTemplate('tip-b'), 'job-std-1', true);
		h.server.setJob(built);

		const { client, socket } = await connectClient(h);
		try {
			await client.setupConnection();
			const open = await client.openStandardChannel(miner.miningId);
			expect(open.extranonceSize).toBe(0);
			expect(open.extranoncePrefix).toHaveLength(8);

			const job = await client.awaitJob(open.channelId);
			expect(job.kind).toBe('standard');
			const prevHash = await client.awaitPrevHash(open.channelId);
			const stdJob = job.kind === 'standard' ? job.msg : (() => { throw new Error('expected standard'); })();

			const channelTarget = u256LEToBigint(open.target);
			const found = mineOnceStandard(stdJob, prevHash, channelTarget);
			expect(found).not.toBeNull();

			const result = await client.submitStandard({
				channelId: open.channelId,
				jobId: stdJob.jobId,
				nonce: found!.nonce,
				ntime: found!.ntime,
				version: found!.version
			});
			expect(result.ok).toBe(true);
			expect(h.shares).toHaveLength(1);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);
});

describe('Sv2Server — auth', () => {
	it('OpenExtendedMiningChannel for an unknown user_identity rejects with OpenMiningChannel.Error and fires onReject', async () => {
		const h = track(makeServer());
		await h.server.listen();
		h.server.setJob(makeBuilt(makeTemplate('tip-auth'), 'job-auth', true));

		const { client, socket } = await connectClient(h);
		try {
			await client.setupConnection();
			await expect(client.openExtendedChannel('nobody')).rejects.toThrow(/OpenMiningChannel\.Error/);
			expect(h.rejects.some((r) => r.reason === 'unauthorized')).toBe(true);
			expect(h.server.minerCount).toBe(0);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);
});

describe('Sv2Server — submit rejects', () => {
	async function openChannel(h: Harness, miner: MinerAuth, built: BuiltJob) {
		h.authProvider.set(miner);
		h.server.setJob(built);
		const { client, socket } = await connectClient(h);
		await client.setupConnection();
		const open = await client.openExtendedChannel(miner.miningId);
		const job = await client.awaitJob(open.channelId);
		const prevHash = await client.awaitPrevHash(open.channelId);
		const extendedJob = job.kind === 'extended' ? job.msg : (() => { throw new Error('expected extended'); })();
		return { client, socket, open, extendedJob, prevHash };
	}

	it('a hash above the channel target is rejected low_difficulty (SubmitShares.Error) and onReject fires', async () => {
		// A very tight (hard) share difficulty makes the channel target tiny —
		// nonce=0's hash is essentially guaranteed to exceed it.
		const h = track(makeServer({ shareDifficulty: 1e12 }));
		await h.server.listen();
		const miner = makeMiner('low-diff');
		const built = makeBuilt(makeTemplate('tip-lowdiff'), 'job-lowdiff', true);
		const { client, socket, open, extendedJob, prevHash } = await openChannel(h, miner, built);
		try {
			const channelTarget = u256LEToBigint(open.target);
			const base: MineParams = {
				job: extendedJob,
				prevHash,
				extranoncePrefix: open.extranoncePrefix,
				extranonce: Buffer.from('00000002', 'hex'),
				target: channelTarget
			};
			// Find a nonce that's definitely ABOVE the (tiny) channel target.
			let nonce = 0;
			for (; nonce < 50; nonce++) {
				if (hashValueForMine(base, nonce) > channelTarget) break;
			}
			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId,
				nonce,
				ntime: prevHash.minNtime,
				version: extendedJob.version,
				extranonce: base.extranonce
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errorCode).toBe('difficulty-too-low');
			expect(h.rejects.some((r) => r.reason === 'low_difficulty')).toBe(true);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);

	it('an unknown job_id is rejected stale-job', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const miner = makeMiner('stale');
		const built = makeBuilt(makeTemplate('tip-stale'), 'job-stale', true);
		const { client, socket, open, extendedJob, prevHash } = await openChannel(h, miner, built);
		try {
			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId + 9999,
				nonce: 0,
				ntime: prevHash.minNtime,
				version: extendedJob.version,
				extranonce: Buffer.from('00000003', 'hex')
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errorCode).toBe('stale-job');
			expect(h.rejects.some((r) => r.reason === 'stale')).toBe(true);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);

	it('resubmitting the exact same share is rejected duplicate-share', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const miner = makeMiner('dup');
		const built = makeBuilt(makeTemplate('tip-dup'), 'job-dup', true);
		const { client, socket, open, extendedJob, prevHash } = await openChannel(h, miner, built);
		try {
			const channelTarget = u256LEToBigint(open.target);
			const extranonce = Buffer.from('00000004', 'hex');
			const base: MineParams = { job: extendedJob, prevHash, extranoncePrefix: open.extranoncePrefix, extranonce, target: channelTarget };
			const found = mineOnce(base);
			expect(found).not.toBeNull();
			const submit = () =>
				client.submitExtended({
					channelId: open.channelId,
					jobId: extendedJob.jobId,
					nonce: found!.nonce,
					ntime: found!.ntime,
					version: found!.version,
					extranonce
				});
			const first = await submit();
			expect(first.ok).toBe(true);
			const second = await submit();
			expect(second.ok).toBe(false);
			if (!second.ok) expect(second.errorCode).toBe('duplicate-share');
			expect(h.rejects.some((r) => r.reason === 'duplicate')).toBe(true);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);

	it('an ntime before the job window is rejected ntime-too-old', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const miner = makeMiner('ntime');
		const built = makeBuilt(makeTemplate('tip-ntime'), 'job-ntime', true);
		const { client, socket, open, extendedJob, prevHash } = await openChannel(h, miner, built);
		try {
			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId,
				nonce: 0,
				ntime: prevHash.minNtime - 1000,
				version: extendedJob.version,
				extranonce: Buffer.from('00000005', 'hex')
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errorCode).toBe('ntime-too-old');
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);
});

describe('Sv2Server — solve path', () => {
	it('a share clearing the channel target emits a SolveEvent with the correct poolJobId/en1/en2', async () => {
		// solveTarget = min(networkTarget, channelTarget >> shift). At the default
		// low share difficulty here, channelTarget (~2^244) is SMALLER (harder)
		// than the regtest-easy network target (~2^255 for EASY_NBITS), so
		// channelTarget is the binding constraint with shift 0 — any share that
		// clears the accept threshold automatically also clears the solve gate
		// (mirrors miningPool.test.ts/stratum.test.ts's identical DIFF/EASY_NBITS pairing).
		const h = track(makeServer({ blockPolicyShift: 0 }));
		await h.server.listen();
		const miner = makeMiner('solver');
		const built = makeBuilt(makeTemplate('tip-solve'), 'job-solve', true);
		h.authProvider.set(miner);
		h.server.setJob(built);

		const { client, socket } = await connectClient(h);
		try {
			await client.setupConnection();
			const open = await client.openExtendedChannel(miner.miningId);
			const job = await client.awaitJob(open.channelId);
			const prevHash = await client.awaitPrevHash(open.channelId);
			const extendedJob = job.kind === 'extended' ? job.msg : (() => { throw new Error('expected extended'); })();
			const channelTarget = u256LEToBigint(open.target);
			expect(channelTarget < bitsToTarget(built.job.nbitsHex)).toBe(true); // sanity: channel target is the binding one
			const extranonce = Buffer.from('0000000a', 'hex');
			const base: MineParams = { job: extendedJob, prevHash, extranoncePrefix: open.extranoncePrefix, extranonce, target: channelTarget };
			const found = mineOnce(base);
			expect(found).not.toBeNull();

			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId,
				nonce: found!.nonce,
				ntime: found!.ntime,
				version: found!.version,
				extranonce
			});
			expect(result.ok).toBe(true);
			expect(h.solves).toHaveLength(1);
			const solve = h.solves[0]!;
			expect(solve.jobId).toBe(built.job.jobId); // poolJobId, not the channel-scoped sv2 job id
			expect(solve.extranonce1Hex).toBe(Buffer.from(open.extranoncePrefix).toString('hex'));
			expect(solve.extranonce2Hex).toBe(extranonce.toString('hex'));
			expect(solve.userId).toBe(miner.userId);
			expect(solve.payoutScriptHex).toBe(Buffer.from(miner.payoutScript).toString('hex'));
		} finally {
			client.close();
			socket.destroy();
		}
	}, 20_000);
});

describe('Sv2Server — DoS guards', () => {
	it('garbage bytes sent before completing the handshake exceed the pre-auth cap and disconnect', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const socket = net.connect(h.server.port, '127.0.0.1');
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', () => resolve());
			socket.once('error', reject);
		});
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		socket.on('error', () => {});
		// Flood well past HANDSHAKE_PRE_AUTH_MAX_BYTES (4096) without ever completing Act-1.
		socket.write(Buffer.alloc(20_000, 0x41));
		await closed;
	}, 10_000);

	it('a malformed encrypted frame after a completed handshake is disconnected (bad decrypt)', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const { client, socket } = await connectClient(h);
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		try {
			await client.setupConnection();
			// Random bytes are not a valid AEAD ciphertext for the established
			// transport keys — the server's EncryptedFrameReader.drain() must throw
			// and the connection must be torn down.
			client.writeRaw(Buffer.alloc(64, 0x99));
			await closed;
		} finally {
			socket.destroy();
		}
	}, 10_000);

	it('a connection that never completes the handshake is dropped after handshakeTimeoutMs', async () => {
		const h = track(makeServer({ handshakeTimeoutMs: 200 }));
		await h.server.listen();
		const socket = net.connect(h.server.port, '127.0.0.1');
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', () => resolve());
			socket.once('error', reject);
		});
		socket.on('error', () => {});
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		// Never send anything — Act1 never completes.
		await closed;
	}, 5_000);

	it('connections beyond maxConnections are destroyed at accept', async () => {
		const h = track(makeServer({ maxConnections: 1 }));
		await h.server.listen();
		const { client: c1, socket: s1 } = await connectClient(h);
		try {
			await c1.setupConnection();
			const s2 = net.connect(h.server.port, '127.0.0.1');
			const closed = new Promise<void>((resolve) => s2.once('close', () => resolve()));
			s2.on('error', () => {});
			await closed;
		} finally {
			c1.close();
			s1.destroy();
		}
	}, 10_000);
});

describe('Sv2Server — setJob fan-out + close()', () => {
	it('setJob() announces a fresh job to every open channel across multiple concurrent clients', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const minerA = makeMiner('fanout-a');
		const minerB = makeMiner('fanout-b');
		h.authProvider.set(minerA);
		h.authProvider.set(minerB);
		h.server.setJob(makeBuilt(makeTemplate('tip-fanout-1'), 'job-fanout-1', true));

		const a = await connectClient(h);
		const b = await connectClient(h);
		try {
			await a.client.setupConnection();
			await b.client.setupConnection();
			const openA = await a.client.openExtendedChannel(minerA.miningId);
			const openB = await b.client.openExtendedChannel(minerB.miningId);
			await a.client.awaitJob(openA.channelId);
			await b.client.awaitJob(openB.channelId);

			h.server.setJob(makeBuilt(makeTemplate('tip-fanout-2'), 'job-fanout-2', true));
			const jobA2 = await a.client.awaitJob(openA.channelId);
			const jobB2 = await b.client.awaitJob(openB.channelId);
			const idA = jobA2.kind === 'extended' ? jobA2.msg.jobId : -1;
			const idB = jobB2.kind === 'extended' ? jobB2.msg.jobId : -1;
			expect(idA).toBeGreaterThan(0);
			expect(idB).toBeGreaterThan(0);
			expect(h.server.connections()).toHaveLength(2);
		} finally {
			a.client.close();
			a.socket.destroy();
			b.client.close();
			b.socket.destroy();
		}
	}, 20_000);

	it('close() destroys every open connection and stops listening', async () => {
		const h = makeServer(); // not tracked — this test closes it itself
		await h.server.listen();
		const { client, socket } = await connectClient(h);
		await client.setupConnection();
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		await h.server.close();
		await closed;
		expect(h.server.listening).toBe(false);
	}, 10_000);
});
