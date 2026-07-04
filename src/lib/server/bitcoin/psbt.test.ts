import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { Transaction } from '@scure/btc-signer';
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

describe('assertSameTransaction (signer-substitution guard)', () => {
	it('accepts a PSBT with identical inputs and outputs', async () => {
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		// A re-serialization is byte-identical in commitment terms.
		expect(() => assertSameTransaction(draft.psbtBase64, draft.psbtBase64)).not.toThrow();
	});

	it('rejects a PSBT that pays a different recipient', async () => {
		// The tester's exact attack: two drafts, then substitute one for the other.
		const a = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 30_000, feeRate: 10 });
		const b = await constructPsbt({
			...COMMON,
			recipient: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', // different address
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

	it('accepts the same transaction after it has been signed', async () => {
		// Signing must NOT trip the guard — inputs/outputs are unchanged.
		const draft = await constructPsbt({ ...COMMON, recipient: RECIPIENT, amount: 70_000, feeRate: 12 });
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		const signed = base64.encode(tx.toPSBT());
		expect(() => assertSameTransaction(draft.psbtBase64, signed)).not.toThrow();
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
