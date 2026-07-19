// s2b QA: finalize a fully-signed PSBT (base64 file) and broadcast it through
// the ELECTRUM SHIM (same path the app uses) to isolate app-vs-shim hangs.
// Usage: node scripts/qa/s2b-finalize-broadcast.mjs <signed.b64 file> [--dry-run]
import fs from 'node:fs';
import net from 'node:net';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';

const [file, flag] = process.argv.slice(2);
const b64 = fs.readFileSync(file, 'utf8').trim();
const tx = Transaction.fromPSBT(base64.decode(b64), { allowUnknown: true });
tx.finalize();
const hex = bytesToHex(tx.extract());
console.log('txid:', tx.id);
if (flag === '--dry-run') {
	console.log('hex:', hex);
	process.exit(0);
}
const sock = net.connect(50021, '127.0.0.1');
let buf = '';
sock.on('connect', () => {
	sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.transaction.broadcast', params: [hex] }) + '\n');
});
const timer = setTimeout(() => {
	console.error('TIMEOUT: shim did not answer broadcast within 15s');
	process.exit(2);
}, 15000);
sock.on('data', (d) => {
	buf += d.toString();
	const idx = buf.indexOf('\n');
	if (idx >= 0) {
		clearTimeout(timer);
		console.log('shim reply:', buf.slice(0, idx));
		sock.end();
	}
});
sock.on('error', (e) => {
	console.error('socket error:', e.message);
	process.exit(1);
});
