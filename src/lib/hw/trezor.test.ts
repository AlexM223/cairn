import { describe, it, expect } from 'vitest';
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
	trezorVaultSignRequest,
	mergeTrezorVaultSignatures,
	selectVaultKeyForDevice,
	xfpFromXpub,
	vaultAccountPath,
	type VaultSignParams
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

// ------------------------------------------------------------------- vaults

// Three deterministic cosigners at the BIP-48 p2wsh account path, exactly the
// { xpub, fingerprint, path } shape vault keys store.
const VAULT_PATH = "m/48'/0'/0'/2'";
const VAULT_ORIGIN = [48 + HARDENED, 0 + HARDENED, 0 + HARDENED, 2 + HARDENED];
const VAULT_MASTERS = [1, 2, 3].map((fill) =>
	HDKey.fromMasterSeed(new Uint8Array(32).fill(fill))
);
const VAULT_ACCOUNTS = VAULT_MASTERS.map((m) => m.derive(VAULT_PATH));
const VAULT_KEYS = VAULT_MASTERS.map((m, i) => ({
	xpub: VAULT_ACCOUNTS[i].publicExtendedKey,
	fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
	path: VAULT_PATH
}));

/** Cosigner k's child pubkey at chain/index. */
function vaultChild(k: number, chain: number, index: number): Uint8Array {
	return VAULT_ACCOUNTS[k].deriveChild(chain).deriveChild(index).publicKey!;
}

/** Cosigner indexes in BIP-67 (lexicographic pubkey) order at chain/index. */
function bip67Order(chain: number, index: number): number[] {
	return [0, 1, 2].sort((a, b) =>
		bytesToHex(vaultChild(a, chain, index)) < bytesToHex(vaultChild(b, chain, index)) ? -1 : 1
	);
}

function vaultDerivations(
	chain: number,
	index: number
): [Uint8Array, { fingerprint: number; path: number[] }][] {
	return [0, 1, 2].map((k) => [
		vaultChild(k, chain, index),
		{
			fingerprint: parseInt(VAULT_KEYS[k].fingerprint, 16) >>> 0,
			path: [...VAULT_ORIGIN, chain, index]
		}
	]);
}

/** A 2-of-3 p2wsh vault PSBT spending one input at 0/<index>, paying DEST,
 *  optionally with a vault change output at 1/<changeIndex>. */
function makeVaultPsbt({
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
	const sorted = bip67Order(0, index).map((k) => vaultChild(k, 0, index));
	const payment = p2wsh(p2ms(threshold, sorted), NETWORK);
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: payment.script, amount: 100_000n },
		witnessScript: payment.witnessScript,
		bip32Derivation: vaultDerivations(0, index)
	});
	tx.addOutputAddress(DEST, 60_000n, NETWORK);
	if (changeIndex !== undefined) {
		const changeSorted = bip67Order(1, changeIndex).map((k) => vaultChild(k, 1, changeIndex));
		const changePayment = p2wsh(p2ms(threshold, changeSorted), NETWORK);
		tx.addOutput({
			script: changePayment.script,
			amount: 30_000n,
			...(changeScript ? { witnessScript: changePayment.witnessScript } : {}),
			bip32Derivation: vaultDerivations(1, changeIndex)
		});
	}
	return base64.encode(tx.toPSBT());
}

function vaultParams(unsignedPsbt: string, overrides: Partial<VaultSignParams> = {}): VaultSignParams {
	return {
		unsignedPsbt,
		threshold: 2,
		keys: VAULT_KEYS,
		scriptType: 'p2wsh',
		...overrides
	};
}

// A structurally plausible DER signature (0x30 sequence, two 0x20-byte ints).
const VAULT_DER_SIG = new Uint8Array([
	0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22)
]);

