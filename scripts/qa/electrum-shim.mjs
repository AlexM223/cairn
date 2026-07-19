#!/usr/bin/env node
// Minimal Electrum-protocol (JSON-RPC 2.0, newline-delimited TCP) shim backed
// by a regtest bitcoind's JSON-RPC 1.0 interface. Built ad hoc for Cairn QA
// (no electrs/Fulcrum binary or Docker available on this box) -- NOT a
// general-purpose Electrum server. Maintains its own scripthash -> UTXO/
// history index by scanning blocks (bitcoind has no address index by
// default), since the Electrum protocol only ever sends a scripthash
// (sha256(scriptPubKey) reversed), never the underlying address/script.
//
// Supports: server.version/ping/banner/features, blockchain.headers.subscribe
// (+ push), blockchain.block.header, blockchain.estimatefee, blockchain.relayfee,
// mempool.get_fee_histogram (stub, empty), blockchain.transaction.get,
// blockchain.transaction.broadcast, blockchain.transaction.get_merkle,
// blockchain.scripthash.{get_balance,get_history,listunspent,subscribe,unsubscribe}
// (+ push on new block).
//
// USAGE (Wave-5R QA gates): each QA driver that needs a live Electrum backend
// spawns its OWN throwaway regtest bitcoind (see mining-regtest-node.mjs) on a
// probed-free RPC port, then spawns this shim pointed at that bitcoind on
// ANOTHER probed-free port, so concurrent QA runs never collide with each
// other or with any long-running dev/QA instance on this box (e.g. the shim
// at the conventional 50001 backing a live app on 5192 — do not target that
// port from a throwaway driver).
//
// Config, argv (preferred — explicit per-invocation) or env fallback:
//   --rpc-url=<url>        BITCOIND_RPC_URL   (default http://127.0.0.1:18543/)
//   --rpc-user=<user>      BITCOIND_RPC_USER  (default cairnqa)
//   --rpc-pass=<pass>      BITCOIND_RPC_PASS  (default cairnqa)
//   --host=<host>          ELECTRUM_SHIM_HOST (default 127.0.0.1)
//   --port=<port>          ELECTRUM_SHIM_PORT (default 50001)
// argv wins over env when both are given. Also importable as a module: see
// exported `startElectrumShim(opts)` for in-process spawn/stop from a QA
// driver (returns { host, port, stop() }) instead of shelling out.

import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgv(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]+)=(.*)$/.exec(a);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/**
 * Start the shim in-process. Returns { host, port, stop }.
 * @param {{ rpcUrl?: string, rpcUser?: string, rpcPass?: string, host?: string, port?: number }} [opts]
 */
export function startElectrumShim(opts = {}) {
	return runShim({
		rpcUrl: opts.rpcUrl ?? process.env.BITCOIND_RPC_URL ?? 'http://127.0.0.1:18543/',
		rpcUser: opts.rpcUser ?? process.env.BITCOIND_RPC_USER ?? 'cairnqa',
		rpcPass: opts.rpcPass ?? process.env.BITCOIND_RPC_PASS ?? 'cairnqa',
		host: opts.host ?? process.env.ELECTRUM_SHIM_HOST ?? '127.0.0.1',
		port: opts.port ?? Number(process.env.ELECTRUM_SHIM_PORT || 50001)
	});
}

