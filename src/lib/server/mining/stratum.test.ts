/**
 * StratumServer contract tests over real localhost sockets. Adapted from the
 * Tessera pool Stratum spec for the SOLO multi-user server: authorization goes
 * through an injected AuthProvider (miningId → MinerAuth), and every job is
 * personalized per connection. The stub BuiltJob's headerFor incorporates the
 * miner's payout script, so a share is only valid against the coinbase the
 * SUBMITTING connection was announced — the property these tests pin.
 */
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as bitcoin from 'bitcoinjs-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from './address';
import { MapAuthProvider, type BuiltJob, type MinerAuth, type ShareEvent, type SolveEvent, type StratumJob } from './types';
import { STRATUM_ERRORS, StratumServer, type StratumServerOptions } from './stratum';
import { bitsToTarget, difficultyToTarget, hashValueFromDisplay, headerHashDisplay, toStratumPrevHash } from './wire';

const REGTEST = NETWORKS.regtest;

/** Lowest representable pool difficulty → highest share target — pre-mining stays fast. */
const DIFF = 0.000001;
const SHARE_TARGET = difficultyToTarget(DIFF);
const EASY_NBITS = '207fffff';
const SHIFT4_SOLVE_TARGET = (() => {
	const shifted = SHARE_TARGET >> 4n;
	const network = bitsToTarget(EASY_NBITS);
	return shifted < network ? shifted : network;
})();

const PREV_DISPLAY = '0a'.repeat(32);

/** Deterministic regtest p2wpkh address from a label. */
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

/** Deterministic 80-byte stub header from (jobId, payoutScript, en, ntime, nonce). */
function stubHeaderFor(jobId: string, payoutHex: string, en1: string, en2: string, ntime: string, nonce: string): Buffer {
	const a = createHash('sha256').update(`${jobId}|${payoutHex}|${en1}|${en2}|${ntime}|${nonce}`).digest();
	const b = createHash('sha256').update(a).digest();
	return Buffer.concat([a, b, a.subarray(0, 16)]);
}

/** Contract-sanctioned stub BuiltJob: personalize() varies by payout script. */
function stubJob(jobId: string, overrides: Partial<StratumJob> = {}): BuiltJob {
	const job: StratumJob = {
		jobId,
		prevHashDisplay: PREV_DISPLAY,
		prevHashStratum: toStratumPrevHash(PREV_DISPLAY),
		merkleBranchesInternalHex: ['ab'.repeat(32)],
		versionHex: '20000000',
		nbitsHex: EASY_NBITS,
		ntimeHex: '68400000',
		height: 102,
		coinbaseValueSats: 5_000_000_000n,
		cleanJobs: true,
		...overrides
	};
	return {
		job,
		personalize: ({ payoutScript }) => {
			const pHex = Buffer.from(payoutScript).toString('hex');
			return {
				coinb1Hex: '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1402660a',
				coinb2Hex: 'ffffffff01' + pHex + '00000000',
				headerFor: (en1, en2, ntime, nonce) => stubHeaderFor(jobId, pHex, en1, en2, ntime, nonce),
				assemble: () => {
					throw new Error('assemble is not exercised by stratum tests');
				}
			};
		}
	};
}

function hashValueFor(jobId: string, payoutHex: string, en1: string, en2: string, ntime: string, nonce: string): bigint {
	return hashValueFromDisplay(headerHashDisplay(stubHeaderFor(jobId, payoutHex, en1, en2, ntime, nonce)));
}

function findNonce(
	jobId: string,
	payoutHex: string,
	en1: string,
	en2: string,
	ntime: string,
	pred: (v: bigint) => boolean
): string {
	for (let n = 0; n < 4_000_000; n++) {
		const nonce = n.toString(16).padStart(8, '0');
		if (pred(hashValueFor(jobId, payoutHex, en1, en2, ntime, nonce))) return nonce;
	}
	throw new Error('no nonce satisfying predicate within 4M attempts');
}

interface RpcResponse {
	id: number | string | null;
	result: unknown;
	error: [number, string, unknown] | null;
}

