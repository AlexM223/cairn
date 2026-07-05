// End-to-end REHEARSAL of the 2-of-3 vault flow using the pieces of this
// stack that need no on-device interaction: the ColdCard file signer
// (cc-sign.mjs) + two Bitcoin Core cosigner wallets. Proves on regtest:
//   - BIP48 sortedmulti wsh vault descriptor imports + derives addresses
//   - funding the vault
//   - walletcreatefundedpsbt produces a PSBT with correct bip32_derivations
//   - cc-sign.mjs signs its inputs from the .psbt FILE round trip
//   - one signature is NOT enough (quorum enforced)
//   - a second signature (descriptorprocesspsbt) completes + broadcasts
//   - destination is a taproot (bech32m, bc1p-style; bcrt1p on regtest) address
//
// The real E2E swaps signer-a/signer-b for the Trezor/Ledger emulators.
//
// Usage: node verify-quorum.mjs   (stack must be up; miner wallet funded)
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils.js';

const RPC = 'http://127.0.0.1:18543';
const AUTH = 'Basic ' + Buffer.from('vaulte2e:vaulte2e').toString('base64');
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const ACCT_PATH = "m/48'/0'/0'/2'";

async function rpc(method, params = [], wallet) {
	const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
		method: 'POST',
		headers: { authorization: AUTH, 'content-type': 'text/plain' },
		body: JSON.stringify({ jsonrpc: '1.0', id: 'vq', method, params })
	});
	const json = await res.json();
	if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
	return json.result;
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const nodeRun = (script, ...args) => execFileSync('node', [path.join(here, script), ...args], { encoding: 'utf8' });

function coreSigner(wallet) {
	const out = nodeRun('core-signer.mjs', 'create', wallet);
	return JSON.parse(out);
}

// ---- assemble the three cosigners ----
const cc = (() => {
	const root = HDKey.fromMasterSeed(
		mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
	);
	const acct = root.derive(ACCT_PATH);
	const tpub = new HDKey({
		depth: acct.depth,
		index: acct.index,
		parentFingerprint: acct.parentFingerprint,
		chainCode: acct.chainCode,
		publicKey: acct.publicKey,
		versions: TESTNET_VERSIONS
	}).publicExtendedKey;
	const xfp = bytesToHex(new Uint8Array(new Uint32Array([root.fingerprint]).buffer).reverse());
	return { xfp, keyOriginTpub: `[${xfp}/48h/0h/0h/2h]${tpub}/<0;1>/*` };
})();
const a = coreSigner('signer-a');
const b = coreSigner('signer-b');
console.log('cosigners:', cc.xfp, a.xfp, b.xfp);

// NB: Bitcoin Core 28 does NOT accept multipath (<0;1>) keys inside
// (sorted)multi — "Key path value '<0;1>' is not a valid uint32". Expand to
// explicit /0/* (receive) and /1/* (change) descriptor twins instead.
const expand = (tpl, branch) => tpl.replaceAll('<0;1>', branch);
const watchDesc = `wsh(sortedmulti(2,${cc.keyOriginTpub},${a.keyOriginTpub},${b.keyOriginTpub}))`;
const signDescA = `wsh(sortedmulti(2,${cc.keyOriginTpub},${a.keyOriginTprv},${b.keyOriginTpub}))`;
// Use .checksum (checksum of the descriptor AS GIVEN) — .descriptor is the
// normalized public form, whose checksum differs for private descriptors.
const checksum = async (d) => `${d}#${(await rpc('getdescriptorinfo', [d])).checksum}`;

// ---- vault watch wallet (unique per run: descriptor re-import with an
// already-advanced range fails on reruns otherwise) ----
const VAULT = `vault-watch-${Date.now()}`;
try {
	await rpc('createwallet', [VAULT, true, true]); // disable_private_keys, blank
} catch (e) {
	if (!/already exists/.test(String(e))) throw e;
	try {
		await rpc('loadwallet', [VAULT]);
	} catch (e2) {
		if (!/already loaded/.test(String(e2))) throw e2;
	}
}
const imp = await rpc(
	'importdescriptors',
	[
		[
			{ desc: await checksum(expand(watchDesc, '0')), active: true, internal: false, timestamp: 'now' },
			{ desc: await checksum(expand(watchDesc, '1')), active: true, internal: true, timestamp: 'now' }
		]
	],
	VAULT
);
if (!imp.every((r) => r.success)) throw new Error('importdescriptors failed: ' + JSON.stringify(imp));
const vaultAddr = await rpc('getnewaddress', [], VAULT);
console.log('vault address:', vaultAddr);

// ---- fund it from the miner ----
await rpc('sendtoaddress', [vaultAddr, 1.0], 'miner');
const mineTo = await rpc('getnewaddress', [], 'miner');
await rpc('generatetoaddress', [1, mineTo]);
console.log('vault balance:', await rpc('getbalance', [], VAULT));

// ---- spend to a taproot destination (bc1p-equivalent; bcrt1p on regtest) ----
const dest = await rpc('getnewaddress', ['', 'bech32m'], 'miner');
console.log('taproot destination:', dest);
const funded = await rpc('walletcreatefundedpsbt', [[], [{ [dest]: 0.5 }], 0, { includeWatching: true }], VAULT);

// ---- signer 1: ColdCard file round trip ----
const dir = mkdtempSync(path.join(tmpdir(), 'vault-e2e-'));
const unsignedFile = path.join(dir, 'spend.psbt');
writeFileSync(unsignedFile, Buffer.from(funded.psbt, 'base64')); // binary, like Cairn's /file download
console.log('cc-sign:', nodeRun('cc-sign.mjs', unsignedFile).trim());
const ccSigned = readFileSync(path.join(dir, 'spend-signed.psbt')).toString('base64');

// ---- quorum check: 1-of-2 signatures must NOT finalize ----
const oneSig = await rpc('finalizepsbt', [ccSigned]);
if (oneSig.complete) throw new Error('quorum NOT enforced: single signature finalized a 2-of-3');
console.log('quorum enforced: 1 signature does not finalize');

// ---- signer 2: Core cosigner via descriptorprocesspsbt ----
const second = await rpc('descriptorprocesspsbt', [
	ccSigned,
	[await checksum(expand(signDescA, '0')), await checksum(expand(signDescA, '1'))]
]);
if (!second.complete) throw new Error('2nd signature did not complete the PSBT: ' + JSON.stringify(second));
console.log('2nd signature completes the quorum');

// ---- broadcast + confirm ----
const txid = await rpc('sendrawtransaction', [second.hex]);
await rpc('generatetoaddress', [1, mineTo]);
const conf = await rpc('gettransaction', [txid], VAULT);
console.log(JSON.stringify({ txid, confirmations: conf.confirmations, dest }, null, 2));
console.log('VAULT 2-OF-3 REHEARSAL PASSED');
