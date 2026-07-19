// Throwaway regtest bitcoind harness for the mining QA drivers.
//
// Independently authored (MIT, this repo) — a minimal spawn + JSON-RPC 1.0
// client, deliberately NOT vendored from Tessera's GPL-3.0 e2e. Prefers a local
// bitcoind binary; falls back to `docker run bitcoin/bitcoin`. Brings up a fresh
// datadir on a free high RPC port so it never collides with any other regtest
// stack — including a developer's own long-running shared regtest node on the
// conventional 18443 — waits for RPC readiness, and tears down cleanly.
//
// Port selection (bead: mining regtest harness port hardcoding hardening):
//   1. $CAIRN_QA_REGTEST_PORT, if set, wins outright (explicit pin for CI/debug).
//   2. Otherwise probe upward from FREE_PORT_RANGE_START for the first port this
//      process can actually bind, so concurrent harness runs and a dev's own
//      shared bitcoind never collide.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';

const RPC_USER = 'heartwoodqa';
const RPC_PASS = 'heartwoodqa';
// Starting point for the free-port probe. Deliberately above the conventional
// bitcoind regtest RPC port (18443) so a probe that (for whatever reason) never
// finds anything free still doesn't collide with the box's normal regtest node.
const FREE_PORT_RANGE_START = 18453;
const FREE_PORT_RANGE_ATTEMPTS = 200;
const CANDIDATE_BINARIES = /** @type {string[]} */ (
	[
		process.env.BITCOIND_PATH,
		'C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe',
		'/usr/bin/bitcoind',
		'/usr/local/bin/bitcoind'
	].filter(Boolean)
);

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBitcoind() {
	for (const c of CANDIDATE_BINARIES) if (existsSync(c)) return c;
	return null;
}

/** True when SOME regtest bitcoind backend is obtainable (binary or docker). */
export async function bitcoindAvailable() {
	if (findBitcoind()) return true;
	return dockerAvailable();
}

function dockerAvailable() {
	return new Promise((resolve) => {
		const p = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
		p.on('error', () => resolve(false));
		p.on('exit', (code) => resolve(code === 0));
	});
}

/** True if `port` can be bound on 127.0.0.1 right now (best-effort — TOCTOU race
 *  with whatever binds it next is inherent to any free-port probe; the caller
 *  retries startup on bind failure via bitcoind's own RPC-readiness poll). */
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

/** Probe upward from `startPort` for the first bindable port. */
export async function findFreePort(startPort = FREE_PORT_RANGE_START, attempts = FREE_PORT_RANGE_ATTEMPTS) {
	for (let i = 0; i < attempts; i++) {
		const candidate = startPort + i;
		if (await isPortFree(candidate)) return candidate;
	}
	throw new Error(`no free port found in range ${startPort}-${startPort + attempts - 1}`);
}

/** Resolve the RPC port to use: $CAIRN_QA_REGTEST_PORT wins if set, otherwise
 *  probe for a free one. Exported so callers (and tests) can gate on the same
 *  mechanism the harness itself uses. */
export async function resolveRegtestPort() {
	const envPort = process.env.CAIRN_QA_REGTEST_PORT;
	if (envPort !== undefined && envPort !== '') {
		const parsed = Number(envPort);
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
			throw new Error(`CAIRN_QA_REGTEST_PORT must be a valid TCP port, got: ${envPort}`);
		}
		return parsed;
	}
	return findFreePort();
}

class Rpc {
	/** @param {string} url */
	constructor(url) {
		this.url = url;
		this.auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
		this.id = 1;
	}
	/**
	 * @param {string} method
	 * @param {unknown[]} params
	 */
	async call(method, params = []) {
		const res = await fetch(this.url, {
			method: 'POST',
			headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '1.0', id: this.id++, method, params })
		});
		const text = await res.text();
		let env;
		try {
			env = JSON.parse(text);
		} catch {
			throw new Error(`RPC ${method}: HTTP ${res.status} non-JSON: ${text.slice(0, 200)}`);
		}
		if (env.error) throw new Error(`RPC ${method} failed (${env.error.code}): ${env.error.message}`);
		return env.result;
	}
}

