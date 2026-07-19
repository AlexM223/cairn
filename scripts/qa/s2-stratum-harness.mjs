#!/usr/bin/env node
// s2-stratum-harness.mjs — Stratum V1 protocol + regtest block-lifecycle QA
// harness for the Heartwood solo mining engine, driven against a LIVE,
// already-running engine instance (never starts/stops/configures one itself).
//
// Speaks the real wire via SyntheticMiner (scripts/qa/mining-miner.mjs), which
// itself imports the engine's own src/lib/server/mining/wire.ts byte-order/hash
// math — never reimplemented — so every assertion here exercises the exact
// code path a real Bitaxe/cpuminer would.
//
// KEY MATH (read before changing grind parameters): a share at pool difficulty
// D requires, on average, D * 2^32 double-SHA256 attempts (DIFF1_TARGET's
// 2^256/target ratio is ~2^32). At the s2 stack's floor difficulty 0.5 that is
// ~2.15e9 hashes — NOT the "trivial regtest" case naive intuition suggests,
// because share difficulty is an ABSOLUTE diff1-relative target, entirely
// independent of how easy the regtest chain's own nbits target is. Measured
// single-thread JS throughput on this box was ~300k hashes/sec (see the
// benchmark note in the QA report), i.e. ~2 hours single-threaded. This harness
// instead parallelizes the grind across worker_threads (scripts/qa/
// s2-grind-worker.mjs), one fixed extranonce2 per worker, all mining the SAME
// live job (rebroadcast whenever the engine's 30s fee-refresh / new-tip rotates
// it) — bringing the wall-clock ETA down roughly linearly with core count.
//
// BLOCK_POLICY_SHIFT is hardcoded to 0 for this engine (src/lib/server/mining/
// index.ts) regardless of network, and on regtest the chain's own nbits target
// (nbits 207fffff) is astronomically easier than any realistic share
// difficulty. So solveTarget = min(networkTarget, shareTarget >> 0) ==
// shareTarget: on THIS stack, every ACCEPTED share at the connection's
// difficulty is ALSO a block solve. One grind therefore proves both "accepted
// share" and "block lifecycle" — there is no separate, harder block-solve
// grind to do here (see stratum.ts:669-691, miningPool.test.ts:5).
//
// Usage:
//   node scripts/qa/s2-stratum-harness.mjs [options]
//
// Options (all optional; defaults match the s2 QA stack):
//   --port <n>             stratum port under full test (default 3343)
//   --host <ip>            (default 127.0.0.1)
//   --mining-id <id>       (default hw_a1b2c3d4)
//   --worker <name>        (default s2worker)
//   --min-diff <n>         expected announced floor difficulty on --port (default 0.5)
//   --asic-port <n>        secondary/ASIC port for dual-floor check (default 3334); 0 disables
//   --asic-min-diff <n>    expected announced floor difficulty on --asic-port (default 65536)
//   --rpc-url <url>        bitcoind RPC base (default http://127.0.0.1:<stack rpcPort or 18453>/)
//   --rpc-user / --rpc-pass  (default from .s2-stack.json, else heartwoodqa/heartwoodqa)
//   --db-path <path>       sqlite DB path (default C:/dev/cairn/data/qa-s2.db)
//   --api-base <url>       app base URL (default http://[::1]:5290 — Vite binds the
//                          IPv6 loopback only; 127.0.0.1 is refused, see repo memory)
//   --cookie <value>       cairn_session cookie for GET /api/mining/me
//   --user-id <n>          expected user_id for DB/API assertions (default 2)
//   --miner-addr <addr>    regtest address for the +100 maturity generate (default
//                          from .s2-stack.json minerAddr)
//   --workers <n>          grind worker_thread count (default max(1, cpus-4))
//   --max-grind-ms <n>     wall-clock cap on the block-solving grind (default 25 min)
//   --skip-asic            skip the dual-port (ASIC floor) section
//   --skip-lifecycle       skip the grind + accepted/duplicate/block-lifecycle steps;
//                          still runs handshake, low-difficulty-reject, and unauthorized
//
// Exit codes: 0 = every assertion passed; 1 = one or more assertions failed;
// 2 = a hard infra error prevented running at all (e.g. stratum port refused).
import { ensureTsRuntime } from './mining-bootstrap.mjs';
ensureTsRuntime(import.meta.url);

import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const { SyntheticMiner } = await import('./mining-miner.mjs');
const { difficultyToTarget } = await import('../../src/lib/server/mining/wire.ts');
const { STRATUM_ERRORS } = await import('../../src/lib/server/mining/stratum.ts');

