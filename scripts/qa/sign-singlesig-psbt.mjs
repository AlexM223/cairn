// Throwaway: sign a single-sig P2WPKH PSBT (base64) with one BIP84 seed byte
// fill, for the coinbase-maturity + sub-1-fee regtest verification
// (cairn-oae1.2 / cairn-eacw.8, 2026-07-14).
// Usage: node scripts/qa/sign-singlesig-psbt.mjs <psbtBase64> <seedByte> <accountPath>
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';

const [psbtB64, seedByteStr, accountPath] = process.argv.slice(2);
const seed = new Uint8Array(32).fill(Number(seedByteStr));
const master = HDKey.fromMasterSeed(seed);
const account = master.derive(accountPath || "m/84'/0'/0'");

const tx = btc.Transaction.fromPSBT(Buffer.from(psbtB64, 'base64'), {
	allowUnknown: true,
	allowLegacyWitnessUtxo: true
});

for (let i = 0; i < tx.inputsLength; i++) {
	const input = tx.getInput(i);
	const derivation = input.bip32Derivation?.[0]?.[1];
	let child;
	if (derivation) {
		// derivation.path is the FULL path from the master seed (includes the
		// hardened account levels), so derive from master, not from `account`.
		child = master;
		for (const step of derivation.path) child = child.deriveChild(step);
	} else {
		// fall back to receive index 0 (this QA script only ever signs single-input spends)
		child = account.deriveChild(0).deriveChild(0);
	}
	tx.signIdx(child.privateKey, i);
}

const out = Buffer.from(tx.toPSBT()).toString('base64');
console.log(out);
