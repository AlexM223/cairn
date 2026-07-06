import { describe, it, expect, vi, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import { Transaction, p2wpkh, p2pkh, p2ms, p2wsh, p2sh, NETWORK } from '@scure/btc-signer';
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
	TrezorError,
	multisigScriptPubkeys,
	trezorMultisigSignRequest,
	mergeTrezorMultisigSignatures,
	selectMultisigKeyForDevice,
	xfpFromXpub,
	multisigAccountPath,
	singleSigAccountPath,
	readSingleSigKeyFromTrezor,
	signPsbtWithTrezor,
	type MultisigSignParams
} from './trezor';
import type { ScriptType } from '$lib/types';

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

// ------------------------------------------------------------------- multisigs

// Three deterministic cosigners at the BIP-48 p2wsh account path, exactly the
// { xpub, fingerprint, path } shape multisig keys store.
const MULTISIG_PATH = "m/48'/0'/0'/2'";
const MULTISIG_ORIGIN = [48 + HARDENED, 0 + HARDENED, 0 + HARDENED, 2 + HARDENED];
const MULTISIG_MASTERS = [1, 2, 3].map((fill) =>
	HDKey.fromMasterSeed(new Uint8Array(32).fill(fill))
);
const MULTISIG_ACCOUNTS = MULTISIG_MASTERS.map((m) => m.derive(MULTISIG_PATH));
const MULTISIG_KEYS = MULTISIG_MASTERS.map((m, i) => ({
	xpub: MULTISIG_ACCOUNTS[i].publicExtendedKey,
	fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
	path: MULTISIG_PATH
}));

/** Cosigner k's child pubkey at chain/index. */
function multisigChild(k: number, chain: number, index: number): Uint8Array {
	return MULTISIG_ACCOUNTS[k].deriveChild(chain).deriveChild(index).publicKey!;
}

/** Cosigner indexes in BIP-67 (lexicographic pubkey) order at chain/index. */
function bip67Order(chain: number, index: number): number[] {
	return [0, 1, 2].sort((a, b) =>
		bytesToHex(multisigChild(a, chain, index)) < bytesToHex(multisigChild(b, chain, index)) ? -1 : 1
	);
}

function multisigDerivations(
	chain: number,
	index: number
): [Uint8Array, { fingerprint: number; path: number[] }][] {
	return [0, 1, 2].map((k) => [
		multisigChild(k, chain, index),
		{
			fingerprint: parseInt(MULTISIG_KEYS[k].fingerprint, 16) >>> 0,
			path: [...MULTISIG_ORIGIN, chain, index]
		}
	]);
}

/** A 2-of-3 p2wsh multisig PSBT spending one input at 0/<index>, paying DEST,
 *  optionally with a multisig change output at 1/<changeIndex>. */
function makeMultisigPsbt({
	index = 5,
	changeIndex,
	changeScript = true,
	threshold = 2
}: {
	index?: number;
	changeIndex?: number;
	changeScript?: boolean;
	threshold?: number;
} = {}): string {
	const sorted = bip67Order(0, index).map((k) => multisigChild(k, 0, index));
	const payment = p2wsh(p2ms(threshold, sorted), NETWORK);
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: payment.script, amount: 100_000n },
		witnessScript: payment.witnessScript,
		bip32Derivation: multisigDerivations(0, index)
	});
	tx.addOutputAddress(DEST, 60_000n, NETWORK);
	if (changeIndex !== undefined) {
		const changeSorted = bip67Order(1, changeIndex).map((k) => multisigChild(k, 1, changeIndex));
		const changePayment = p2wsh(p2ms(threshold, changeSorted), NETWORK);
		tx.addOutput({
			script: changePayment.script,
			amount: 30_000n,
			...(changeScript ? { witnessScript: changePayment.witnessScript } : {}),
			bip32Derivation: multisigDerivations(1, changeIndex)
		});
	}
	return base64.encode(tx.toPSBT());
}

function multisigParams(unsignedPsbt: string, overrides: Partial<MultisigSignParams> = {}): MultisigSignParams {
	return {
		unsignedPsbt,
		threshold: 2,
		keys: MULTISIG_KEYS,
		scriptType: 'p2wsh',
		...overrides
	};
}

