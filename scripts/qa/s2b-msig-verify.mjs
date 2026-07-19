// s2b QA: independently derive the 2-of-2 sorted-multisig P2WSH address at
// m/48'/0'/0'/2'/0/0 for seeds 212/213 and compare with the wizard's display.
import { HDKey } from '@scure/bip32';
import { p2ms, p2wsh, NETWORK } from '@scure/btc-signer';

const PATH = "m/48'/0'/0'/2'";
function compareBytes(a, b) {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
const keys = [212, 213].map((s) =>
	HDKey.fromMasterSeed(new Uint8Array(32).fill(s)).derive(PATH).deriveChild(0).deriveChild(0).publicKey
);
keys.sort(compareBytes);
console.log(p2wsh(p2ms(2, keys), NETWORK).address);
