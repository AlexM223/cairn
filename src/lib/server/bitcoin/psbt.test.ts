import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { Transaction, NETWORK } from '@scure/btc-signer';
import {
	constructPsbt,
	summarizePsbt,
	finalizePsbt,
	assertSameTransaction,
	parseOriginPath,
	PsbtError,
	PsbtMismatchError,
	type SpendableUtxo
} from './psbt';

// BIP84 documentation vectors ("abandon … about" mnemonic) — public test
// keys, never a real wallet.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ZPRV =
	'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5';

const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const RECEIVE_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/0/1
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const UTXOS: SpendableUtxo[] = [
	{ txid: '11'.repeat(32), vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 },
	{ txid: '22'.repeat(32), vout: 1, value: 40_000, height: 800_001, address: RECEIVE_1, chain: 0, index: 1 },
	{ txid: '33'.repeat(32), vout: 0, value: 5_000, height: 0, address: RECEIVE_0, chain: 0, index: 0 }
];

const COMMON = {
	xpub: ZPUB,
	utxos: UTXOS,
	changeAddress: CHANGE_0,
	changeIndex: 0,
	origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
};

function accountKey(): HDKey {
	const b58 = base58check(sha256);
	const raw = b58.decode(ZPRV);
	raw.set([0x04, 0x88, 0xad, 0xe4], 0); // rewrite SLIP-132 zprv → xprv
	return HDKey.fromExtendedKey(b58.encode(raw)).derive("m/84'/0'/0'");
}

/**
 * A synthetic previous transaction paying the given outputs, with its REAL
 * txid (display-order hex, as explorers and Electrum report it). Lets tests
 * exercise the nonWitnessUtxo path, where btc-signer verifies the raw tx
 * hashes to the input's txid.
 */
function fundingTx(outputs: { address: string; value: number }[]): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

const FUND_A = fundingTx([{ address: RECEIVE_0, value: 60_000 }]);
const FUND_B = fundingTx([{ address: RECEIVE_1, value: 40_000 }]);
const RAW_TXS: Record<string, string> = { [FUND_A.txid]: FUND_A.hex, [FUND_B.txid]: FUND_B.hex };

/** UTXOs whose txids genuinely hash from RAW_TXS — usable with fetchRawTx. */
const REAL_UTXOS: SpendableUtxo[] = [
	{ txid: FUND_A.txid, vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 },
	{ txid: FUND_B.txid, vout: 0, value: 40_000, height: 800_001, address: RECEIVE_1, chain: 0, index: 1 }
];

async function fetchRawTx(txid: string): Promise<string> {
	const hex = RAW_TXS[txid];
	if (!hex) throw new Error(`no such tx ${txid}`);
	return hex;
}

describe('constructPsbt', () => {
	it('builds a spend with change and conserves value', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		expect(draft.amount).toBe(30_000);
		expect(draft.fee).toBeGreaterThan(0);
		const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputs).toContainEqual({ address: RECIPIENT, value: 30_000 });
		expect(summary.signedInputs).toBe(0);
		expect(summary.complete).toBe(false);
		if (draft.change) {
			expect(summary.outputs).toContainEqual({ address: CHANGE_0, value: draft.change.value });
		}
	});

	it('returns small change instead of burning it as fee', async () => {
		// Regression: btc-signer's `dust` option is a rate, not a sats
		// threshold — passing 546 there silently swallowed ~1k sats of change.
		const small: SpendableUtxo[] = [
			{ txid: 'aa'.repeat(32), vout: 0, value: 1_860, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
		];
		const draft = await constructPsbt({
			...COMMON,
			utxos: small,
			recipient: RECIPIENT,
			amount: 600,
			feeRate: 1
		});
		expect(draft.change).not.toBeNull();
		expect(draft.change!.value).toBeGreaterThan(900);
		expect(draft.fee).toBeLessThan(300); // ~110 vB segwit tx at 1 sat/vB
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(2);
	});

	it('never selects unconfirmed coins', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		expect(draft.inputs.some((i) => i.txid === '33'.repeat(32))).toBe(false);
	});

	it('sweeps everything confirmed on send-max with a single output', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 'max', feeRate: 5 });
		expect(draft.inputs).toHaveLength(2);
		expect(draft.change).toBeNull();
		expect(draft.amount).toBe(100_000 - draft.fee);
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(1);
		expect(summary.outputs[0].value).toBe(draft.amount);
	});

	it('rejects unaffordable amounts with a friendly error', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 99_999_999, feeRate: 10 })
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});

	it('rejects invalid recipients and fee rates', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipient: 'garbage', amount: 1_000, feeRate: 5 })
		).rejects.toMatchObject({ code: 'invalid_recipient' });
		await expect(
			constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 1_000, feeRate: 0 })
		).rejects.toMatchObject({ code: 'invalid_amount' });
		expect(PsbtError).toBeDefined();
	});

	it('produces PSBTs a signer can complete via embedded derivation paths', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 70_000, feeRate: 12 });
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));

		for (let i = 0; i < tx.inputsLength; i++) {
			const deriv = tx.getInput(i).bip32Derivation?.[0];
			expect(deriv, `input ${i} carries bip32Derivation`).toBeDefined();
			const path = deriv![1].path;
			const child = account.deriveChild(path[3]).deriveChild(path[4]);
			tx.signIdx(child.privateKey!, i);
		}

		const signed = base64.encode(tx.toPSBT());
		const summary = summarizePsbt(signed);
		expect(summary.complete).toBe(true);
		expect(summary.signedInputs).toBe(tx.inputsLength);

		const { rawHex, txid } = finalizePsbt(signed);
		expect(rawHex.length).toBeGreaterThan(200);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses to finalize an unsigned PSBT', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		expect(() => finalizePsbt(draft.psbtBase64)).toThrow();
	});
});