function runShim(cfg) {
	const RPC_URL = cfg.rpcUrl;
	const RPC_USER = cfg.rpcUser;
	const RPC_PASS = cfg.rpcPass;
	const LISTEN_HOST = cfg.host;
	const LISTEN_PORT = cfg.port;
	const POLL_MS = 2000;

	const auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
	let rpcId = 1;

	async function rpc(method, params = []) {
		const res = await fetch(RPC_URL, {
			method: 'POST',
			headers: { Authorization: auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '1.0', id: rpcId++, method, params })
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

	function sha256(buf) {
		return crypto.createHash('sha256').update(buf).digest();
	}
	function scripthashFromHex(scriptPubKeyHex) {
		return Buffer.from(sha256(Buffer.from(scriptPubKeyHex, 'hex'))).reverse().toString('hex');
	}

	// ------------------------------------------------------------------- index
	const utxoByOutpoint = new Map(); // "txid:vout" -> { scripthash, value, height }
	const scripthashUtxos = new Map(); // scripthash -> Set(outpointKey)
	const scripthashHistory = new Map(); // scripthash -> [{tx_hash, height}]
	let indexedHeight = -1;

	function addHistory(scripthash, txid, height) {
		let arr = scripthashHistory.get(scripthash);
		if (!arr) {
			arr = [];
			scripthashHistory.set(scripthash, arr);
		}
		if (!arr.some((e) => e.tx_hash === txid && e.height === height)) arr.push({ tx_hash: txid, height });
	}

	async function scanBlock(height, touched) {
		const hash = await rpc('getblockhash', [height]);
		const block = await rpc('getblock', [hash, 2]);
		for (const tx of block.tx) {
			const txid = tx.txid;
			for (const vin of tx.vin) {
				if (vin.coinbase) continue;
				const key = `${vin.txid}:${vin.vout}`;
				const prev = utxoByOutpoint.get(key);
				if (prev) {
					utxoByOutpoint.delete(key);
					scripthashUtxos.get(prev.scripthash)?.delete(key);
					addHistory(prev.scripthash, txid, height);
					touched?.add(prev.scripthash);
				}
			}
			for (const vout of tx.vout) {
				const spkHex = vout.scriptPubKey?.hex;
				if (!spkHex) continue;
				const scripthash = scripthashFromHex(spkHex);
				const key = `${txid}:${vout.n}`;
				const valueSats = Math.round(vout.value * 1e8);
				utxoByOutpoint.set(key, { scripthash, value: valueSats, height });
				if (!scripthashUtxos.has(scripthash)) scripthashUtxos.set(scripthash, new Set());
				scripthashUtxos.get(scripthash).add(key);
				addHistory(scripthash, txid, height);
				touched?.add(scripthash);
			}
		}
		indexedHeight = height;
	}

	async function catchUp(touched) {
		const tip = await rpc('getblockcount');
		for (let h = indexedHeight + 1; h <= tip; h++) {
			await scanBlock(h, touched);
		}
		return tip;
	}

	// crude unconfirmed tracking: sum of mempool-tx outputs per scripthash, minus
	// nothing (spends of unconfirmed inputs aren't netted) -- good enough for QA
	// "is there an unconfirmed tx" signal, not exact accounting.
	const mempoolSeen = new Set();
	const mempoolReceived = new Map(); // scripthash -> sats
	async function scanMempoolOnce(touched) {
		let txids;
		try {
			txids = await rpc('getrawmempool', []);
		} catch {
			return;
		}
		const stillPresent = new Set(txids);
		for (const seen of [...mempoolSeen]) {
			if (!stillPresent.has(seen)) mempoolSeen.delete(seen); // confirmed or evicted; history already added on confirm
		}
		for (const txid of txids) {
			if (mempoolSeen.has(txid)) continue;
			mempoolSeen.add(txid);
			try {
				const raw = await rpc('getrawtransaction', [txid, 2]);
				for (const vout of raw.vout || []) {
					const spkHex = vout.scriptPubKey?.hex;
					if (!spkHex) continue;
					const scripthash = scripthashFromHex(spkHex);
					addHistory(scripthash, txid, 0);
					mempoolReceived.set(scripthash, (mempoolReceived.get(scripthash) || 0) + Math.round(vout.value * 1e8));
					touched?.add(scripthash);
				}
				for (const vin of raw.vin || []) {
					const spk = vin.prevout?.scriptPubKey?.hex;
					if (!spk) continue;
					const scripthash = scripthashFromHex(spk);
					addHistory(scripthash, txid, 0);
					touched?.add(scripthash);
				}
			} catch {
				/* tx evicted between listing and fetch; ignore */
			}
		}
	}

	function computeStatus(scripthash) {
		const hist = (scripthashHistory.get(scripthash) || []).slice().sort((a, b) => {
			const ah = a.height <= 0 ? Infinity : a.height;
			const bh = b.height <= 0 ? Infinity : b.height;
			return ah - bh;
		});
		if (hist.length === 0) return null;
		const s = hist.map((e) => `${e.tx_hash}:${e.height}:`).join('');
		return sha256(Buffer.from(s, 'utf8')).toString('hex');
	}

	// ---------------------------------------------------------------- merkle
	function merkleBranch(txidsDisplayOrder, index) {
		let hashes = txidsDisplayOrder.map((id) => Buffer.from(id, 'hex').reverse());
		let idx = index;
		const branch = [];
		while (hashes.length > 1) {
			if (hashes.length % 2 === 1) hashes.push(hashes[hashes.length - 1]);
			const next = [];
			for (let i = 0; i < hashes.length; i += 2) {
				if (i === idx - (idx % 2)) {
					const siblingIdx = idx % 2 === 0 ? i + 1 : i;
					branch.push(Buffer.from(hashes[siblingIdx]).reverse().toString('hex'));
				}
				next.push(sha256(sha256(Buffer.concat([hashes[i], hashes[i + 1]]))));
			}
			idx = Math.floor(idx / 2);
			hashes = next;
		}
		return branch;
	}

	// ------------------------------------------------------------------ server
	const headerSubscribers = new Set(); // sockets
	const scripthashSubscribers = new Map(); // scripthash -> Set(sockets)

	function jsonLine(obj) {
		return JSON.stringify(obj) + '\n';
	}

	async function handle(method, params) {
		switch (method) {
			case 'server.version':
				return ['CairnQAElectrumShim 1.0', '1.4'];
			case 'server.ping':
				return null;
			case 'server.banner':
				return 'Cairn QA regtest electrum shim (not electrs)';
			case 'server.features':
				return { genesis_hash: null, hash_function: 'sha256', protocol_max: '1.4', protocol_min: '1.4' };
			case 'blockchain.headers.subscribe': {
				const tip = await rpc('getblockcount');
				const hash = await rpc('getblockhash', [tip]);
				const hex = await rpc('getblockheader', [hash, false]);
				return { height: tip, hex };
			}
			case 'blockchain.block.header': {
				const height = params[0];
				const hash = await rpc('getblockhash', [height]);
				return rpc('getblockheader', [hash, false]);
			}
			case 'blockchain.estimatefee': {
				try {
					const r = await rpc('estimatesmartfee', [params[0] ?? 6]);
					if (r && typeof r.feerate === 'number') return r.feerate; // BTC/kvB, matches electrum convention
					return -1;
				} catch {
					return -1;
				}
			}
			case 'blockchain.relayfee': {
				const info = await rpc('getnetworkinfo', []);
				return info.relayfee ?? 0.00001;
			}
			case 'mempool.get_fee_histogram':
				return [];
			case 'blockchain.transaction.get': {
				const [txid, verbose] = params;
				return rpc('getrawtransaction', [txid, verbose ? 2 : false]);
			}
			case 'blockchain.transaction.broadcast': {
				const [hex] = params;
				return rpc('sendrawtransaction', [hex]);
			}
			case 'blockchain.transaction.get_merkle': {
				const [txid, height] = params;
				const hash = await rpc('getblockhash', [height]);
				const block = await rpc('getblock', [hash, 1]);
				const idx = block.tx.indexOf(txid);
				if (idx < 0) throw new Error('tx not in specified block');
				return { block_height: height, merkle: merkleBranch(block.tx, idx), pos: idx };
			}
			case 'blockchain.scripthash.get_balance': {
				const [sh] = params;
				const keys = scripthashUtxos.get(sh);
				let confirmed = 0;
				if (keys) for (const k of keys) confirmed += utxoByOutpoint.get(k)?.value ?? 0;
				const unconfirmed = mempoolReceived.get(sh) ?? 0;
				return { confirmed, unconfirmed };
			}
			case 'blockchain.scripthash.get_history': {
				const [sh] = params;
				return (scripthashHistory.get(sh) || []).slice();
			}
			case 'blockchain.scripthash.listunspent': {
				const [sh] = params;
				const keys = scripthashUtxos.get(sh);
				if (!keys) return [];
				return [...keys].map((k) => {
					const [txid, voutStr] = k.split(':');
					const u = utxoByOutpoint.get(k);
					return { tx_hash: txid, tx_pos: Number(voutStr), height: u.height, value: u.value };
				});
			}
			case 'blockchain.scripthash.subscribe':
			case 'blockchain.scripthash.unsubscribe':
				// handled specially in dispatch (needs socket reference)
				throw new Error('internal: handled in dispatch');
			default:
				throw new Error(`unsupported method: ${method}`);
		}
	}

	const server = net.createServer((socket) => {
		socket.setEncoding('utf8');
		let buffer = '';
		const ownHeaderSub = { active: false };
		const ownScripthashSubs = new Set();

		socket.on('data', (chunk) => {
			buffer += chunk;
			let idx;
			while ((idx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				void (async () => {
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						return;
					}
					const { id, method, params = [] } = msg;
					try {
						let result;
						if (method === 'blockchain.scripthash.subscribe') {
							const [sh] = params;
							ownScripthashSubs.add(sh);
							if (!scripthashSubscribers.has(sh)) scripthashSubscribers.set(sh, new Set());
							scripthashSubscribers.get(sh).add(socket);
							result = computeStatus(sh);
						} else if (method === 'blockchain.scripthash.unsubscribe') {
							const [sh] = params;
							ownScripthashSubs.delete(sh);
							scripthashSubscribers.get(sh)?.delete(socket);
							result = true;
						} else {
							if (method === 'blockchain.headers.subscribe') ownHeaderSub.active = true, headerSubscribers.add(socket);
							result = await handle(method, params);
						}
						if (id !== undefined) socket.write(jsonLine({ jsonrpc: '2.0', id, result }));
					} catch (e) {
						if (id !== undefined) {
							socket.write(jsonLine({ jsonrpc: '2.0', id, error: { code: -1, message: String(e?.message || e) } }));
						}
					}
				})();
			}
		});

		socket.on('close', () => {
			headerSubscribers.delete(socket);
			for (const sh of ownScripthashSubs) scripthashSubscribers.get(sh)?.delete(socket);
		});
		socket.on('error', () => {});
	});

	let pollTimer = null;
	let polling = false;
	async function pollOnce() {
		if (polling) return;
		polling = true;
		try {
			const touched = new Set();
			const prevHeight = indexedHeight;
			const newTip = await catchUp(touched);
			await scanMempoolOnce(touched);
			if (newTip > prevHeight) {
				const hash = await rpc('getblockhash', [newTip]);
				const hex = await rpc('getblockheader', [hash, false]);
				const msg = jsonLine({
					jsonrpc: '2.0',
					method: 'blockchain.headers.subscribe',
					params: [{ height: newTip, hex }]
				});
				for (const sock of headerSubscribers) sock.write(msg);
			}
			for (const sh of touched) {
				const subs = scripthashSubscribers.get(sh);
				if (subs && subs.size) {
					const status = computeStatus(sh);
					const m = jsonLine({ jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [sh, status] });
					for (const sock of subs) sock.write(m);
				}
			}
		} catch (e) {
			console.error('[electrum-shim] poll error:', e?.message || e);
		} finally {
			polling = false;
		}
	}

	server.listen(LISTEN_PORT, LISTEN_HOST, () => {
		console.log(`[electrum-shim] listening on ${LISTEN_HOST}:${LISTEN_PORT}, backed by ${RPC_URL}`);
	});

	// Initial full catch-up before accepting is nice but not required -- the
	// server already listens above; kick an immediate scan now, then interval.
	pollOnce();
	pollTimer = setInterval(pollOnce, POLL_MS);

	return {
		host: LISTEN_HOST,
		port: LISTEN_PORT,
		async stop() {
			clearInterval(pollTimer);
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

// ------------------------------------------------------------------ CLI entry
// Only auto-starts from CLI args/env when invoked directly (`node
// electrum-shim.mjs ...`), not when imported by a QA driver via
// startElectrumShim().
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
	const argv = parseArgv(process.argv.slice(2));
	startElectrumShim({
		rpcUrl: argv['rpc-url'],
		rpcUser: argv['rpc-user'],
		rpcPass: argv['rpc-pass'],
		host: argv.host,
		port: argv.port !== undefined ? Number(argv.port) : undefined
	});
}
