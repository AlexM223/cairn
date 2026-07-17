#!/usr/bin/env node
// Load + edge-case + security harness for the Heartwood solo mining engine
// (bead cairn-vn43.2, Deliverable 2). No bitcoind required: it drives the REAL
// MiningPool + StratumServer (src/lib/server/mining/*.ts) over a FakeRpc that
// serves a fixed template and accepts submitblock. Synthetic miners
// (mining-miner.mjs) speak the real Stratum wire.
//
// Sections:
//   LOAD      60+ concurrent miners across ~20 users submitting valid shares for
//             ~N seconds. Asserts: zero fatalErrors, every accepted share
//             accounted (server onShare count == client-accepted count),
//             event-loop health (max setTimeout drift), memory bounded.
//   EDGE      partial-JSON-then-destroy, disconnect-immediately-after-submit,
//             zero-hashrate user (no NaN), maxConnections exceeded, reconfigure
//             mid-session, protocol-fuzz / oversized / malformed connections.
//   SECURITY  below-target share rejected (no stat inflation), duplicate share
//             rejected, unknown mining_id rejected, authorize-time frozen payout
//             (a miner can only ever pay its OWN script).
//
//   node scripts/qa/mining-load-test.mjs [--seconds N] [--miners M] [--users U]
import { randomBytes } from 'node:crypto';
import { ensureTsRuntime } from './mining-bootstrap.mjs';
ensureTsRuntime(import.meta.url);

const { MiningPool } = await import('../../src/lib/server/mining/miningPool.ts');
const { MapAuthProvider } = await import('../../src/lib/server/mining/types.ts');
const { NETWORKS } = await import('../../src/lib/server/mining/address.ts');
const { SyntheticMiner } = await import('./mining-miner.mjs');
const { FakeRpc, LOAD_TEMPLATE, EASY_TEMPLATE, makeMiner } = await import('./mining-fakerpc.mjs');
const { GrindPool } = await import('./mining-grind-pool.mjs');

const REGTEST = NETWORKS.regtest;
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
const RUN_SECONDS = argVal('--seconds', 60);
const MINERS = argVal('--miners', 60);
const USERS = argVal('--users', 20);
const SHARE_DIFFICULTY = 0.000001; // floor: ~2^-12 share prob (~4k hashes/share)
const PER_SHARE_MS = 15; // small inter-share pace; real throughput is CPU-bound

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const notes = [];
function check(cond, msg) {
	if (cond) notes.push(`ok   ${msg}`);
	else {
		failures.push(msg);
		console.error(`  FAIL: ${msg}`);
	}
}

function baseConfig(over = {}) {
	return {
		bindHost: '127.0.0.1',
		port: 0,
		network: REGTEST,
		poolTag: 'heartwood-load',
		shareDifficulty: SHARE_DIFFICULTY,
		vardiffEnabled: false,
		vardiffTargetPerMin: 6,
		maxDifficulty: 2 ** 40,
		maxConnections: 128,
		blockPolicyShift: 0,
		...over
	};
}

function buildAuth(nUsers) {
	const miners = [];
	for (let u = 0; u < nUsers; u++) {
		miners.push(makeMiner(`mid-${u}`, 1000 + u, 5000 + u, (u % 250) + 1, REGTEST));
	}
	return { provider: new MapAuthProvider(miners), miners };
}

async function until(cond, ms = 5000, label = 'condition') {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
		await sleep(10);
	}
}

