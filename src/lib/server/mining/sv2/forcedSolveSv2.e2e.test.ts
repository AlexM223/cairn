/**
 * SV2 regtest forced-solve e2e + V1/V2 coexistence (Phase 5,
 * docs/SV2-IMPLEMENTATION-PLAN.md, bead cairn-qfez8.10 deliverable a).
 *
 * Mirrors ../forcedSolve.e2e.test.ts's shape (real regtest bitcoind via
 * scripts/qa/mining-regtest-node.mjs, same hermetic port allocation +
 * describe.skipIf(!BITCOIND_AVAILABLE || !PORT_AVAILABLE) gate) but drives the
 * engine DIRECTLY inside this vitest process rather than spawning the
 * mining-forced-solve.mjs driver as a child: unlike that driver, this suite
 * only imports modules vitest already transforms natively for every other
 * sv2/*.test.ts file (Sv2Server, MiningPool, authority.ts's settings.ts
 * dependency, etc.) — no `--experimental-transform-types` re-exec bootstrap is
 * needed here (see mining-bootstrap.mjs's doc comment for why the .mjs driver
 * needs one and this file doesn't).
 *
 * One regtest node + one MiningPool (both the V1 standard listener AND the
 * SV2 listener enabled, exactly as mining/index.ts wires them for a real
 * instance) is shared across all three cases in this file:
 *   A. SV2 extended channel: full Noise handshake -> solve -> submitblock
 *      accepted -> coinbase pays the winner's payout script exactly.
 *   B. SV2 standard channel: server-computed merkle_root -> solve -> accepted.
 *   C. V1 + V2 simultaneously connected to the SAME pool: each solves in turn
 *      (attributed to its own identity), and a pre-computed SV2 share for a
 *      job that a V1 solve has since invalidated is rejected stale-job.
 *
 * Not asserted here (unlike ../forcedSolve.e2e.test.ts): a `mining_blocks`
 * DB row / wallet receive_cursor. MiningPool is deliberately DB-free (see its
 * module doc comment — persistence is the Heartwood bridge's job, out of
 * band, driven by the SAME onBlockAccepted callback this suite already
 * exercises); wiring a throwaway DB schema here would test the bridge, not
 * the SV2 listener, so it's left to the (already-covered, protocol-agnostic)
 * V1 driver.
 */
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as bitcoin from 'bitcoinjs-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from '../address';
import { MiningPool, type MiningPoolOptions } from '../miningPool';
import { MapAuthProvider, type MinerAuth, type MiningEngineConfig, type SolveEvent } from '../types';
import { issueCert } from './authority';
import { randomSecret32, staticFromSecret } from './crypto';
import type { Sv2ServerOptions } from './sv2Server';
import { Sv2TestClient, mineOnce, mineOnceStandard, u256LEToBigint, type MineParams } from './testClient';
// Plain-JS QA harness modules, no .d.ts — tsc's checkJs infers their shapes
// well enough that the imports themselves don't need suppressing (mirrors
// ../forcedSolve.e2e.test.ts's import of the sibling mining-regtest-node.mjs).
import { bitcoindAvailable, findFreePort, startRegtestNode } from '../../../../../scripts/qa/mining-regtest-node.mjs';
import { SyntheticMiner } from '../../../../../scripts/qa/mining-miner.mjs';

const REGTEST = NETWORKS.regtest;
const POOL_TAG = 'heartwood-sv2-e2e';
const COINBASE_SHARE_DIFFICULTY = 0.000001; // parity with forcedSolve.e2e's driver: clears real regtest PoW too

function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, REGTEST.bech32);
}

let nextUser = 1;
function makeMiner(label: string): MinerAuth {
	const address = addr(label);
	return {
		userId: nextUser++,
		miningId: `mid-sv2e2e-${label}`,
		walletId: 5000 + nextUser,
		address,
		payoutScript: addressToOutputScript(address, REGTEST)
	};
}