describe('fee-rate ceiling', () => {
	it('rejects fee rates above 1000 sat/vB as a probable mistake', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 1_000, feeRate: 1001 })
		).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(
			constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 1_000, feeRate: 5_000 })
		).rejects.toThrow(/1000 sat\/vB/);
	});

	it('still allows exactly 1000 sat/vB (the ceiling is exclusive)', async () => {
		const whale: SpendableUtxo[] = [
			{ txid: 'ab'.repeat(32), vout: 0, value: 10_000_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
		];
		const draft = await constructPsbt({
			...COMMON,
			utxos: whale,
			recipient: RECIPIENT,
			amount: 30_000,
			feeRate: 1000
		});
		expect(draft.amount).toBe(30_000);
		expect(draft.fee).toBeGreaterThan(50_000); // ~110 vB at 1000 sat/vB
	});
});

describe('segwit nonWitnessUtxo (fee-lying protection)', () => {
	const WITH_RAW = { ...COMMON, utxos: REAL_UTXOS, fetchRawTx };

	it('attaches the full previous tx ALONGSIDE witnessUtxo on every input', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipient: RECIPIENT, amount: 70_000, feeRate: 10 });
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBeGreaterThan(0);
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			expect(inp.witnessUtxo, `input ${i} keeps witnessUtxo`).toBeDefined();
			expect(inp.nonWitnessUtxo, `input ${i} carries nonWitnessUtxo`).toBeDefined();
		}
	});

	it('does the same on the send-max sweep path', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipient: RECIPIENT, amount: 'max', feeRate: 5 });
		expect(draft.amount).toBe(100_000 - draft.fee);
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBe(2);
		for (let i = 0; i < tx.inputsLength; i++) {
			expect(tx.getInput(i).nonWitnessUtxo).toBeDefined();
			expect(tx.getInput(i).witnessUtxo).toBeDefined();
		}
	});

	it('does not change fee estimation relative to witnessUtxo-only', async () => {
		const withRaw = await constructPsbt({ ...WITH_RAW, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		const withoutRaw = await constructPsbt({
			...COMMON,
			utxos: REAL_UTXOS,
			recipient: RECIPIENT,
			amount: 30_000,
			feeRate: 10
		});
		expect(withRaw.fee).toBe(withoutRaw.fee);
		expect(withRaw.vsize).toBe(withoutRaw.vsize);
	});

	it('remains signable and finalizable with both fields present', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipient: RECIPIENT, amount: 70_000, feeRate: 12 });
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		const { txid } = finalizePsbt(base64.encode(tx.toPSBT()));
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects with a clear error when the fetched prev tx does not match the txid', async () => {
		// Chain source hands back FUND_B's bytes when asked for FUND_A's txid.
		const lying = async () => FUND_B.hex;
		const p = constructPsbt({
			...COMMON,
			utxos: [REAL_UTXOS[0]],
			fetchRawTx: lying,
			recipient: RECIPIENT,
			amount: 10_000,
			feeRate: 5
		});
		await expect(p).rejects.toMatchObject({ code: 'construction_failed' });
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [REAL_UTXOS[0]],
				fetchRawTx: lying,
				recipient: RECIPIENT,
				amount: 10_000,
				feeRate: 5
			})
		).rejects.toThrow(/wrong previous transaction/);
	});

	it('rejects unparseable prev-tx bytes with a clear error', async () => {
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [REAL_UTXOS[0]],
				fetchRawTx: async () => 'deadbeef',
				recipient: RECIPIENT,
				amount: 10_000,
				feeRate: 5
			})
		).rejects.toThrow(/could not be parsed/);
	});

	it('stays witnessUtxo-only when no raw-tx source is provided', async () => {
		// constructPsbt must remain usable without a chain hookup (pure tests,
		// offline preview) — segwit inputs then carry witnessUtxo alone.
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			expect(tx.getInput(i).nonWitnessUtxo).toBeUndefined();
			expect(tx.getInput(i).witnessUtxo).toBeDefined();
		}
	});
});

