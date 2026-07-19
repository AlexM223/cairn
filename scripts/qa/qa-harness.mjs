// Shared helpers for the Wave-5R durable QA gates (route-crawl.mjs,
// notif-deeplink.mjs, concurrent-broadcast.mjs). Factored out so each driver
// isn't re-deriving the same free-port probe / prod-boot / DB-seed plumbing
// prod-boot-smoke.mjs and seed-qa2.mjs already established as the house
// patterns on this repo.
//
// Seeding note: unlike scripts/qa/seed-qa2.mjs (which DELETEs an existing
// user's sessions before inserting — fine for a long-lived shared QA DB, but
// a footgun if copied into a harness where two runs could share a DB), the
// seedAdminAndSession() helper here is INSERT-only: it creates the user only
// if missing and always adds a NEW session row, never deletes existing ones.
// Every driver in this file uses a fresh throwaway DB per run so it wouldn't
// matter at runtime either way — this is about keeping the *pattern* itself
// safe to copy.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- free port

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

/**
 * Probe upward from `startPort` for the first bindable port. Same pattern as
 * mining-regtest-node.mjs / prod-boot-smoke.mjs's findFreePort.
 * @param {number} [startPort]
 * @param {number} [attempts]
 */
export async function findFreePort(startPort = 18763, attempts = 200) {
	for (let i = 0; i < attempts; i++) {
		const candidate = startPort + i;
		if (await isPortFree(candidate)) return candidate;
	}
	throw new Error(`no free port found in range ${startPort}-${startPort + attempts - 1}`);
}

// ---------------------------------------------------------------- process run

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
export function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			// Windows: spawning a .cmd shim (npm.cmd) directly without a shell fails
			// with EINVAL — see prod-boot-smoke.mjs's identical note. cmd/args here
			// are always static literals from this repo's own scripts, never
			// user/network input.
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

/** Run `npm run build` unless CAIRN_QA_SKIP_BUILD is set (fast local iteration only). */
export async function buildForProduction() {
	if (process.env.CAIRN_QA_SKIP_BUILD) {
		console.log('[qa-harness] CAIRN_QA_SKIP_BUILD set — skipping npm run build');
		return;
	}
	console.log('[qa-harness] running production build (npm run build)...');
	const start = Date.now();
	const { code, stdout, stderr } = await run('npm', ['run', 'build']);
	if (code !== 0) {
		console.error(stdout);
		console.error(stderr);
		throw new Error(`npm run build exited ${code}`);
	}
	if (!existsSync(path.join(REPO_ROOT, 'build', 'handler.js'))) {
		throw new Error('build succeeded but build/handler.js is missing — adapter-node output layout changed?');
	}
	console.log(`[qa-harness] build OK in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- app boot

const FATAL_MARKERS = [
	'uncaughtException',
	'unhandledRejection',
	'"phase":"app-import"',
	'Cannot find module',
	'ERR_MODULE_NOT_FOUND',
	'ERR_PACKAGE_PATH_NOT_EXPORTED'
];

/**
 * Boot `node server.mjs` (the real prod entrypoint — same as prod-boot-smoke.mjs)
 * against a throwaway DB + port, optionally pointed at an Electrum host/port.
 * Resolves once "cairn: app ready" is seen. Returns { proc, port, dbPath, dbDir,
 * base, stdout(), fatalLines, stop() }.
 * @param {{ electrumHost?: string, electrumPort?: number, port?: number, bootTimeoutMs?: number, extraEnv?: Record<string,string> }} [opts]
 */
export async function bootApp(opts = {}) {
	const port = opts.port ?? (await findFreePort());
	const dbDir = mktempAppDir();
	const dbPath = path.join(dbDir, 'app.db');
	const logPath = path.join(dbDir, 'app.log');
	const bootTimeoutMs = opts.bootTimeoutMs ?? 60_000;

	const env = {
		...process.env,
		NODE_ENV: 'production',
		PORT: String(port),
		HOST: '127.0.0.1',
		CAIRN_HTTPS_PORT: '',
		CAIRN_DB: dbPath,
		CAIRN_LOG_FILE: logPath,
		// Only honoured by the app on a genuinely fresh DB (seed-once) — always
		// true here since dbDir is a brand-new mkdtemp.
		CAIRN_ELECTRUM_HOST: opts.electrumHost ?? '127.0.0.1',
		CAIRN_ELECTRUM_PORT: String(opts.electrumPort ?? 1),
		CAIRN_ELECTRUM_TLS: 'false',
		...(opts.extraEnv ?? {})
	};

	console.log(`[qa-harness] booting node server.mjs on 127.0.0.1:${port} (db=${dbPath})`);
	const proc = spawn('node', ['server.mjs'], {
		cwd: REPO_ROOT,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	let exitInfo = null;
	const fatalLines = [];

	const captureFatal = (chunk) => {
		const text = String(chunk);
		for (const marker of FATAL_MARKERS) {
			if (text.includes(marker)) fatalLines.push(text.trim().slice(0, 500));
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

	const deadline = Date.now() + bootTimeoutMs;
	let sawReady = false;
	while (Date.now() < deadline) {
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
		proc.kill('SIGKILL');
		throw new Error(`timed out after ${bootTimeoutMs}ms waiting for "cairn: app ready"\n${stdoutBuf.slice(-4000)}`);
	}

	return {
		proc,
		port,
		dbPath,
		dbDir,
		base: `http://127.0.0.1:${port}`,
		stdout: () => stdoutBuf,
		stderr: () => stderrBuf,
		fatalLines,
		async stop() {
			if (exitInfo) return;
			proc.kill('SIGTERM');
			const stopDeadline = Date.now() + 10_000;
			while (!exitInfo && Date.now() < stopDeadline) await sleep(100);
			if (!exitInfo) proc.kill('SIGKILL');
		}
	};
}