function errCode(r: RpcResponse): number {
	expect(r.error).not.toBeNull();
	return r.error![0];
}

/** Minimal raw-socket Stratum client. */
class TestClient {
	private readonly sock = new net.Socket();
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (m: RpcResponse) => void; timer: NodeJS.Timeout }>();
	private readonly queue: { method: string; params: unknown[] }[] = [];
	private readonly waiters: { method: string; resolve: (p: unknown[]) => void; timer: NodeJS.Timeout }[] = [];
	readonly log: { method: string; params: unknown[] }[] = [];
	private readonly closedP: Promise<void>;

	constructor() {
		let buf = '';
		this.sock.on('data', (chunk: Buffer) => {
			buf += chunk.toString('utf8');
			let idx: number;
			while ((idx = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line.length > 0) this.onMessage(JSON.parse(line) as Record<string, unknown>);
			}
		});
		this.sock.on('error', () => {});
		this.closedP = new Promise((resolve) => this.sock.once('close', () => resolve()));
	}

	private onMessage(msg: Record<string, unknown>): void {
		if (typeof msg.method === 'string') {
			const note = { method: msg.method, params: Array.isArray(msg.params) ? (msg.params as unknown[]) : [] };
			this.log.push(note);
			const wi = this.waiters.findIndex((w) => w.method === note.method);
			if (wi >= 0) {
				const w = this.waiters.splice(wi, 1)[0]!;
				clearTimeout(w.timer);
				w.resolve(note.params);
			} else {
				this.queue.push(note);
			}
			return;
		}
		if (typeof msg.id === 'number') {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				clearTimeout(p.timer);
				p.resolve(msg as unknown as RpcResponse);
			}
		}
	}

	connect(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const onErr = (e: Error) => reject(e);
			this.sock.once('error', onErr);
			this.sock.connect(port, '127.0.0.1', () => {
				this.sock.removeListener('error', onErr);
				resolve();
			});
		});
	}

	request(method: string, params: unknown[], timeoutMs = 4000): Promise<RpcResponse> {
		const id = this.nextId++;
		const p = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for response to ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
		});
		this.sock.write(JSON.stringify({ id, method, params }) + '\n');
		return p;
	}

	notification(method: string, timeoutMs = 4000): Promise<unknown[]> {
		const idx = this.queue.findIndex((n) => n.method === method);
		if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]!.params);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
			this.waiters.push({ method, resolve, timer });
		});
	}

	raw(data: string): void {
		this.sock.write(data);
	}

	waitClose(timeoutMs = 4000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs);
			void this.closedP.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	destroy(): void {
		this.sock.destroy();
	}
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error('condition not met in time');
		await new Promise((r) => setTimeout(r, 10));
	}
}

interface Harness {
	server: StratumServer;
	provider: MapAuthProvider;
	shares: ShareEvent[];
	solves: SolveEvent[];
	rejects: string[];
	clients: TestClient[];
	newClient(): Promise<TestClient>;
	miner(auth: MinerAuth, worker?: string): Promise<{ client: TestClient; en1: string }>;
	stop(): Promise<void>;
}

async function startHarness(over: Partial<StratumServerOptions> = {}, miners: MinerAuth[] = []): Promise<Harness> {
	const provider = new MapAuthProvider(miners);
	const shares: ShareEvent[] = [];
	const solves: SolveEvent[] = [];
	const rejects: string[] = [];
	const server = new StratumServer({
		port: 0,
		shareDifficulty: DIFF,
		network: REGTEST,
		authProvider: provider,
		onShare: (e) => shares.push(e),
		onSolve: (e) => solves.push(e),
		onReject: (e) => rejects.push(e.reason),
		...over
	});
	await server.listen();
	const clients: TestClient[] = [];
	const newClient = async () => {
		const c = new TestClient();
		await c.connect(server.port);
		clients.push(c);
		return c;
	};
	return {
		server,
		provider,
		shares,
		solves,
		rejects,
		clients,
		newClient,
		miner: async (auth: MinerAuth, worker = 'rig1') => {
			const client = await newClient();
			const sub = await client.request('mining.subscribe', ['stratum-spec/1']);
			const en1 = (sub.result as [unknown, string, number])[1];
			const authResp = await client.request('mining.authorize', [`${auth.miningId}.${worker}`, 'x']);
			expect(authResp.result).toBe(true);
			return { client, en1 };
		},
		stop: async () => {
			for (const c of clients) c.destroy();
			await server.close();
		}
	};
}

