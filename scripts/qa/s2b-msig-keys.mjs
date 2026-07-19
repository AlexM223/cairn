// s2b QA: two deterministic BIP48 mainnet xpubs (m/48'/0'/0'/2') for the
// 2-of-2 multisig wizard smoke test (seeds 212/213 — instance validates
// mainnet keys; see s2b report: chain_network row missing on this stack).
import { HDKey } from '@scure/bip32';

const PATH = "m/48'/0'/0'/2'";
for (const seedByte of [212, 213]) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(PATH);
	const fp = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	console.log(JSON.stringify({ seedByte, fingerprint: fp, path: PATH, xpub: account.publicExtendedKey }));
}