function makeAuthority(): { authorityXonly32: Uint8Array; material: Sv2ServerOptions['authority'] } {
	const authoritySecret32 = randomSecret32();
	const { xonly32: authorityXonly32 } = staticFromSecret(authoritySecret32);
	const staticSecret32 = randomSecret32();
	const { xonly32: staticXonly32, ell64: staticEll64 } = staticFromSecret(staticSecret32);
	const cert = issueCert(staticXonly32, authoritySecret32);
	return {
		authorityXonly32,
		material: { staticPriv32: staticSecret32, staticEll64, cert, reissueCert: () => issueCert(staticXonly32, authoritySecret32) }
	};
}

// Deliberately a DISJOINT probe range from mining-regtest-node.mjs's own
// default (18453+, used by resolveRegtestPort()/../forcedSolve.e2e.test.ts's
// driver): findFreePort()'s bind-test-close probe has an inherent TOCTOU race
// (documented in its own module comment) between "confirmed free" and
// "actually bound by the real bitcoind spawn" — when two e2e suites probe the
// SAME range concurrently in separate vitest workers, both can observe the
// same port as free before either binds it, and one bitcoind fails to start
// its HTTP server. Scanning a non-overlapping range makes that collision
// structurally impossible between this file and ../forcedSolve.e2e.test.ts,
// without changing the shared harness (out of this suite's fix scope).
const SV2_E2E_PORT_RANGE_START = 18753;

async function regtestPortAvailable(): Promise<boolean> {
	try {
		await findFreePort(SV2_E2E_PORT_RANGE_START);
		return true;
	} catch {
		return false;
	}
}

const BITCOIND_AVAILABLE: boolean = await bitcoindAvailable();
// Only probe for a port if a bitcoind backend even exists — no point spinning
// up the net.Server probe on a box that will skip on BITCOIND_AVAILABLE anyway.
const PORT_AVAILABLE = BITCOIND_AVAILABLE ? await regtestPortAvailable() : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await cond()) return;
		if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
		await sleep(20);
	}
}

interface AcceptedRecord {
	solve: SolveEvent;
	blockHash: string;
	coinbaseTxid: string;
}

async function connectSv2(port: number, authorityXonly32: Uint8Array): Promise<{ client: Sv2TestClient; socket: net.Socket }> {
	const socket = net.connect(port, '127.0.0.1');
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('error', reject);
	});
	socket.on('error', () => {}); // tests intentionally destroy sockets; don't crash on ECONNRESET
	const client = new Sv2TestClient(authorityXonly32);
	await client.connect(socket);
	return { client, socket };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- QA harness RPC client has no .d.ts
type RegtestNode = any;

