// Ephemeral regtest bitcoind lifecycle + a minimal JSON-RPC client, for the
// mining forced-solve harness (cairn-vn43.2). Mirrors the general shape of
// scripts/load-test/bootstrap.mjs (spawn -> poll a readiness signal -> return
// a stop() handle) and scripts/vault-e2e's docker-compose conventions, but
// written fresh for this harness — own project name/port so it never
// collides with vault-e2e (18543) or qa-sub1 (18544), and always torn down
// with `down -v` so CI runs start from a byte-identical empty chain.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const PROJECT = 'cairn-mining-forcedsolve';

export const RPC_HOST = '127.0.0.1';
export const RPC_PORT = 18546;
export const RPC_USER = 'cairnminingharness';
export const RPC_PASS = 'cairnminingharness';

function run(args, { allowFailure = false } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => (stdout += d));
		proc.stderr.on('data', (d) => (stderr += d));
		proc.on('error', reject);
		proc.on('exit', (code) => {
			if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
			else reject(new Error(`docker ${args.join(' ')} exited ${code}\n${stderr}`));
		});
	});
}

const composeArgs = (...rest) => ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...rest];

/** Minimal Bitcoin Core JSON-RPC call over HTTP basic auth (Node 22+ global fetch). */
export async function rpcCall(method, params = []) {
	const url = `http://${RPC_HOST}:${RPC_PORT}/`;
	const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
		body: JSON.stringify({ jsonrpc: '1.0', id: 'cairn-forced-solve', method, params }),
		signal: AbortSignal.timeout(30_000)
	});
	const body = await res.json();
	if (body.error) {
		throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
	}
	return body.result;
}

async function waitForRpcReady(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			await rpcCall('getblockchaininfo');
			return;
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`bitcoind RPC did not become ready within ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
}

/**
 * Start a fresh ephemeral regtest bitcoind (always `down -v` first, so no
 * state survives from a prior/crashed run), wait for RPC readiness, and
 * return a stop() handle. Caller MUST call stop() in a finally block.
 */
export async function startRegtestNode() {
	await run(composeArgs('down', '-v', '--remove-orphans'), { allowFailure: true });
	await run(composeArgs('up', '-d'));
	await waitForRpcReady();
	return {
		rpc: rpcCall,
		async stop() {
			await run(composeArgs('down', '-v', '--remove-orphans'), { allowFailure: true });
		}
	};
}