// ---------------------------------------------------------------- CLI args
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}
const argv = parseArgs(process.argv.slice(2));

function stackDefaults() {
	const p = 'C:/dev/cairn/scripts/qa/.s2-stack.json';
	if (existsSync(p)) {
		try {
			return JSON.parse(readFileSync(p, 'utf8'));
		} catch {
			return {};
		}
	}
	return {};
}
const stack = stackDefaults();

const PORT = Number(argv.port ?? 3343);
const HOST = String(argv.host ?? '127.0.0.1');
const MINING_ID = String(argv['mining-id'] ?? 'hw_a1b2c3d4');
const WORKER_NAME = String(argv.worker ?? 's2worker');
const MIN_DIFF = Number(argv['min-diff'] ?? 0.5);
const ASIC_PORT = argv['skip-asic'] ? 0 : Number(argv['asic-port'] ?? 3334);
const ASIC_MIN_DIFF = Number(argv['asic-min-diff'] ?? 65536);
const RPC_URL = String(argv['rpc-url'] ?? `http://127.0.0.1:${stack.rpcPort ?? 18453}/`);
const RPC_USER = String(argv['rpc-user'] ?? stack.rpcUser ?? 'heartwoodqa');
const RPC_PASS = String(argv['rpc-pass'] ?? stack.rpcPass ?? 'heartwoodqa');
const DB_PATH = String(argv['db-path'] ?? 'C:/dev/cairn/data/qa-s2.db');
// Vite in this repo binds the IPv6 loopback only (repo memory hazard); 127.0.0.1
// gets ECONNREFUSED even though the server is up. Default to [::1].
const API_BASE = String(argv['api-base'] ?? 'http://[::1]:5290');
const COOKIE = String(argv.cookie ?? 'cairn_session=mamY2UGtZfZfThSkGAyVsUAh2CSXXNBSifG6gEiOkBk');
const USER_ID = Number(argv['user-id'] ?? 2);
const MINER_ADDR = String(argv['miner-addr'] ?? stack.minerAddr ?? '');
const GRIND_WORKERS = Number(argv.workers ?? Math.max(1, cpus().length - 4));
const MAX_GRIND_MS = Number(argv['max-grind-ms'] ?? 25 * 60_000);
const SKIP_LIFECYCLE = Boolean(argv['skip-lifecycle']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- bookkeeping
const results = [];
function check(name, pass, detail = '') {
	results.push({ name, pass, detail });
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
	return pass;
}
function section(title) {
	console.log(`\n=== ${title} ===`);
}

// --------------------------------------------------------------- bitcoind RPC
let rpcSeq = 1;
async function rpc(method, params = []) {
	const body = JSON.stringify({ jsonrpc: '1.0', id: rpcSeq++, method, params });
	const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
	const res = await fetch(RPC_URL, {
		method: 'POST',
		headers: { 'content-type': 'text/plain', authorization: `Basic ${auth}` },
		body
	});
	const j = await res.json();
	if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
	return j.result;
}

async function apiMiningMe() {
	const res = await fetch(`${API_BASE}/api/mining/me`, { headers: { cookie: COOKIE } });
	if (res.status !== 200) throw new Error(`GET /api/mining/me -> HTTP ${res.status}`);
	return res.json();
}

function queryBlockRow(hashDisplay) {
	const db = new DatabaseSync(DB_PATH, { readOnly: true });
	try {
		return db.prepare('SELECT * FROM mining_blocks WHERE block_hash = ?').get(hashDisplay) ?? null;
	} finally {
		db.close();
	}
}

/** Poll `fn` until it returns a truthy, non-throwing value, or give up. */
async function waitFor(fn, { attempts = 20, delayMs = 500, label = 'condition' } = {}) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			lastErr = e;
		}
		await sleep(delayMs);
	}
	throw new Error(`timed out waiting for: ${label}${lastErr ? ' (' + lastErr.message + ')' : ''}`);
}

// ===================================================== grind orchestration
/**
 * Parallel-grind the CURRENT job on `miner`'s connection until a share meeting
 * the connection's announced difficulty is found, or `maxMs` elapses. Tracks
 * job rotation (30s fee-refresh / new tip) and rebroadcasts to all workers.
 * Returns { jobId, en2, nonce, ntimeHex, hashDisplay } or null on timeout.
 */
