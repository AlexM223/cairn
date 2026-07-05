// Bitcoin Core wallet as a scripted vault cosigner (Bastion's approach).
//
// Talks to the vault-e2e-bitcoind regtest node (http://127.0.0.1:18543,
// vaulte2e/vaulte2e). Each "signer" is a Core descriptor wallet; we pull its
// master root tprv out of `listdescriptors true` (Core embeds the ROOT key in
// every private descriptor), derive the BIP48 account locally, and report
// { xpub, xfp, path } exactly like a hardware cosigner would.
//
// Commands:
//   node core-signer.mjs create <walletName> [path]
//       creates the wallet (or reuses it) and prints signer JSON:
//       { wallet, xfp, path, xpub, tpub, keyOriginPub, keyOriginTpub, keyOriginTprv }
//       - keyOriginPub / keyOriginTpub go into the vault / watch descriptor
//       - keyOriginTprv goes into `sign` (descriptorprocesspsbt needs
//         TESTNET-encoded keys on a regtest node)
//   node core-signer.mjs sign <psbtBase64|@file> <descriptor> [descriptor...]
//       node-level descriptorprocesspsbt: signs with the private descriptors
//       (checksums added automatically). Prints { psbt, complete }.
//       NOTE: walletprocesspsbt only signs scripts the WALLET knows; for a
//       multisig the wallet would first need importdescriptors of the full
//       multisig descriptor. descriptorprocesspsbt is wallet-free and simpler
//       for scripted cosigners.
import { readFileSync } from 'node:fs';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils.js';

const RPC = 'http://127.0.0.1:18543';
const AUTH = 'Basic ' + Buffer.from('vaulte2e:vaulte2e').toString('base64');
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const MAINNET_VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };

async function rpc(method, params = [], wallet) {
	const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
		method: 'POST',
		headers: { authorization: AUTH, 'content-type': 'text/plain' },
		body: JSON.stringify({ jsonrpc: '1.0', id: 'vault-e2e', method, params })
	});
	const json = await res.json();
	if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
	return json.result;
}

function reencode(hd, versions) {
	return new HDKey({
		depth: hd.depth,
		index: hd.index,
		parentFingerprint: hd.parentFingerprint,
		chainCode: hd.chainCode,
		...(hd.privateKey ? { privateKey: hd.privateKey } : { publicKey: hd.publicKey }),
		versions
	});
}

const fpHex = (hd) => bytesToHex(new Uint8Array(new Uint32Array([hd.fingerprint]).buffer).reverse());
const pathH = (path) => path.replace(/^m\//, '').replace(/'/g, 'h'); // descriptor origin form

async function create(wallet, path = "m/48'/0'/0'/2'") {
	try {
		await rpc('createwallet', [wallet]);
	} catch (e) {
		if (!/already exists/.test(String(e))) throw e;
		try {
			await rpc('loadwallet', [wallet]);
		} catch (e2) {
			if (!/already loaded/.test(String(e2))) throw e2;
		}
	}
	const { descriptors } = await rpc('listdescriptors', [true], wallet);
	const m = descriptors.map((d) => d.desc.match(/[tx]prv[0-9A-Za-z]+/)).find(Boolean);
	if (!m) throw new Error('no root xprv found in listdescriptors output');
	const root = HDKey.fromExtendedKey(m[0], m[0].startsWith('tprv') ? TESTNET_VERSIONS : MAINNET_VERSIONS);
	if (root.depth !== 0) throw new Error('descriptor key is not a root key; cannot compute master fingerprint');
	const acct = root.derive(path);
	const xfp = fpHex(root);
	const xpub = reencode(acct, MAINNET_VERSIONS).publicExtendedKey;
	const tpub = reencode(acct, TESTNET_VERSIONS).publicExtendedKey;
	const tprv = reencode(acct, TESTNET_VERSIONS).privateExtendedKey;
	const origin = `[${xfp}/${pathH(path)}]`;
	console.log(
		JSON.stringify(
			{
				signer: 'core',
				wallet,
				xfp,
				path,
				xpub,
				tpub,
				keyOriginPub: `${origin}${xpub}/<0;1>/*`,
				keyOriginTpub: `${origin}${tpub}/<0;1>/*`,
				keyOriginTprv: `${origin}${tprv}/<0;1>/*`
			},
			null,
			2
		)
	);
}

async function sign(psbtArg, ...descriptors) {
	const psbt = psbtArg.startsWith('@') ? readFileSync(psbtArg.slice(1), 'base64') : psbtArg;
	const withChecksums = [];
	for (const d of descriptors) {
		const info = await rpc('getdescriptorinfo', [d]);
		withChecksums.push(d.includes('#') ? d : `${d}#${info.checksum}`);
	}
	const result = await rpc('descriptorprocesspsbt', [psbt, withChecksums]);
	console.log(JSON.stringify(result, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'create' && args[0]) await create(args[0], args[1]);
else if (cmd === 'sign' && args.length >= 2) await sign(...args);
else {
	console.error('usage: node core-signer.mjs create <wallet> [path]\n       node core-signer.mjs sign <psbtBase64|@file> <privateDescriptor>...');
	process.exit(1);
}
