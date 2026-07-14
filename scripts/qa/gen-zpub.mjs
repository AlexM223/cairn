// Throwaway: generate a fresh BIP84 mainnet zpub (m/84'/0'/0') for QA single-sig
// wallet import (coinbase-maturity + sub-1-fee regtest verification, 2026-07-14).
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const b58check = createBase58check(sha256);
const ZPUB_VERSION = 0x04b24746;

function toZpub(hdkey) {
	const raw = b58check.decode(hdkey.publicExtendedKey);
	const out = new Uint8Array(raw);
	out[0] = (ZPUB_VERSION >>> 24) & 0xff;
	out[1] = (ZPUB_VERSION >>> 16) & 0xff;
	out[2] = (ZPUB_VERSION >>> 8) & 0xff;
	out[3] = ZPUB_VERSION & 0xff;
	return b58check.encode(out);
}

const seedArg = process.argv[2];
let seed;
let mnemonic;
if (seedArg) {
	seed = new Uint8Array(32).fill(Number(seedArg));
} else {
	mnemonic = generateMnemonic(wordlist);
	seed = mnemonicToSeedSync(mnemonic);
}

const master = HDKey.fromMasterSeed(seed);
const account = master.derive("m/84'/0'/0'");
const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
const zpub = toZpub(account);

console.log(JSON.stringify({ mnemonic, fingerprint, path: "m/84'/0'/0'", zpub }, null, 2));