// ---------------------------------------------------------------- LOAD section
async function runLoad() {
	console.log(`\n=== LOAD: ${MINERS} miners / ${USERS} users / ${RUN_SECONDS}s ===`);
	const rpc = new FakeRpc();
	const { provider, miners } = buildAuth(USERS);
	let onShareCount = 0;
	let onRejectCount = 0;
	const fatalSeen = [];
	const pool = new MiningPool({
		rpc,
		config: baseConfig(),
		authProvider: provider,
		tipPollIntervalMs: 250,
		feeRefreshMs: 3_600_000,
		onShare: () => {
			onShareCount++;
		},
		onReject: () => {
			onRejectCount++;
		},
		onBlockAccepted: () => {},
		log: () => {}
	});
	await pool.start();
	const port = pool.status().port;
	await until(() => pool.status().lastJobAt !== null, 5000, 'first job');

	// Event-loop drift monitor. "Sustained" stall = the loop is chronically
	// behind (p95 drift), which is the real health signal; a lone spike (GC, OS
	// scheduling) is expected and must not fail the run.
	const drifts = [];
	const DRIFT_INTERVAL = 50;
	let lastTick = Date.now();
	const driftTimer = setInterval(() => {
		const now = Date.now();
		const drift = now - lastTick - DRIFT_INTERVAL;
		lastTick = now;
		drifts.push(Math.max(0, drift));
	}, DRIFT_INTERVAL);

	const rssStart = process.memoryUsage().rss;
	let rssPeak = rssStart;

	// Connect miners: MINERS miners spread across USERS users.
	const conns = [];
	for (let i = 0; i < MINERS; i++) {
		const m = miners[i % USERS];
		const miner = new SyntheticMiner(port);
		await miner.connect();
		await miner.handshake(m.miningId, `w${i}`);
		conns.push(miner);
	}
	console.log(`  ${conns.length} miners connected & handshaken`);
	check(pool.status().minerCount === MINERS, `engine reports all ${MINERS} miners authorized`);

	// Drive shares for RUN_SECONDS. Grinding runs on a worker-thread pool so the
	// CPU cost stays OFF the main thread — the drift monitor then measures the
	// engine + socket IO (the system under test), not the load generator.
	const grindPool = new GrindPool();
	const deadline = Date.now() + RUN_SECONDS * 1000;
	let clientSent = 0;
	const workers = conns.map(async (miner, idx) => {
		let en2n = idx * 100_003 + 1;
		while (Date.now() < deadline) {
			const en2 = (en2n++ >>> 0).toString(16).padStart(8, '0');
			try {
				const jobId = miner.job.jobId;
				const found = await grindPool.grind(miner.jobForPool(), miner.en1, en2, miner.targetHex(), 200_000);
				if (found) {
					const ok = await miner.submit(jobId, found.en2, found.nonce);
					if (ok) clientSent++;
				}
			} catch {
				/* socket race at teardown */
			}
			const rss = process.memoryUsage().rss;
			if (rss > rssPeak) rssPeak = rss;
			await sleep(PER_SHARE_MS);
		}
	});
	await Promise.all(workers);
	await grindPool.close();
	clearInterval(driftTimer);

	// Let the last in-flight submit responses drain.
	await until(() => onShareCount >= clientSent, 5000, 'share accounting drain').catch(() => {});

	const rssEnd = process.memoryUsage().rss;
	const mb = (b) => (b / 1048576).toFixed(1);
	const sharesPerSec = (onShareCount / RUN_SECONDS).toFixed(1);
	drifts.sort((a, b) => a - b);
	const maxDrift = drifts.length ? drifts[drifts.length - 1] : 0;
	const p95 = drifts.length ? drifts[Math.floor(drifts.length * 0.95)] : 0;
	const over = drifts.filter((d) => d > 250).length;
	console.log(`  shares accepted (server): ${onShareCount}  client-confirmed: ${clientSent}  rejects: ${onRejectCount}`);
	console.log(`  throughput: ${sharesPerSec} shares/s sustained`);
	console.log(`  event-loop drift: p95 ${p95}ms  max ${maxDrift}ms  samples>250ms ${over}/${drifts.length}`);
	console.log(`  rss start ${mb(rssStart)}MB  peak ${mb(rssPeak)}MB  end ${mb(rssEnd)}MB  growth ${mb(rssEnd - rssStart)}MB`);

	check(pool.status().fatalErrors.length === 0, 'no engine fatalErrors under load');
	check(onShareCount === clientSent, `every client-confirmed share accounted server-side (${onShareCount}==${clientSent})`);
	check(onShareCount > MINERS, `meaningful share volume produced (${onShareCount})`);
	check(p95 < 250, `no sustained event-loop stall (p95 drift ${p95}ms < 250ms; max ${maxDrift}ms)`);
	check(rssEnd - rssStart < 200 * 1048576, `rss growth bounded (<200MB, was ${mb(rssEnd - rssStart)}MB)`);
	check(rpc.submitted.length === 0, 'no spurious block submits (hard template ⇒ shares are not solves)');

	for (const m of conns) m.destroy();
	await pool.stop();
	return { onShareCount, sharesPerSec, p95, maxDrift, rssGrowthMB: mb(rssEnd - rssStart) };
}

