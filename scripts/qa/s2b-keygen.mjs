// s2b QA (2026-07-19, worker B): regtest-native key generator.
// The s2 stack runs a NATIVE regtest chain (v0.2.40+), so the app's
// parseXpub validates against network 'regtest' and requires
// testnet/regtest SLIP-132 encodings (tpub/upub/vpub). This emits:
//  - one BIP84 single-sig signer (m/84'/1'/0') as vpub (0x045f1cf6)
//  - two BIP48 multisig signers (m/48'/1'/0'/2') as tpub (0x043587cf)
// Deterministic seed bytes 211/212/213 (clear of prior waves 1/2/3/101/201-203).
// Also derives the first receive address (m/.../0/0) with HRP bcrt1 so the
// UI-rendered receive address can be cross-checked out-of-band.
import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { p2ms } from '@scure/btc-signer';
import fs from 'node:fs';

const b58check = base58check(sha256);
const TPUB_VERSION = 0x043587cf; // testnet/regtest xpub
const VPUB_VERSION = 0x045f1cf6; // testnet/regtest BIP84 (SLIP-132 vpub)

function reencode(hdkey, version) {
	const raw = b58check.decode(hdkey.publicExtendedKey);
	const out = new Uint8Array(raw);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return b58check.encode(out);
}

function bech32Regtest(program) {
	return bech32.encode('bcrt', [0, ...bech32.toWords(program)], 1023);
}

function makeMaster(seedByte) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	return { master, fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0') };
}

// --- single-sig BIP84 (regtest path m/84'/1'/0') ---
const SS_SEED = 211;
const SS_PATH = "m/84'/1'/0'";
const ss = makeMaster(SS_SEED);
const ssAccount = ss.master.derive(SS_PATH);
const ssChild0 = ssAccount.deriveChild(0).deriveChild(0);
const ssAddr0 = bech32Regtest(ripemd160(sha256(ssChild0.publicKey)));

// --- multisig 2-of-2 BIP48 (regtest path m/48'/1'/0'/2') ---
const MS_PATH = "m/48'/1'/0'/2'";
const msSigners = [212, 213].map((b) => {
	const { master, fingerprint } = makeMaster(b);
	const account = master.derive(MS_PATH);
	return { seedByte: b, fingerprint, account, tpub: reencode(account, TPUB_VERSION) };
});
function compareBytes(a, b) {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
const msChildren = msSigners.map((s) => s.account.deriveChild(0).deriveChild(0));
const msPubkeys = msChildren.map((c) => c.publicKey).sort(compareBytes);
const msScript = p2ms(2, msPubkeys).script;
const msAddr0 = bech32Regtest(sha256(msScript));

const out = {
	singlesig: {
		seedByte: SS_SEED,
		path: SS_PATH,
		fingerprint: ss.fingerprint,
		vpub: reencode(ssAccount, VPUB_VERSION),
		tpub: reencode(ssAccount, TPUB_VERSION),
		expectedAddr0: ssAddr0
	},
	multisig: {
		path: MS_PATH,
		threshold: 2,
		signers: msSigners.map((s) => ({ seedByte: s.seedByte, fingerprint: s.fingerprint, tpub: s.tpub })),
		expectedAddr0: msAddr0
	}
};
fs.writeFileSync('s2b-keys.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