describe('multisigScriptPubkeys', () => {
	it('recovers pubkeys in SCRIPT order, not sorted order, from a deliberately unsorted script', () => {
		const sorted = bip67Order(0, 5).map((k) => vaultChild(k, 0, 5));
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

describe('trezorVaultSignRequest', () => {
	it('builds a 2-of-3 p2wsh input with cosigner nodes in the script order', () => {
		const { request, devicePubkeys } = trezorVaultSignRequest(vaultParams(makeVaultPsbt()), 0);

		expect(request.coin).toBe('btc');
		expect(request.inputs).toHaveLength(1);
		const input = request.inputs[0];
		expect(input.script_type).toBe('SPENDWITNESS');
		expect(input.prev_hash).toBe('a'.repeat(64));
		expect(input.prev_index).toBe(0);
		expect(input.amount).toBe('100000');
		// This DEVICE's full path (cosigner 0's origin + chain/index).
		expect(input.address_n).toEqual([...VAULT_ORIGIN, 0, 5]);

		// Cosigner nodes: BIP-67 order as recovered from the witnessScript, each
		// as the account xpub + the non-hardened [chain, index] suffix.
		const order = bip67Order(0, 5);
		expect(input.multisig.m).toBe(2);
		expect(input.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => VAULT_KEYS[k].xpub));
		for (const p of input.multisig.pubkeys) expect(p.address_n).toEqual([0, 5]);
		expect(input.multisig.signatures).toEqual(['', '', '']);

		// The signMap: this device signs with cosigner 0's derived child.
		expect(devicePubkeys).toHaveLength(1);
		expect(bytesToHex(devicePubkeys[0])).toBe(bytesToHex(vaultChild(0, 0, 5)));

		// Destination is a plain address output the device displays.
		expect(request.outputs).toEqual([
			{ address: DEST, amount: '60000', script_type: 'PAYTOADDRESS' }
		]);
	});

	it('follows the script order even when the script is deliberately NOT BIP-67 sorted', () => {
		// Hand-build a PSBT whose witnessScript lists the keys in reversed order —
		// the driver must mirror the script, never re-sort (Bastion RISK #2).
		const scrambled = bip67Order(0, 5)
			.map((k) => vaultChild(k, 0, 5))
			.reverse();
		const payment = p2wsh(p2ms(2, scrambled), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			witnessScript: payment.witnessScript,
			bip32Derivation: vaultDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorVaultSignRequest(vaultParams(base64.encode(tx.toPSBT())), 0);
		const scriptOrder = bip67Order(0, 5).reverse();
		expect(request.inputs[0].multisig.pubkeys.map((p) => p.node)).toEqual(
			scriptOrder.map((k) => VAULT_KEYS[k].xpub)
		);
	});

	it('uses each cosigner as the device key: address_n and signMap follow deviceKeyIndex', () => {
		for (const device of [0, 1, 2]) {
			const { request, devicePubkeys } = trezorVaultSignRequest(
				vaultParams(makeVaultPsbt()),
				device
			);
			expect(request.inputs[0].address_n).toEqual([...VAULT_ORIGIN, 0, 5]);
			expect(bytesToHex(devicePubkeys[0])).toBe(bytesToHex(vaultChild(device, 0, 5)));
		}
	});

	it('maps p2sh-p2wsh to SPENDP2SHWITNESS', () => {
		const sorted = bip67Order(0, 5).map((k) => vaultChild(k, 0, 5));
		const payment = p2sh(p2wsh(p2ms(2, sorted), NETWORK), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			redeemScript: payment.redeemScript,
			witnessScript: payment.witnessScript,
			bip32Derivation: vaultDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorVaultSignRequest(
			vaultParams(base64.encode(tx.toPSBT()), { scriptType: 'p2sh-p2wsh' }),
			0
		);
		expect(request.inputs[0].script_type).toBe('SPENDP2SHWITNESS');
		expect(request.refTxs).toBeUndefined();
	});

	it('maps legacy p2sh to SPENDMULTISIG with a refTx from nonWitnessUtxo', () => {
		const sorted = bip67Order(0, 5).map((k) => vaultChild(k, 0, 5));
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
			bip32Derivation: vaultDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);

		const { request } = trezorVaultSignRequest(
			vaultParams(base64.encode(tx.toPSBT()), { scriptType: 'p2sh' }),
			0
		);
		expect(request.inputs[0].script_type).toBe('SPENDMULTISIG');
		expect(request.inputs[0].amount).toBe('100000');
		expect(request.refTxs).toHaveLength(1);
		expect(request.refTxs![0].hash).toBe(prev.id);
	});

	it('sends a vault change output as address_n + multisig so the device verifies ownership', () => {
		const { request } = trezorVaultSignRequest(
			vaultParams(makeVaultPsbt({ changeIndex: 2 })),
			1
		);
		expect(request.outputs).toHaveLength(2);
		const change = request.outputs[1];
		expect(change.script_type).toBe('PAYTOWITNESS');
		if (change.script_type !== 'PAYTOWITNESS') throw new Error('unreachable');
		expect(change.address_n).toEqual([...VAULT_ORIGIN, 1, 2]);
		expect(change.amount).toBe('30000');
		const order = bip67Order(1, 2);
		expect(change.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => VAULT_KEYS[k].xpub));
	});

	it('still builds change (BIP-67 sorted) when the change witnessScript is absent', () => {
		const { request } = trezorVaultSignRequest(
			vaultParams(makeVaultPsbt({ changeIndex: 2, changeScript: false })),
			0
		);
		const change = request.outputs[1];
		expect(change.script_type).toBe('PAYTOWITNESS');
		if (change.script_type !== 'PAYTOWITNESS') throw new Error('unreachable');
		const order = bip67Order(1, 2);
		expect(change.multisig.pubkeys.map((p) => p.node)).toEqual(order.map((k) => VAULT_KEYS[k].xpub));
	});

	it('rejects a threshold that disagrees with the script', () => {
		expect(() => trezorVaultSignRequest(vaultParams(makeVaultPsbt(), { threshold: 3 }), 0)).toThrow(
			/threshold/
		);
	});

	it('rejects an input missing its witnessScript', () => {
		const sorted = bip67Order(0, 5).map((k) => vaultChild(k, 0, 5));
		const payment = p2wsh(p2ms(2, sorted), NETWORK);
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('a'.repeat(64)),
			index: 0,
			witnessUtxo: { script: payment.script, amount: 100_000n },
			bip32Derivation: vaultDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);
		try {
			trezorVaultSignRequest(vaultParams(base64.encode(tx.toPSBT())), 0);
			expect.unreachable('expected a missing-witnessScript error');
		} catch (e) {
			expect(e).toBeInstanceOf(TrezorError);
			expect((e as TrezorError).code).toBe('bad_psbt');
			expect((e as TrezorError).message).toMatch(/witnessScript/);
		}
	});

	it('rejects a script whose keys are not this vault\'s cosigners', () => {
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
			bip32Derivation: vaultDerivations(0, 5)
		});
		tx.addOutputAddress(DEST, 60_000n, NETWORK);
		expect(() => trezorVaultSignRequest(vaultParams(base64.encode(tx.toPSBT())), 0)).toThrow(
			/isn't derived from this vault/
		);
	});

	it('rejects an out-of-range device key index', () => {
		expect(() => trezorVaultSignRequest(vaultParams(makeVaultPsbt()), 3)).toThrow(TrezorError);
	});
});