// ---------------------------------------------------------------------------

describe('subscribe / authorize (AuthProvider)', async () => {
	const MINER_A = makeMiner('auth-a');
	const h = await startHarness({}, [MINER_A]);
	afterAll(() => h.stop());

	it('subscribe returns a notify subscription, an 8-hex extranonce1, and en2 size 4', async () => {
		const c = await h.newClient();
		const r = await c.request('mining.subscribe', ['agent/1']);
		expect(r.error).toBeNull();
		const [subs, en1, en2Size] = r.result as [unknown[][], string, number];
		expect(subs[0]![0]).toBe('mining.notify');
		expect(en1).toMatch(/^[0-9a-f]{8}$/);
		expect(en2Size).toBe(4);
		const r2 = await c.request('mining.subscribe', ['agent/1']);
		expect((r2.result as [unknown, string, number])[1]).toBe(en1);
	});

	it('assigns a unique extranonce1 per connection', async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const c = await h.newClient();
			const r = await c.request('mining.subscribe', []);
			seen.add((r.result as [unknown, string, number])[1]);
		}
		expect(seen.size).toBe(5);
	});

	it('authorize with a known miningId → true, then set_difficulty then this miner\'s personalized notify', async () => {
		const built = stubJob('auth-job');
		h.server.setJob(built);
		const c = await h.newClient();
		await c.request('mining.subscribe', []);
		const authResp = await c.request('mining.authorize', [`${MINER_A.miningId}.rigX`, 'pass']);
		expect(authResp.result).toBe(true);
		expect(authResp.error).toBeNull();

		const diff = await c.notification('mining.set_difficulty');
		expect(diff).toEqual([DIFF]);
		const notify = await c.notification('mining.notify');
		// notify carries THIS miner's personalized coinb2 (its payout script).
		const pHex = Buffer.from(MINER_A.payoutScript).toString('hex');
		expect(notify[0]).toBe('auth-job');
		expect(notify[3]).toContain(pHex);
		const iDiff = c.log.findIndex((n) => n.method === 'mining.set_difficulty');
		const iNotify = c.log.findIndex((n) => n.method === 'mining.notify');
		expect(iNotify).toBeGreaterThan(iDiff);
	});

	it('rejects an unknown/revoked miningId with UNAUTHORIZED (24)', async () => {
		const c = await h.newClient();
		await c.request('mining.subscribe', []);
		const r = await c.request('mining.authorize', ['mid-does-not-exist.rig', 'x']);
		expect(r.result).toBe(false);
		expect(errCode(r as unknown as RpcResponse)).toBe(STRATUM_ERRORS.UNAUTHORIZED);
		expect(h.rejects).toContain('unauthorized');
	});

	it('rejects re-authorization on the same connection', async () => {
		const c = await h.newClient();
		await c.request('mining.subscribe', []);
		expect((await c.request('mining.authorize', [MINER_A.miningId, 'x'])).result).toBe(true);
		const again = await c.request('mining.authorize', [MINER_A.miningId, 'x']);
		expect(again.result).toBe(false);
	});

	it('tracks minerCount as authorized connections', async () => {
		const before = h.server.minerCount;
		const { client } = await h.miner(MINER_A);
		expect(h.server.minerCount).toBe(before + 1);
		client.destroy();
		await until(() => h.server.minerCount === before);
	});
});

// ---------------------------------------------------------------------------