// A structurally plausible DER signature (0x30 sequence, two 0x20-byte ints).
const MULTISIG_DER_SIG = new Uint8Array([
	0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22)
]);

describe('multisigScriptPubkeys', () => {
	it('recovers pubkeys in SCRIPT order, not sorted order, from a deliberately unsorted script', () => {
		const sorted = bip67Order(0, 5).map((k) => multisigChild(k, 0, 5));
		const scrambled = [...sorted].reverse(); // guaranteed ≠ BIP-67 order for 3 distinct keys
		const { m, pubkeys } = multisigScriptPubkeys(p2ms(2, scrambled).script);
		expect(m).toBe(2);
		expect(pubkeys.map(bytesToHex)).toEqual(scrambled.map(bytesToHex));
		expect(pubkeys.map(bytesToHex)).not.toEqual(sorted.map(bytesToHex));
	});

	it('rejects a non-multisig script', () => {
		expect(() => multisigScriptPubkeys(p2wpkh(PUBKEY, NETWORK).script)).toThrow(TrezorError);
		try {
			multisigScriptPubkeys(p2wpkh(PUBKEY, NETWORK).script);
		} catch (e) {
			expect((e as TrezorError).code).toBe('bad_psbt');
		}
	});
});

describe('trezorMultisigSignRequest', () => {
	it('builds a 2-of-3 p2wsh input with cosigner nodes in the script order', () => {
		const { request, devicePubkeys } = trezorMultisigSignRequest(multisigParams(makeMultisigPsbt()), 0);

		expect(request.coin).toBe('btc');
		expect(request.inputs).toHaveLength(1);
		const input = request.inputs[0];
		expect(input.script_type).toBe('SPENDWITNESS');
		expect(input.prev_hash).toBe('a'.repeat(64));
		expect(input.prev_index).toBe(0);
		expect(input.amount).toBe('100000');
		// This DEVICE's full path (cosigner 0's origin + chain/index).
		expect(input.address_n).toEqual([...MULTISIG_ORIGIN, 0, 5]);

		// Cosigner nodes: BIP-67 order as recovered from the witnessScript, each
		// as the account xpub + the non-hardened [chain, index] suffix.
		const order = bip67Order(0, 5);
		expect(input.multisig.m).toBe(2);
		expect(input.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => MULTISIG_KEYS[k].xpub));
		for (const p of input.multisig.pubkeys) expect(p.address_n).toEqual([0, 5]);
		expect(input.multisig.signatures).toEqual(['', '', '']);

		// The signMap: this device signs with cosigner 0's derived child.
		expect(devicePubkeys).toHaveLength(1);
		expect(bytesToHex(devicePubkeys[0])).toBe(bytesToHex(multisigChild(0, 0, 5)));

		// Destination is a plain address output the device displays.
		expect(request.outputs).toEqual([
			{ address: DEST, amount: '60000', script_type: 'PAYTOADDRESS' }
		]);
	});

	it('follows the script order even when the script is deliberately NOT BIP-67 sorted', () => {
		// Hand-build a PSBT whose witnessScript lists the keys in reversed order —
		// the driver must mirror the script, never re-sort (Bastion RISK #2).
		const scrambled = bip67Order(0, 5)
			.map((k) => multisigChild(k, 0, 5))
			.reverse();
		const payment = p2wsh(p2ms(2, scrambled), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			witnessScript: payment.witnessScript,
			bip32Derivation: multisigDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorMultisigSignRequest(multisigParams(base64.encode(tx.toPSBT())), 0);
		const scriptOrder = bip67Order(0, 5).reverse();
		expect(request.inputs[0].multisig.pubkeys.map((p) => p.node)).toEqual(
			scriptOrder.map((k) => MULTISIG_KEYS[k].xpub)
		);
	});

	it('uses each cosigner as the device key: address_n and signMap follow deviceKeyIndex', () => {
		for (const device of [0, 1, 2]) {
			const { request, devicePubkeys } = trezorMultisigSignRequest(
				multisigParams(makeMultisigPsbt()),
				device
			);
			expect(request.inputs[0].address_n).toEqual([...MULTISIG_ORIGIN, 0, 5]);
			expect(bytesToHex(devicePubkeys[0])).toBe(bytesToHex(multisigChild(device, 0, 5)));
		}
	});

	it('maps p2sh-p2wsh to SPENDP2SHWITNESS', () => {
		const sorted = bip67Order(0, 5).map((k) => multisigChild(k, 0, 5));
		const payment = p2sh(p2wsh(p2ms(2, sorted), NETWORK), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			redeemScript: payment.redeemScript,
			witnessScript: payment.witnessScript,
			bip32Derivation: multisigDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorMultisigSignRequest(
			multisigParams(base64.encode(tx.toPSBT()), { scriptType: 'p2sh-p2wsh' }),
			0
		);
		expect(request.inputs[0].script_type).toBe('SPENDP2SHWITNESS');
		expect(request.refTxs).toBeUndefined();
	});

	it('maps legacy p2sh to SPENDMULTISIG with a refTx from nonWitnessUtxo', () => {
		const sorted = bip67Order(0, 5).map((k) => multisigChild(k, 0, 5));
		const ms = p2ms(2, sorted);
		const payment = p2sh(ms, NETWORK);
		const prev = new Transaction();
		prev.addInput({ txid: hexToBytes('d'.repeat(64)), index: 1 });
		prev.addOutput({ script: payment.script, amount: 100_000n });

		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes(prev.id),
			index: 0,
			nonWitnessUtxo: prev.toBytes(true),
			redeemScript: payment.redeemScript,
			bip32Derivation: multisigDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorMultisigSignRequest(
			multisigParams(base64.encode(tx.toPSBT()), { scriptType: 'p2sh' }),
			0
		);
		expect(request.inputs[0].script_type).toBe('SPENDMULTISIG');
		expect(request.inputs[0].amount).toBe('100000');
		expect(request.refTxs).toHaveLength(1);
		expect(request.refTxs![0].hash).toBe(prev.id);
	});

	it('sends a multisig change output as address_n + multisig so the device verifies ownership', () => {
		const { request } = trezorMultisigSignRequest(
			multisigParams(makeMultisigPsbt({ changeIndex: 2 })),
			1
		);
		expect(request.outputs).toHaveLength(2);
		const change = request.outputs[1];
		expect(change.script_type).toBe('PAYTOWITNESS');
		if (change.script_type !== 'PAYTOWITNESS') throw new Error('unreachable');
		expect(change.address_n).toEqual([...MULTISIG_ORIGIN, 1, 2]);
		expect(change.amount).toBe('30000');
		const order = bip67Order(1, 2);
		expect(change.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => MULTISIG_KEYS[k].xpub));
	});

	it('still builds change (BIP-67 sorted) when the change witnessScript is absent', () => {
		const { request } = trezorMultisigSignRequest(
			multisigParams(makeMultisigPsbt({ changeIndex: 2, changeScript: false })),
			0
		);
		const change = request.outputs[1];
		expect(change.script_type).toBe('PAYTOWITNESS');
		if (change.script_type !== 'PAYTOWITNESS') throw new Error('unreachable');
		const order = bip67Order(1, 2);
		expect(change.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => MULTISIG_KEYS[k].xpub));
	});

	it('rejects a threshold that disagrees with the script', () => {
		expect(() => trezorMultisigSignRequest(multisigParams(makeMultisigPsbt(), { threshold: 3 }), 0)).toThrow(
			/threshold/
		);
	});

	it('rejects an input missing its witnessScript', () => {
		const sorted = bip67Order(0, 5).map((k) => multisigChild(k, 0, 5));
		const payment = p2wsh(p2ms(2, sorted), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			bip32Derivation: multisigDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);
		try {
			trezorMultisigSignRequest(multisigParams(base64.encode(tx.toPSBT())), 0);
			expect.unreachable('expected a missing-witnessScript error');
		} catch (e) {
			expect(e).toBeInstanceOf(TrezorError);
			expect((e as TrezorError).code).toBe('bad_psbt');
			expect((e as TrezorError).message).toMatch(/witnessScript/);
		}
	});

	it('rejects a script whose keys are not this multisig\'s cosigners', () => {
		const strangers = [0, 1, 2].map(
			(i) =>
				HDKey.fromMasterSeed(new Uint8Array(32).fill(40 + i))
					.deriveChild(0)
					.deriveChild(0).publicKey!
		);
		const payment = p2wsh(p2ms(2, strangers), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			witnessScript: payment.witnessScript,
			bip32Derivation: multisigDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);
		expect(() => trezorMultisigSignRequest(multisigParams(base64.encode(tx.toPSBT())), 0)).toThrow(
			/isn't derived from this multisig/
		);
	});

	it('rejects an out-of-range device key index', () => {
		expect(() => trezorMultisigSignRequest(multisigParams(makeMultisigPsbt()), 3)).toThrow(TrezorError);
	});

	// cairn-s2bf — pins fix cairn-yaw1 (trezor.ts:1081): an output that carries
	// bip32Derivation but fails multisig-change verification must fall back to a
	// plain display address WITH a console.warn diagnostic — a genuine policy
	// mismatch and a benign unrelated recipient must not collapse into silence.
	it('warns when an output with derivations fails multisig-change verification, falling back to a display address', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// A normal 2-of-3 input…
			const inSorted = bip67Order(0, 5).map((k) => multisigChild(k, 0, 5));
			const inPayment = p2wsh(p2ms(2, inSorted), NETWORK);
			// …and a change-shaped output whose witnessScript is a 2-of-3 of
			// STRANGER keys: the derivations parse, but the script's keys aren't
			// derived from this multisig's cosigners.
			const strangers = [0, 1, 2].map(
				(i) =>
					HDKey.fromMasterSeed(new Uint8Array(32).fill(50 + i))
						.deriveChild(1)
						.deriveChild(2).publicKey!
			);
			const changePayment = p2wsh(p2ms(2, strangers), NETWORK);

			const tx = new Transaction();
			tx.addInput({
				txid: hexToBytes('a'.repeat(64)),
				index: 0,
				witnessUtxo: { script: inPayment.script, amount: 100_000n },
				witnessScript: inPayment.witnessScript,
				bip32Derivation: multisigDerivations(0, 5)
			});
			tx.addOutputAddress(DEST, 60_000n, NETWORK);
			tx.addOutput({
				script: changePayment.script,
				amount: 30_000n,
				witnessScript: changePayment.witnessScript,
				bip32Derivation: multisigDerivations(1, 2)
			});

			const { request } = trezorMultisigSignRequest(
				multisigParams(base64.encode(tx.toPSBT())),
				0
			);

			// Soft-fail behavior preserved: the output becomes a plain address the
			// user confirms on the device, and the request still builds.
			expect(request.outputs).toHaveLength(2);
			expect(request.outputs[1].script_type).toBe('PAYTOADDRESS');
			expect(request.outputs[1].address).toBeTruthy();

			// …but no longer silently: exactly one diagnostic for output 1.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toContain('output 1 not treated as multisig change');
			expect(warn.mock.calls[0]![1]).toBeInstanceOf(TrezorError);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('mergeTrezorMultisigSignatures', () => {
	it('appends SIGHASH_ALL and attributes the signature to the device pubkey', () => {
		const psbt = makeMultisigPsbt();
		const tx = Transaction.fromPSBT(base64.decode(psbt));
		const { devicePubkeys } = trezorMultisigSignRequest(multisigParams(psbt), 1);

		mergeTrezorMultisigSignatures(tx, [bytesToHex(MULTISIG_DER_SIG)], devicePubkeys);

		const input = tx.getInput(0);
		expect(input.partialSig).toHaveLength(1);
		const [pk, s] = input.partialSig![0];
		expect(bytesToHex(Uint8Array.from(pk))).toBe(bytesToHex(multisigChild(1, 0, 5)));
		expect(Array.from(s)).toEqual([...MULTISIG_DER_SIG, 0x01]);
	});

	it('preserves another cosigner\'s existing partialSig (combined-PSBT merge)', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		const otherSig = new Uint8Array([...MULTISIG_DER_SIG, 0x01]);
		tx.updateInput(0, { partialSig: [[multisigChild(2, 0, 5), otherSig]] });

		mergeTrezorMultisigSignatures(tx, [bytesToHex(MULTISIG_DER_SIG)], [multisigChild(0, 0, 5)]);

		const sigs = tx.getInput(0).partialSig!;
		expect(sigs).toHaveLength(2);
		const byPk = new Map(sigs.map(([pk, s]) => [bytesToHex(Uint8Array.from(pk)), s]));
		expect(byPk.has(bytesToHex(multisigChild(0, 0, 5)))).toBe(true);
		expect(byPk.has(bytesToHex(multisigChild(2, 0, 5)))).toBe(true);
	});

	it('rejects a signature whose pubkey is not declared in the input derivations', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		expect(() =>
			mergeTrezorMultisigSignatures(tx, [bytesToHex(MULTISIG_DER_SIG)], [PUBKEY])
		).toThrow(/isn't part of this multisig/);
	});

	it('skips empty per-input entries but requires at least one signature', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		expect(() => mergeTrezorMultisigSignatures(tx, [''], [multisigChild(0, 0, 5)])).toThrow(
			/no signatures/
		);
	});

	it('rejects a count mismatch', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		expect(() => mergeTrezorMultisigSignatures(tx, [], [multisigChild(0, 0, 5)])).toThrow(
			/0 signatures for 1 inputs/
		);
	});
});