// ---------------------------------------------------------------- EDGE section
async function runEdge() {
	console.log('\n=== EDGE CASES ===');
	const rpc = new FakeRpc();
	const { provider, miners } = buildAuth(6);
	let onShareCount = 0;
	const pool = new MiningPool({
		rpc,
		config: baseConfig({ maxConnections: 8 }),
		authProvider: provider,
		tipPollIntervalMs: 250,
		feeRefreshMs: 3_600_000,
		onShare: () => {
			onShareCount++;
		},
		onBlockAccepted: () => {},
		log: () => {}
	});
	await pool.start();
	const port = pool.status().port;
	await until(() => pool.status().lastJobAt !== null, 5000, 'first job');

	// (1) partial JSON then socket destroy — engine unaffected.
	{
		const good = new SyntheticMiner(port);
		await good.connect();
		await good.handshake(miners[0].miningId, 'ok');
		const bad = new SyntheticMiner(port);
		await bad.connect();
		bad.writeRaw('{"id":1,"method":"mining.sub'); // half a line, no newline
		bad.destroy();
		await sleep(150);
		check(await good.mineOneShare('0000aa01'), 'healthy miner still mines after a peer sends partial JSON + destroys');
		check(pool.status().fatalErrors.length === 0, 'partial-JSON peer did not fault the engine');
		good.destroy();
	}

	// (2) disconnect immediately after submit — the share is still counted.
	{
		const m = new SyntheticMiner(port);
		await m.connect();
		await m.handshake(miners[1].miningId, 'flash');
		const before = onShareCount;
		const found = m.grind('0000bb01', { maxNonces: 200_000 });
		// Fire the submit and destroy the socket without awaiting the ack.
		m.writeRaw(JSON.stringify({ id: 99, method: 'mining.submit', params: ['_', found.jobId, found.en2, m.job.ntimeHex, found.nonce] }) + '\n');
		m.destroy();
		await until(() => onShareCount === before + 1, 2000, 'post-destroy share count').catch(() => {});
		check(onShareCount === before + 1, 'share submitted immediately before disconnect is still counted');
	}

	// (3) zero-hashrate user: authorized, never submits — no NaN in status.
	{
		const idle = new SyntheticMiner(port);
		await idle.connect();
		await idle.handshake(miners[2].miningId, 'idle');
		await sleep(100);
		const conn = pool.status().connections.find((c) => c.miningId === miners[2].miningId);
		check(!!conn, 'idle miner appears in engine status');
		const anyNaN = pool.status().connections.some(
			(c) => Number.isNaN(c.difficulty) || Number.isNaN(c.sharesAccepted) || (c.lastShareAt !== null && Number.isNaN(c.lastShareAt))
		);
		check(!anyNaN, 'no NaN in status read model for a zero-hashrate miner');
		check(conn.sharesAccepted === 0 && conn.lastShareAt === null, 'idle miner shows 0 shares / null lastShareAt (not NaN)');
		idle.destroy();
	}

	// (4) maxConnections exceeded — the surplus connection is refused, engine stable.
	{
		await sleep(200); // let prior test sockets fully close server-side
		const cfgMax = 8;
		const held = [];
		for (let i = 0; i < cfgMax; i++) {
			const m = new SyntheticMiner(port);
			await m.connect();
			held.push(m);
		}
		await sleep(100);
		// One more than the cap: the server destroys it on accept, so it can never
		// complete a handshake.
		const over = new SyntheticMiner(port);
		await over.connect();
		let refused = false;
		try {
			await Promise.race([over.subscribe(), sleep(400).then(() => Promise.reject(new Error('timeout')))]);
		} catch {
			refused = true;
		}
		if (!refused) refused = over._closed || over.sock.destroyed;
		check(refused, `connection past maxConnections (${cfgMax}) is refused (cannot handshake)`);
		check(pool.status().fatalErrors.length === 0, 'engine stable after a refused over-cap connection');
		for (const m of held) m.destroy();
		over.destroy();
		await sleep(150);
	}

	// (5) protocol fuzz: random bytes, oversized line, malformed JSON-RPC.
	{
		const before = pool.status().fatalErrors.length;
		const fuzz1 = new SyntheticMiner(port);
		await fuzz1.connect();
		fuzz1.writeRaw(randomBytes(64).toString('hex') + '\n');
		const fuzz2 = new SyntheticMiner(port);
		await fuzz2.connect();
		fuzz2.writeRaw('x'.repeat(20_000) + '\n'); // over the 16KB line cap
		const fuzz3 = new SyntheticMiner(port);
		await fuzz3.connect();
		fuzz3.writeRaw('[1,2,3]\n'); // valid JSON, not a JSON-RPC object
		fuzz3.writeRaw(JSON.stringify({ id: 1, method: 12345 }) + '\n'); // non-string method
		await sleep(200);
		fuzz1.destroy();
		fuzz2.destroy();
		fuzz3.destroy();
		check(pool.status().fatalErrors.length === before, 'protocol-fuzz connections did not fault the engine');
		// A healthy miner still works afterward.
		const good = new SyntheticMiner(port);
		await good.connect();
		await good.handshake(miners[3].miningId, 'post-fuzz');
		check(await good.mineOneShare('0000cc01'), 'engine still serves a healthy miner after fuzz');
		good.destroy();
	}

	await pool.stop();

	// (6) reconfigure mid-session: stop + start a fresh engine while miners are
	//     connected. Miners reconnect to the new listener; no crash, no
	//     double-counted aggregates.
	{
		const rpc2 = new FakeRpc();
		let shareCount2 = 0;
		const mk = (cfg) =>
			new MiningPool({
				rpc: rpc2,
				config: cfg,
				authProvider: provider,
				tipPollIntervalMs: 250,
				feeRefreshMs: 3_600_000,
				onShare: () => {
					shareCount2++;
				},
				onBlockAccepted: () => {},
				log: () => {}
			});
		let engine = mk(baseConfig());
		await engine.start();
		const p1 = engine.status().port;
		const m = new SyntheticMiner(p1);
		await m.connect();
		await m.handshake(miners[4].miningId, 'reconf');
		await until(() => engine.status().lastJobAt !== null, 5000, 'job p1');
		check(await m.mineOneShare('0000dd01'), 'share accepted before reconfigure');
		const countAtStop = shareCount2;
		m.destroy();
		await engine.stop(); // "settings change" ⇒ full stop
		// Fresh engine with new settings (poolTag changed).
		engine = mk(baseConfig({ poolTag: 'heartwood-reconfigured' }));
		await engine.start();
		const p2 = engine.status().port;
		await until(() => engine.status().lastJobAt !== null, 5000, 'job p2');
		const m2 = new SyntheticMiner(p2);
		await m2.connect();
		await m2.handshake(miners[4].miningId, 'reconf');
		check(await m2.mineOneShare('0000dd02'), 'miner reconnects and mines after reconfigure');
		check(shareCount2 === countAtStop + 1, `no double-count across reconfigure (${shareCount2}==${countAtStop + 1})`);
		check(engine.status().fatalErrors.length === 0, 'engine clean after reconfigure');
		m2.destroy();
		await engine.stop();
	}
}

