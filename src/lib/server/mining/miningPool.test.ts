/**
 * MiningPool end-to-end "forced solve" over a FAKE rpc (no bitcoind): a real
 * buildJob + a real StratumServer driven by a real localhost Stratum client.
 * The rpc hands back a fixed easy template and records submitblock; with
 * blockPolicyShift 0 and easy nbits every accepted share also solves, so a single
 * pre-mined nonce exercises the whole winning path:
 *   tip → getblocktemplate → buildJob → notify → submit → re-personalize →
 *   assemble → (assembled hash == solve hash assertion) → submitblock → callback.
 */
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as bitcoin from 'bitcoinjs-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from './address';
import { buildJob } from './job';
import { MiningPool } from './miningPool';
import { MapAuthProvider, type GbtTemplate, type MinerAuth, type MiningEngineConfig, type SolveEvent } from './types';
import { difficultyToTarget, hashValueFromDisplay, headerHashDisplay } from './wire';

const REGTEST = NETWORKS.regtest;
const DIFF = 0.000001;
const SHARE_TARGET = difficultyToTarget(DIFF);

const TIP_HASH = createHash('sha256').update('mining-pool-tip').digest('hex');
const TIP_HEIGHT = 500;

const TEMPLATE: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: TIP_HASH,
	height: TIP_HEIGHT + 1,
	curtime: 1_750_500_000,
	bits: '207fffff',
	coinbasevalue: 5_000_000_000,
	transactions: []
};

function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, REGTEST.bech32);
}

function makeMiner(label: string): MinerAuth {
	const address = addr(label);
	return { userId: 7, miningId: `mid-${label}`, walletId: 42, address, payoutScript: addressToOutputScript(address, REGTEST) };
}

/** Fake RpcLike: fixed tip + easy template; records submitblock and returns a scripted result. */
class FakeRpc {
	submitted: string[] = [];
	submitResult: string | null = null;
	gbtCalls = 0;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async call<T>(method: string, params: unknown[] = []): Promise<T> {
		switch (method) {
			case 'getbestblockhash':
				return TIP_HASH as unknown as T;
			case 'getblock':
				return { height: TIP_HEIGHT } as unknown as T;
			case 'getblocktemplate':
				this.gbtCalls++;
				return { ...TEMPLATE } as unknown as T;
			case 'submitblock':
				this.submitted.push(params[0] as string);
				return this.submitResult as unknown as T;
			default:
				throw new Error(`unexpected rpc ${method}`);
		}
	}
}

const config: MiningEngineConfig = {
	bindHost: '127.0.0.1',
	port: 0,
	network: REGTEST,
	poolTag: 'heartwood-solo',
	shareDifficulty: DIFF,
	vardiffEnabled: false,
	vardiffTargetPerMin: 5,
	maxDifficulty: 2 ** 20,
	maxConnections: 64,
	blockPolicyShift: 0 // easy nbits → every accepted share solves
};

/** Raw-socket helper: subscribe + authorize + return en1 and the notify job fields. */
async function connectMiner(
	port: number,
	miningId: string
): Promise<{ sock: net.Socket; en1: string; jobId: string; ntime: string; submit: (en2: string, nonce: string) => Promise<boolean> }> {
	const sock = net.connect(port, '127.0.0.1');
	await new Promise<void>((res, rej) => {
		sock.once('connect', () => res());
		sock.once('error', rej);
	});
	let buf = '';
	const pending = new Map<number, (r: { result: unknown; error: unknown }) => void>();
	let notifyResolve: ((p: unknown[]) => void) | null = null;
	let pendingNotify: unknown[] | null = null;
	sock.on('data', (chunk: Buffer) => {
		buf += chunk.toString('utf8');
		let idx: number;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (line.length === 0) continue;
			const m = JSON.parse(line) as { id?: number; method?: string; params?: unknown[]; result?: unknown; error?: unknown };
			if (m.method === 'mining.notify') {
				if (notifyResolve) {
					notifyResolve(m.params!);
					notifyResolve = null;
				} else pendingNotify = m.params!;
			} else if (typeof m.id === 'number' && pending.has(m.id)) {
				pending.get(m.id)!({ result: m.result, error: m.error });
				pending.delete(m.id);
			}
		}
	});
	let nextId = 1;
	const req = (method: string, params: unknown[]) =>
		new Promise<{ result: unknown; error: unknown }>((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			sock.write(JSON.stringify({ id, method, params }) + '\n');
		});
	const nextNotify = () =>
		new Promise<unknown[]>((resolve) => {
			if (pendingNotify) {
				resolve(pendingNotify);
				pendingNotify = null;
			} else notifyResolve = resolve;
		});

	const sub = await req('mining.subscribe', ['e2e/1']);
	const en1 = (sub.result as [unknown, string, number])[1];
	const auth = await req('mining.authorize', [miningId, 'x']);
	if (auth.result !== true) throw new Error('authorize failed');
	const notify = await nextNotify();
	const jobId = notify[0] as string;
	const ntime = notify[7] as string;
	const submit = async (en2: string, nonce: string) => {
		const r = await req('mining.submit', [miningId, jobId, en2, ntime, nonce]);
		return r.result === true;
	};
	return { sock, en1, jobId, ntime, submit };
}