describe('selectMultisigKeyForDevice', () => {
	it('matches the device by account xpub key material', () => {
		expect(selectMultisigKeyForDevice(MULTISIG_KEYS, [{ xpub: MULTISIG_KEYS[1].xpub }], null)).toBe(1);
	});

	it('falls back to the master fingerprint when no account xpub matches', () => {
		expect(selectMultisigKeyForDevice(MULTISIG_KEYS, [], MULTISIG_KEYS[2].fingerprint)).toBe(2);
	});

	it('never matches on the placeholder fingerprint', () => {
		const keys = MULTISIG_KEYS.map((k) => ({ ...k, fingerprint: '00000000' }));
		expect(() => selectMultisigKeyForDevice(keys, [], '00000000')).toThrow(TrezorError);
	});

	it('rejects a device that holds none of the multisig\'s keys, naming both sides', () => {
		const stranger = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
		const strangerXpub = stranger.derive(MULTISIG_PATH).publicExtendedKey;
		try {
			selectMultisigKeyForDevice(MULTISIG_KEYS, [{ xpub: strangerXpub }], 'deadbeef');
			expect.unreachable('expected a wrong_device error');
		} catch (e) {
			expect(e).toBeInstanceOf(TrezorError);
			expect((e as TrezorError).code).toBe('wrong_device');
			expect((e as TrezorError).message).toContain('deadbeef');
			for (const k of MULTISIG_KEYS) expect((e as TrezorError).message).toContain(k.fingerprint);
		}
	});

	// cairn-s2bf — pins fix cairn-yaw1 (trezor.ts:1202): a malformed STORED
	// cosigner xpub must leave a console.warn trace, not be silently swallowed
	// into a misleading generic wrong_device.
	it('warns about an unparseable stored cosigner xpub and still resolves via the fingerprint fallback', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const keys = [{ ...MULTISIG_KEYS[0], xpub: 'not-an-xpub' }, MULTISIG_KEYS[1], MULTISIG_KEYS[2]];
			expect(selectMultisigKeyForDevice(keys, [], MULTISIG_KEYS[0].fingerprint)).toBe(0);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toContain('stored cosigner xpub failed to parse');
		} finally {
			warn.mockRestore();
		}
	});

	// cairn-s2bf — pins fix cairn-yaw1 (trezor.ts:1211): an unparseable DEVICE
	// account xpub is warned about and skipped, never failing the whole match.
	it('warns about an unparseable device account xpub and keeps matching the remaining reads', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(
				selectMultisigKeyForDevice(
					MULTISIG_KEYS,
					[{ xpub: 'device-garbage' }, { xpub: MULTISIG_KEYS[2].xpub }],
					null
				)
			).toBe(2);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toContain('device account xpub failed to parse');
		} finally {
			warn.mockRestore();
		}
	});

	// cairn-s2bf — the pre-existing soft-fail contract still holds: when every
	// stored xpub is malformed and nothing matches, the result is the typed
	// wrong_device error — but now with one warning per unparseable key.
	it('still soft-fails to wrong_device after warning about every unparseable stored xpub', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const keys = MULTISIG_KEYS.map((k) => ({ ...k, xpub: 'nope' }));
			try {
				selectMultisigKeyForDevice(keys, [{ xpub: MULTISIG_KEYS[0].xpub }], 'deadbeef');
				expect.unreachable('expected a wrong_device error');
			} catch (e) {
				expect(e).toBeInstanceOf(TrezorError);
				expect((e as TrezorError).code).toBe('wrong_device');
			}
			expect(warn).toHaveBeenCalledTimes(keys.length);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('xfpFromXpub', () => {
	it('recovers the master fingerprint from a depth-0 xpub (BIP32 test vector 1)', () => {
		expect(
			xfpFromXpub(
				'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'
			)
		).toBe('3442193e');
	});

	it('matches the fixture masters', () => {
		for (let i = 0; i < MULTISIG_MASTERS.length; i++) {
			expect(xfpFromXpub(MULTISIG_MASTERS[i].publicExtendedKey)).toBe(MULTISIG_KEYS[i].fingerprint);
		}
	});
});

describe('multisigAccountPath (Trezor)', () => {
	it("maps p2wsh to the BIP-48 2' suffix and both p2sh forms to 1'", () => {
		expect(multisigAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");
		expect(multisigAccountPath('p2sh-p2wsh')).toBe("m/48'/0'/0'/1'");
		expect(multisigAccountPath('p2sh')).toBe("m/48'/0'/0'/1'");
	});

	it('honours a non-default account index', () => {
		expect(multisigAccountPath('p2wsh', 3)).toBe("m/48'/0'/3'/2'");
	});

	it('rejects a bogus account index', () => {
		expect(() => multisigAccountPath('p2wsh', -1)).toThrow(TrezorError);
		expect(() => multisigAccountPath('p2wsh', 1.5)).toThrow(TrezorError);
	});
});

// ------------------------------------------------------------------ single-sig

describe('singleSigAccountPath (Trezor)', () => {
	it('maps each script type to its standard BIP44/49/84/86 account path', () => {
		expect(singleSigAccountPath('p2pkh')).toBe("m/44'/0'/0'");
		expect(singleSigAccountPath('p2sh-p2wpkh')).toBe("m/49'/0'/0'");
		expect(singleSigAccountPath('p2wpkh')).toBe("m/84'/0'/0'");
		expect(singleSigAccountPath('p2tr')).toBe("m/86'/0'/0'");
	});

	it('honours a non-default account index', () => {
		expect(singleSigAccountPath('p2wpkh', 3)).toBe("m/84'/0'/3'");
	});

	it('rejects a bogus account index', () => {
		expect(() => singleSigAccountPath('p2wpkh', -1)).toThrow(TrezorError);
		expect(() => singleSigAccountPath('p2wpkh', 1.5)).toThrow(TrezorError);
	});
});

// A single stubbed TrezorConnect the mocked module returns; each test sets what
// getPublicKey resolves to. Mirrors readMultisigKeyFromTrezor's bundle read
// ([m-path xpub → fingerprint, account xpub → key]) without a real popup.
const trezorStub = {
	init: vi.fn(async () => {}),
	getPublicKey: vi.fn(
		async (_params: { bundle: { path: string; coin?: string; showOnTrezor?: boolean }[] }) => ({
			success: true,
			payload: [] as { xpub: string }[]
		})
	),
	// signPsbtWithTrezor's device call. Loosely typed on purpose: tests script
	// both success and failure payload shapes per call.
	signTransaction: vi.fn(
		async (_params: Record<string, unknown>): Promise<{ success: boolean; payload: unknown }> => ({
			success: false,
			payload: { error: 'not stubbed' }
		})
	)
};
vi.mock('@trezor/connect-web', () => ({ default: trezorStub }));

describe('readSingleSigKeyFromTrezor', () => {
	// A depth-0 master + its account nodes, so xfpFromXpub recovers a real
	// fingerprint and the account xpub is a genuine 78-byte extended key the
	// SLIP-132 re-encode can act on.
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(11));
	const masterXpub = master.publicExtendedKey;
	const EXPECTED_FP = (master.fingerprint >>> 0).toString(16).padStart(8, '0');

	// Script type → its standard purpose and the SLIP-132 prefix the stored key
	// must carry (xpub for p2pkh AND p2tr, ypub for p2sh-p2wpkh, zpub for p2wpkh).
	const CASES: [ScriptType, number, string][] = [
		['p2pkh', 44, 'xpub'],
		['p2sh-p2wpkh', 49, 'ypub'],
		['p2wpkh', 84, 'zpub'],
		['p2tr', 86, 'xpub']
	];

	beforeAll(() => {
		(globalThis as { window?: unknown }).window = { isSecureContext: true, location: { origin: 'https://localhost' } };
	});
	afterAll(() => {
		delete (globalThis as { window?: unknown }).window;
	});
	afterEach(() => {
		trezorStub.getPublicKey.mockReset();
	});

	for (const [scriptType, purpose, prefix] of CASES) {
		it(`reads ${scriptType} at m/${purpose}'/0'/0' and normalizes to the ${prefix} prefix`, async () => {
			const path = `m/${purpose}'/0'/0'`;
			// The device returns a plain xpub for the account node; the reader must
			// re-encode it to the script type's SLIP-132 prefix.
			const accountXpub = master.derive(path).publicExtendedKey;
			trezorStub.getPublicKey.mockResolvedValueOnce({
				success: true,
				payload: [{ xpub: masterXpub }, { xpub: accountXpub }]
			});

			const key = await readSingleSigKeyFromTrezor(scriptType);

			expect(key.path).toBe(path);
			expect(key.fingerprint).toBe(EXPECTED_FP);
			expect(key.xpub.startsWith(prefix)).toBe(true);
			// The reader asked the device for [m, account-path] silently.
			const call = trezorStub.getPublicKey.mock.calls[0]![0];
			expect(call.bundle[0]!.path).toBe('m');
			expect(call.bundle[1]!.path).toBe(path);
			expect(call.bundle[1]!.coin).toBe('btc');
			expect(call.bundle[0]!.showOnTrezor).toBe(false);
		});
	}

	it('honours a non-default account index in the path it requests', async () => {
		const path = "m/84'/0'/2'";
		trezorStub.getPublicKey.mockResolvedValueOnce({
			success: true,
			payload: [{ xpub: masterXpub }, { xpub: master.derive(path).publicExtendedKey }]
		});
		const key = await readSingleSigKeyFromTrezor('p2wpkh', 2);
		expect(key.path).toBe(path);
		expect(trezorStub.getPublicKey.mock.calls[0]![0].bundle[1]!.path).toBe(path);
	});
});

// cairn-aczh — the signing ENTRY POINT itself (signPsbtWithTrezor), previously
// untested beyond its pure helpers: the full popup flow against the mocked
// Connect module — wrong-device guard read, signTransaction, signature merge —
// plus the typed mapping of a device rejection.
describe('signPsbtWithTrezor', () => {
	// The device: a deterministic master whose m/84'/0'/0' account holds the
	// PSBT's input key at 0/4 (makePsbt's defaults).
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(21));
	const account = master.derive("m/84'/0'/0'");
	const child = account.deriveChild(0).deriveChild(4);
	const accountPayload = {
		publicKey: bytesToHex(account.publicKey!),
		chainCode: bytesToHex(account.chainCode!)
	};
	// A structurally plausible DER signature (0x30 sequence, two 0x20-byte ints).
	const SIGN_DER_SIG = new Uint8Array([
		0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x33), 0x02, 0x20, ...new Array(32).fill(0x44)
	]);

	// Loose views for scripting per-call payload shapes (the stub's declared
	// types describe the bundle-read flow used elsewhere in this file).
	const getPublicKey = trezorStub.getPublicKey as unknown as Mock;
	const signTransaction = trezorStub.signTransaction as unknown as Mock;

	beforeAll(() => {
		(globalThis as { window?: unknown }).window = {
			isSecureContext: true,
			location: { origin: 'https://localhost' }
		};
	});
	afterAll(() => {
		delete (globalThis as { window?: unknown }).window;
	});
	afterEach(() => {
		getPublicKey.mockReset();
		signTransaction.mockReset();
	});

	it('throws the typed unavailable error outside a secure browser context, before touching the device', async () => {
		const saved = (globalThis as { window?: unknown }).window;
		delete (globalThis as { window?: unknown }).window;
		try {
			await expect(signPsbtWithTrezor(makePsbt())).rejects.toMatchObject({
				name: 'TrezorError',
				code: 'unavailable'
			});
			expect(signTransaction).not.toHaveBeenCalled();
		} finally {
			(globalThis as { window?: unknown }).window = saved;
		}
	});

	it('happy path: verifies the account, signs, and returns the PSBT with the signature merged', async () => {
		const psbt = makePsbt({ pubkey: child.publicKey! });
		getPublicKey.mockResolvedValueOnce({ success: true, payload: accountPayload });
		signTransaction.mockResolvedValueOnce({
			success: true,
			payload: { signatures: [bytesToHex(SIGN_DER_SIG)] }
		});

		const signedBase64 = await signPsbtWithTrezor(psbt);

		// The wrong-device guard read was silent, at the PSBT's account path.
		expect(getPublicKey).toHaveBeenCalledTimes(1);
		expect(getPublicKey.mock.calls[0]![0]).toMatchObject({
			path: [84 + HARDENED, 0 + HARDENED, 0 + HARDENED],
			coin: 'btc',
			showOnTrezor: false
		});

		// The device request came from the PSBT and never lets Connect broadcast.
		expect(signTransaction).toHaveBeenCalledTimes(1);
		const req = signTransaction.mock.calls[0]![0] as Record<string, unknown>;
		expect(req.push).toBe(false);
		expect(req.coin).toBe('btc');
		expect((req.inputs as unknown[]).length).toBe(1);
		expect((req.outputs as unknown[]).length).toBe(1);

		// The returned PSBT is the ORIGINAL commitment plus the merged signature
		// (device DER sig completed with SIGHASH_ALL, attributed to the input key).
		const signed = Transaction.fromPSBT(base64.decode(signedBase64));
		expect(signed.inputsLength).toBe(1);
		expect(Number(signed.getOutput(0).amount)).toBe(90_000);
		const partialSig = signed.getInput(0).partialSig;
		expect(partialSig).toHaveLength(1);
		const [pk, sig] = partialSig![0];
		expect(bytesToHex(Uint8Array.from(pk))).toBe(bytesToHex(child.publicKey!));
		expect(Array.from(sig)).toEqual([...SIGN_DER_SIG, 0x01]);
	});

	it('maps an on-device rejection from signTransaction to the typed rejected error', async () => {
		const psbt = makePsbt({ pubkey: child.publicKey! });
		getPublicKey.mockResolvedValueOnce({ success: true, payload: accountPayload });
		signTransaction.mockResolvedValueOnce({
			success: false,
			payload: { error: 'Failure_ActionCancelled' }
		});

		await expect(signPsbtWithTrezor(psbt)).rejects.toMatchObject({
			name: 'TrezorError',
			code: 'rejected'
		});
	});

	it('fails the wrong-device guard BEFORE signTransaction when the account derives different keys', async () => {
		const psbt = makePsbt({ pubkey: child.publicKey! });
		const other = HDKey.fromMasterSeed(new Uint8Array(32).fill(22)).derive("m/84'/0'/0'");
		getPublicKey.mockResolvedValueOnce({
			success: true,
			payload: { publicKey: bytesToHex(other.publicKey!), chainCode: bytesToHex(other.chainCode!) }
		});

		await expect(signPsbtWithTrezor(psbt)).rejects.toThrow(/does not hold this wallet's keys/);
		expect(signTransaction).not.toHaveBeenCalled();
	});
});