describe.skipIf(!BITCOIND_AVAILABLE || !PORT_AVAILABLE)('SV2 regtest forced-solve e2e + V1/V2 coexistence (cairn-qfez8.10)', () => {
	let node: RegtestNode;
	let pool: MiningPool;
	let authorityXonly32: Uint8Array;
	let authProvider: MapAuthProvider;
	let accepted: AcceptedRecord[];
	let rejected: { solve: SolveEvent; reason: string }[];
	let v1Port: number;
	let sv2Port: number;

	beforeAll(async () => {
		// $CAIRN_QA_REGTEST_PORT still wins outright if the operator pinned one
		// (matches every other harness caller); otherwise re-probe our disjoint
		// range fresh right before spawning (the top-level PORT_AVAILABLE probe
		// only proved a port WAS free at module-load time).
		const pinned = process.env.CAIRN_QA_REGTEST_PORT;
		const port = pinned && pinned !== '' ? undefined : await findFreePort(SV2_E2E_PORT_RANGE_START);
		node = await startRegtestNode(port !== undefined ? { port } : {});
		const throwaway = addr('sv2-e2e-throwaway');
		await node.rpc.call('generatetoaddress', [101, throwaway]);
		expect(await node.rpc.call('getblockcount')).toBe(101);

		const { authorityXonly32: ax, material } = makeAuthority();
		authorityXonly32 = ax;
		authProvider = new MapAuthProvider();
		accepted = [];
		rejected = [];

		const config: MiningEngineConfig = {
			bindHost: '127.0.0.1',
			port: 0,
			network: REGTEST,
			poolTag: POOL_TAG,
			shareDifficulty: COINBASE_SHARE_DIFFICULTY,
			vardiffEnabled: false,
			vardiffTargetPerMin: 6,
			maxDifficulty: 2 ** 40,
			maxConnections: 64,
			blockPolicyShift: 0,
			asicPortEnabled: false,
			asicPort: 0,
			asicShareDifficulty: COINBASE_SHARE_DIFFICULTY,
			sv2Enabled: true,
			sv2Port: 0,
			sv2ShareDifficulty: COINBASE_SHARE_DIFFICULTY,
			sv2VersionRolling: false
		};

		const opts: MiningPoolOptions = {
			rpc: { call: (method, params: unknown[] = []) => node.rpc.call(method, params) },
			config,
			authProvider,
			sv2Authority: material,
			tipPollIntervalMs: 300,
			feeRefreshMs: 3_600_000,
			onBlockAccepted: (solve, blockHash, coinbaseTxid) => accepted.push({ solve, blockHash, coinbaseTxid }),
			onBlockRejected: (solve, reason) => rejected.push({ solve, reason }),
			log: () => {}
		};
		pool = new MiningPool(opts);

		await pool.start();
		await until(() => pool.status().lastJobAt !== null, 8000, 'first job installed');
		v1Port = pool.status().port;
		const sv2Listener = pool.status().listeners.find((l) => l.role === 'sv2');
		if (!sv2Listener) throw new Error('sv2 listener not present in pool.status().listeners');
		sv2Port = sv2Listener.port;
	}, 60_000);

	afterAll(async () => {
		if (pool) await pool.stop().catch(() => {});
		if (node) await node.stop().catch(() => {});
	}, 30_000);

	/** Wait for the engine's own tip tracking to reach `height` before the next
	 *  case opens a channel — otherwise a fast-connecting client could receive
	 *  the pre-solve job (stale prevhash) and race the 300ms tip poller. */
	async function syncTip(height: number): Promise<void> {
		await until(() => pool.status().lastTipHeight === height, 8000, `engine tip synced to ${height}`);
	}

	it('extended channel: handshake -> solve -> submitblock accepted -> coinbase pays exactly the winner', async () => {
		const miner = makeMiner('ext-winner');
		authProvider.set(miner);
		const heightBefore = await node.rpc.call('getblockcount');

		const { client, socket } = await connectSv2(sv2Port, authorityXonly32);
		try {
			await client.setupConnection();
			const open = await client.openExtendedChannel(miner.miningId);
			const job = await client.awaitJob(open.channelId);
			const prevHash = await client.awaitPrevHash(open.channelId);
			const extendedJob = job.kind === 'extended' ? job.msg : (() => { throw new Error('expected an extended job'); })();
			const channelTarget = u256LEToBigint(open.target);
			const extranonce = Buffer.from('00000001', 'hex');
			const base: MineParams = { job: extendedJob, prevHash, extranoncePrefix: open.extranoncePrefix, extranonce, target: channelTarget };
			const found = mineOnce(base);
			expect(found).not.toBeNull();

			const before = accepted.length;
			const result = await client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob.jobId,
				nonce: found!.nonce,
				ntime: found!.ntime,
				version: found!.version,
				extranonce
			});
			expect(result.ok).toBe(true);
			await until(() => accepted.length === before + 1, 8000, 'block accepted callback (extended)');
			expect(pool.status().fatalErrors).toHaveLength(0);

			const rec = accepted[accepted.length - 1]!;
			expect(rec.solve.userId).toBe(miner.userId);
			expect(rec.solve.miningId).toBe(miner.miningId);

			const countAfter = await node.rpc.call('getblockcount');
			expect(countAfter).toBe(heightBefore + 1);
			const bestHash = await node.rpc.call('getbestblockhash');
			expect(bestHash).toBe(rec.blockHash); // chain tip is exactly the engine-assembled block

			const block = await node.rpc.call('getblock', [bestHash, 2]);
			const coinbaseTx = block.tx[0];
			const valueOuts = coinbaseTx.vout.filter((o: { value: number }) => o.value > 0);
			const zeroOuts = coinbaseTx.vout.filter((o: { value: number }) => o.value === 0);
			expect(valueOuts).toHaveLength(1); // solo legal gate: exactly one value-bearing output
			expect(zeroOuts.length).toBeGreaterThanOrEqual(1); // the zero-value witness commitment
			expect(valueOuts[0].scriptPubKey.address).toBe(miner.address);
			const paidSats = Math.round(valueOuts[0].value * 1e8);
			expect(paidSats).toBe(Number(rec.solve.coinbaseValueSats));
			expect(coinbaseTx.txid).toBe(rec.coinbaseTxid);

			await syncTip(heightBefore + 1);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 90_000);

	it('standard channel: server-computed merkle_root -> solve -> submitblock accepted -> coinbase pays exactly the winner', async () => {
		const miner = makeMiner('std-winner');
		authProvider.set(miner);
		const heightBefore = await node.rpc.call('getblockcount');

		const { client, socket } = await connectSv2(sv2Port, authorityXonly32);
		try {
			await client.setupConnection();
			const open = await client.openStandardChannel(miner.miningId);
			expect(open.extranonceSize).toBe(0);
			expect(open.extranoncePrefix).toHaveLength(8);
			const job = await client.awaitJob(open.channelId);
			const prevHash = await client.awaitPrevHash(open.channelId);
			const stdJob = job.kind === 'standard' ? job.msg : (() => { throw new Error('expected a standard job'); })();
			const channelTarget = u256LEToBigint(open.target);
			const found = mineOnceStandard(stdJob, prevHash, channelTarget);
			expect(found).not.toBeNull();

			const before = accepted.length;
			const result = await client.submitStandard({
				channelId: open.channelId,
				jobId: stdJob.jobId,
				nonce: found!.nonce,
				ntime: found!.ntime,
				version: found!.version
			});
			expect(result.ok).toBe(true);
			await until(() => accepted.length === before + 1, 8000, 'block accepted callback (standard)');
			expect(pool.status().fatalErrors).toHaveLength(0);

			const rec = accepted[accepted.length - 1]!;
			expect(rec.solve.userId).toBe(miner.userId);

			const countAfter = await node.rpc.call('getblockcount');
			expect(countAfter).toBe(heightBefore + 1);
			const bestHash = await node.rpc.call('getbestblockhash');
			expect(bestHash).toBe(rec.blockHash);

			const block = await node.rpc.call('getblock', [bestHash, 2]);
			const coinbaseTx = block.tx[0];
			const valueOuts = coinbaseTx.vout.filter((o: { value: number }) => o.value > 0);
			expect(valueOuts).toHaveLength(1);
			expect(valueOuts[0].scriptPubKey.address).toBe(miner.address);
			const paidSats = Math.round(valueOuts[0].value * 1e8);
			expect(paidSats).toBe(Number(rec.solve.coinbaseValueSats));

			await syncTip(heightBefore + 1);
		} finally {
			client.close();
			socket.destroy();
		}
	}, 90_000);

	it('V1 and SV2 miners share one pool; each solves in turn (own identity) and a stale SV2 resubmit after a V1 solve is rejected', async () => {
		const minerV1 = makeMiner('sim-v1');
		const minerV2 = makeMiner('sim-v2');
		authProvider.set(minerV1);
		authProvider.set(minerV2);
		const heightStart = await node.rpc.call('getblockcount');

		const v1Miner = new SyntheticMiner(v1Port);
		await v1Miner.connect();
		await v1Miner.handshake(minerV1.miningId, 'w1');

		const { client: sv2Client, socket: sv2Socket } = await connectSv2(sv2Port, authorityXonly32);
		try {
			await sv2Client.setupConnection();
			const open = await sv2Client.openExtendedChannel(minerV2.miningId);

			// Both protocols online against the same pool simultaneously.
			expect(pool.status().minerCount).toBeGreaterThanOrEqual(2);
			const conns = pool.status().connections;
			expect(conns.some((c) => c.miningId === minerV1.miningId && c.protocol !== 'sv2')).toBe(true);
			expect(conns.some((c) => c.miningId === minerV2.miningId && c.protocol === 'sv2')).toBe(true);

			// SV2 grinds + captures a share for the CURRENT job, held back (not
			// submitted) until it is guaranteed stale by a V1 solve below.
			const job0 = await sv2Client.awaitJob(open.channelId);
			const prevHash0 = await sv2Client.awaitPrevHash(open.channelId);
			const extendedJob0 = job0.kind === 'extended' ? job0.msg : (() => { throw new Error('expected an extended job'); })();
			const channelTarget = u256LEToBigint(open.target);
			const staleExtranonce = Buffer.from('0000dead', 'hex');
			const staleFound = mineOnce({
				job: extendedJob0,
				prevHash: prevHash0,
				extranoncePrefix: open.extranoncePrefix,
				extranonce: staleExtranonce,
				target: channelTarget
			});
			expect(staleFound).not.toBeNull();
			const staleJobId = extendedJob0.jobId;

			// V1 solves against its own current job -> tip advances, attributed to V1.
			const foundV1 = v1Miner.grind('00000001', { maxNonces: 8_000_000 });
			expect(foundV1).not.toBeNull();
			const okV1 = await v1Miner.submit(foundV1!.jobId, foundV1!.en2, foundV1!.nonce);
			expect(okV1).toBe(true);
			await until(
				() => accepted.length >= 1 && accepted[accepted.length - 1]!.solve.userId === minerV1.userId,
				8000,
				'v1 solve accepted, attributed to v1'
			);
			await until(async () => (await node.rpc.call('getblockcount')) === heightStart + 1, 8000, 'height +1 after v1 solve');

			// Both connections observe the post-tip-change fanned job. channels.ts
			// clears ch.jobs unconditionally on every clean job (unlike V1's
			// size-pruned JOB_WINDOW), so the SV2 side is the deterministic one to
			// assert staleness against after exactly one tip change.
			const job1 = await sv2Client.awaitJob(open.channelId);
			const prevHash1 = await sv2Client.awaitPrevHash(open.channelId);
			const extendedJob1 = job1.kind === 'extended' ? job1.msg : (() => { throw new Error('expected an extended job'); })();
			expect(extendedJob1.jobId).not.toBe(staleJobId);

			// SV2 solves against the FRESH job -> tip advances again, attributed to V2.
			const freshExtranonce = Buffer.from('0000beef', 'hex');
			const freshFound = mineOnce({
				job: extendedJob1,
				prevHash: prevHash1,
				extranoncePrefix: open.extranoncePrefix,
				extranonce: freshExtranonce,
				target: channelTarget
			});
			expect(freshFound).not.toBeNull();
			const subResult = await sv2Client.submitExtended({
				channelId: open.channelId,
				jobId: extendedJob1.jobId,
				nonce: freshFound!.nonce,
				ntime: freshFound!.ntime,
				version: freshFound!.version,
				extranonce: freshExtranonce
			});
			expect(subResult.ok).toBe(true);
			await until(
				() => accepted.length >= 2 && accepted[accepted.length - 1]!.solve.userId === minerV2.userId,
				8000,
				'sv2 solve accepted, attributed to v2'
			);
			await until(async () => (await node.rpc.call('getblockcount')) === heightStart + 2, 8000, 'height +2 after sv2 solve');

			// The pre-computed share for the now long-stale ORIGINAL job must be
			// rejected -- proving a V1-triggered tip change correctly invalidates
			// SV2 channel job state cross-protocol.
			const staleResult = await sv2Client.submitExtended({
				channelId: open.channelId,
				jobId: staleJobId,
				nonce: staleFound!.nonce,
				ntime: staleFound!.ntime,
				version: staleFound!.version,
				extranonce: staleExtranonce
			});
			expect(staleResult.ok).toBe(false);
			if (!staleResult.ok) expect(staleResult.errorCode).toBe('stale-job');

			// No third block resulted from the rejected stale resubmit.
			expect(await node.rpc.call('getblockcount')).toBe(heightStart + 2);
			expect(pool.status().fatalErrors).toHaveLength(0);
		} finally {
			v1Miner.destroy();
			sv2Client.close();
			sv2Socket.destroy();
		}
	}, 120_000);
});
