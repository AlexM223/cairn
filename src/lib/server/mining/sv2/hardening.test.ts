/**
 * Sv2Server edge-case / hardening sweep (Phase 5 addendum, cairn-qfez8.10
 * deliverable c). Complements sv2Server.test.ts's happy-path + basic DoS-guard
 * coverage (handshake timeout, pre-auth byte flood, maxConnections, malformed
 * post-handshake frame, duplicate-share reject — all already covered there)
 * with the remaining edge cases from the P5 brief: mid-handshake disconnect
 * cleanup, abrupt post-open socket loss pruning the channel, an oversized
 * declared msg_length after a completed handshake, Act1 filled with garbage,
 * and rapid connect/disconnect churn. Every case asserts the server stays
 * healthy for OTHER connections afterward — the "never crash the app" rule
 * is only proven if the process (and the listener) survives to serve the next
 * peer, not just that this one test doesn't throw.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as bitcoin from 'bitcoinjs-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from '../address';
import { buildJob } from '../job';
import { MapAuthProvider, type BuiltJob, type GbtTemplate, type MinerAuth } from '../types';
import { issueCert } from './authority';
import { MSG, encodeSetupConnection } from './codec';
import { randomSecret32, staticFromSecret } from './crypto';
import { ACT1_LEN, ACT2_LEN, NoiseInitiator } from './noise';
import { sealFrame } from './frames';
import { Sv2Server, type Sv2ServerOptions } from './sv2Server';
import { Sv2TestClient, mineOnce, u256LEToBigint, type MineParams } from './testClient';

const REGTEST = NETWORKS.regtest;
const POOL_TAG = 'heartwood-sv2-hardening';
const EASY_NBITS = '207fffff';

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
		walletId: 2000 + nextUser,
		address,
		payoutScript: addressToOutputScript(address, REGTEST)
	};
}

function makeTemplate(seed: string, height = 600): GbtTemplate {
	return {
		version: 0x20000000,
		previousblockhash: createHash('sha256').update(seed).digest('hex'),
		height,
		curtime: 1_753_000_000,
		bits: EASY_NBITS,
		coinbasevalue: 5_000_000_000,
		transactions: []
	};
}

function makeBuilt(template: GbtTemplate, jobId: string): BuiltJob {
	return buildJob(template, { network: REGTEST, poolTag: POOL_TAG, jobId, cleanJobs: true });
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

interface Harness {
	server: Sv2Server;
	authorityXonly32: Uint8Array;
	authProvider: MapAuthProvider;
}

function makeServer(overrides: Partial<Sv2ServerOptions> = {}): Harness {
	const { authorityXonly32, material } = makeAuthority();
	const authProvider = new MapAuthProvider();
	const server = new Sv2Server({
		port: 0,
		host: '127.0.0.1',
		shareDifficulty: 0.000001,
		network: REGTEST,
		authProvider,
		onShare: () => {},
		onSolve: () => {},
		onReject: () => {},
		blockPolicyShift: 0,
		authority: material,
		log: () => {},
		...overrides
	});
	return { server, authorityXonly32, authProvider };
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

async function connectRawSocket(port: number): Promise<net.Socket> {
	const socket = net.connect(port, '127.0.0.1');
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('error', reject);
	});
	socket.on('error', () => {}); // tests intentionally destroy sockets; don't crash on ECONNRESET
	return socket;
}

async function waitClose(socket: net.Socket, timeoutMs = 5000): Promise<void> {
	if (socket.destroyed) return;
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`socket did not close within ${timeoutMs}ms`)), timeoutMs);
		socket.once('close', () => {
			clearTimeout(t);
			resolve();
		});
	});
}

async function until(cond: () => boolean, ms: number, label: string): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function connectClient(h: Harness): Promise<{ client: Sv2TestClient; socket: net.Socket }> {
	const socket = await connectRawSocket(h.server.port);
	const client = new Sv2TestClient(h.authorityXonly32);
	await client.connect(socket);
	return { client, socket };
}

/** Full end-to-end proof the server is still healthy: handshake, setup, open an
 *  extended channel, receive a job, mine + submit an accepted share. */