async function grindForShare(miner, nWorkers, maxMs) {
	const workerUrl = pathToFileURL('C:/dev/cairn/scripts/qa/s2-grind-worker.mjs');
	const workers = [];
	let generation = 0;
	let lastJobId = null;

	function jobDescriptor() {
		const j = miner.job;
		return {
			jobId: j.jobId,
			coinb1: j.coinb1,
			coinb2: j.coinb2,
			branchesHex: j.branchesHex,
			versionHex: j.versionHex,
			prevHashDisplay: j.prevHashDisplay,
			ntimeHex: j.ntimeHex,
			nbitsHex: j.nbitsHex,
			en1: miner.en1,
			targetHex: difficultyToTarget(miner.difficulty).toString(16)
		};
	}

	function broadcastJob() {
		lastJobId = miner.job.jobId;
		const base = jobDescriptor();
		for (const w of workers) {
			w.postMessage({ type: 'job', generation, job: { ...base, en2: w.en2 } });
		}
	}

	for (let i = 0; i < nWorkers; i++) {
		const en2 = (i & 0xff).toString(16).padStart(2, '0') + '000000';
		const w = new Worker(workerUrl, { workerData: { workerId: i }, execArgv: process.execArgv });
		w.en2 = en2;
		workers.push(w);
	}

	return await new Promise((resolve) => {
		let settled = false;
		let hashesInWindow = 0;
		const t0 = Date.now();

		const finish = (val) => {
			if (settled) return;
			settled = true;
			clearInterval(rotateTimer);
			clearInterval(reportTimer);
			for (const w of workers) {
				try {
					w.postMessage({ type: 'stop' });
				} catch {
					/* already gone */
				}
				w.terminate().catch(() => {});
			}
			resolve(val);
		};

		for (const w of workers) {
			w.on('message', (msg) => {
				if (settled) return;
				if (msg.type === 'found') {
					finish({
						jobId: msg.jobId,
						en2: msg.en2,
						nonce: msg.nonce,
						ntimeHex: msg.ntimeHex,
						hashDisplay: msg.hashDisplay
					});
				} else if (msg.type === 'progress') {
					hashesInWindow += msg.hashes;
				} else if (msg.type === 'error') {
					console.error(`  [grind worker ${msg.workerId}] error: ${msg.message}`);
				}
			});
			w.on('error', (e) => console.error(`  [grind worker] thread error: ${e.message}`));
		}

		// Wait for the first job to exist, then broadcast; re-broadcast whenever
		// the connection's job rotates (fee-refresh / new tip) so no worker keeps
		// grinding a job that's fallen out of the server's JOB_WINDOW.
		broadcastJob();
		const rotateTimer = setInterval(() => {
			if (miner.job && miner.job.jobId !== lastJobId) {
				generation++;
				broadcastJob();
			}
		}, 1500);
		rotateTimer.unref?.();

		const reportTimer = setInterval(() => {
			const elapsedSec = (Date.now() - t0) / 1000;
			const rate = hashesInWindow / 10;
			const target = difficultyToTarget(miner.difficulty);
			const expectedAttempts = Number(2n ** 256n / target);
			const etaSec = rate > 0 ? Math.max(0, (expectedAttempts - elapsedSec * rate) / rate) : Infinity;
			console.log(
				`  [grind] t=${elapsedSec.toFixed(0)}s aggregate≈${(rate / 1000).toFixed(0)}k h/s ` +
					`(${workers.length} workers) remaining-ETA≈${Number.isFinite(etaSec) ? (etaSec / 60).toFixed(1) + 'min' : 'n/a'}`
			);
			hashesInWindow = 0;
		}, 10_000);
		reportTimer.unref?.();

		setTimeout(() => finish(null), maxMs).unref?.();
	});
}