describe('per-connection personalization on the SAME jobId', async () => {
	const A = makeMiner('pc-a');
	const B = makeMiner('pc-b');
	const h = await startHarness({}, [A, B]);
	afterAll(() => h.stop());

	it('two miners on one jobId get their OWN coinbase in notify', async () => {
		// Both authorize before any job exists (no authorize-time notify), then setJob
		// delivers exactly one personalized notify to each.
		const { client: ca } = await h.miner(A);
		const { client: cb } = await h.miner(B);
		const built = stubJob('same-job');
		h.server.setJob(built);
		const na = await ca.notification('mining.notify');
		const nb = await cb.notification('mining.notify');
		expect(na[0]).toBe('same-job');
		expect(nb[0]).toBe('same-job');
		// same jobId, same merkle branches, but different personalized coinb2
		expect(na[4]).toEqual(nb[4]);
		expect(na[3]).not.toEqual(nb[3]);
		expect(na[3]).toContain(Buffer.from(A.payoutScript).toString('hex'));
		expect(nb[3]).toContain(Buffer.from(B.payoutScript).toString('hex'));
	});
});

// ---------------------------------------------------------------------------

describe('mining.submit validation and share acceptance', async () => {
	const M = makeMiner('submitter');
	const h = await startHarness({}, [M]);
	const built = stubJob('j1');
	h.server.setJob(built);
	const { client, en1 } = await h.miner(M, 'rig9');
	const pHex = Buffer.from(M.payoutScript).toString('hex');
	afterAll(() => h.stop());

	const EN2 = '00000001';
	const goodNonce = findNonce('j1', pHex, en1, EN2, built.job.ntimeHex, (v) => v <= SHARE_TARGET);

	it('accepts a share meeting the share target and emits a typed ShareEvent', async () => {
		const r = await client.request('mining.submit', [`${M.miningId}.rig9`, 'j1', EN2, built.job.ntimeHex, goodNonce]);
		expect(r.result).toBe(true);
		expect(h.shares).toHaveLength(1);
		const share = h.shares[0]!;
		expect(share.userId).toBe(M.userId);
		expect(share.miningId).toBe(M.miningId);
		expect(share.worker).toBe('rig9');
		expect(share.difficulty).toBe(DIFF);
		expect(typeof share.timestampMs).toBe('number');
	});

	it('rejects an exact duplicate (jobId, en1, en2, nonce)', async () => {
		const r = await client.request('mining.submit', [M.miningId, 'j1', EN2, built.job.ntimeHex, goodNonce]);
		expect(errCode(r)).toBe(STRATUM_ERRORS.DUPLICATE_SHARE);
		expect(h.shares).toHaveLength(1);
	});

	it('rejects a share above the share target with LOW_DIFFICULTY and no ShareEvent', async () => {
		const badNonce = findNonce('j1', pHex, en1, '00000002', built.job.ntimeHex, (v) => v > SHARE_TARGET);
		const before = h.shares.length;
		const r = await client.request('mining.submit', [M.miningId, 'j1', '00000002', built.job.ntimeHex, badNonce]);
		expect(errCode(r)).toBe(STRATUM_ERRORS.LOW_DIFFICULTY);
		expect(h.shares).toHaveLength(before);
	});

	it('does NOT record low-difficulty submits in the dedup set', async () => {
		const lowNonce = findNonce('j1', pHex, en1, '0000aaaa', built.job.ntimeHex, (v) => v > SHARE_TARGET);
		const first = await client.request('mining.submit', [M.miningId, 'j1', '0000aaaa', built.job.ntimeHex, lowNonce]);
		expect(errCode(first)).toBe(STRATUM_ERRORS.LOW_DIFFICULTY);
		const again = await client.request('mining.submit', [M.miningId, 'j1', '0000aaaa', built.job.ntimeHex, lowNonce]);
		expect(errCode(again)).toBe(STRATUM_ERRORS.LOW_DIFFICULTY);
		const okNonce = findNonce('j1', pHex, en1, '0000aaaa', built.job.ntimeHex, (v) => v <= SHARE_TARGET);
		const ok = await client.request('mining.submit', [M.miningId, 'j1', '0000aaaa', built.job.ntimeHex, okNonce]);
		expect(ok.result).toBe(true);
		const dup = await client.request('mining.submit', [M.miningId, 'j1', '0000aaaa', built.job.ntimeHex, okNonce]);
		expect(errCode(dup)).toBe(STRATUM_ERRORS.DUPLICATE_SHARE);
	});

	it('rejects an unknown jobId as stale', async () => {
		const r = await client.request('mining.submit', [M.miningId, 'no-such-job', EN2, built.job.ntimeHex, '00000000']);
		expect(errCode(r)).toBe(STRATUM_ERRORS.STALE_JOB);
	});

	it('rejects a wrong extranonce2 length and a non-matching ntime', async () => {
		for (const en2 of ['00', '0000000000', 'zzzzzzzz']) {
			const r = await client.request('mining.submit', [M.miningId, 'j1', en2, built.job.ntimeHex, '00000000']);
			expect(errCode(r)).toBe(STRATUM_ERRORS.OTHER);
		}
		const bad = await client.request('mining.submit', [M.miningId, 'j1', '00000003', 'deadbeef', '00000000']);
		expect(errCode(bad)).toBe(STRATUM_ERRORS.OTHER);
	});

	it('rejects submit before authorize / before subscribe', async () => {
		const subOnly = await h.newClient();
		await subOnly.request('mining.subscribe', []);
		const r1 = await subOnly.request('mining.submit', [M.miningId, 'j1', EN2, built.job.ntimeHex, '00000000']);
		expect(errCode(r1)).toBe(STRATUM_ERRORS.UNAUTHORIZED);
		const authOnly = await h.newClient();
		await authOnly.request('mining.authorize', [M.miningId, 'x']);
		const r2 = await authOnly.request('mining.submit', [M.miningId, 'j1', EN2, built.job.ntimeHex, '00000000']);
		expect(errCode(r2)).toBe(STRATUM_ERRORS.NOT_SUBSCRIBED);
	});
});