describe('mergeTrezorVaultSignatures', () => {
	it('appends SIGHASH_ALL and attributes the signature to the device pubkey', () => {
		const psbt = makeVaultPsbt();
		const tx = Transaction.fromPSBT(base64.decode(psbt));
		const { devicePubkeys } = trezorVaultSignRequest(vaultParams(psbt), 1);

		mergeTrezorVaultSignatures(tx, [bytesToHex(VAULT_DER_SIG)], devicePubkeys);

		const input = tx.getInput(0);
		expect(input.partialSig).toHaveLength(1);
		const [pk, s] = input.partialSig![0];
		expect(bytesToHex(Uint8Array.from(pk))).toBe(bytesToHex(vaultChild(1, 0, 5)));
		expect(Array.from(s)).toEqual([...VAULT_DER_SIG, 0x01]);
	});

	it('preserves another cosigner\'s existing partialSig (combined-PSBT merge)', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeVaultPsbt()));
		const otherSig = new Uint8Array([...VAULT_DER_SIG, 0x01]);
		tx.updateInput(0, { partialSig: [[vaultChild(2, 0, 5), otherSig]] });

		mergeTrezorVaultSignatures(tx, [bytesToHex(VAULT_DER_SIG)], [vaultChild(0, 0, 5)]);

		const sigs = tx.getInput(0).partialSig!;
		expect(sigs).toHaveLength(2);
		const byPk = new Map(sigs.map(([pk, s]) => [bytesToHex(Uint8Array.from(pk)), s]));
		expect(byPk.has(bytesToHex(vaultChild(0, 0, 5)))).toBe(true);
		expect(byPk.has(bytesToHex(vaultChild(2, 0, 5)))).toBe(true);
	});

	it('rejects a signature whose pubkey is not declared in the input derivations', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeVaultPsbt()));
		expect(() =>
			mergeTrezorVaultSignatures(tx, [bytesToHex(VAULT_DER_SIG)], [PUBKEY])
		).toThrow(/isn't part of this vault/);
	});

	it('skips empty per-input entries but requires at least one signature', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeVaultPsbt()));
		expect(() => mergeTrezorVaultSignatures(tx, [''], [vaultChild(0, 0, 5)])).toThrow(
			/no signatures/
		);
	});

	it('rejects a count mismatch', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeVaultPsbt()));
		expect(() => mergeTrezorVaultSignatures(tx, [], [vaultChild(0, 0, 5)])).toThrow(
			/0 signatures for 1 inputs/
		);
	});
});

