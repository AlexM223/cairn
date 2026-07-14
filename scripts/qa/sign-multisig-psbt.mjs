// Throwaway: sign a P2WSH multisig PSBT (base64) with one BIP48 seed-byte-fill
// key, deriving the exact per-input path from the PSBT's own bip32Derivation
// (full path from master) rather than assuming a fixed account path — this
// matches how real multisig PSBTs carry per-signer key origins.
// Usage: node scripts/qa/sign-multisig-psbt.mjs <psbtBase64> <seedByte>
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';

const [psbtB64, seedByteStr] = process.argv.slice(2);
const seed = new Uint8Array(32).fill(Number(seedByteStr));
const master = HDKey.fromMasterSeed(seed);
const myFingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');

const tx = btc.Transaction.fromPSBT(Buffer.from(psbtB64, 'base64'), {
	allowUnknown: true,
	allowLegacyWitnessUtxo: true
});

let signedAny = false;
for (let i = 0; i < tx.inputsLength; i++) {
	const input = tx.getInput(i);
	const entries = input.bip32Derivation ?? [];
	const mine = entries.find(([, info]) => {
		const fp = (info.fingerprint >>> 0).toString(16).padStart(8, '0');
		return fp === myFingerprint;
	});
	if (!mine) continue;
	let child = master;
	for (const step of mine[1].path) child = child.deriveChild(step);
	tx.signIdx(child.privateKey, i);
	signedAny = true;
}

if (!signedAny) {
	console.error(`no input matched fingerprint ${myFingerprint}`);
	process.exit(1);
}

console.log(Buffer.from(tx.toPSBT()).toString('base64'));