// ---------------------------------------------------------------------------

describe('a share is validated against the SUBMITTING connection\'s own coinbase', async () => {
	const A = makeMiner('cross-a');
	const B = makeMiner('cross-b');
	const h = await startHarness({}, [A, B]);
	const built = stubJob('cross-job');
	h.server.setJob(built);
	const a = await h.miner(A);
	const b = await h.miner(B);
	const pA = Buffer.from(A.payoutScript).toString('hex');
	const pB = Buffer.from(B.payoutScript).toString('hex');
	afterAll(() => h.stop());

	it('a nonce valid for A (its en1+payout) is rejected on B\'s connection', async () => {
		// mined against A's coinbase (A.en1, A.payout); also verify it is NOT valid for B's coinbase
		const EN2 = '0000000c';
		const nonce = findNonce('cross-job', pA, a.en1, EN2, built.job.ntimeHex, (v) => v <= SHARE_TARGET);
		// A accepts its own share
		const rA = await a.client.request('mining.submit', [A.miningId, 'cross-job', EN2, built.job.ntimeHex, nonce]);
		expect(rA.result).toBe(true);
		// B submits the same (en2, nonce): validated against B's frozen coinbase (B.en1, B.payout) → rejected
		expect(hashValueFor('cross-job', pB, b.en1, EN2, built.job.ntimeHex, nonce) <= SHARE_TARGET).toBe(false);
		const rB = await b.client.request('mining.submit', [B.miningId, 'cross-job', EN2, built.job.ntimeHex, nonce]);
		expect(rB.result).toBeNull();
		expect(errCode(rB)).toBe(STRATUM_ERRORS.LOW_DIFFICULTY);
	});
});

// ---------------------------------------------------------------------------

