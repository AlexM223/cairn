import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseXpub, deriveAddress, scriptPubKeyHex, addressToScriptPubKey } from './xpub';

// Regression for cairn-j6fv: transaction delta was computed by matching wallet
// ADDRESS STRINGS against explorer-reported addresses. Cairn derives mainnet
// (bc1…) addresses, but a regtest node reports bcrt1… for the same output, so
// the strings never matched and delta came out 0 — while the balance (derived
// from the scriptPubKey via the scripthash) stayed correct. The fix matches by
// scriptPubKey, which is identical across networks. These tests pin that.

// BIP-84 test-vector account xpub (the well-known zpub).
const BIP84_ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('scriptPubKeyHex — network-agnostic transaction attribution', () => {
	it('gives the SAME scriptPubKey for a derived bc1 address and the regtest bcrt1 form', () => {
		const parsed = parseXpub(BIP84_ZPUB);
		const { address } = deriveAddress(parsed, 0, 0); // mainnet bc1…
		expect(address.startsWith('bc1q')).toBe(true);

		const spk = scriptPubKeyHex(address);
		// P2WPKH scriptPubKey: OP_0 PUSH20 <hash> = "0014" + 40 hex chars.
		expect(spk).toMatch(/^0014[0-9a-f]{40}$/);

		// Re-encode the SAME witness program as a regtest address — exactly the
		// mismatch the bug hit (derived bc1 vs on-chain bcrt1).
		const dec = bech32.decode(address as `bc1${string}`);
		const program = bech32.fromWords(dec.words.slice(1));
		const regtestAddr = bech32.encode('bcrt', dec.words);
		expect(regtestAddr.startsWith('bcrt1q')).toBe(true);
		expect(regtestAddr).not.toBe(address); // different STRING…

		// …but the node reports the identical scriptPubKey for both, which is what
		// the fix now matches on. So an output paying this key is attributed to the
		// wallet whether the explorer speaks mainnet or regtest.
		const onChainScript = '0014' + bytesToHex(program);
		expect(onChainScript).toBe(spk);
	});

	it('equals addressToScriptPubKey, lowercase hex', () => {
		const parsed = parseXpub(BIP84_ZPUB);
		const { address } = deriveAddress(parsed, 0, 5);
		const hex = scriptPubKeyHex(address);
		expect(hex).toBe(bytesToHex(addressToScriptPubKey(address)));
		expect(hex).toBe(hex.toLowerCase());
	});

	it('distinct derived addresses yield distinct scripts (no accidental collision)', () => {
		const parsed = parseXpub(BIP84_ZPUB);
		const a = scriptPubKeyHex(deriveAddress(parsed, 0, 0).address);
		const b = scriptPubKeyHex(deriveAddress(parsed, 0, 1).address);
		const change = scriptPubKeyHex(deriveAddress(parsed, 1, 0).address);
		expect(new Set([a, b, change]).size).toBe(3);
	});
});
