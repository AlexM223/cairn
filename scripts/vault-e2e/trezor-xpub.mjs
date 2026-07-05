// Fetches a BIP48 account xpub from the vault-e2e Trezor emulator through the
// real @trezor/connect Node entrypoint + Bridge transport, and cross-checks it
// against a local derivation from the known test mnemonic.
//
// KEY TRICK for this stack: the bridge is on host port 31325 (NOT the default
// 21325, which a leftover container from a previous session owns). Connect's
// `transports` option accepts a Transport *constructor*, so we subclass
// BridgeTransport with the custom port. The E2E agent should reuse this
// pattern for signTransaction calls.
//
// Usage: node trezor-xpub.mjs [path]     (default m/48'/0'/0'/2')
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TrezorConnectPkg = require('@trezor/connect');
const { BridgeTransport } = require('@trezor/transport');
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const TrezorConnect = TrezorConnectPkg.default?.default ?? TrezorConnectPkg.default ?? TrezorConnectPkg;

const BRIDGE_PORT = 31325;
const CONTROLLER = 'ws://127.0.0.1:29001';
const MNEMONIC = 'all all all all all all all all all all all all';
const PATH = process.argv[2] ?? "m/48'/0'/0'/2'";

class VaultE2eBridgeTransport extends BridgeTransport {
	constructor(params) {
		super({ ...params, port: BRIDGE_PORT });
	}
}

// Auto-answer the two interactive UI events a browser popup would handle.
function pressYes() {
	const ws = new WebSocket(CONTROLLER);
	ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'emulator-press-yes', id: Math.floor(Math.random() * 1e6) })));
	ws.addEventListener('message', () => ws.close());
}
TrezorConnect.on('UI_EVENT', (e) => {
	if (e.type === 'ui-select_device') {
		TrezorConnect.uiResponse({ type: 'ui-receive_device', payload: { device: e.payload.devices[0] } });
	}
	if (e.type === 'ui-button') pressYes();
});

// ---- local reference derivation from the known mnemonic ----
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const local = root.derive(PATH);
const masterFp = bytesToHex(new Uint8Array(new Uint32Array([root.fingerprint]).buffer).reverse());
console.log('local  master fingerprint:', masterFp);
console.log('local  xpub @', PATH, ':', local.publicExtendedKey);

// ---- device ----
await TrezorConnect.init({
	manifest: { email: 'vault-e2e@cairn.local', appUrl: 'http://localhost' },
	transports: [VaultE2eBridgeTransport],
	lazyLoad: false
});
try {
	const res = await TrezorConnect.getPublicKey({ path: PATH, coin: 'btc', showOnTrezor: false });
	if (!res.success) throw new Error('getPublicKey failed: ' + JSON.stringify(res.payload));
	console.log('device xpub @', PATH, ':', res.payload.xpub);

	// Compare key material (chaincode+pubkey), ignoring SLIP-132 version bytes.
	const material = (x) => bytesToHex(base58check(sha256).decode(x).slice(13));
	if (material(res.payload.xpub) !== material(local.publicExtendedKey)) {
		throw new Error('MISMATCH: device xpub does not match local derivation from the test mnemonic');
	}
	console.log('MATCH: device xpub == local derivation. Trezor signer ready.');
	console.log(JSON.stringify({ signer: 'trezor', xfp: masterFp, path: PATH, xpub: local.publicExtendedKey }));
} finally {
	TrezorConnect.dispose();
}
