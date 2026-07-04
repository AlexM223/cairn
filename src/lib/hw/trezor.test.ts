import { describe, it, expect } from 'vitest';
import { Transaction, p2wpkh, p2pkh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
	isTrezorConnectAvailable,
	trezorSignRequestFromPsbt,
	accountPathFromPsbt,
	assertAccountMatchesPsbt,
	mergeTrezorSignatures,
	toTrezorError,
	TrezorError
} from './trezor';

// A deterministic compressed pubkey (secp256k1 generator, X-only prefixed 0x02).
const PUBKEY = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const HARDENED = 0x80000000;
const DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

// Build a minimal single-input p2wpkh PSBT carrying bip32Derivation exactly as
// src/lib/server/bitcoin/psbt.ts embeds it: [pubkey, { fingerprint: uint32, path }].
function makePsbt({
	pubkey = PUBKEY,
	fingerprint = 0x1a2b3c4d,
	accountPath = [84 + HARDENED, 0 + HARDENED, 0 + HARDENED],
	chain = 0,
	index = 4,
	sequence
}: {
	pubkey?: Uint8Array;
	fingerprint?: number;
	accountPath?: number[];
	chain?: number;
	index?: number;
	sequence?: number;
} = {}): string {
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: p2wpkh(pubkey, NETWORK).script, amount: 100_000n },
		bip32Derivation: [[pubkey, { fingerprint, path: [...accountPath, chain, index] }]],
		...(sequence !== undefined ? { sequence } : {})
	});
	tx.addOutputAddress(DEST, 90_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

// A raw previous transaction paying one p2pkh output, plus a spending PSBT that
// carries it as nonWitnessUtxo — the legacy-input shape psbt.ts produces.
function makeLegacyPsbt(): { psbt: string; prevTxid: string } {
	const prev = new Transaction();
	prev.addInput({ txid: hexToBytes('d'.repeat(64)), index: 1, sequence: 0xfffffffe });
	prev.addOutput({ script: p2pkh(PUBKEY, NETWORK).script, amount: 100_000n });
	const prevBytes = prev.toBytes(true);

	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes(prev.id),
		index: 0,
		nonWitnessUtxo: prevBytes,
		bip32Derivation: [
			[PUBKEY, { fingerprint: 0x1a2b3c4d, path: [44 + HARDENED, 0 + HARDENED, 0 + HARDENED, 0, 4] }]
		]
	});
	tx.addOutputAddress(DEST, 90_000n, NETWORK);
	return { psbt: base64.encode(tx.toPSBT()), prevTxid: prev.id };
}

describe('isTrezorConnectAvailable', () => {
	it('is false in a Node/SSR environment with no window', () => {
		expect(isTrezorConnectAvailable()).toBe(false);
	});
});

