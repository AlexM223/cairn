// Prod-boot smoke test (cairn-luqs QA half).
//
// Context: v0.2.34-36 shipped a boot crash on Umbrel — a phantom (undeclared)
// runtime dependency (bitcoinjs-lib, pulled in transitively) got inlined by
// adapter-node's rollup and its CJS require('@noble/hashes/ripemd160') then
// resolved to the wrong hoisted version, at runtime, in the PRODUCTION build
// only. `vite dev` and `vitest` never exercise that code path, so nothing in
// CI caught it. cairn-jj6q fixed that specific crash; cairn-luqs's dep-audit
// half (shipped v0.2.37) found and fixed the one remaining phantom dep. This
// script is the missing gate: it actually builds for production and boots
// the built server, so the WHOLE CLASS of "broke silently in prod, not dev"
// bug fails CI instead of shipping.
//
// What it does:
//   1. `npm run build` (vite build — the real production build, adapter-node
//      output) and times it.
//   2. Boots the REAL prod entrypoint — `node server.mjs` (not adapter-node's
//      own build/index.js: server.mjs is what Dockerfile CMDs and what every
//      real deployment actually runs — see server.mjs's own header comment
//      for why: it wraps adapter-node's handler with a boot-phase 503
//      placeholder + optional HTTPS listener).
//   3. Points it at a fresh throwaway temp SQLite DB (CAIRN_DB) and a
//      dead-end Electrum target (CAIRN_ELECTRUM_HOST=127.0.0.1,
//      CAIRN_ELECTRUM_PORT=1 — nothing listens on port 1, so connection
//      attempts fail fast/immediately instead of hanging or reaching a real
//      network). A FRESH temp DB matters here: chainEnvSeed.ts's
//      seedChainConfigFromEnv() only writes CAIRN_ELECTRUM_* into the
//      `settings` table when that setting has never been stored (seed-once,
//      non-destructive) — a reused/dirty DB could silently ignore the env
//      vars this script sets and dial whatever was seeded previously.
//   4. Probes a free, locally-bound TCP port (same probe pattern as
//      scripts/qa/mining-regtest-node.mjs's findFreePort/isPortFree, post
//      22e52ca/4b6d31f) so concurrent runs/dev servers never collide, and
//      binds the app to 127.0.0.1 explicitly (HOST=127.0.0.1) so this
//      script's own HTTP probe target is unambiguous — the Docker/Umbrel
//      default (HOST unset -> 0.0.0.0) is irrelevant to what we're gating.
//   5. Waits for the `cairn: app ready` stdout line (server.mjs's own
//      boot-complete signal, emitted right after the SvelteKit handler
//      import resolves), then asserts:
//        - the process is still alive N seconds after "app ready" (catches a
//          crash that happens just after the ready line, e.g. in a
//          setInterval/watcher kicked off post-boot)
//        - GET / returns a real HTTP status (2xx or 3xx — a fresh DB has no
//          admin yet, so this legitimately 302s to /setup-admin; a hang,
//          ECONNREFUSED, or 5xx fails the gate)
//        - GET /api/health returns 200 {"status":"ok"}
//        - stdout/stderr contain no fatal markers (uncaughtException,
//          unhandledRejection, or this file's own structured
//          tag:"boot",phase:"app-import" line — see server.mjs)
//   6. Sends SIGTERM and waits for clean exit (server.mjs's shutdown()),
//      force-killing after a grace period.
//   7. Prints a one-line CI-consumable summary and exits 0 (pass) or 1
//      (fail) with everything needed to diagnose without re-running.
//
// Usage: node scripts/qa/prod-boot-smoke.mjs
// Env overrides (mainly for local debugging):
//   CAIRN_QA_SMOKE_PORT       — pin the HTTP port instead of probing one free.
//   CAIRN_QA_SMOKE_SKIP_BUILD — skip step 1 and boot whatever is already in
//                               build/ (fast iteration on this script itself;
//                               NEVER set this in CI — the build IS half the
//                               gate).
//   CAIRN_QA_SMOKE_ALIVE_SECS — how long to hold the process open post-ready
//                               before probing (default 5).
//   CAIRN_QA_SMOKE_BOOT_TIMEOUT_MS — how long to wait for "app ready" before
//                               declaring a boot hang (default 60000).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ALIVE_SECS = Number(process.env.CAIRN_QA_SMOKE_ALIVE_SECS ?? 5);
const BOOT_TIMEOUT_MS = Number(process.env.CAIRN_QA_SMOKE_BOOT_TIMEOUT_MS ?? 60_000);
const FREE_PORT_RANGE_START = 18563; // above mining-regtest-node.mjs's 18453+200 range
const FREE_PORT_RANGE_ATTEMPTS = 200;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- free-port probe (same pattern as scripts/qa/mining-regtest-node.mjs) --

/** @param {number} port */
function isPortFree(port) {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once('error', () => resolve(false));
		srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			srv.close(() => resolve(true));
		});
	});
}