describe('frozen payout: a wallet change after announce cannot move an in-flight job', async () => {
	const M = makeMiner('frozen');
	const h = await startHarness({}, [M]);
	const built = stubJob('frozen-job');
	h.server.setJob(built);
	const { client, en1 } = await h.miner(M);
	const originalPHex = Buffer.from(M.payoutScript).toString('hex');
	afterAll(() => h.stop());

	it('validates + solves against the payout frozen at notify, not the live auth', async () => {
		await client.notification('mining.notify'); // ensure the job was announced (payout frozen)
		// Miner "changes wallets" AFTER the announce: the provider now returns a different payout.
		const CHANGED = makeMiner('frozen-changed');
		h.provider.set({ ...M, address: CHANGED.address, payoutScript: CHANGED.payoutScript, walletId: 9999 });

		// A nonce mined against the ORIGINAL (frozen) payout still solves.
		const EN2 = '0000000d';
		const nonce = findNonce('frozen-job', originalPHex, en1, EN2, built.job.ntimeHex, (v) => v <= SHIFT4_SOLVE_TARGET);
		const r = await client.request('mining.submit', [M.miningId, 'frozen-job', EN2, built.job.ntimeHex, nonce]);
		expect(r.result).toBe(true);
		expect(h.solves).toHaveLength(1);
		const solve = h.solves[0]!;
		// The solve carries the FROZEN payout + address + wallet, never the changed one.
		expect(solve.payoutScriptHex).toBe(originalPHex);
		expect(solve.address).toBe(M.address);
		expect(solve.walletId).toBe(M.walletId);
		expect(solve.height).toBe(built.job.height);
		expect(solve.coinbaseValueSats).toBe(built.job.coinbaseValueSats);
	}, 30_000);
});

// ---------------------------------------------------------------------------

