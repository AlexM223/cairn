// One-off generator for scripts/load-test/fixtures/xpubs.json.
//
// The harness needs 600+ UNIQUE, structurally-valid mainnet zpubs (BIP-84,
// SLIP-132 prefix 'zpub') to seed 55 single-sig wallets for the load-test
// admin plus 1-3 each for every other seeded user, and to exercise
// POST /api/wallets with a fresh xpub in scenario (c). They must pass this
// repo's own parseXpub() (src/lib/server/bitcoin/xpub.ts) — that function:
//   - base58check-decodes (sha256 double-hash checksum),
//   - requires exactly 78 raw bytes,
//   - reads the 4-byte version prefix and requires it to be a known SLIP-132
//     mainnet PUBLIC version (zpub = 0x04b24746),
//   - swaps those bytes for standard xpub bytes (0x0488b21e) and hands the
//     result to @scure/bip32's HDKey.fromExtendedKey(), which re-validates
//     the full BIP32 structure (depth/parent-fingerprint/child-number/chain
//     code/pubkey).
//
// Rather than guess at byte layout, this script drives the SAME libraries
// parseXpub uses (@scure/bip32 + @scure/base's createBase58check(sha256)) to
// build genuine BIP32 account keys from random seeds, then does the mirror
// image of parseXpub's version-byte swap: take the library's own standard
// xpub serialization and re-stamp it with the zpub version bytes. Because
// the swap only touches the 4 version bytes (verified identical in both
// directions), the result round-trips through parseXpub exactly like a real
// hardware wallet's BIP-84 account xpub would.
//
// Run manually with `node scripts/load-test/fixtures/generate-xpubs.mjs`
// whenever fixtures/xpubs.json needs regenerating (e.g. a larger count). The
// output is checked in so a load-test run never depends on this script.

import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const b58check = createBase58check(sha256);

const XPUB_VERSION = 0x0488b21e;
const ZPUB_VERSION = 0x04b24746;

function withVersion(raw, version) {
	const out = new Uint8Array(raw);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return out;
}

/** One random BIP-84-shaped account-level zpub (m/84'/0'/0' depth=3, as a
 *  real hardware wallet would export), derived from a random 32-byte seed.
 *  Exported so scenarios.mjs can mint fresh, never-colliding xpubs on demand
 *  for the write-pressure POST /api/wallets scenario, instead of depending
 *  on a finite pre-generated fixture pool. */
export function randomZpub() {
	const seed = randomBytes(32);
	const master = HDKey.fromMasterSeed(seed);
	const account = master.derive("m/84'/0'/0'"); // hardened account node — public-safe to export as an xpub-equivalent
	const neutered = account.publicExtendedKey; // standard 'xpub...' (version 0x0488b21e), base58check-encoded

	const raw = b58check.decode(neutered);
	const zpubRaw = withVersion(raw, ZPUB_VERSION);
	return b58check.encode(zpubRaw);
}

// Only regenerate the checked-in fixture file when this module is run
// directly (`node generate-xpubs.mjs [count]`) — importing randomZpub from
// scenarios.mjs must NOT have the side effect of rewriting xpubs.json.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
	const COUNT = Number(process.argv[2] ?? 650);

	const seen = new Set();
	const xpubs = [];
	while (xpubs.length < COUNT) {
		const z = randomZpub();
		if (seen.has(z)) continue; // astronomically unlikely, guarded anyway
		seen.add(z);
		xpubs.push(z);
	}

	const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xpubs.json');
	writeFileSync(outPath, JSON.stringify(xpubs, null, 0));
	console.log(`wrote ${xpubs.length} unique zpubs to ${outPath}`);
}