function until(cond: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const t = setInterval(() => {
			if (cond()) {
				clearInterval(t);
				resolve();
			} else if (Date.now() - start > ms) {
				clearInterval(t);
				reject(new Error('condition not met in time'));
			}
		}, 10);
	});
}

let pool: MiningPool | null = null;
afterEach(async () => {
	if (pool) await pool.stop();
	pool = null;
});

describe('MiningPool forced solve (fake rpc)', () => {
	it('assembles + submits the exact winning block and fires onBlockAccepted', async () => {
		const rpc = new FakeRpc();
		const miner = makeMiner('winner');
		const accepted: { solve: SolveEvent; blockHash: string; coinbaseTxid: string }[] = [];
		pool = new MiningPool({
			rpc,
			config,
			authProvider: new MapAuthProvider([miner]),
			tipPollIntervalMs: 25,
			feeRefreshMs: 3_600_000,
			onBlockAccepted: (solve, blockHash, coinbaseTxid) => accepted.push({ solve, blockHash, coinbaseTxid }),
			log: () => {}
		});
		await pool.start();
		const port = pool.status().port;
		// wait until the first tip built a job
		await until(() => pool!.status().lastJobAt !== null);

		const m = await connectMiner(port, miner.miningId);
		try {
			// Grind a solving nonce locally against the real coinbase the pool built.
			const variant = buildJob(TEMPLATE, {
				network: REGTEST,
				poolTag: config.poolTag,
				jobId: m.jobId,
				cleanJobs: true
			}).personalize({ payoutScript: miner.payoutScript });
			const EN2 = '00000005';
			let nonce = '';
			for (let n = 0; n < 8_000_000; n++) {
				const cand = n.toString(16).padStart(8, '0');
				const v = hashValueFromDisplay(headerHashDisplay(variant.headerFor(m.en1, EN2, m.ntime, cand)));
				if (v <= SHARE_TARGET) {
					nonce = cand;
					break;
				}
			}
			expect(nonce).not.toBe('');
			const ok = await m.submit(EN2, nonce);
			expect(ok).toBe(true);

			await until(() => accepted.length === 1);
			const expected = variant.assemble(m.en1, EN2, m.ntime, nonce);
			expect(accepted[0]!.blockHash).toBe(expected.blockHashDisplay);
			expect(accepted[0]!.coinbaseTxid).toBe(expected.coinbaseTxidDisplay);
			// the pool submitted exactly the assembled block hex to bitcoind
			expect(rpc.submitted).toContain(expected.blockHex);
			// the solve carried the miner's frozen payout + wallet + height
			const solve = accepted[0]!.solve;
			expect(solve.payoutScriptHex).toBe(Buffer.from(miner.payoutScript).toString('hex'));
			expect(solve.walletId).toBe(miner.walletId);
			expect(solve.height).toBe(TEMPLATE.height);
			// no invariant violations
			expect(pool!.status().fatalErrors).toEqual([]);
		} finally {
			m.sock.destroy();
		}
	}, 40_000);

	it('fires onBlockRejected (non-fatal) when bitcoind rejects the block', async () => {
		const rpc = new FakeRpc();
		rpc.submitResult = 'inconclusive';
		const miner = makeMiner('rejected');
		const rejected: { solve: SolveEvent; reason: string }[] = [];
		pool = new MiningPool({
			rpc,
			config,
			authProvider: new MapAuthProvider([miner]),
			tipPollIntervalMs: 25,
			feeRefreshMs: 3_600_000,
			onBlockRejected: (solve, reason) => rejected.push({ solve, reason }),
			log: () => {}
		});
		await pool.start();
		const port = pool.status().port;
		await until(() => pool!.status().lastJobAt !== null);

		const m = await connectMiner(port, miner.miningId);
		try {
			const variant = buildJob(TEMPLATE, {
				network: REGTEST,
				poolTag: config.poolTag,
				jobId: m.jobId,
				cleanJobs: true
			}).personalize({ payoutScript: miner.payoutScript });
			const EN2 = '00000006';
			let nonce = '';
			for (let n = 0; n < 8_000_000; n++) {
				const cand = n.toString(16).padStart(8, '0');
				const v = hashValueFromDisplay(headerHashDisplay(variant.headerFor(m.en1, EN2, m.ntime, cand)));
				if (v <= SHARE_TARGET) {
					nonce = cand;
					break;
				}
			}
			expect(await m.submit(EN2, nonce)).toBe(true);
			await until(() => rejected.length === 1);
			expect(rejected[0]!.reason).toBe('inconclusive');
			// a rejection is non-fatal: fatalErrors stays clean
			expect(pool!.status().fatalErrors).toEqual([]);
		} finally {
			m.sock.destroy();
		}
	}, 40_000);
});