// =================================================================== main
async function main() {
	console.log(`s2-stratum-harness: port=${PORT} miningId=${MINING_ID} worker=${WORKER_NAME} minDiff=${MIN_DIFF}`);
	console.log(`grind workers=${GRIND_WORKERS} (of ${cpus().length} logical CPUs) maxGrindMs=${MAX_GRIND_MS}`);

	// ---------------------------------------------------- 1. handshake
	section(`1. Handshake — subscribe / authorize / notify (port ${PORT})`);
	const miner = new SyntheticMiner(PORT, { host: HOST });
	let handshakeOk = false;
	try {
		await miner.connect();
		const subRes = await miner._req('mining.subscribe', ['heartwood-qa-harness/1']);
		check(
			'subscribe result shape [[[method,subId]], extranonce1, extranonce2size]',
			Array.isArray(subRes.result) &&
				subRes.result.length === 3 &&
				Array.isArray(subRes.result[0]) &&
				typeof subRes.result[1] === 'string' &&
				subRes.result[2] === 4,
			JSON.stringify(subRes.result)
		);
		miner.en1 = subRes.result[1];
		const authRes = await miner._req('mining.authorize', [`${MINING_ID}.${WORKER_NAME}`, 'x']);
		check(`authorize accepted for ${MINING_ID}.${WORKER_NAME}`, authRes.result === true, JSON.stringify(authRes));
		const job = await miner.nextNotify();
		check('mining.notify received after authorize', Boolean(job && job.jobId), job ? job.jobId : 'none');
		check(
			`mining.set_difficulty announced a positive difficulty (got ${miner.difficulty})`,
			typeof miner.difficulty === 'number' && miner.difficulty > 0
		);
		check(
			`announced difficulty equals expected floor ${MIN_DIFF}`,
			miner.difficulty === MIN_DIFF,
			`got ${miner.difficulty}`
		);
		handshakeOk = authRes.result === true && Boolean(job);
	} catch (err) {
		check('handshake completed without throwing', false, String(err?.stack ?? err));
	}

	if (!handshakeOk) {
		section('ABORT');
		console.log('handshake failed — cannot proceed with dependent steps. See failures above.');
		printSummaryAndExit();
		return;
	}

	// ---------------------------------------------------- 4. low-difficulty reject
	section('4. Share with a nonce that does NOT meet the target -> LOW_DIFFICULTY');
	{
		const j = miner.job;
		const en2 = 'aaaa0000';
		const nonce = '00000000';
		const r = await miner._req('mining.submit', ['_ignored', j.jobId, en2, j.ntimeHex, nonce]);
		check(
			'low-quality nonce rejected (result !== true)',
			r.result !== true,
			JSON.stringify(r)
		);
		check(
			`rejection carries LOW_DIFFICULTY error code (${STRATUM_ERRORS.LOW_DIFFICULTY})`,
			Array.isArray(r.error) && r.error[0] === STRATUM_ERRORS.LOW_DIFFICULTY,
			JSON.stringify(r.error)
		);
		check('rejection error carries a human-readable message', Array.isArray(r.error) && typeof r.error[1] === 'string' && r.error[1].length > 0, JSON.stringify(r.error));
	}

	// ---------------------------------------------------- 5. unauthorized
	section('5. Unauthorized / wrong mining_id worker');
	{
		// 5a. submit without ever authorizing on a fresh connection.
		const bad = new SyntheticMiner(PORT, { host: HOST });
		try {
			await bad.connect();
			const sub = await bad._req('mining.subscribe', ['heartwood-qa-harness-unauth/1']);
			bad.en1 = sub.result[1];
			const r = await bad._req('mining.submit', ['_ignored', 'nonexistent-job', 'bbbb0000', '00000000', '00000000']);
			check(
				'submit before authorize is rejected UNAUTHORIZED',
				r.result !== true && Array.isArray(r.error) && r.error[0] === STRATUM_ERRORS.UNAUTHORIZED,
				JSON.stringify(r)
			);
		} finally {
			bad.destroy();
		}

		// 5b. authorize with an unknown/revoked mining_id.
		const bad2 = new SyntheticMiner(PORT, { host: HOST });
		try {
			await bad2.connect();
			const sub = await bad2._req('mining.subscribe', ['heartwood-qa-harness-unauth2/1']);
			bad2.en1 = sub.result[1];
			const r = await bad2._req('mining.authorize', ['hw_deadbeef00.x', 'x']);
			check(
				'authorize with unknown mining_id rejected UNAUTHORIZED',
				r.result === false && Array.isArray(r.error) && r.error[0] === STRATUM_ERRORS.UNAUTHORIZED,
				JSON.stringify(r)
			);
		} finally {
			bad2.destroy();
		}
	}

	// ------------------------------------------- 2/3/6. grind, accept, dup, lifecycle
	let solved = null;
	let heightBefore = null;
	if (!SKIP_LIFECYCLE) {
		section(`2. Grind an accepted share on port ${PORT} (difficulty ${miner.difficulty})`);
		const expectedAttempts = miner.difficulty * 2 ** 32;
		console.log(`  expected attempts to solve ≈ ${expectedAttempts.toExponential(3)} (difficulty * 2^32)`);
		try {
			heightBefore = await rpc('getblockcount');
			console.log(`  regtest height before grind: ${heightBefore}`);
		} catch (err) {
			check('read pre-grind block height via RPC', false, String(err?.message ?? err));
		}

		solved = await grindForShare(miner, GRIND_WORKERS, MAX_GRIND_MS);
		if (solved === null) {
			check(
				`found an accepted share within ${(MAX_GRIND_MS / 60_000).toFixed(1)} min budget`,
				false,
				`timed out — see grind progress log above for measured hashrate; ` +
					`expected attempts ${expectedAttempts.toExponential(3)} at floor difficulty ${miner.difficulty}`
			);
		} else {
			console.log(`  found: jobId=${solved.jobId} en2=${solved.en2} nonce=${solved.nonce} hash=${solved.hashDisplay}`);
			const submitRes = await miner._req('mining.submit', [
				'_ignored',
				solved.jobId,
				solved.en2,
				solved.ntimeHex,
				solved.nonce
			]);
			check('ground share ACCEPTED (result === true)', submitRes.result === true, JSON.stringify(submitRes));

			section('3. Duplicate submit of the same share -> DUPLICATE_SHARE');
			const dupRes = await miner._req('mining.submit', [
				'_ignored',
				solved.jobId,
				solved.en2,
				solved.ntimeHex,
				solved.nonce
			]);
			check('duplicate submit rejected (result !== true)', dupRes.result !== true, JSON.stringify(dupRes));
			check(
				`duplicate rejection carries DUPLICATE_SHARE error code (${STRATUM_ERRORS.DUPLICATE_SHARE})`,
				Array.isArray(dupRes.error) && dupRes.error[0] === STRATUM_ERRORS.DUPLICATE_SHARE,
				JSON.stringify(dupRes.error)
			);

			section('6. Block lifecycle — bitcoind, DB, /api/mining/me, maturity');
			try {
				const newHeight = await waitFor(
					async () => {
						const h = await rpc('getblockcount');
						return h > heightBefore ? h : null;
					},
					{ attempts: 30, delayMs: 500, label: 'getblockcount to advance past the accepted share' }
				);
				check(`bitcoind getblockcount advanced (${heightBefore} -> ${newHeight})`, newHeight === heightBefore + 1, `newHeight=${newHeight}`);

				const chainHash = await rpc('getblockhash', [newHeight]);
				check(
					"new tip's block hash equals the miner's solved hash",
					chainHash === solved.hashDisplay,
					`chain=${chainHash} solved=${solved.hashDisplay}`
				);

				const block = await rpc('getblock', [chainHash, 1]);
				check('getblock returns the new block and it contains a coinbase tx', Array.isArray(block?.tx) && block.tx.length >= 1);

				const row = await waitFor(() => queryBlockRow(solved.hashDisplay), {
					attempts: 20,
					delayMs: 500,
					label: 'mining_blocks row for the solved hash'
				});
				check('mining_blocks gained a row for the solved block_hash', Boolean(row));
				if (row) {
					check(`mining_blocks.height === ${newHeight}`, row.height === newHeight, `got ${row.height}`);
					check('mining_blocks.coinbase_txid is set', typeof row.coinbase_txid === 'string' && row.coinbase_txid.length > 0);
					check(`mining_blocks.user_id === ${USER_ID}`, row.user_id === USER_ID, `got ${row.user_id}`);
					check("mining_blocks.submit_result === 'accepted'", row.submit_result === 'accepted', `got ${row.submit_result}`);
				}

				const view = await waitFor(
					async () => {
						const v = await apiMiningMe();
						const entry = v.earnings.blocksFound.find((b) => b.height === newHeight);
						return entry ? { v, entry } : null;
					},
					{ attempts: 15, delayMs: 500, label: '/api/mining/me to show the new block' }
				);
				check('GET /api/mining/me lists the new block in earnings.blocksFound', Boolean(view));
				if (view) {
					check(
						"new block shows status 'maturing' before 100 confirmations",
						view.entry.status === 'maturing',
						`got ${view.entry.status}`
					);
				}

				if (MINER_ADDR) {
					console.log(`  mining 100 blocks to ${MINER_ADDR} to mature the coinbase...`);
					await rpc('generatetoaddress', [100, MINER_ADDR]);
					const view2 = await waitFor(
						async () => {
							const v = await apiMiningMe();
							const entry = v.earnings.blocksFound.find((b) => b.height === newHeight);
							return entry && entry.status !== 'maturing' ? { entry } : null;
						},
						{ attempts: 15, delayMs: 500, label: '/api/mining/me to flip to mature after +100 blocks' }
					);
					check(
						"after +100 blocks, /api/mining/me shows the block as 'mature'",
						Boolean(view2) && view2.entry.status === 'mature',
						view2 ? `got ${view2.entry.status}` : 'entry never changed status'
					);
				} else {
					check('miner address available for the +100 maturity step', false, 'no --miner-addr and no .s2-stack.json minerAddr');
				}
			} catch (err) {
				check('block lifecycle checks completed without throwing', false, String(err?.stack ?? err));
			}
		}
	} else {
		console.log('\n(--skip-lifecycle set: skipping grind / accepted-share / duplicate / block-lifecycle sections)');
	}

	// ------------------------------------------------------- ASIC dual-floor
	if (ASIC_PORT > 0) {
		section(`ASIC dual-port floor semantics — port ${ASIC_PORT} (expected floor ${ASIC_MIN_DIFF})`);
		const asicMiner = new SyntheticMiner(ASIC_PORT, { host: HOST });
		try {
			await asicMiner.connect();
			const sub = await asicMiner._req('mining.subscribe', ['heartwood-qa-harness-asic/1']);
			asicMiner.en1 = sub.result[1];
			const auth = await asicMiner._req('mining.authorize', [`${MINING_ID}.${WORKER_NAME}-asic`, 'x']);
			check(`authorize accepted on ASIC port ${ASIC_PORT}`, auth.result === true, JSON.stringify(auth));
			const asicJob = await asicMiner.nextNotify();
			check('mining.notify received on ASIC port', Boolean(asicJob && asicJob.jobId));
			check(
				`ASIC port announces the high floor difficulty (expected ${ASIC_MIN_DIFF}, got ${asicMiner.difficulty})`,
				asicMiner.difficulty === ASIC_MIN_DIFF
			);

			// Cheap, definitive rejection: an arbitrary nonce essentially never
			// clears even the LOW (0.5) floor, let alone 65536 — grinding a real
			// 65536-difficulty share is ~2^48 hashes (~2^17x this harness's already
			// multi-minute 0.5 grind) and out of scope for a JS QA harness.
			const r = await asicMiner._req('mining.submit', [
				'_ignored',
				asicJob.jobId,
				'cccc0000',
				asicJob.ntimeHex,
				'00000000'
			]);
			check(
				'arbitrary nonce rejected on ASIC port (fails the 65536 floor a fortiori)',
				r.result !== true && Array.isArray(r.error) && r.error[0] === STRATUM_ERRORS.LOW_DIFFICULTY,
				JSON.stringify(r)
			);

			// Differential proof (computed, not a live cross-port submit — the two
			// ports assign independent extranonce1 values, so the SAME nonce would
			// hash differently there; replaying byte-for-byte across ports proves
			// nothing about difficulty, only about extranonce1 independence). Using
			// the REAL winning hash this harness ground for the standard port,
			// show analytically that it clears difficulty 0.5's target but fails
			// the ASIC port's 65536 target — the exact class of share the brief asks
			// to differentiate.
			if (solved !== null) {
				const hashValue = BigInt('0x' + solved.hashDisplay);
				const target05 = difficultyToTarget(MIN_DIFF);
				const targetAsic = difficultyToTarget(ASIC_MIN_DIFF);
				check(
					`[computed] the ${PORT} winning share clears difficulty ${MIN_DIFF}'s target`,
					hashValue <= target05
				);
				check(
					`[computed] that SAME hash value fails difficulty ${ASIC_MIN_DIFF}'s (ASIC) target`,
					hashValue > targetAsic,
					`hash=${hashValue.toString(16)} asicTarget=${targetAsic.toString(16)}`
				);
			} else {
				console.log('  (no real winning share available from section 2 to run the computed differential check against)');
			}
		} catch (err) {
			check('ASIC dual-port section completed without throwing', false, String(err?.stack ?? err));
		} finally {
			asicMiner.destroy();
		}
	} else {
		console.log('\n(--skip-asic set or --asic-port 0: skipping dual-port section)');
	}

	miner.destroy();
	printSummaryAndExit();
}

function printSummaryAndExit() {
	const failed = results.filter((r) => !r.pass);
	console.log('\n================ s2-stratum-harness RESULT ================');
	for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
	console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
	if (failed.length > 0) {
		console.log(`RESULT: FAIL (${failed.length} failure(s))`);
	} else {
		console.log('RESULT: PASS');
	}
	console.log('=============================================================');
	process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
	console.error('FATAL (uncaught):', err?.stack ?? err);
	process.exitCode = 2;
});