/**
 * Spawn a local bitcoind into a fresh datadir. Returns { rpc, stop }.
 * @param {string} binary
 * @param {number} port
 */
async function startLocal(binary, port) {
	const datadir = path.join(os.tmpdir(), `heartwood-mining-regtest-${process.pid}-${Date.now()}`);
	rmSync(datadir, { recursive: true, force: true });
	mkdirSync(datadir, { recursive: true });
	const args = [
		'-regtest',
		`-datadir=${datadir}`,
		`-rpcport=${port}`,
		`-rpcuser=${RPC_USER}`,
		`-rpcpassword=${RPC_PASS}`,
		'-server=1',
		'-listen=0',
		'-fallbackfee=0.0001'
	];
	const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
	let stderrTail = '';
	proc.stderr?.on('data', (c) => (stderrTail = (stderrTail + c).slice(-4096)));
	let exited = false;
	proc.on('exit', () => (exited = true));
	const rpc = new Rpc(`http://127.0.0.1:${port}/`);
	const deadline = Date.now() + 30_000;
	let lastErr = '';
	while (Date.now() < deadline) {
		if (exited) throw new Error(`bitcoind exited during startup. stderr:\n${stderrTail}`);
		try {
			await rpc.call('getblockcount');
			return {
				rpc,
				async stop() {
					if (!exited) {
						await rpc.call('stop').catch(() => {});
						for (let i = 0; i < 40 && !exited; i++) await sleep(150);
						if (!exited) proc.kill();
					}
					for (let i = 0; i < 24; i++) {
						try {
							rmSync(datadir, { recursive: true, force: true });
							if (!existsSync(datadir)) break;
						} catch {
							/* Windows holds the datadir lock briefly after exit — retry */
						}
						await sleep(300);
					}
				}
			};
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
			await sleep(200);
		}
	}
	proc.kill();
	throw new Error(`bitcoind RPC not ready in 30s (last: ${lastErr})`);
}

/**
 * Spawn a dockerized bitcoind. Returns { rpc, stop }.
 * @param {number} port
 */
async function startDocker(port) {
	const name = `heartwood-mining-regtest-${process.pid}`;
	const img = process.env.BITCOIND_IMAGE ?? 'bitcoin/bitcoin:28.0';
	const runArgs = [
		'run', '--rm', '-d', '--name', name,
		'-p', `127.0.0.1:${port}:${port}`,
		...(process.env.DOCKER_DNS ? ['--dns', process.env.DOCKER_DNS] : []),
		img,
		'-regtest', `-rpcport=${port}`, '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0',
		`-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`, '-server=1', '-fallbackfee=0.0001'
	];
	/** @type {Promise<void>} */
	const dockerRun = new Promise((resolve, reject) => {
		const p = spawn('docker', runArgs, { stdio: 'ignore' });
		p.on('error', reject);
		p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker run exited ${code}`))));
	});
	await dockerRun;
	const rpc = new Rpc(`http://127.0.0.1:${port}/`);
	const deadline = Date.now() + 40_000;
	let lastErr = '';
	while (Date.now() < deadline) {
		try {
			await rpc.call('getblockcount');
			return {
				rpc,
				async stop() {
					await new Promise((res) => spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).on('exit', res));
				}
			};
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
			await sleep(400);
		}
	}
	await new Promise((res) => spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).on('exit', res));
	throw new Error(`dockerized bitcoind RPC not ready in 40s (last: ${lastErr})`);
}

/**
 * Bring up a regtest node (local binary preferred, docker fallback). Picks a
 * free RPC port unless $CAIRN_QA_REGTEST_PORT or opts.port pins one, so this
 * never collides with a developer's own long-running shared regtest node.
 * @param {{ port?: number }} [opts]
 */
export async function startRegtestNode(opts = {}) {
	const port = opts.port ?? (await resolveRegtestPort());
	const binary = findBitcoind();
	if (binary) {
		return { kind: 'local', binary, port, ...(await startLocal(binary, port)) };
	}
	if (await dockerAvailable()) {
		return { kind: 'docker', port, ...(await startDocker(port)) };
	}
	throw new Error('no regtest bitcoind available (no local binary, no docker)');
}
