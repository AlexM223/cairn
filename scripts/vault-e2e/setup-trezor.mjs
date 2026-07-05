// One-shot Trezor emulator provisioning for the vault-e2e stack.
//
// Talks to trezor-user-env's controller websocket (host port 29001) and:
//   1. starts a T2T1 (Trezor Model T) emulator, wiped clean
//   2. loads it with the standard Trezor test mnemonic ("all all all ... all")
//   3. starts the LEGACY trezord-go bridge v2.0.33 (explicit version matters:
//      under MACOS=1 an unversioned bridge-start picks the node bridge on
//      21328, which is NOT the port Trezor Connect probes)
//   4. copies proxy.py into the container and launches it, so the
//      loopback-only bridge becomes reachable on host port 31325
//
// Usage:  node setup-trezor.mjs           (after `docker compose -p vault-e2e up -d`)
// Verify: curl -s -X POST http://127.0.0.1:31325/   -> {"version":"2.0.33"}
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTROLLER = 'ws://127.0.0.1:29001';
const CONTAINER = 'vault-e2e-trezor';
const MNEMONIC = 'all all all all all all all all all all all all';

const here = path.dirname(fileURLToPath(import.meta.url));

function controller() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(CONTROLLER);
		const pending = new Map();
		ws.addEventListener('open', () =>
			resolve({
				send(cmd, timeoutMs = 60000) {
					const id = Math.floor(Math.random() * 1e9);
					return new Promise((res, rej) => {
						const t = setTimeout(() => {
							pending.delete(id);
							rej(new Error(`controller command timed out: ${cmd.type}`));
						}, timeoutMs);
						pending.set(id, (msg) => {
							clearTimeout(t);
							res(msg);
						});
						ws.send(JSON.stringify({ ...cmd, id }));
					});
				},
				close: () => ws.close()
			})
		);
		ws.addEventListener('message', (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.type === 'client') return; // unsolicited hello
			const cb = pending.get(msg.id);
			if (cb) {
				pending.delete(msg.id);
				cb(msg);
			}
		});
		ws.addEventListener('error', (e) => reject(new Error('controller ws error: ' + e.message)));
	});
}

function assertOk(label, msg) {
	if (msg.success === false) throw new Error(`${label} failed: ${JSON.stringify(msg)}`);
	console.log(`${label}: ok`, msg.response ? JSON.stringify(msg.response).slice(0, 120) : '');
}

const c = await controller();
console.log('connected to trezor-user-env controller at', CONTROLLER);

assertOk('emulator-start', await c.send({ type: 'emulator-start', model: 'T2T1', version: '2.7.2', wipe: true }, 120000));
assertOk(
	'emulator-setup',
	await c.send({
		type: 'emulator-setup',
		mnemonic: MNEMONIC,
		pin: '',
		passphrase_protection: false,
		label: 'vault-e2e'
	})
);
assertOk('bridge-start', await c.send({ type: 'bridge-start', version: '2.0.33' }, 120000));
c.close();

// Bridge is loopback-only inside the container; inject the TCP proxy.
execFileSync('docker', ['cp', path.join(here, 'proxy.py'), `${CONTAINER}:/tmp/proxy.py`]);
// [p]roxy so pkill's pattern doesn't match this very sh -c command line
// (it would SIGTERM its own shell -> exit 143); try/catch for "no match" (1).
try {
	execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', "pkill -f '[p]roxy.py' 2>/dev/null || true"]);
} catch {}
// NB: must be `sh -c "exec python3 ..."` with docker exec -d — a `nohup ... &`
// inside `-d` dies with the shell, and a bare /tmp path arg gets mangled by
// Git Bash when run manually (MSYS path conversion).
execFileSync('docker', ['exec', '-d', CONTAINER, 'sh', '-c', 'exec python3 /tmp/proxy.py > /tmp/proxy.log 2>&1']);
console.log('proxy injected; bridge should now answer on http://127.0.0.1:31325');

// Smoke-check from the host. trezord-go enforces an Origin allowlist (403
// otherwise) — any *.trezor.io origin passes.
await new Promise((r) => setTimeout(r, 1500));
const res = await fetch('http://127.0.0.1:31325/', { method: 'POST', headers: { origin: 'https://connect.trezor.io' } });
console.log('bridge check:', res.status, await res.text());