describe('summarizePsbt coin transparency', () => {
	it('reports per-input txid/vout/value, txid in display order', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: REAL_UTXOS,
			fetchRawTx,
			recipient: RECIPIENT,
			amount: 70_000,
			feeRate: 10
		});
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.inputs).toHaveLength(draft.inputs.length);
		// Round-trip check: FUND_A.txid is a real double-SHA id in display order
		// (what Transaction.id, explorers, and Electrum report). If summarize
		// ever emitted wire-order bytes this would come back reversed.
		expect(summary.inputs).toContainEqual({ txid: FUND_A.txid, vout: 0, value: 60_000 });
		expect(summary.inputs).toContainEqual({ txid: FUND_B.txid, vout: 0, value: 40_000 });
		const reversed = FUND_A.txid.match(/../g)!.reverse().join('');
		expect(summary.inputs.some((i) => i.txid === reversed)).toBe(false);
	});

	it('recovers input values from nonWitnessUtxo when witnessUtxo is absent', () => {
		// Hand-built legacy-style input: full prev tx only, as p2pkh spends carry.
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		tx.addInput({ txid: FUND_A.txid, index: 0, nonWitnessUtxo: hexToBytes(FUND_A.hex) });
		tx.addOutputAddress(RECIPIENT, 59_000n, NETWORK);
		const summary = summarizePsbt(base64.encode(tx.toPSBT()));
		expect(summary.inputs).toEqual([{ txid: FUND_A.txid, vout: 0, value: 60_000 }]);
	});

	it('identifies the change output by its bip32Derivation', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		expect(draft.change).not.toBeNull();
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.change).not.toBeNull();
		expect(summary.change!.value).toBe(draft.change!.value);
		// The identified vout really is the change address's output.
		expect(summary.outputs[summary.change!.vout]).toEqual({
			address: CHANGE_0,
			value: draft.change!.value
		});
	});

	it('returns null change when the wallet has no key origin', async () => {
		const draft = await constructPsbt({
			...COMMON,
			origin: null,
			recipient: RECIPIENT,
			amount: 30_000,
			feeRate: 10
		});
		expect(draft.change).not.toBeNull(); // change exists…
		expect(summarizePsbt(draft.psbtBase64).change).toBeNull(); // …but is not identifiable
	});

	it('returns null change on a changeless sweep', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 'max', feeRate: 5 });
		expect(summarizePsbt(draft.psbtBase64).change).toBeNull();
	});
});

describe('assertSameTransaction (signer-substitution guard)', () => {
	it('accepts a signed PSBT with identical inputs and outputs', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 70_000, feeRate: 12 });
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		// Signing only adds signatures — the guard must not trip.
		expect(() =>
			assertSameTransaction(draft.psbtBase64, base64.encode(tx.toPSBT()))
		).not.toThrow();
	});

	it('rejects a PSBT that pays a different recipient (the substitution attack)', async () => {
		const a = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		const b = await constructPsbt({
			...COMMON,
			recipient: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
			amount: 30_000,
			feeRate: 10
		});
		expect(() => assertSameTransaction(a.psbtBase64, b.psbtBase64)).toThrow(PsbtMismatchError);
	});

	it('rejects a PSBT that changes the amount', async () => {
		const a = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		const b = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 31_000, feeRate: 10 });
		expect(() => assertSameTransaction(a.psbtBase64, b.psbtBase64)).toThrow(PsbtMismatchError);
	});
});

describe('parseOriginPath', () => {
	it('parses hardened notation', () => {
		expect(parseOriginPath("m/84'/0'/0'")).toEqual([0x80000054, 0x80000000, 0x80000000]);
		expect(parseOriginPath('m/84h/0h/0h')).toEqual([0x80000054, 0x80000000, 0x80000000]);
	});

	it('throws on garbage', () => {
		expect(() => parseOriginPath('m/x/y')).toThrow();
	});
});