function mktempAppDir() {
	return mkdtempSync(path.join(os.tmpdir(), 'cairn-qa-app-'));
}

/** Best-effort recursive cleanup; never throws. @param {string} dir */
export function cleanupDir(dir) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------- DB seeding

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function scryptAsync(pw, salt, keylen, options) {
	return new Promise((resolve, reject) => {
		scrypt(pw, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk)));
	});
}
async function hashPassword(pw) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}
function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}
function mintToken() {
	return randomBytes(32).toString('base64url');
}
function randHex(bytes) {
	return randomBytes(bytes).toString('hex');
}

/**
 * Seed an admin user + a fresh session into `dbPath`. INSERT-only: creates the
 * user only if it doesn't already exist, and always inserts a NEW session row
 * rather than deleting old ones first (see file header — this is the pattern
 * fix over seed-qa2.mjs's DELETE-then-insert). Returns { userId, token, cookie }.
 * @param {string} dbPath
 * @param {{ email?: string, password?: string, displayName?: string }} [opts]
 */
export async function seedAdminAndSession(dbPath, opts = {}) {
	const email = opts.email ?? 'qa-route-crawl@test.local';
	const password = opts.password ?? 'QaRouteCrawl!2026x';
	const displayName = opts.displayName ?? 'QA Route Crawl';

	if (!existsSync(dbPath)) {
		throw new Error(`seedAdminAndSession: ${dbPath} does not exist (app must boot + create schema first)`);
	}

	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

	const passwordHash = await hashPassword(password);
	const agreementVersionRow = db.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`).get();
	const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

	let userId, userToken;
	db.exec('BEGIN');
	try {
		const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
		if (existing) {
			userId = Number(existing.id);
			db.prepare(
				`UPDATE users SET password_hash = ?, display_name = ?, is_admin = 1, disabled = 0, must_reset_password = 0 WHERE id = ?`
			).run(passwordHash, displayName, userId);
		} else {
			const result = db
				.prepare(
					`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
					 VALUES (?, ?, ?, 1, 0, 0)`
				)
				.run(email, passwordHash, displayName);
			userId = Number(result.lastInsertRowid);
		}

		db.prepare(
			`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?)
			 ON CONFLICT(user_id) DO NOTHING`
		).run(userId);
		db.prepare(
			`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)
			 ON CONFLICT(user_id, version) DO NOTHING`
		).run(userId, agreementVersion);

		const hasPhrase = db.prepare(`SELECT user_id FROM account_recovery_phrases WHERE user_id = ?`).get(userId);
		if (!hasPhrase) {
			db.prepare(`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?)`).run(
				userId,
				`scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`
			);
		}
		const hasCode = db.prepare(`SELECT id FROM account_recovery_codes WHERE user_id = ? LIMIT 1`).get(userId);
		if (!hasCode) {
			db.prepare(`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`).run(
				userId,
				`scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`
			);
		}

		// INSERT-only: always add a NEW session, never delete existing ones for
		// this user (see file header).
		userToken = mintToken();
		const expiresAt = new Date(Date.now() + 3650 * 86_400_000).toISOString();
		db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
			sha256hex(userToken),
			userId,
			expiresAt
		);

		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		db.close();
		throw e;
	}
	db.close();

	return { userId, token: userToken, cookie: `cairn_session=${userToken}`, email, password };
}

/** Open the app DB for direct row insertion (e.g. notification/event fixtures). @param {string} dbPath */
export function openDb(dbPath) {
	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	return db;
}

// ---------------------------------------------------------------- HTTP

/**
 * Authenticated GET. Returns { status, text }.
 * @param {string} url
 * @param {string} cookie
 */
export async function getWithCookie(url, cookie) {
	const res = await fetch(url, {
		headers: cookie ? { Cookie: cookie } : {},
		redirect: 'manual'
	});
	const text = await res.text().catch(() => '');
	return { status: res.status, text };
}
