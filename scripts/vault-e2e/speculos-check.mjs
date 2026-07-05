// Verifies the vault-e2e Speculos (Ledger Nano S+, app-bitcoin-new mainnet
// app) is up and scriptable:
//   - REST automation API answers on http://127.0.0.1:25000
//   - APDU path works via @ledgerhq/hw-transport-node-speculos-http
//   - fetches master fingerprint + a BIP48 account xpub, cross-checked
//     against a local derivation from the known Speculos test seed
//
// NOTE on packages: @ledgerhq ESM builds use extensionless relative imports
// Node rejects — always load them through createRequire (CJS build).
//
// Usage: node speculos-check.mjs [path]   (default m/48'/0'/0'/2')
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SpeculosHttpTransport = require('@ledgerhq/hw-transport-node-speculos-http').default;
const { AppClient } = require('@ledgerhq/hw-app-btc/lib/newops/appClient');
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const API_PORT = 25000;
const MNEMONIC =
	'glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobo dawn victory error impact';
const PATH = process.argv[2] ?? "m/48'/0'/0'/2'";

// ---- REST automation API sanity ----
const events = await fetch(`http://127.0.0.1:${API_PORT}/events?currentscreenonly=true`);
console.log('automation API /events:', events.status, JSON.stringify(await events.json()).slice(0, 160));

// ---- local reference derivation ----
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const local = root.derive(PATH);
const localFp = bytesToHex(new Uint8Array(new Uint32Array([root.fingerprint]).buffer).reverse());
console.log('local  master fingerprint:', localFp);
console.log('local  xpub @', PATH, ':', local.publicExtendedKey);

// ---- device via APDU ----
const transport = await SpeculosHttpTransport.open({ apiPort: API_PORT });
try {
	const client = new AppClient(transport);
	const deviceFp = Buffer.from(await client.getMasterFingerprint()).toString('hex');
	// AppClient.getExtendedPubkey takes the path as number[] (hardened = +0x80000000)
	const pathElements = PATH.replace(/^m\//, '')
		.split('/')
		.map((seg) => (seg.endsWith("'") || seg.endsWith('h') ? (parseInt(seg, 10) >>> 0) + 0x80000000 : parseInt(seg, 10)));
	const deviceXpub = await client.getExtendedPubkey(false, pathElements);
	console.log('device master fingerprint:', deviceFp);
	console.log('device xpub @', PATH, ':', deviceXpub);

	if (deviceFp !== localFp) throw new Error(`MISMATCH: device fp ${deviceFp} != local ${localFp}`);
	const material = (x) => bytesToHex(base58check(sha256).decode(x).slice(13));
	if (material(deviceXpub) !== material(local.publicExtendedKey)) {
		throw new Error('MISMATCH: device xpub does not match local derivation');
	}
	console.log('MATCH: device fingerprint + xpub == local derivation. Ledger signer ready.');
	console.log(JSON.stringify({ signer: 'ledger', xfp: deviceFp, path: PATH, xpub: deviceXpub }));
} finally {
	await transport.close();
}