// ------------------------------------------------------------ SECURITY section
async function runSecurity() {
	console.log('\n=== SECURITY SPOT-CHECKS ===');
	const rpc = new FakeRpc();
	const { provider, miners } = buildAuth(3);
	let onShareCount = 0;
	let onRejectCount = 0;
	const rejects = [];
	const solves = [];
	// High difficulty so a RANDOM nonce's hash almost always EXCEEDS the share
	// target — makes it trivial to submit a genuinely below-target (low-diff)
	// share and prove it's rejected without stat inflation.
	const pool = new MiningPool({
		rpc,
		config: baseConfig({ shareDifficulty: 1_000_000, blockPolicyShift: 0 }),
		authProvider: provider,
		tipPollIntervalMs: 250,
		feeRefreshMs: 3_600_000,
		onShare: () => {
			onShareCount++;
		},
		onReject: (e) => {
			onRejectCount++;
			rejects.push(e.reason);
		},
		onBlockAccepted: () => {},
		log: () => {}
	});
	await pool.start();
	const port = pool.status().port;
	await until(() => pool.status().lastJobAt !== null, 5000, 'first job');

	// (a) below-target share rejected, no stat inflation.
	{
		const m = new SyntheticMiner(port);
		await m.connect();
		await m.handshake(miners[0].miningId, 'lowdiff');
		const before = onShareCount;
		// nonce 0 at diff 1e6 ⇒ hash overwhelmingly exceeds the tiny target.
		const r = await m.submitRaw(m.job.jobId, '00000001', m.job.ntimeHex, '00000000');
		check(r.result !== true, 'a share below the announced difficulty target is rejected');
		check(onShareCount === before, 'a rejected low-difficulty share does NOT inflate accepted stats');
		check(rejects.includes('low_difficulty'), "reject reason is 'low_difficulty'");
		m.destroy();
	}

	// (b) duplicate share rejected. Use an easy pool so the first submit is
	//     accepted, then replay the exact same (en2,nonce).
	{
		const dupPool = new MiningPool({
			rpc: new FakeRpc(),
			config: baseConfig(),
			authProvider: provider,
			tipPollIntervalMs: 250,
			feeRefreshMs: 3_600_000,
			onReject: (e) => rejects.push(`dup:${e.reason}`),
			onBlockAccepted: () => {},
			log: () => {}
		});
		await dupPool.start();
		const dp = dupPool.status().port;
		await until(() => dupPool.status().lastJobAt !== null, 5000, 'dup job');
		const m = new SyntheticMiner(dp);
		await m.connect();
		await m.handshake(miners[0].miningId, 'dup');
		const found = m.grind('0000ee01', { maxNonces: 200_000 });
		const first = await m.submitRaw(found.jobId, found.en2, m.job.ntimeHex, found.nonce);
		const second = await m.submitRaw(found.jobId, found.en2, m.job.ntimeHex, found.nonce);
		check(first.result === true, 'first submit of a valid share accepted');
		check(second.result !== true, 'identical resubmit (duplicate share) rejected');
		check(rejects.includes('dup:duplicate'), "duplicate reject reason is 'duplicate'");
		m.destroy();
		await dupPool.stop();
	}

	// (c) unknown mining_id rejected at authorize.
	{
		const m = new SyntheticMiner(port);
		await m.connect();
		await m.subscribe();
		const ok = await m.authorize('mid-does-not-exist', 'ghost');
		check(ok === false, 'authorize with an unknown mining_id is rejected');
		m.destroy();
	}

	// (d) authorize-time frozen payout: a miner can ONLY pay its own script.
	//     Solve on an easy pool and assert the SolveEvent carries THIS miner's
	//     payout — not another user's — proving payout is frozen to the
	//     authorizing identity and unspoofable over the wire.
	{
		const solvePool = new MiningPool({
			rpc: new FakeRpc(EASY_TEMPLATE), // easy nbits ⇒ every accepted share solves
			config: baseConfig({ blockPolicyShift: 0 }),
			authProvider: provider,
			tipPollIntervalMs: 250,
			feeRefreshMs: 3_600_000,
			onBlockAccepted: (solve) => solves.push(solve),
			log: () => {}
		});
		await solvePool.start();
		const sp = solvePool.status().port;
		await until(() => solvePool.status().lastJobAt !== null, 5000, 'solve job');
		const meIdx = 1;
		const me = miners[meIdx];
		const m = new SyntheticMiner(sp);
		await m.connect();
		await m.handshake(me.miningId, 'frozen');
		// Grind to a solve (blockPolicyShift 32 ⇒ many shares also solve).
		let solved = false;
		for (let k = 0; k < 40 && !solved; k++) {
			const found = m.grind((k + 1).toString(16).padStart(8, '0'), { maxNonces: 200_000 });
			if (found) await m.submit(found.jobId, found.en2, found.nonce);
			await sleep(30);
			solved = solves.length > 0;
		}
		check(solves.length > 0, 'produced a solve for the frozen-payout check');
		if (solves.length > 0) {
			const s = solves[0];
			const mine = Buffer.from(me.payoutScript).toString('hex');
			const others = miners.filter((_, i) => i !== meIdx).map((o) => Buffer.from(o.payoutScript).toString('hex'));
			check(s.payoutScriptHex === mine, "solve pays the authorizing miner's OWN frozen payout script");
			check(!others.includes(s.payoutScriptHex), 'solve does NOT pay any other user (payout isolation on the wire)');
			check(s.userId === me.userId && s.walletId === me.walletId, 'solve attributes to the authorizing user/wallet');
		}
		m.destroy();
		await solvePool.stop();
	}

	await pool.stop();
}

// ------------------------------------------------------------------------ main
async function main() {
	const t0 = Date.now();
	let load;
	try {
		load = await runLoad();
		await runEdge();
		await runSecurity();
	} catch (err) {
		failures.push(`unhandled: ${err.stack ?? err.message}`);
		console.error('FATAL', err);
	}
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log('\n================ MINING LOAD / EDGE / SECURITY REPORT ================');
	console.log(`elapsed ${elapsed}s   assertions: ${notes.length} ok, ${failures.length} failed`);
	if (load) console.log(`load: ${load.onShareCount} shares @ ${load.sharesPerSec}/s, drift p95 ${load.p95}ms / max ${load.maxDrift}ms, rss growth ${load.rssGrowthMB}MB`);
	if (failures.length === 0) {
		console.log('RESULT: PASS');
	} else {
		console.log(`RESULT: FAIL — ${failures.length} assertion(s):`);
		for (const f of failures) console.log(`  x ${f}`);
	}
	console.log('=====================================================================');
	process.exit(failures.length === 0 ? 0 : 1);
}

main();
