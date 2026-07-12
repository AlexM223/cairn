// Self-contained (no $lib alias, no TypeScript) re-implementation of the
// small slice of src/lib/server/bitcoin/xpub.ts that seed.mjs needs: turn a
// generated zpub fixture into real derived receive/change addresses, so
// seeded wallet_snapshots contain addresses that are actually consistent
// with the wallet's own xpub (rather than opaque random strings). Kept
// separate from fixtures/generate-xpubs.mjs (which only needs to PRODUCE
// zpubs) since seed.mjs needs to DERIVE from them instead.
//
// seed.mjs is a plain Node script run outside Vite/SvelteKit, so it can't
// import the real src/lib/server/bitcoin/xpub.ts (path aliases aren't
// resolved). This duplicates its parse + P2WPKH-derive logic using the same
// underlying libraries (@scure/bip32, @scure/base) — see that file for the
// authoritative version; keep this in sync if the real one changes shape.

import { HDKey } from '@scure/bip32';
import { createBase58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const b58check = createBase58check(sha256);
const XPUB_VERSION = 0x0488b21e;

function hash160(data) {
	return ripemd160(sha256(data));
}

/** Parse a zpub (SLIP-132) into an HDKey by swapping its version bytes back
 *  to standard xpub bytes, mirroring parseXpub(). */
export function hdkeyFromZpub(zpub) {
	const raw = b58check.decode(zpub.trim());
	const normalized = new Uint8Array(raw);
	normalized[0] = (XPUB_VERSION >>> 24) & 0xff;
	normalized[1] = (XPUB_VERSION >>> 16) & 0xff;
	normalized[2] = (XPUB_VERSION >>> 8) & 0xff;
	normalized[3] = XPUB_VERSION & 0xff;
	return HDKey.fromExtendedKey(b58check.encode(normalized));
}

/** P2WPKH address at m/<change>/<index> relative to the account key. */
export function deriveP2wpkhAddress(hdkey, change, index) {
	const child = hdkey.deriveChild(change).deriveChild(index);
	const pkh = hash160(child.publicKey);
	const words = [0, ...bech32.toWords(pkh)];
	return bech32.encode('bc', words);
}
