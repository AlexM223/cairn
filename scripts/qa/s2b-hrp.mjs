// s2b QA: bech32 HRP twin converter (MANUAL.md 16.5 trick).
// Same witness program, different HRP — converts bc1... <-> bcrt1... so a
// mainnet-encoded app address can be funded on regtest and vice versa.
// Usage: node scripts/qa/s2b-hrp.mjs <address> [targetHrp=bcrt|bc]
import { bech32 } from '@scure/base';

const [addr, target] = process.argv.slice(2);
if (!addr) {
	console.error('usage: node scripts/qa/s2b-hrp.mjs <bech32 address> [bcrt|bc]');
	process.exit(1);
}
const dec = bech32.decode(addr, 1023);
const hrp = target || (dec.prefix === 'bc' ? 'bcrt' : 'bc');
console.log(bech32.encode(hrp, dec.words, 1023));