describe('solve gating: min(networkTarget, shareTarget >> blockPolicyShift)', () => {
	it('default shift 4: a share above the solve target does NOT solve; below it does', async () => {
		const M = makeMiner('solver');
		const h = await startHarness({}, [M]);
		try {
			const built = stubJob('solve-job');
			h.server.setJob(built);
			const { client, en1 } = await h.miner(M);
			const pHex = Buffer.from(M.payoutScript).toString('hex');
			const nt = built.job.ntimeHex;
			const shareOnly = findNonce('solve-job', pHex, en1, '0000000a', nt, (v) => v <= SHARE_TARGET && v > SHIFT4_SOLVE_TARGET);
			const r1 = await client.request('mining.submit', [M.miningId, 'solve-job', '0000000a', nt, shareOnly]);
			expect(r1.result).toBe(true);
			expect(h.solves).toHaveLength(0);
			const solveNonce = findNonce('solve-job', pHex, en1, '0000000b', nt, (v) => v <= SHIFT4_SOLVE_TARGET);
			const r2 = await client.request('mining.submit', [M.miningId, 'solve-job', '0000000b', nt, solveNonce]);
			expect(r2.result).toBe(true);
			expect(h.solves).toHaveLength(1);
			expect(h.solves[0]!.extranonce2Hex).toBe('0000000b');
		} finally {
			await h.stop();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------

describe('stale-submit rate limiting', () => {
	const STALE_PARAMS = (mid: string) => [mid, 'no-such-job', '00000000', '68400000', '00000000'];

	it('default limit 30: the 30th stale rejection survives, the 31st destroys the connection', async () => {
		const M = makeMiner('stale-default');
		const h = await startHarness({}, [M]);
		try {
			h.server.setJob(stubJob('live'));
			const { client } = await h.miner(M);
			for (let i = 0; i < 30; i++) {
				const r = await client.request('mining.submit', STALE_PARAMS(M.miningId));
				expect(errCode(r)).toBe(STRATUM_ERRORS.STALE_JOB);
			}
			expect((await client.request('mining.subscribe', [])).error).toBeNull();
			client.raw(JSON.stringify({ id: 999, method: 'mining.submit', params: STALE_PARAMS(M.miningId) }) + '\n');
			await client.waitClose();
		} finally {
			await h.stop();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------

describe('vardiff runaway ceiling', () => {
	it('rejects maxDifficulty < shareDifficulty and a non-positive target at construction', () => {
		const M = makeMiner('vd-guard');
		expect(
			() =>
				new StratumServer({
					port: 0,
					shareDifficulty: DIFF,
					network: REGTEST,
					authProvider: new MapAuthProvider([M]),
					onShare: () => {},
					onSolve: () => {},
					vardiff: { targetSharesPerMin: 5, maxDifficulty: DIFF / 2 }
				})
		).toThrow(/maxDifficulty/);
		expect(
			() =>
				new StratumServer({
					port: 0,
					shareDifficulty: DIFF,
					network: REGTEST,
					authProvider: new MapAuthProvider([M]),
					onShare: () => {},
					onSolve: () => {},
					vardiff: { targetSharesPerMin: 0 }
				})
		).toThrow(/targetSharesPerMin/);
	});

	it('never announces a difficulty above maxDifficulty under a sustained accepted-share flood', async () => {
		// maxDifficulty == shareDifficulty: every upward retarget is ceiling-clamped
		// straight back to the (minable) floor, so mining stays cheap while the
		// ceiling path is exercised on every accepted share.
		const M = makeMiner('vd-ceiling');
		let clock = 1_000_000;
		const h = await startHarness(
			{
				vardiff: {
					targetSharesPerMin: 0.001, // measured rate always exceeds → always wants to double
					maxDifficulty: DIFF,
					adjustIntervalMs: 1000,
					windowMs: 60_000,
					now: () => clock
				}
			},
			[M]
		);
		try {
			const built = stubJob('vd-job');
			h.server.setJob(built);
			const { client, en1 } = await h.miner(M);
			const pHex = Buffer.from(M.payoutScript).toString('hex');
			const nt = built.job.ntimeHex;
			let maxAnnounced = DIFF;
			for (let i = 0; i < 25; i++) {
				clock += 1500; // cross the adjust interval every share
				const en2 = (0x1000 + i).toString(16).padStart(8, '0');
				const nonce = findNonce('vd-job', pHex, en1, en2, nt, (v) => v <= SHARE_TARGET);
				const r = await client.request('mining.submit', [M.miningId, 'vd-job', en2, nt, nonce]);
				expect(r.result).toBe(true);
			}
			// Any set_difficulty the server pushed must be within [shareDifficulty, maxDifficulty].
			for (const n of client.log.filter((l) => l.method === 'mining.set_difficulty')) {
				const d = n.params[0] as number;
				expect(d).toBeLessThanOrEqual(DIFF);
				expect(d).toBeGreaterThanOrEqual(DIFF);
				maxAnnounced = Math.max(maxAnnounced, d);
			}
			expect(maxAnnounced).toBeLessThanOrEqual(DIFF);
			// connection is still alive and responsive (no crash from a runaway snap)
			expect((await client.request('mining.subscribe', [])).error).toBeNull();
		} finally {
			await h.stop();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------

describe('framing and hardening', () => {
	it('destroys the connection when the line buffer overflows (16 KiB, no newline)', async () => {
		const h = await startHarness();
		try {
			const c = await h.newClient();
			c.raw('a'.repeat(17 * 1024));
			await c.waitClose();
		} finally {
			await h.stop();
		}
	});

	it('destroys the connection on malformed JSON', async () => {
		const h = await startHarness();
		try {
			const c = await h.newClient();
			c.raw('this is not json\n');
			await c.waitClose();
		} finally {
			await h.stop();
		}
	});

	it('caps simultaneous connections at 64', async () => {
		const h = await startHarness();
		try {
			const first = await Promise.all(Array.from({ length: 64 }, () => h.newClient()));
			const extra = await h.newClient();
			await extra.waitClose();
			const r = await first[0]!.request('mining.subscribe', []);
			expect(r.error).toBeNull();
		} finally {
			await h.stop();
		}
	}, 30_000);

	it('rejects an empty host at construction', () => {
		expect(
			() =>
				new StratumServer({
					port: 0,
					host: '',
					shareDifficulty: DIFF,
					network: REGTEST,
					authProvider: new MapAuthProvider(),
					onShare: () => {},
					onSolve: () => {}
				})
		).toThrow(/host/);
	});
});