describe('selectVaultKeyForDevice', () => {
	it('matches the device by account xpub key material', () => {
		expect(selectVaultKeyForDevice(VAULT_KEYS, [{ xpub: VAULT_KEYS[1].xpub }], null)).toBe(1);
	});

	it('falls back to the master fingerprint when no account xpub matches', () => {
		expect(selectVaultKeyForDevice(VAULT_KEYS, [], VAULT_KEYS[2].fingerprint)).toBe(2);
	});

	it('never matches on the placeholder fingerprint', () => {
		const keys = VAULT_KEYS.map((k) => ({ ...k, fingerprint: '00000000' }));
		expect(() => selectVaultKeyForDevice(keys, [], '00000000')).toThrow(TrezorError);
	});

	it('rejects a device that holds none of the vault\'s keys, naming both sides', () => {
		const stranger = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
		const strangerXpub = stranger.derive(VAULT_PATH).publicExtendedKey;
		try {
			selectVaultKeyForDevice(VAULT_KEYS, [{ xpub: strangerXpub }], 'deadbeef');
			expect.unreachable('expected a wrong_device error');
		} catch (e) {
			expect(e).toBeInstanceOf(TrezorError);
			expect((e as TrezorError).code).toBe('wrong_device');
			expect((e as TrezorError).message).toContain('deadbeef');
			for (const k of VAULT_KEYS) expect((e as TrezorError).message).toContain(k.fingerprint);
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
		for (let i = 0; i < VAULT_MASTERS.length; i++) {
			expect(xfpFromXpub(VAULT_MASTERS[i].publicExtendedKey)).toBe(VAULT_KEYS[i].fingerprint);
		}
	});
});

describe('vaultAccountPath (Trezor)', () => {
	it("maps p2wsh to the BIP-48 2' suffix and both p2sh forms to 1'", () => {
		expect(vaultAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");
		expect(vaultAccountPath('p2sh-p2wsh')).toBe("m/48'/0'/0'/1'");
		expect(vaultAccountPath('p2sh')).toBe("m/48'/0'/0'/1'");
	});

	it('honours a non-default account index', () => {
		expect(vaultAccountPath('p2wsh', 3)).toBe("m/48'/0'/3'/2'");
	});

	it('rejects a bogus account index', () => {
		expect(() => vaultAccountPath('p2wsh', -1)).toThrow(TrezorError);
		expect(() => vaultAccountPath('p2wsh', 1.5)).toThrow(TrezorError);
	});
});