describe('trezorSignRequestFromPsbt', () => {
	it('translates a p2wpkh input to SPENDWITNESS with the full derivation path', () => {
		const req = trezorSignRequestFromPsbt(makePsbt());
		expect(req.coin).toBe('btc');
		expect(req.inputs).toHaveLength(1);
		expect(req.inputs[0]).toEqual({
			address_n: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED, 0, 4],
			prev_hash: 'a'.repeat(64),
			prev_index: 0,
			amount: '100000',
			script_type: 'SPENDWITNESS',
			sequence: 4294967295 // btc-signer's default; passed through explicitly
		});
	});

	it('sends the destination as a plain address output the device will display', () => {
		const req = trezorSignRequestFromPsbt(makePsbt());
		expect(req.outputs).toEqual([{ address: DEST, amount: '90000', script_type: 'PAYTOADDRESS' }]);
	});

	it('commits to the PSBT version and locktime, and omits refTxs for segwit', () => {
		const req = trezorSignRequestFromPsbt(makePsbt());
		expect(req.version).toBe(2);
		expect(req.locktime).toBe(0);
		expect(req.refTxs).toBeUndefined();
	});

	it('maps each BIP purpose to its Trezor input script type', () => {
		const cases: [number, string][] = [
			[44, 'SPENDADDRESS'],
			[49, 'SPENDP2SHWITNESS'],
			[84, 'SPENDWITNESS'],
			[86, 'SPENDTAPROOT']
		];
		for (const [purpose, scriptType] of cases) {
			const psbt = makePsbt({
				accountPath: [purpose + HARDENED, 0 + HARDENED, 0 + HARDENED]
			});
			expect(trezorSignRequestFromPsbt(psbt).inputs[0].script_type).toBe(scriptType);
		}
	});

	it('passes an explicit (RBF) sequence through unchanged', () => {
		const req = trezorSignRequestFromPsbt(makePsbt({ sequence: 0xfffffffd }));
		expect(req.inputs[0].sequence).toBe(0xfffffffd);
	});

	it('builds a refTx from nonWitnessUtxo for a legacy input', () => {
		const { psbt, prevTxid } = makeLegacyPsbt();
		const req = trezorSignRequestFromPsbt(psbt);

		expect(req.inputs[0].script_type).toBe('SPENDADDRESS');
		expect(req.inputs[0].prev_hash).toBe(prevTxid);
		expect(req.inputs[0].amount).toBe('100000');

		expect(req.refTxs).toHaveLength(1);
		const ref = req.refTxs![0];
		expect(ref.hash).toBe(prevTxid);
		expect(ref.version).toBe(2);
		expect(ref.lock_time).toBe(0);
		expect(ref.inputs).toEqual([
			{ prev_hash: 'd'.repeat(64), prev_index: 1, script_sig: '', sequence: 0xfffffffe }
		]);
		expect(ref.bin_outputs).toEqual([
			{ amount: 100_000, script_pubkey: bytesToHex(p2pkh(PUBKEY, NETWORK).script) }
		]);
	});

	it('sends a change output carrying bip32Derivation as address_n', () => {
		const tx = Transaction.fromPSBT(base64.decode(makePsbt()));
		tx.addOutput({
			script: p2wpkh(PUBKEY, NETWORK).script,
			amount: 5_000n,
			bip32Derivation: [
				[PUBKEY, { fingerprint: 0x1a2b3c4d, path: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED, 1, 7] }]
			]
		});
		const req = trezorSignRequestFromPsbt(base64.encode(tx.toPSBT()));
		expect(req.outputs[1]).toEqual({
			address_n: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED, 1, 7],
			amount: '5000',
			script_type: 'PAYTOWITNESS'
		});
	});

	it('throws bad_psbt when an input has no bip32Derivation', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('b'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress(DEST, 90_000n, NETWORK);
		const psbt = base64.encode(tx.toPSBT());
		expect(() => trezorSignRequestFromPsbt(psbt)).toThrow(TrezorError);
		try {
			trezorSignRequestFromPsbt(psbt);
		} catch (e) {
			expect((e as TrezorError).code).toBe('bad_psbt');
		}
	});

	it('throws bad_psbt for a non-standard purpose', () => {
		const psbt = makePsbt({ accountPath: [99 + HARDENED, 0 + HARDENED, 0 + HARDENED] });
		expect(() => trezorSignRequestFromPsbt(psbt)).toThrow(/not a standard single-sig/);
	});

	it('throws bad_psbt on garbage input', () => {
		expect(() => trezorSignRequestFromPsbt('not-a-psbt')).toThrow(TrezorError);
	});
});

