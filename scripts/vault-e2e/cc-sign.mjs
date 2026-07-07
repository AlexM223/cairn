// ColdCard stand-in: a scripted FILE-BASED signer that mimics the ColdCard SD
// round trip. Reads an unsigned .psbt file (binary or base64), signs every
// input whose bip32_derivation lists OUR master fingerprint (deriving each
// key from a fixed test seed, BIP48-style paths included), and writes
// <name>-signed.psbt next to it — partially signed, NOT finalized, exactly
// like a real ColdCard leaves it for the coordinator to finalize.
//
// Fixed test seed: the public BIP39 vector "abandon ... about"
//   master fingerprint: 73c5da0a
//
// Usage:
//   node cc-sign.mjs --selftest                 # prints xfp + BIP48 xpub
//   node cc-sign.mjs <unsigned.psbt> [out.psbt] # sign
import { readFileSync, writeFileSync } from 'node:fs';
import { Transaction } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DEFAULT_PATH = "m/48'/0'/0'/2'";

const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const xfp = bytesToHex(new Uint8Array(new Uint32Array([root.fingerprint]).buffer).reverse());

if (process.argv[2] === '--selftest') {
	const path = process.argv[3] ?? DEFAULT_PATH;
	const acct = root.derive(path);
	console.log(JSON.stringify({ signer: 'coldcard-file', xfp, path, xpub: acct.publicExtendedKey }, null, 2));
	process.exit(0);
}

const inFile = process.argv[2];
if (!inFile) {
	console.error('usage: node cc-sign.mjs --selftest | <unsigned.psbt> [out.psbt]');
	process.exit(1);
}
const outFile = process.argv[3] ?? inFile.replace(/(\.psbt)?$/i, '-signed.psbt');

// ColdCards accept both binary and base64 .psbt files; so do we.
const raw = readFileSync(inFile);
const isBinary = raw.length >= 5 && raw[0] === 0x70 && raw[1] === 0x73 && raw[2] === 0x62 && raw[3] === 0x74 && raw[4] === 0xff;
const psbtBytes = isBinary ? new Uint8Array(raw) : base64.decode(raw.toString('utf8').trim());

const tx = Transaction.fromPSBT(psbtBytes, { allowUnknown: true });

let signed = 0;
for (let i = 0; i < tx.inputsLength; i++) {
	const input = tx.getInput(i);
	for (const [pubkey, meta] of input.bip32Derivation ?? []) {
		const metaFp = bytesToHex(new Uint8Array(new Uint32Array([meta.fingerprint]).buffer).reverse());
		if (metaFp !== xfp) continue;
		const key = meta.path.reduce((node, idx) => node.deriveChild(idx), root);
		if (bytesToHex(key.publicKey) !== bytesToHex(Uint8Array.from(pubkey))) {
			throw new Error(`input ${i}: derivation path yields a different pubkey than the PSBT declares — corrupt PSBT or wrong seed`);
		}
		tx.signIdx(key.privateKey, i);
		signed++;
	}
}

if (signed === 0) {
	console.error(`no inputs list our fingerprint ${xfp}; nothing signed`);
	process.exit(2);
}

// Like a real ColdCard: write the still-partial PSBT (binary), do not finalize.
writeFileSync(outFile, tx.toPSBT());
console.log(JSON.stringify({ signedInputs: signed, xfp, out: outFile }));
