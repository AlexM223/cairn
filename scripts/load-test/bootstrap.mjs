// Boots and tears down a throwaway `node server.mjs` instance pointed at a
// sandboxed SQLite DB with no live chain backend. Two boot modes:
//   - bootServerForSchema(): plain boot (no elmon), used ONLY to let db.ts's
//     CREATE TABLE IF NOT EXISTS migrations run once against a fresh file, so
//     seed.mjs has real tables to write into. Stopped immediately after.
//   - bootServerForLoad(): the real boot used during measurement, with the
//     event-loop monitor injected via NODE_OPTIONS.
//
// Both go through one spawn() implementation so env/args stay in sync.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import {
	ROOT_DIR,
	RESULTS_DIR,
	DB_PATH,
	HTTP_PORT,
	HOST,
	SERVER_ORIGIN,
	ELMON_PORT,
	DEAD_ELECTRUM_PORT,
	THROWAWAY_DIR,
	assertSafeDbPath,
	assertSafeRemoveDir
} from './config.mjs';

/** Poll GET /api/health until it returns 200 {status:"ok"}, or throw after
 *  timeoutMs. Unauthenticated by design (see src/routes/api/health) — exactly
 *  the readiness signal the design calls for. */
async function waitForHealth(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastErr = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${SERVER_ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) });
			if (res.status === 200) {
				const body = await res.json();
				if (body?.status === 'ok') return;
				lastErr = new Error(`health returned ${res.status} ${JSON.stringify(body)}`);
			} else {
				lastErr = new Error(`health returned HTTP ${res.status}`);
			}
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`server did not become healthy within ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
}

function baseEnv(dbPath) {
	assertSafeDbPath(dbPath);
	// logger.ts defaults LOG_FILE to <cwd>/data/logs/cairn.log, independent of
	// HEARTWOOD_DB — since the server is spawned with cwd=ROOT_DIR (this
	// worktree), an unset CAIRN_LOG_FILE would write a data/logs directory
	// into the worktree itself instead of the sandbox. Pin it alongside the
	// throwaway DB so EVERYTHING this harness writes lives under
	// os.tmpdir()/cairn-loadtest, never inside the repo checkout.
	const logFile = path.join(path.dirname(dbPath), 'logs', 'cairn.log');
	assertSafeDbPath(logFile);
	return {
		...process.env,
		HEARTWOOD_DB: dbPath,
		CAIRN_LOG_FILE: logFile,
		PORT: String(HTTP_PORT),
		HOST,
		CAIRN_ORIGIN: SERVER_ORIGIN,
		// Point at a closed local port so every Electrum dial fails fast
		// (ECONNREFUSED) instead of hanging or reaching a real chain backend.
		CAIRN_ELECTRUM_HOST: '127.0.0.1',
		CAIRN_ELECTRUM_PORT: String(DEAD_ELECTRUM_PORT),
		CAIRN_ELECTRUM_TLS: 'false',
		// Deliberately absent/unset: no HTTPS listener, no env-var admin
		// bootstrap (seed.mjs mints the admin + sessions directly).
		CAIRN_HTTPS_PORT: '',
		CAIRN_ADMIN_PASSWORD: ''
	};
}

/**
 * Spawn `node server.mjs`, tee its stdout/stderr to results/server-<ISO>.log
 * AND to this process's own stdout (prefixed), and wait for /api/health.
 * Returns { proc, logPath, stop() }.
 */
async function bootServer({ env, label }) {
	assertSafeDbPath(env.HEARTWOOD_DB);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.mkdirSync(path.dirname(env.HEARTWOOD_DB), { recursive: true });

	const iso = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = path.join(RESULTS_DIR, `server-${label}-${iso}.log`);
	const logStream = fs.createWriteStream(logPath, { flags: 'a' });

	const proc = spawn(process.execPath, ['server.mjs'], {
		cwd: ROOT_DIR,
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	proc.stdout.on('data', (chunk) => {
		logStream.write(chunk);
		process.stdout.write(`[server:${label}] ${chunk}`);
	});
	proc.stderr.on('data', (chunk) => {
		logStream.write(chunk);
		process.stderr.write(`[server:${label}:err] ${chunk}`);
	});

	let exited = false;
	let exitInfo = null;
	proc.on('exit', (code, signal) => {
		exited = true;
		exitInfo = { code, signal };
	});

	try {
		await waitForHealth();
	} catch (e) {
		if (exited) {
			throw new Error(
				`server process exited before becoming healthy (code=${exitInfo?.code}, signal=${exitInfo?.signal}); see ${logPath}`
			);
		}
		throw new Error(`${e.message}; see ${logPath}`);
	}

	const stop = () =>
		new Promise((resolve) => {
			if (exited) return resolve();
			const onExit = () => resolve();
			proc.once('exit', onExit);
			proc.kill('SIGTERM');
			// Escalate if it ignores SIGTERM (shouldn't — server.mjs handles it —
			// but a load-test harness must never hang waiting on a stuck child).
			setTimeout(() => {
				if (!exited) proc.kill('SIGKILL');
			}, 8_000).unref();
		});

	return { proc, logPath, stop, isExited: () => exited, exitInfo: () => exitInfo };
}

/** Schema-creation boot: plain `node server.mjs`, no elmon, just long enough
 *  for db.ts's migrations to run against a fresh DB file. Caller stops it
 *  immediately after health passes. */
export async function bootServerForSchema(dbPath) {
	return bootServer({ env: baseEnv(dbPath), label: 'schema' });
}

/** Load-pass boot: same server, plus the event-loop-lag monitor injected via
 *  NODE_OPTIONS --import (elmon.mjs listens on ELMON_PORT). */
export async function bootServerForLoad(dbPath) {
	const env = baseEnv(dbPath);
	// --import requires a valid ESM specifier — on Windows a raw
	// "C:\..." path is NOT one (ERR_UNSUPPORTED_ESM_URL_SCHEME); it must be a
	// file:// URL. pathToFileURL() handles both platforms correctly.
	const elmonUrl = pathToFileURL(path.join(ROOT_DIR, 'scripts', 'load-test', 'elmon.mjs')).href;
	env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${elmonUrl}`].filter(Boolean).join(' ');
	env.CAIRN_LOADTEST_ELMON_PORT = String(ELMON_PORT);
	return bootServer({ env, label: 'load' });
}

