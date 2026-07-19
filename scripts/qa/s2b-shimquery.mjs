// s2b QA: query the electrum shim directly to attribute confirmed/unconfirmed
// inconsistencies (app vs shim). Prints get_history + listunspent for an address.
// Usage: node scripts/qa/s2b-shimquery.mjs <bech32 address> [host] [port]
import net from 'node:net';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const [addr, host = '127.0.0.1', port = '50021'] = process.argv.slice(2);
const dec = bech32.decode(addr, 1023);
const program = new Uint8Array(bech32.fromWords(dec.words.slice(1)));
// P2WPKH/P2WSH scriptPubKey: OP_0 PUSH<len> <program>
const spk = new Uint8Array([0x00, program.length, ...program]);
const scripthash = bytesToHex(sha256(spk).slice().reverse());

const sock = net.connect(Number(port), host);
let buf = '';
const pending = new Map();
let nextId = 1;
function call(method, params) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
}
sock.on('data', (d) => {
	buf += d.toString();
	let idx;
	while ((idx = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		const p = pending.get(msg.id);
		if (p) {
			pending.delete(msg.id);
			msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
		}
	}
});
sock.on('connect', async () => {
	try {
		const hist = await call('blockchain.scripthash.get_history', [scripthash]);
		const unspent = await call('blockchain.scripthash.listunspent', [scripthash]);
		const tip = await call('blockchain.headers.subscribe', []);
		console.log(JSON.stringify({ address: addr, scripthash, tip: tip?.height, history: hist, listunspent: unspent }, null, 2));
	} catch (e) {
		console.error('shim query failed:', e.message);
		process.exitCode = 1;
	} finally {
		sock.end();
	}
});
sock.on('error', (e) => {
	console.error('socket error:', e.message);
	process.exit(1);
});