async function findFreePort(startPort = FREE_PORT_RANGE_START, attempts = FREE_PORT_RANGE_ATTEMPTS) {
	for (let i = 0; i < attempts; i++) {
		const candidate = startPort + i;
		if (await isPortFree(candidate)) return candidate;
	}
	throw new Error(`no free port found in range ${startPort}-${startPort + attempts - 1}`);
}

async function resolvePort() {
	const envPort = process.env.CAIRN_QA_SMOKE_PORT;
	if (envPort) {
		const parsed = Number(envPort);
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
			throw new Error(`CAIRN_QA_SMOKE_PORT must be a valid TCP port, got: ${envPort}`);
		}
		return parsed;
	}
	return findFreePort();
}

// ---- summary / result plumbing ---------------------------------------------

const summary = {
	pass: false,
	buildMs: null,
	bootMs: null,
	port: null,
	rootStatus: null,
	healthStatus: null,
	healthBody: null,
	aliveAfterSecs: null,
	fatalLines: [],
	failReason: null
};

function printSummary() {
	const lines = [
		'',
		'==================== prod-boot-smoke summary ====================',
		`result:        ${summary.pass ? 'PASS' : 'FAIL'}`,
		`build:         ${summary.buildMs === null ? 'skipped' : `${(summary.buildMs / 1000).toFixed(1)}s`}`,
		`boot:          ${summary.bootMs === null ? 'n/a' : `${(summary.bootMs / 1000).toFixed(1)}s to "app ready"`}`,
		`port:          ${summary.port ?? 'n/a'}`,
		`GET /:         ${summary.rootStatus ?? 'n/a'}`,
		`GET /api/health: ${summary.healthStatus ?? 'n/a'} ${summary.healthBody ? JSON.stringify(summary.healthBody) : ''}`,
		`alive check:   ${summary.aliveAfterSecs === null ? 'n/a' : `still running ${summary.aliveAfterSecs}s after ready`}`,
		`fatal lines:   ${summary.fatalLines.length}`
	];
	if (summary.fatalLines.length) {
		lines.push('  ' + summary.fatalLines.join('\n  '));
	}
	if (!summary.pass) {
		lines.push(`fail reason:   ${summary.failReason}`);
	}
	lines.push('===================================================================');
	console.log(lines.join('\n'));
}

function fail(reason) {
	summary.pass = false;
	summary.failReason = reason;
	printSummary();
	process.exitCode = 1;
}

