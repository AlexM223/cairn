import { describe, it, expect } from 'vitest';
import { Transaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
	isWebHidAvailable,
	accountOriginFromPsbt,
	fingerprintToBuffer,
	mergeSignatures,
	toLedgerError,
	LedgerError
} from './ledger';

// A deterministic compressed pubkey (secp256k1 generator, X-only prefixed 0x02).
const PUBKEY = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const HARDENED = 0x80000000;

// Build a minimal single-input p2wpkh PSBT carrying bip32Derivation exactly as
// src/lib/server/bitcoin/psbt.ts embeds it: [pubkey, { fingerprint: uint32, path }].
function makePsbt({
	fingerprint = 0x1a2b3c4d,
	accountPath = [84 + HARDENED, 0 + HARDENED, 0 + HARDENED],
	chain = 0,
	index = 4
}: {
	fingerprint?: number;
	accountPath?: number[];
	chain?: number;
	index?: number;
} = {}): string {
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n },
		bip32Derivation: [[PUBKEY, { fingerprint, path: [...accountPath, chain, index] }]]
	});
	tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('isWebHidAvailable', () => {
	it('is false in a Node/SSR environment with no navigator.hid', () => {
		expect(isWebHidAvailable()).toBe(false);
	});
});

describe('fingerprintToBuffer', () => {
	it('renders a uint32 as 4-byte big-endian', () => {
		expect(Array.from(fingerprintToBuffer(0x1a2b3c4d))).toEqual([0x1a, 0x2b, 0x3c, 0x4d]);
	});
	it('handles the high bit without sign issues', () => {
		expect(Array.from(fingerprintToBuffer(0xf0000001))).toEqual([0xf0, 0x00, 0x00, 0x01]);
	});
});

describe('accountOriginFromPsbt', () => {
	it('recovers fingerprint, account path (chain/index stripped), and wpkh template', () => {
		const origin = accountOriginFromPsbt(makePsbt());
		expect(origin.fingerprint).toBe(0x1a2b3c4d);
		expect(origin.accountPath).toEqual([84 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
		expect(origin.template).toBe('wpkh(@0/**)');
	});

	it('maps each BIP purpose to its Ledger descriptor template', () => {
		const cases: [number, string][] = [
			[44, 'pkh(@0/**)'],
			[49, 'sh(wpkh(@0/**))'],
			[84, 'wpkh(@0/**)'],
			[86, 'tr(@0/**)']
		];
		for (const [purpose, template] of cases) {
			const psbt = makePsbt({
				accountPath: [purpose + HARDENED, 0 + HARDENED, 0 + HARDENED]
			});
			expect(accountOriginFromPsbt(psbt).template).toBe(template);
		}
	});

	it('honours a non-default account index (m/84\'/0\'/3\')', () => {
		const psbt = makePsbt({
			accountPath: [84 + HARDENED, 0 + HARDENED, 3 + HARDENED]
		});
		expect(accountOriginFromPsbt(psbt).accountPath[2]).toBe(3 + HARDENED);
	});

	it('throws bad_psbt when the input has no bip32Derivation', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('b'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
		const psbt = base64.encode(tx.toPSBT());
		expect(() => accountOriginFromPsbt(psbt)).toThrow(LedgerError);
		try {
			accountOriginFromPsbt(psbt);
		} catch (e) {
			expect((e as LedgerError).code).toBe('bad_psbt');
		}
	});

	it('throws bad_psbt for a non-standard purpose', () => {
		const psbt = makePsbt({ accountPath: [99 + HARDENED, 0 + HARDENED, 0 + HARDENED] });
		expect(() => accountOriginFromPsbt(psbt)).toThrow(/not a standard single-sig/);
	});

	it('throws bad_psbt on garbage input', () => {
		expect(() => accountOriginFromPsbt('not-a-psbt')).toThrow(LedgerError);
	});
});

describe('mergeSignatures', () => {
	it('attaches a partial signature to the input pubkey and preserves the commitment', () => {
		const psbt = makePsbt();
		const tx = Transaction.fromPSBT(base64.decode(psbt));

		// A dummy DER-ish signature blob (content is opaque to the merge step).
		const sig = new Uint8Array([0x30, 0x44, ...new Array(68).fill(0x11)]);
		mergeSignatures(tx, new Map([[0, Buffer.from(sig)]]));

		const input = tx.getInput(0);
		expect(input.partialSig).toBeDefined();
		expect(input.partialSig!.length).toBe(1);
		const [pk, s] = input.partialSig![0];
		expect(Array.from(pk)).toEqual(Array.from(PUBKEY));
		expect(Array.from(s)).toEqual(Array.from(sig));

		// Inputs and outputs (the commitment) are unchanged by signing.
		const before = Transaction.fromPSBT(base64.decode(psbt));
		expect(tx.inputsLength).toBe(before.inputsLength);
		expect(tx.outputsLength).toBe(before.outputsLength);
		expect(Number(tx.getOutput(0).amount)).toBe(90_000);
	});

	it('throws when a signature targets an input with no key-origin', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('c'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
		expect(() => mergeSignatures(tx, new Map([[0, Buffer.from([1, 2, 3])]]))).toThrow(LedgerError);
	});
});

describe('toLedgerError', () => {
	it('passes a LedgerError through unchanged', () => {
		const orig = new LedgerError('x', 'bad_psbt');
		expect(toLedgerError(orig)).toBe(orig);
	});

	it('classifies the app-not-open status code', () => {
		expect(toLedgerError({ statusCode: 0x6e01 }).code).toBe('app_not_open');
	});

	it('classifies user rejection', () => {
		expect(toLedgerError({ statusCode: 0x6985 }).code).toBe('rejected');
	});

	it('classifies a locked device', () => {
		expect(toLedgerError({ statusCode: 0x5515 }).code).toBe('device_locked');
	});

	it('classifies no-device-selected from a WebHID NotFoundError', () => {
		expect(toLedgerError({ name: 'NotFoundError', message: 'no device selected' }).code).toBe(
			'no_device'
		);
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toLedgerError(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});
