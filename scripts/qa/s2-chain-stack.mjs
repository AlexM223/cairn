// scripts/qa/s2-chain-stack.mjs — Session-2 QA long-lived chain stack.
//
// Starts a throwaway regtest bitcoind (mining-regtest-node.mjs) + the
// electrum-shim pointed at it, mines an initial 120 blocks for coinbase
// maturity, writes connection info to scripts/qa/.s2-stack.json, then stays
// alive until killed. All QA workers read the JSON for ports.
//
// Usage: node scripts/qa/s2-chain-stack.mjs

import { startRegtestNode } from './mining-regtest-node.mjs';
import { startElectrumShim } from './electrum-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFO_PATH = path.join(__dirname, '.s2-stack.json');

function findFreePort(start) {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', () => {
			srv.close(() => resolve(findFreePort(start + 1)));
		});
		srv.listen(start, '127.0.0.1', () => {
			srv.close(() => resolve(start));
		});
	});
}

async function main() {
	console.log('[s2-stack] starting regtest bitcoind...');
	const regtest = await startRegtestNode();
	console.log(`[s2-stack] bitcoind up (${regtest.kind}) RPC port ${regtest.port}`);

	await regtest.rpc.call('createwallet', ['s2qa']).catch(() => {});
	const minerAddr = await regtest.rpc.call('getnewaddress', []);
	console.log('[s2-stack] mining 120 blocks...');
	await regtest.rpc.call('generatetoaddress', [120, minerAddr]);
	const height = await regtest.rpc.call('getblockcount', []);
	console.log(`[s2-stack] chain height ${height}`);

	const shimPort = await findFreePort(50021);
	const shim = startElectrumShim({
		rpcUrl: `http://127.0.0.1:${regtest.port}/`,
		rpcUser: 'heartwoodqa',
		rpcPass: 'heartwoodqa',
		host: '127.0.0.1',
		port: shimPort
	});
	console.log(`[s2-stack] electrum shim on ${shim.host}:${shim.port}`);

	fs.writeFileSync(
		INFO_PATH,
		JSON.stringify(
			{
				pid: process.pid,
				rpcPort: regtest.port,
				rpcUser: 'heartwoodqa',
				rpcPass: 'heartwoodqa',
				shimHost: shim.host,
				shimPort: shim.port,
				minerAddr,
				startedAt: new Date().toISOString()
			},
			null,
			2
		)
	);
	console.log(`[s2-stack] info written to ${INFO_PATH}`);
	console.log('[s2-stack] READY — staying alive until killed');

	const shutdown = async () => {
		try { shim.stop(); } catch {}
		try { await regtest.stop(); } catch {}
		try { fs.unlinkSync(INFO_PATH); } catch {}
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	// keep event loop alive
	setInterval(() => {}, 60_000);
}

main().catch((e) => {
	console.error('[s2-stack] FATAL', e);
	process.exit(1);
});