/** `npm run build` unless --no-build was passed and build/handler.js already
 *  exists. Runs in the worktree root (ROOT_DIR), inherits stdio so build
 *  errors are visible directly. */
export async function ensureBuilt({ skip }) {
	const handlerPath = path.join(ROOT_DIR, 'build', 'handler.js');
	if (skip && fs.existsSync(handlerPath)) {
		console.log('[bootstrap] --no-build: reusing existing build/handler.js');
		return;
	}
	console.log('[bootstrap] running `npm run build`…');
	await new Promise((resolve, reject) => {
		// Windows: npm ships as npm.cmd, a shell script — spawn() needs
		// shell:true to invoke it directly (a bare argv exec of a .cmd file
		// fails with EINVAL). shell:true is a no-op difference on POSIX.
		const proc = spawn('npm', ['run', 'build'], {
			cwd: ROOT_DIR,
			stdio: 'inherit',
			shell: true
		});
		proc.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm run build exited with code ${code}`));
		});
		proc.on('error', reject);
	});
	if (!fs.existsSync(handlerPath)) {
		throw new Error(`build finished but ${handlerPath} still doesn't exist`);
	}
}

/** Remove the whole throwaway dir tree. Guarded — refuses anything outside
 *  the sandbox root. Safe to call even if the dir was never created. */
export function cleanupThrowawayDir(dir = THROWAWAY_DIR) {
	assertSafeRemoveDir(dir);
	fs.rmSync(dir, { recursive: true, force: true });
}