// ---- step 1: production build ----------------------------------------------

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 */
function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			// Windows: spawning a .cmd shim (npm.cmd) directly without a shell
			// fails with EINVAL — this is a documented Node/Windows quirk, not
			// avoidable by resolving the .cmd path yourself. shell:true is safe
			// here specifically because `cmd`/`args` are always static literals
			// from this file, never user/network input (Node's DEP0190 warning
			// is about untrusted args, which doesn't apply).
			shell: process.platform === 'win32',
			windowsHide: true,
			...opts
		});
		let stdout = '';
		let stderr = '';
		proc.stdout?.on('data', (c) => (stdout += c));
		proc.stderr?.on('data', (c) => (stderr += c));
		proc.on('error', reject);
		proc.on('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

async function buildForProduction() {
	if (process.env.CAIRN_QA_SMOKE_SKIP_BUILD) {
		console.log('[prod-boot-smoke] CAIRN_QA_SMOKE_SKIP_BUILD set — skipping npm run build');
		return;
	}
	console.log('[prod-boot-smoke] running production build (npm run build)...');
	const start = Date.now();
	// npm run build === "vite build" per package.json scripts.build — the
	// real adapter-node production build, not `vite dev`/`vitest`.
	const { code, stdout, stderr } = await run('npm', ['run', 'build']);
	summary.buildMs = Date.now() - start;
	if (code !== 0) {
		console.error(stdout);
		console.error(stderr);
		throw new Error(`npm run build exited ${code}`);
	}
	if (!existsSync(path.join(REPO_ROOT, 'build', 'handler.js'))) {
		throw new Error('build succeeded but build/handler.js is missing — adapter-node output layout changed?');
	}
	console.log(`[prod-boot-smoke] build OK in ${(summary.buildMs / 1000).toFixed(1)}s`);
}

// ---- step 2-6: boot + assert -------------------------------------------------

const FATAL_MARKERS = [
	'uncaughtException',
	'unhandledRejection',
	'"phase":"app-import"',
	'Cannot find module',
	'ERR_MODULE_NOT_FOUND',
	'ERR_PACKAGE_PATH_NOT_EXPORTED'
];

async function bootAndAssert() {
	const port = await resolvePort();
	summary.port = port;

	const dbDir = mkdtempSync(path.join(os.tmpdir(), 'cairn-prod-boot-smoke-'));
	const dbPath = path.join(dbDir, 'smoke.db');
	const logPath = path.join(dbDir, 'smoke.log');

	console.log(`[prod-boot-smoke] temp DB dir: ${dbDir}`);
	console.log(`[prod-boot-smoke] booting node server.mjs on 127.0.0.1:${port}...`);

	const env = {
		...process.env,
		NODE_ENV: 'production',
		PORT: String(port),
		HOST: '127.0.0.1',
		CAIRN_HTTPS_PORT: '', // disable the HTTPS listener — not what this gate is testing
		CAIRN_DB: dbPath,
		CAIRN_LOG_FILE: logPath,
		// Fresh temp DB (above) means seedChainConfigFromEnv's seed-once-if-unset
		// write actually lands — a dead-end target that fails fast, never a real
		// network endpoint.
		CAIRN_ELECTRUM_HOST: '127.0.0.1',
		CAIRN_ELECTRUM_PORT: '1',
		CAIRN_ELECTRUM_TLS: 'false'
	};

	const proc = spawn('node', ['server.mjs'], {
		cwd: REPO_ROOT,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	let sawReady = false;
	let exitInfo = null;

	const captureFatal = (chunk) => {
		const text = String(chunk);
		for (const marker of FATAL_MARKERS) {
			if (text.includes(marker)) {
				summary.fatalLines.push(text.trim().slice(0, 500));
			}
		}
	};
	proc.stdout?.on('data', (c) => {
		stdoutBuf += c;
		if (stdoutBuf.length > 200_000) stdoutBuf = stdoutBuf.slice(-100_000);
		captureFatal(c);
	});
	proc.stderr?.on('data', (c) => {
		stderrBuf += c;
		if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000);
		captureFatal(c);
	});
	proc.on('exit', (code, signal) => {
		exitInfo = { code, signal };
	});

	const cleanupTemp = () => {
		try {
			rmSync(dbDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	};

	const killProc = async () => {
		if (exitInfo) return;
		proc.kill('SIGTERM');
		const deadline = Date.now() + 10_000;
		while (!exitInfo && Date.now() < deadline) await sleep(100);
		if (!exitInfo) proc.kill('SIGKILL');
	};

	try {
		const bootStart = Date.now();
		const bootDeadline = bootStart + BOOT_TIMEOUT_MS;
		while (Date.now() < bootDeadline) {
			if (stdoutBuf.includes('cairn: app ready')) {
				sawReady = true;
				break;
			}
			if (exitInfo) {
				throw new Error(
					`server.mjs exited before "app ready" (code=${exitInfo.code}, signal=${exitInfo.signal})\n` +
						`--- stdout (tail) ---\n${stdoutBuf.slice(-4000)}\n--- stderr (tail) ---\n${stderrBuf.slice(-4000)}`
				);
			}
			await sleep(150);
		}
		if (!sawReady) {
			throw new Error(
				`timed out after ${BOOT_TIMEOUT_MS}ms waiting for "cairn: app ready"\n` +
					`--- stdout (tail) ---\n${stdoutBuf.slice(-4000)}\n--- stderr (tail) ---\n${stderrBuf.slice(-4000)}`
			);
		}
		summary.bootMs = Date.now() - bootStart;
		console.log(`[prod-boot-smoke] "app ready" after ${(summary.bootMs / 1000).toFixed(1)}s`);

		// Hold it open for N seconds and confirm it doesn't crash right after
		// boot (e.g. inside a post-ready watcher/interval).
		for (let i = 0; i < ALIVE_SECS; i++) {
			await sleep(1000);
			if (exitInfo) {
				throw new Error(
					`server.mjs died ${i + 1}s after "app ready" (code=${exitInfo.code}, signal=${exitInfo.signal})\n` +
						`--- stdout (tail) ---\n${stdoutBuf.slice(-4000)}\n--- stderr (tail) ---\n${stderrBuf.slice(-4000)}`
				);
			}
		}
		summary.aliveAfterSecs = ALIVE_SECS;

		// HTTP probes — same host:port the server itself just bound.
		const base = `http://127.0.0.1:${port}`;
		const rootRes = await fetch(`${base}/`, { redirect: 'manual' }).catch((e) => {
			throw new Error(`GET / failed to connect: ${e.message}`);
		});
		summary.rootStatus = rootRes.status;
		if (rootRes.status >= 500 || rootRes.status === 0) {
			throw new Error(`GET / returned ${rootRes.status} (expected 2xx or 3xx — e.g. 302 to /setup-admin on a fresh DB)`);
		}

		const healthRes = await fetch(`${base}/api/health`).catch((e) => {
			throw new Error(`GET /api/health failed to connect: ${e.message}`);
		});
		summary.healthStatus = healthRes.status;
		let healthBody = null;
		try {
			healthBody = await healthRes.json();
		} catch {
			/* non-JSON body is itself a failure below */
		}
		summary.healthBody = healthBody;
		if (healthRes.status !== 200 || healthBody?.status !== 'ok') {
			throw new Error(`GET /api/health returned ${healthRes.status} ${JSON.stringify(healthBody)} (expected 200 {status:"ok"})`);
		}

		if (summary.fatalLines.length > 0) {
			throw new Error(`fatal marker(s) seen in server output: ${summary.fatalLines.join(' | ')}`);
		}

		summary.pass = true;
	} finally {
		await killProc();
		cleanupTemp();
	}
}

// ---- main --------------------------------------------------------------------

async function main() {
	try {
		await buildForProduction();
	} catch (e) {
		fail(`build step: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	try {
		await bootAndAssert();
		printSummary();
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
}

main();
