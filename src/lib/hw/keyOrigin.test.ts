import { describe, it, expect } from 'vitest';
import { Transaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import { psbtHasKeyOrigin } from './keyOrigin';

const PUBKEY = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const HARDENED = 0x80000000;
const DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function makeInput(withDerivation: boolean) {
	return {
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n },
		...(withDerivation
			? {
					bip32Derivation: [
						[
							PUBKEY,
							{
								fingerprint: 0x1a2b3c4d,
								path: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED, 0, 4]
							}
						]
					] as [Uint8Array, { fingerprint: number; path: number[] }][]
				}
			: {})
	};
}

function makePsbt(inputs: boolean[]): string {
	const tx = new Transaction();
	for (const withDerivation of inputs) tx.addInput(makeInput(withDerivation));
	tx.addOutputAddress(DEST, 90_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('psbtHasKeyOrigin', () => {
	it('is true when every input carries bip32Derivation', () => {
		expect(psbtHasKeyOrigin(makePsbt([true, true]))).toBe(true);
	});

	it('is false for a bare-xpub PSBT with no derivation info', () => {
		expect(psbtHasKeyOrigin(makePsbt([false]))).toBe(false);
	});

	it('is false when any single input is missing key-origin', () => {
		expect(psbtHasKeyOrigin(makePsbt([true, false]))).toBe(false);
	});

	it('is false for garbage input', () => {
		expect(psbtHasKeyOrigin('not-a-psbt')).toBe(false);
	});

	it('is false for a PSBT with no inputs', () => {
		const tx = new Transaction();
		tx.addOutputAddress(DEST, 90_000n, NETWORK);
		expect(psbtHasKeyOrigin(base64.encode(tx.toPSBT()))).toBe(false);
	});
});