describe('accountPathFromPsbt', () => {
	it('recovers the account path with chain/index stripped', () => {
		expect(accountPathFromPsbt(makePsbt())).toEqual([84 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
	});

	it("honours a non-default account index (m/84'/0'/3')", () => {
		const psbt = makePsbt({ accountPath: [84 + HARDENED, 0 + HARDENED, 3 + HARDENED] });
		expect(accountPathFromPsbt(psbt)[2]).toBe(3 + HARDENED);
	});
});

describe('assertAccountMatchesPsbt', () => {
	const ACCOUNT_PATH = [84 + HARDENED, 0 + HARDENED, 0 + HARDENED];
	const seed = new Uint8Array(32).fill(7);
	const account = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'");
	const accountNode = {
		publicKey: bytesToHex(account.publicKey!),
		chainCode: bytesToHex(account.chainCode!)
	};

	function psbtForChild(chain: number, index: number): Transaction {
		const child = account.deriveChild(chain).deriveChild(index);
		const psbt = makePsbt({ pubkey: child.publicKey!, accountPath: ACCOUNT_PATH, chain, index });
		return Transaction.fromPSBT(base64.decode(psbt));
	}

	it('accepts a PSBT whose input pubkeys derive from the device account', () => {
		expect(() => assertAccountMatchesPsbt(psbtForChild(0, 4), ACCOUNT_PATH, accountNode)).not.toThrow();
	});

	it('rejects a device whose account derives different keys', () => {
		const other = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/84'/0'/0'");
		const wrongNode = {
			publicKey: bytesToHex(other.publicKey!),
			chainCode: bytesToHex(other.chainCode!)
		};
		try {
			assertAccountMatchesPsbt(psbtForChild(0, 4), ACCOUNT_PATH, wrongNode);
			expect.unreachable('expected a wrong-device error');
		} catch (e) {
			expect(e).toBeInstanceOf(TrezorError);
			expect((e as TrezorError).message).toMatch(/does not hold this wallet's keys/);
		}
	});

	it('rejects a PSBT whose input path does not extend the account path', () => {
		const otherAccount = [84 + HARDENED, 0 + HARDENED, 1 + HARDENED];
		try {
			assertAccountMatchesPsbt(psbtForChild(0, 4), otherAccount, accountNode);
			expect.unreachable('expected a mixed-accounts error');
		} catch (e) {
			expect((e as TrezorError).code).toBe('bad_psbt');
		}
	});
});

describe('mergeTrezorSignatures', () => {
	// A structurally plausible DER signature (0x30 sequence, two 0x20-byte ints).
	const DER_SIG = new Uint8Array([
		0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22)
	]);

	it('appends SIGHASH_ALL and attaches the signature to the input pubkey', () => {
		const psbt = makePsbt();
		const tx = Transaction.fromPSBT(base64.decode(psbt));

		mergeTrezorSignatures(tx, [bytesToHex(DER_SIG)]);

		const input = tx.getInput(0);
		expect(input.partialSig).toBeDefined();
		expect(input.partialSig!.length).toBe(1);
		const [pk, s] = input.partialSig![0];
		expect(Array.from(pk)).toEqual(Array.from(PUBKEY));
		expect(Array.from(s)).toEqual([...DER_SIG, 0x01]); // Trezor omits the sighash byte

		// Inputs and outputs (the commitment) are unchanged by signing.
		const before = Transaction.fromPSBT(base64.decode(psbt));
		expect(tx.inputsLength).toBe(before.inputsLength);
		expect(tx.outputsLength).toBe(before.outputsLength);
		expect(Number(tx.getOutput(0).amount)).toBe(90_000);
	});

	it('throws when the signature count does not match the input count', () => {
		const tx = Transaction.fromPSBT(base64.decode(makePsbt()));
		expect(() => mergeTrezorSignatures(tx, [])).toThrow(/0 signatures for 1 inputs/);
		expect(() =>
			mergeTrezorSignatures(tx, [bytesToHex(DER_SIG), bytesToHex(DER_SIG)])
		).toThrow(TrezorError);
	});

	it('throws on a malformed (non-DER) signature instead of merging it', () => {
		const tx = Transaction.fromPSBT(base64.decode(makePsbt()));
		expect(() => mergeTrezorSignatures(tx, ['11'.repeat(64)])).toThrow(/malformed signature/);
	});

	it('throws when a signature targets an input with no key-origin', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('c'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress(DEST, 90_000n, NETWORK);
		expect(() => mergeTrezorSignatures(tx, [bytesToHex(DER_SIG)])).toThrow(TrezorError);
	});
});

describe('toTrezorError', () => {
	it('passes a TrezorError through unchanged', () => {
		const orig = new TrezorError('x', 'bad_psbt');
		expect(toTrezorError(orig)).toBe(orig);
	});

	it('classifies an on-device rejection before the generic cancel branch', () => {
		expect(toTrezorError({ error: 'Failure_ActionCancelled' }).code).toBe('rejected');
	});

	it('classifies a closed popup as a host-side cancellation', () => {
		expect(toTrezorError({ error: 'Popup closed', code: 'Method_Interrupted' }).code).toBe(
			'cancelled'
		);
	});

	it('classifies denied Connect permissions as a host-side cancellation', () => {
		expect(toTrezorError({ error: 'Permissions not granted' }).code).toBe('cancelled');
	});

	it('classifies a disconnected device', () => {
		expect(toTrezorError({ error: 'device disconnected during action' }).code).toBe('no_device');
	});

	it('classifies a restricted key path as bad_psbt, not an on-device rejection', () => {
		expect(toTrezorError({ error: 'Forbidden key path' }).code).toBe('bad_psbt');
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toTrezorError(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});