async function assertServerStillHealthy(h: Harness): Promise<void> {
	const miner = makeMiner(`health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	h.authProvider.set(miner);
	h.server.setJob(makeBuilt(makeTemplate(`health-tip-${miner.miningId}`), `health-job-${miner.miningId}`));
	const { client, socket } = await connectClient(h);
	try {
		await client.setupConnection();
		const open = await client.openExtendedChannel(miner.miningId);
		const job = await client.awaitJob(open.channelId);
		const prevHash = await client.awaitPrevHash(open.channelId);
		const extendedJob = job.kind === 'extended' ? job.msg : (() => { throw new Error('expected extended'); })();
		const base: MineParams = {
			job: extendedJob,
			prevHash,
			extranoncePrefix: open.extranoncePrefix,
			extranonce: Buffer.from('0000cafe', 'hex'),
			target: u256LEToBigint(open.target)
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
	} finally {
		client.close();
		socket.destroy();
	}
}

describe('Sv2Server hardening — mid-handshake disconnect', () => {
	it('sockets destroyed before completing Act1 are cleaned up server-side (no connection-slot leak)', async () => {
		const h = track(makeServer({ maxConnections: 2 }));
		await h.server.listen();

		// Well beyond maxConnections=2 stale half-open attempts, each destroyed
		// before ever sending a full 64-byte Act1. If the server leaked a slot per
		// abandoned handshake, the maxConnections cap would starve real clients.
		for (let i = 0; i < 5; i++) {
			const socket = await connectRawSocket(h.server.port);
			socket.write(randomBytes(10)); // well short of ACT1_LEN(64) — handshake never completes
			socket.destroy();
			await waitClose(socket);
		}

		await assertServerStillHealthy(h);
	}, 20_000);
});

describe('Sv2Server hardening — abrupt post-open socket loss', () => {
	it('destroying the client socket after a channel is open prunes the channel (minerCount -> 0)', async () => {
		const h = track(makeServer());
		await h.server.listen();
		const miner = makeMiner('abrupt-loss');
		h.authProvider.set(miner);
		h.server.setJob(makeBuilt(makeTemplate('tip-abrupt'), 'job-abrupt'));

		const { client, socket } = await connectClient(h);
		await client.setupConnection();
		const open = await client.openExtendedChannel(miner.miningId);
		expect(open.channelId).toBeGreaterThan(0);
		expect(h.server.minerCount).toBe(1);
		expect(h.server.connections()).toHaveLength(1);

		// Abrupt loss, not a clean CloseChannel/FIN — simulates a crashed miner.
		socket.destroy();
		await until(() => h.server.minerCount === 0, 5000, 'channel pruned after abrupt socket loss');
		expect(h.server.connections()).toHaveLength(0);

		await assertServerStillHealthy(h);
	}, 20_000);
});

describe('Sv2Server hardening — oversized post-handshake frame', () => {
	it('a frame declaring msg_length beyond the DoS cap is dropped (connection killed); other connections keep being served', async () => {
		const h = track(makeServer());
		await h.server.listen();

		// A raw Noise initiator (not going through Sv2TestClient) so we control
		// the exact bytes sent after the handshake completes.
		const initiator = new NoiseInitiator({ authorityXonly32: h.authorityXonly32 });
		const socket = await connectRawSocket(h.server.port);
		const act2 = await new Promise<Buffer>((resolve, reject) => {
			let buf = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				if (buf.length >= ACT2_LEN) {
					socket.removeListener('data', onData);
					resolve(buf.subarray(0, ACT2_LEN));
				}
			};
			socket.on('data', onData);
			socket.once('error', reject);
			socket.write(Buffer.from(initiator.writeAct1()));
		});
		initiator.readAct2(act2);
		const { send } = initiator.split();

		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		// A real (huge, but under the U24 wire ceiling) payload — sealFrame derives
		// msg_length from payload.length, so this genuinely declares > MAX_MSG_LEN.
		const hugePayload = Buffer.alloc(1_048_577, 0x41); // MAX_MSG_LEN (1 MiB) + 1
		const frame = sealFrame(send, MSG.SetupConnection, false, hugePayload);
		socket.write(Buffer.from(frame));
		await closed;

		await assertServerStillHealthy(h);
	}, 20_000);
});

describe('Sv2Server hardening — garbage Act1', () => {
	it('64 bytes of garbage as Act1 never crashes the server; the session is torn down cleanly and other peers are unaffected', async () => {
		const h = track(makeServer());
		await h.server.listen();

		const socket = await connectRawSocket(h.server.port);
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		const gotAct2 = new Promise<void>((resolve) => {
			let buf = Buffer.alloc(0);
			socket.on('data', (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				if (buf.length >= ACT2_LEN) resolve();
			});
		});

		// EllSwift is defined to decode ANY 64-byte string, so the responder does
		// not necessarily throw on readAct1 — the important guarantee is that the
		// server never crashes, and any garbage that follows (which can never be
		// valid ciphertext for keys the "attacker" never legitimately derived)
		// is cleanly rejected.
		expect(() => socket.write(randomBytes(ACT1_LEN))).not.toThrow();
		await gotAct2; // server produced a well-formed Act2 without throwing

		socket.write(randomBytes(128)); // garbage instead of a valid encrypted frame
		await closed;

		await assertServerStillHealthy(h);
	}, 20_000);
});

describe('Sv2Server hardening — rapid connect/disconnect churn', () => {
	it('20x rapid connect/disconnect leaves the server listening and able to serve a real client', async () => {
		const h = track(makeServer());
		await h.server.listen();

		for (let i = 0; i < 20; i++) {
			const socket = await connectRawSocket(h.server.port);
			socket.destroy();
			await waitClose(socket);
		}

		expect(h.server.listening).toBe(true);
		expect(h.server.minerCount).toBe(0);
		await assertServerStillHealthy(h);
	}, 20_000);
});
