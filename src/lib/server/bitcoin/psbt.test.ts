import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { Transaction, NETWORK, Address, OutScript, p2wpkh } from '@scure/btc-signer';
import { addressToScriptPubKey, parseXpub, deriveAddress } from './xpub';
import {
	constructPsbt,
	summarizePsbt,
	finalizePsbt,
	assertSameTransaction,
	addressFromScript,
	parseOriginPath,
	PsbtError,
	PsbtMismatchError,
	type SpendableUtxo
} from './psbt';
import {
	parentVsizeFromRawTx,
	classifyAndCacheParent,
	clearParentMassCache
} from './signingMass';

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
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
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
			recipients: [{ address: RECIPIENT, amount: 600 }],
			feeRate: 1
		});
		expect(draft.change).not.toBeNull();
		expect(draft.change!.value).toBeGreaterThan(900);
		expect(draft.fee).toBeLessThan(300); // ~110 vB segwit tx at 1 sat/vB
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(2);
	});

	it('never selects unconfirmed coins', async () => {
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
		expect(draft.inputs.some((i) => i.txid === '33'.repeat(32))).toBe(false);
	});

	it('sweeps everything confirmed on send-max with a single output', async () => {
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 'max' }], feeRate: 5 });
		expect(draft.inputs).toHaveLength(2);
		expect(draft.change).toBeNull();
		expect(draft.amount).toBe(100_000 - draft.fee);
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(1);
		expect(summary.outputs[0].value).toBe(draft.amount);
	});

	it('rejects unaffordable amounts with a friendly error', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 99_999_999 }], feeRate: 10 })
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});

	it('rejects invalid recipients and fee rates', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipients: [{ address: 'garbage', amount: 1_000 }], feeRate: 5 })
		).rejects.toMatchObject({ code: 'invalid_recipient' });
		await expect(
			constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 1_000 }], feeRate: 0 })
		).rejects.toMatchObject({ code: 'invalid_amount' });
		expect(PsbtError).toBeDefined();
	});

	it('produces PSBTs a signer can complete via embedded derivation paths', async () => {
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 70_000 }], feeRate: 12 });
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
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
		expect(() => finalizePsbt(draft.psbtBase64)).toThrow();
	});

	it('emits NO bip32Derivation without a key origin (cairn-alw8 pre-fix state)', async () => {
		// Regression guard: this is what every single-key wallet's PSBT looked
		// like before wallets stored master_fingerprint — no input carries
		// key-origin data, so no hardware wallet can identify its key. The fix
		// captures the origin at wallet creation; this pins the contract that
		// origin: null honestly produces an origin-free PSBT (never a guessed
		// fingerprint) while origin: {…} produces a signable one (test above).
		const draft = await constructPsbt({
			...COMMON,
			origin: null,
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10
		});
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			expect(tx.getInput(i).bip32Derivation ?? []).toHaveLength(0);
		}
		for (let i = 0; i < tx.outputsLength; i++) {
			expect(tx.getOutput(i).bip32Derivation ?? []).toHaveLength(0);
		}
	});
});

describe('destination address types (all six)', () => {
	// Known-good fixtures. P2SH-P2WPKH shares the 3… script form with plain
	// P2SH — as a DESTINATION they are indistinguishable, so both rows simply
	// exercise the a914…87 template with different known addresses.
	const b58 = base58check(sha256);
	const plainP2sh = (() => {
		// Deterministic 3… address over a fixed 20-byte hash (self-checking:
		// the test derives the expected script from the same hash).
		const payload = new Uint8Array(21);
		payload[0] = 0x05;
		payload.set(Uint8Array.from({ length: 20 }, (_, i) => 0xa0 + i), 1);
		return b58.encode(payload);
	})();

	const DESTS: { kind: string; address: string; spkLen: number; spkHead: string }[] = [
		{
			kind: 'p2pkh',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // genesis
			spkLen: 25,
			spkHead: '76a914'
		},
		{ kind: 'p2sh', address: plainP2sh, spkLen: 23, spkHead: 'a914' },
		{
			kind: 'p2sh-p2wpkh',
			address: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', // BIP-49 test vector
			spkLen: 23,
			spkHead: 'a914'
		},
		{
			kind: 'p2wpkh',
			address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // BIP-173 vector
			spkLen: 22,
			spkHead: '0014'
		},
		{
			kind: 'p2wsh',
			address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', // BIP-173 vector
			spkLen: 34,
			spkHead: '0020'
		},
		{
			kind: 'p2tr',
			address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', // BIP-86 vector m/86'/0'/0'/0/0
			spkLen: 34,
			spkHead: '5120'
		}
	];

	it.each(DESTS)('fixture $kind decodes identically in xpub.ts and btc-signer', ({ address, spkLen, spkHead }) => {
		// Cross-implementation check: our hand-rolled decoder vs btc-signer's —
		// two independent codebases must produce the same scriptPubKey.
		const ours = addressToScriptPubKey(address);
		// Same ArrayBuffer-generics bridge psbt.ts uses for Address/OutScript.
		const theirs = OutScript.encode(Address(NETWORK).decode(address) as never);
		expect(bytesToHex(ours)).toBe(bytesToHex(theirs));
		expect(ours.length).toBe(spkLen);
		expect(bytesToHex(ours).startsWith(spkHead)).toBe(true);
	});

	it.each(DESTS)(
		'constructPsbt pays a $kind destination: script byte-match, value conserved, summary round-trip',
		async ({ address }) => {
			const draft = await constructPsbt({
				...COMMON,
				recipients: [{ address, amount: 20_000 }],
				feeRate: 10
			});

			// The output scriptPubKey byte-matches the address decoder.
			const expectSpk = bytesToHex(addressToScriptPubKey(address));
			const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
			let matched = 0;
			for (let i = 0; i < tx.outputsLength; i++) {
				const out = tx.getOutput(i);
				if (out.script && bytesToHex(out.script) === expectSpk) {
					matched++;
					expect(out.amount).toBe(20_000n);
				}
			}
			expect(matched).toBe(1);

			// Value conservation: inputs = amount + fee + change.
			const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
			expect(totalIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

			// summarizePsbt round-trips the exact address string for review UI.
			const summary = summarizePsbt(draft.psbtBase64);
			expect(summary.outputs).toContainEqual({ address, value: 20_000 });
		}
	);

	it.each(DESTS)('addressFromScript reverse-maps the $kind script to the address', ({ address }) => {
		expect(addressFromScript(addressToScriptPubKey(address))).toBe(address);
	});

	it('addressFromScript returns null for a non-standard script', () => {
		expect(addressFromScript(hexToBytes('6a0548656c6c6f'))).toBeNull(); // OP_RETURN "Hello"
		expect(addressFromScript(new Uint8Array([0x51]))).toBeNull(); // bare OP_1
	});

	it('pays P2TR + P2WPKH + P2PKH simultaneously in one transaction', async () => {
		const p2tr = DESTS.find((d) => d.kind === 'p2tr')!.address;
		const p2wpkh = DESTS.find((d) => d.kind === 'p2wpkh')!.address;
		const p2pkh = DESTS.find((d) => d.kind === 'p2pkh')!.address;
		const draft = await constructPsbt({
			...COMMON,
			recipients: [
				{ address: p2tr, amount: 15_000 },
				{ address: p2wpkh, amount: 12_000 },
				{ address: p2pkh, amount: 11_000 }
			],
			feeRate: 8
		});
		expect(draft.amount).toBe(38_000);
		const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputs).toContainEqual({ address: p2tr, value: 15_000 });
		expect(summary.outputs).toContainEqual({ address: p2wpkh, value: 12_000 });
		expect(summary.outputs).toContainEqual({ address: p2pkh, value: 11_000 });

		// Each destination's scriptPubKey is on the wire exactly as decoded.
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		const scripts = new Set<string>();
		for (let i = 0; i < tx.outputsLength; i++) scripts.add(bytesToHex(tx.getOutput(i).script!));
		for (const address of [p2tr, p2wpkh, p2pkh]) {
			expect(scripts.has(bytesToHex(addressToScriptPubKey(address)))).toBe(true);
		}
	});

	it('send-max to taproot prices the 43-vB output correctly', async () => {
		const p2tr = DESTS.find((d) => d.kind === 'p2tr')!.address;
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: p2tr, amount: 'max' }],
			feeRate: 5
		});
		// 11 overhead + 2 × 68 (p2wpkh inputs) + 43 (p2tr output) = 190 vB.
		expect(draft.vsize).toBe(190);
		expect(draft.fee).toBe(950);
		expect(draft.amount).toBe(100_000 - draft.fee);
	});

	it('remains signable and finalizable when paying a taproot destination', async () => {
		const p2tr = DESTS.find((d) => d.kind === 'p2tr')!.address;
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: p2tr, amount: 70_000 }],
			feeRate: 10
		});
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		const { txid } = finalizePsbt(base64.encode(tx.toPSBT()));
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('coin control (onlyUtxos allowlist)', () => {
	const COIN_60K = { txid: '11'.repeat(32), vout: 0 };
	const COIN_40K = { txid: '22'.repeat(32), vout: 1 };
	const COIN_UNCONFIRMED = { txid: '33'.repeat(32), vout: 0 };

	it('selects only from the allowlisted coins', async () => {
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 5,
			onlyUtxos: [COIN_40K]
		});
		expect(draft.inputs).toHaveLength(1);
		expect(draft.inputs[0]).toMatchObject({ txid: COIN_40K.txid, vout: COIN_40K.vout });
		// Normal selection semantics still apply inside the subset: change exists.
		expect(draft.change).not.toBeNull();
		const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(draft.amount + draft.fee + draft.change!.value);
	});

	it('is a restriction of the candidate set, never adding coins outside it', async () => {
		const allow = new Set([`${COIN_60K.txid}:${COIN_60K.vout}`, `${COIN_40K.txid}:${COIN_40K.vout}`]);
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 5,
			onlyUtxos: [COIN_60K, COIN_40K]
		});
		expect(draft.inputs.every((i) => allow.has(`${i.txid}:${i.vout}`))).toBe(true);
	});

	it('rejects when the selected coins cannot cover amount plus fee', async () => {
		const params = {
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5,
			onlyUtxos: [COIN_40K] // the 40k coin cannot pay 50k + fee
		};
		await expect(constructPsbt(params)).rejects.toMatchObject({ code: 'insufficient_funds' });
		await expect(constructPsbt(params)).rejects.toThrow(/selected coins don't cover/);
	});

	it('spends an unconfirmed coin when the user explicitly allowlists it (coin-control opt-in)', async () => {
		// cairn-u9ob.1: coin control is an explicit opt-in, so an unconfirmed coin
		// the user picked by hand is now spendable (it was previously refused).
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 1_000 }],
			feeRate: 5,
			onlyUtxos: [COIN_UNCONFIRMED]
		});
		expect(draft.inputs).toHaveLength(1);
		expect(draft.inputs[0]).toMatchObject({ txid: COIN_UNCONFIRMED.txid, vout: COIN_UNCONFIRMED.vout });
	});

	it('send-max over an allowlist sweeps exactly the selected coins minus fee', async () => {
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate: 5,
			onlyUtxos: [COIN_40K]
		});
		expect(draft.inputs).toHaveLength(1);
		expect(draft.inputs[0]).toMatchObject({ txid: COIN_40K.txid, vout: COIN_40K.vout });
		expect(draft.amount).toBe(40_000 - draft.fee);
		expect(draft.change).toBeNull();
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(1);
		expect(summary.outputs[0]).toEqual({ address: RECIPIENT, value: draft.amount });
	});

	it('an empty allowlist means automatic selection over everything', async () => {
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 70_000 }],
			feeRate: 5,
			onlyUtxos: []
		});
		// 70k needs both confirmed coins — an empty list must not restrict.
		expect(draft.inputs).toHaveLength(2);
	});
});

describe('unconfirmed coin selection policy (cairn-u9ob.1)', () => {
	const CONFIRMED: SpendableUtxo = {
		txid: 'a1'.repeat(32), vout: 0, value: 100_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0
	};
	const OWN_CHANGE: SpendableUtxo = {
		txid: 'b2'.repeat(32), vout: 0, value: 80_000, height: 0, address: CHANGE_0, chain: 1, index: 0,
		unconfirmedTrust: 'own-change'
	};
	const RECEIVED: SpendableUtxo = {
		txid: 'c3'.repeat(32), vout: 0, value: 80_000, height: 0, address: RECEIVE_1, chain: 0, index: 1,
		unconfirmedTrust: 'received'
	};

	it('prefers confirmed coins and leaves unconfirmed change untouched when confirmed covers it', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [CONFIRMED, OWN_CHANGE],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});
		expect(draft.inputs.map((i) => i.txid)).toEqual([CONFIRMED.txid]);
	});

	it('reaches for unconfirmed own-change only when confirmed coins cannot cover the spend', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [CONFIRMED, OWN_CHANGE],
			recipients: [{ address: RECIPIENT, amount: 150_000 }],
			feeRate: 5
		});
		const used = new Set(draft.inputs.map((i) => i.txid));
		expect(used.has(CONFIRMED.txid)).toBe(true);
		expect(used.has(OWN_CHANGE.txid)).toBe(true);
	});

	it('never auto-selects an unconfirmed coin received from elsewhere', async () => {
		// Confirmed alone can't cover 150k; the only other coin is received-
		// unconfirmed, which must NOT be pulled in without explicit coin control.
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [CONFIRMED, RECEIVED],
				recipients: [{ address: RECIPIENT, amount: 150_000 }],
				feeRate: 5
			})
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});

	it('treats an unconfirmed coin of unknown trust conservatively (excluded from auto)', async () => {
		const unknown: SpendableUtxo = { ...RECEIVED, unconfirmedTrust: undefined };
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [CONFIRMED, unknown],
				recipients: [{ address: RECIPIENT, amount: 150_000 }],
				feeRate: 5
			})
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});

	it('spends a received unconfirmed coin only when the user picks it via coin control', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [CONFIRMED, RECEIVED],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5,
			onlyUtxos: [{ txid: RECEIVED.txid, vout: RECEIVED.vout }]
		});
		expect(draft.inputs.map((i) => i.txid)).toEqual([RECEIVED.txid]);
	});
});

describe('batch sending (multiple recipients)', () => {
	const RECIPIENT_2 = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';

	it('pays every recipient plus change and conserves value', async () => {
		const draft = await constructPsbt({
			...COMMON,
			recipients: [
				{ address: RECIPIENT, amount: 20_000 },
				{ address: RECIPIENT_2, amount: 30_000 }
			],
			feeRate: 10
		});
		expect(draft.amount).toBe(50_000); // total across recipients
		expect(draft.recipient).toBe(RECIPIENT); // first recipient anchors display
		expect(draft.recipients).toEqual([
			{ address: RECIPIENT, amount: 20_000 },
			{ address: RECIPIENT_2, amount: 30_000 }
		]);
		const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputs).toContainEqual({ address: RECIPIENT, value: 20_000 });
		expect(summary.outputs).toContainEqual({ address: RECIPIENT_2, value: 30_000 });
		expect(summary.outputCount).toBe(draft.change ? 3 : 2);
	});

	it('remains signable and finalizable with several outputs', async () => {
		const draft = await constructPsbt({
			...COMMON,
			recipients: [
				{ address: RECIPIENT, amount: 20_000 },
				{ address: RECIPIENT_2, amount: 30_000 }
			],
			feeRate: 10
		});
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		const { txid } = finalizePsbt(base64.encode(tx.toPSBT()));
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('validates each recipient address and amount individually', async () => {
		await expect(
			constructPsbt({
				...COMMON,
				recipients: [
					{ address: RECIPIENT, amount: 10_000 },
					{ address: 'garbage', amount: 10_000 }
				],
				feeRate: 5
			})
		).rejects.toMatchObject({ code: 'invalid_recipient' });
		await expect(
			constructPsbt({
				...COMMON,
				recipients: [
					{ address: RECIPIENT, amount: 10_000 },
					{ address: RECIPIENT_2, amount: 0 }
				],
				feeRate: 5
			})
		).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(
			constructPsbt({ ...COMMON, recipients: [], feeRate: 5 })
		).rejects.toMatchObject({ code: 'invalid_recipient' });
	});

	it('measures insufficient funds against the recipients total', async () => {
		// 60k + 40k confirmed: each recipient alone is affordable, the SUM is not.
		await expect(
			constructPsbt({
				...COMMON,
				recipients: [
					{ address: RECIPIENT, amount: 60_000 },
					{ address: RECIPIENT_2, amount: 60_000 }
				],
				feeRate: 5
			})
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});

	it('rejects send-max combined with multiple recipients', async () => {
		const params = {
			...COMMON,
			recipients: [
				{ address: RECIPIENT, amount: 'max' as const },
				{ address: RECIPIENT_2, amount: 10_000 }
			],
			feeRate: 5
		};
		await expect(constructPsbt(params)).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(constructPsbt(params)).rejects.toThrow(/single recipient/);
	});
});

describe('fee-rate ceiling', () => {
	it('rejects fee rates above 1000 sat/vB as a probable mistake', async () => {
		await expect(
			constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 1_000 }], feeRate: 1001 })
		).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(
			constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 1_000 }], feeRate: 5_000 })
		).rejects.toThrow(/1000 sat\/vB/);
	});

	it('still allows exactly 1000 sat/vB (the ceiling is exclusive)', async () => {
		const whale: SpendableUtxo[] = [
			{ txid: 'ab'.repeat(32), vout: 0, value: 10_000_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
		];
		const draft = await constructPsbt({
			...COMMON,
			utxos: whale,
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 1000
		});
		expect(draft.amount).toBe(30_000);
		expect(draft.fee).toBeGreaterThan(50_000); // ~110 vB at 1000 sat/vB
	});
});

describe('segwit nonWitnessUtxo (fee-lying protection)', () => {
	const WITH_RAW = { ...COMMON, utxos: REAL_UTXOS, fetchRawTx };

	it('attaches the full previous tx ALONGSIDE witnessUtxo on every input', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipients: [{ address: RECIPIENT, amount: 70_000 }], feeRate: 10 });
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBeGreaterThan(0);
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			expect(inp.witnessUtxo, `input ${i} keeps witnessUtxo`).toBeDefined();
			expect(inp.nonWitnessUtxo, `input ${i} carries nonWitnessUtxo`).toBeDefined();
		}
	});

	it('does the same on the send-max sweep path', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipients: [{ address: RECIPIENT, amount: 'max' }], feeRate: 5 });
		expect(draft.amount).toBe(100_000 - draft.fee);
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBe(2);
		for (let i = 0; i < tx.inputsLength; i++) {
			expect(tx.getInput(i).nonWitnessUtxo).toBeDefined();
			expect(tx.getInput(i).witnessUtxo).toBeDefined();
		}
	});

	it('does not change fee estimation relative to witnessUtxo-only', async () => {
		const withRaw = await constructPsbt({ ...WITH_RAW, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
		const withoutRaw = await constructPsbt({
			...COMMON,
			utxos: REAL_UTXOS,
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10
		});
		expect(withRaw.fee).toBe(withoutRaw.fee);
		expect(withRaw.vsize).toBe(withoutRaw.vsize);
	});

	it('remains signable and finalizable with both fields present', async () => {
		const draft = await constructPsbt({ ...WITH_RAW, recipients: [{ address: RECIPIENT, amount: 70_000 }], feeRate: 12 });
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
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 5
		});
		await expect(p).rejects.toMatchObject({ code: 'construction_failed' });
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [REAL_UTXOS[0]],
				fetchRawTx: lying,
				recipients: [{ address: RECIPIENT, amount: 10_000 }],
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
				recipients: [{ address: RECIPIENT, amount: 10_000 }],
				feeRate: 5
			})
		).rejects.toThrow(/could not be parsed/);
	});

	it('stays witnessUtxo-only when no raw-tx source is provided', async () => {
		// constructPsbt must remain usable without a chain hookup (pure tests,
		// offline preview) — segwit inputs then carry witnessUtxo alone.
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
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
			recipients: [{ address: RECIPIENT, amount: 70_000 }],
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
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
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
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10
		});
		expect(draft.change).not.toBeNull(); // change exists…
		expect(summarizePsbt(draft.psbtBase64).change).toBeNull(); // …but is not identifiable
	});

	it('returns null change on a changeless sweep', async () => {
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 'max' }], feeRate: 5 });
		expect(summarizePsbt(draft.psbtBase64).change).toBeNull();
	});
});

// ── legacy inputs as the SPENDING SOURCE (cairn-degh) ────────────────────────
//
// The destination-type matrix above pays TO p2pkh / p2sh addresses; these tests
// spend FROM them. A p2pkh input must carry the full previous transaction
// (nonWitnessUtxo — legacy sighash hashes it), and a p2sh-p2wpkh input must
// carry the OP_0 PUSH20 redeemScript (without it no signer can satisfy the
// script-hash). Both were previously untested as spending sources.

describe('legacy spending sources (cairn-degh)', () => {
	// Deterministic test master (never a real wallet). SLIP-132 re-encoding of
	// the account key selects constructPsbt's script type, exactly as a user
	// importing an xpub vs a ypub would.
	const MASTER = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x51));
	const MASTER_FP = (MASTER.fingerprint >>> 0).toString(16).padStart(8, '0');

	function slip132Pub(hdXpub: string, version: number): string {
		const b58 = base58check(sha256);
		const raw = b58.decode(hdXpub);
		raw[0] = (version >>> 24) & 0xff;
		raw[1] = (version >>> 16) & 0xff;
		raw[2] = (version >>> 8) & 0xff;
		raw[3] = version & 0xff;
		return b58.encode(raw);
	}

	/** Account fixture for one script type: keys, addresses, a REAL funding tx. */
	function account(originPath: string, version: number | null) {
		const acct = MASTER.derive(originPath);
		const pub = version === null ? acct.publicExtendedKey : slip132Pub(acct.publicExtendedKey, version);
		const parsed = parseXpub(pub);
		const receive = deriveAddress(parsed, 0, 0).address;
		const change = deriveAddress(parsed, 1, 0).address;
		const fund = fundingTx([{ address: receive, value: 60_000 }]);
		const utxo: SpendableUtxo = {
			txid: fund.txid, vout: 0, value: 60_000, height: 800_000, address: receive, chain: 0, index: 0
		};
		const params = {
			xpub: pub,
			utxos: [utxo],
			changeAddress: change,
			changeIndex: 0,
			origin: { fingerprint: MASTER_FP, path: originPath },
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10,
			fetchRawTx: async (txid: string) => {
				if (txid === fund.txid) return fund.hex;
				throw new Error(`no such tx ${txid}`);
			}
		};
		return { acct, parsed, fund, params };
	}

	function signAll(psbtBase64: string, acct: HDKey): string {
		const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(acct.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}
		return base64.encode(tx.toPSBT());
	}

	describe('spending FROM p2pkh (BIP44 xpub)', () => {
		const P2PKH = () => account("m/44'/0'/0'", null);

		it('attaches nonWitnessUtxo (and no witness fields) to the legacy input', async () => {
			const { params } = P2PKH();
			const draft = await constructPsbt(params);
			const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
			expect(tx.inputsLength).toBe(1);
			const inp = tx.getInput(0);
			expect(inp.nonWitnessUtxo, 'legacy input carries the full previous tx').toBeDefined();
			expect(inp.witnessUtxo).toBeUndefined();
			expect(inp.redeemScript).toBeUndefined();
			// The embedded prev tx really is the funding tx (btc-signer verified its
			// hash against the input txid on addInput; double-check the output too).
			expect(Number(inp.nonWitnessUtxo!.outputs[0].amount)).toBe(60_000);
		});

		it('refuses to build a p2pkh spend without a raw-tx source', async () => {
			const { params } = P2PKH();
			await expect(
				constructPsbt({ ...params, fetchRawTx: undefined })
			).rejects.toMatchObject({ code: 'construction_failed' });
			await expect(
				constructPsbt({ ...params, fetchRawTx: undefined })
			).rejects.toThrow(/raw previous transactions/);
		});

		it('remains signable and finalizable', async () => {
			const { params, acct } = P2PKH();
			const draft = await constructPsbt(params);
			const { txid } = finalizePsbt(signAll(draft.psbtBase64, acct));
			expect(txid).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	describe('spending FROM p2sh-p2wpkh (BIP49 ypub)', () => {
		const YPUB_VERSION = 0x049d7cb2;
		const P2SH_P2WPKH = () => account("m/49'/0'/0'", YPUB_VERSION);

		it('attaches the OP_0 PUSH20 redeemScript alongside witnessUtxo', async () => {
			const { params, parsed } = P2SH_P2WPKH();
			expect(parsed.scriptType).toBe('p2sh-p2wpkh'); // the ypub selected the wrapper
			// No fetchRawTx here: the wrapped-segwit input must stand on
			// witnessUtxo + redeemScript alone.
			const draft = await constructPsbt({ ...params, fetchRawTx: undefined });
			const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
			expect(tx.inputsLength).toBe(1);
			const inp = tx.getInput(0);
			expect(inp.witnessUtxo).toBeDefined();
			expect(inp.redeemScript, 'wrapped-segwit input carries its redeemScript').toBeDefined();
			// Byte-exact: the redeemScript IS the wrapped v0 keyhash program of the
			// derived child key (OP_0 PUSH20 <hash160(pubkey)>).
			const child = parsed.hdkey.deriveChild(0).deriveChild(0);
			expect(bytesToHex(inp.redeemScript!)).toBe(bytesToHex(p2wpkh(child.publicKey!, NETWORK).script));
			expect(inp.redeemScript![0]).toBe(0x00);
			expect(inp.redeemScript![1]).toBe(0x14);
			expect(inp.redeemScript!).toHaveLength(22);
		});

		it('also carries nonWitnessUtxo when a raw-tx source is available (fee-lying protection)', async () => {
			const { params } = P2SH_P2WPKH();
			const draft = await constructPsbt(params);
			const inp = Transaction.fromPSBT(base64.decode(draft.psbtBase64)).getInput(0);
			expect(inp.witnessUtxo).toBeDefined();
			expect(inp.redeemScript).toBeDefined();
			expect(inp.nonWitnessUtxo).toBeDefined();
		});

		it('remains signable and finalizable', async () => {
			const { params, acct } = P2SH_P2WPKH();
			const draft = await constructPsbt(params);
			const { txid } = finalizePsbt(signAll(draft.psbtBase64, acct));
			expect(txid).toMatch(/^[0-9a-f]{64}$/);
		});
	});
});

describe('assertSameTransaction (signer-substitution guard)', () => {
	it('accepts a signed PSBT with identical inputs and outputs', async () => {
		const draft = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 70_000 }], feeRate: 12 });
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
		const a = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
		const b = await constructPsbt({
			...COMMON,
			recipients: [{ address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', amount: 30_000 }],
			feeRate: 10
		});
		expect(() => assertSameTransaction(a.psbtBase64, b.psbtBase64)).toThrow(PsbtMismatchError);
	});

	it('rejects a PSBT that changes the amount', async () => {
		const a = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 30_000 }], feeRate: 10 });
		const b = await constructPsbt({ ...COMMON, recipients: [{ address: RECIPIENT, amount: 31_000 }], feeRate: 10 });
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

describe('signingMass on construction (cairn-194)', () => {
	beforeEach(() => clearParentMassCache());

	it('carries the mass block computed from the fetched parents', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: REAL_UTXOS,
			fetchRawTx,
			recipients: [{ address: RECIPIENT, amount: 80_000 }], // forces both inputs
			feeRate: 10
		});
		expect(draft.inputs).toHaveLength(2);
		expect(draft.signingMass).toBeDefined();
		const mass = draft.signingMass!;
		expect(mass.totalParentVsize).toBe(
			parentVsizeFromRawTx(FUND_A.hex) + parentVsizeFromRawTx(FUND_B.hex)
		);
		expect(mass.tier).toBe('low'); // two tiny synthetic parents
		expect(mass.splitSuggested).toBe(false);
		expect(mass.warnLevel).toBe('none');
		expect(mass.perDevice.map((d) => d.device).sort()).toEqual(['coldcard', 'ledger', 'trezor']);
		// Single-sig wallet: totals are per-signer brackets (quorum 1).
		expect(mass.totalSeconds.lo).toBeLessThanOrEqual(mass.totalSeconds.hi);
	});

	it('carries the mass block on the send-max sweep path too', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: REAL_UTXOS,
			fetchRawTx,
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate: 5
		});
		expect(draft.signingMass).toBeDefined();
		expect(draft.signingMass!.totalParentVsize).toBe(
			parentVsizeFromRawTx(FUND_A.hex) + parentVsizeFromRawTx(FUND_B.hex)
		);
	});

	it('omits signingMass entirely when parents were not fetched — construction still succeeds', async () => {
		// witnessUtxo-only build (no fetchRawTx): mass over unknown parents would
		// be false confidence, so the field is absent rather than understated.
		const draft = await constructPsbt({
			...COMMON,
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10
		});
		expect(draft.psbtBase64.length).toBeGreaterThan(0);
		expect(draft.signingMass).toBeUndefined();
	});

	// ---- low-mass selection bias (best-effort, fee-neutral) -----------------
	// Two coins of EQUAL value, one funded by a pool-sized parent, one by a
	// tiny P2P parent. btc-signer's selector orders by value, so equal values
	// tie-break on candidate order — which preferLowMassOrder biases when (and
	// only when) mass data is already cached.
	const HUGE_FUND = fundingTx([
		{ address: RECEIVE_0, value: 60_000 },
		...Array.from({ length: 2_999 }, () => ({ address: RECIPIENT, value: 1_000 }))
	]);
	const SMALL_FUND = fundingTx([{ address: RECEIVE_1, value: 60_000 }]);
	const EQUAL_UTXOS: SpendableUtxo[] = [
		{ txid: HUGE_FUND.txid, vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 },
		{ txid: SMALL_FUND.txid, vout: 0, value: 60_000, height: 800_001, address: RECEIVE_1, chain: 0, index: 1 }
	];
	const fetchBias = async (txid: string) => {
		if (txid === HUGE_FUND.txid) return HUGE_FUND.hex;
		if (txid === SMALL_FUND.txid) return SMALL_FUND.hex;
		throw new Error(`no such tx ${txid}`);
	};
	const biasParams = {
		...COMMON,
		utxos: EQUAL_UTXOS,
		fetchRawTx: fetchBias,
		recipients: [{ address: RECIPIENT, amount: 30_000 }],
		feeRate: 10
	};

	it('without cached mass data, candidate order stands (heavy-parent coin wins the tie)', async () => {
		const draft = await constructPsbt(biasParams);
		expect(draft.inputs).toHaveLength(1);
		expect(draft.inputs[0].txid).toBe(HUGE_FUND.txid);
	});

	it('cached mass data reorders selection toward the light parent — same fee, same amount', async () => {
		const control = await constructPsbt(biasParams);
		clearParentMassCache();
		classifyAndCacheParent(HUGE_FUND.txid, HUGE_FUND.hex);
		classifyAndCacheParent(SMALL_FUND.txid, SMALL_FUND.hex);
		const biased = await constructPsbt(biasParams);
		expect(biased.inputs).toHaveLength(1);
		expect(biased.inputs[0].txid).toBe(SMALL_FUND.txid);
		// Never increases fees or changes amounts: same-size inputs, same tx shape.
		expect(biased.fee).toBe(control.fee);
		expect(biased.amount).toBe(control.amount);
		expect(biased.signingMass!.totalParentVsize).toBeLessThan(control.signingMass!.totalParentVsize);
	});

	it('exact-inputs (RBF) never reorders — it must spend what it is given', async () => {
		classifyAndCacheParent(HUGE_FUND.txid, HUGE_FUND.hex);
		classifyAndCacheParent(SMALL_FUND.txid, SMALL_FUND.hex);
		const draft = await constructPsbt({ ...biasParams, exactInputs: true });
		expect(draft.inputs.map((i) => i.txid)).toEqual([HUGE_FUND.txid, SMALL_FUND.txid]);
		expect(draft.signingMass).toBeDefined(); // both parents fetched → mass present
	});
});

describe('coinbase maturity', () => {
	const CB_IMMATURE: SpendableUtxo = {
		txid: '44'.repeat(32),
		vout: 0,
		value: 60_000,
		height: 900_000,
		address: RECEIVE_0,
		chain: 0,
		index: 0,
		coinbase: true
	};

	it('rejects an explicitly-selected immature coinbase (coin control)', async () => {
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [CB_IMMATURE],
				recipients: [{ address: RECIPIENT, amount: 30_000 }],
				feeRate: 10,
				onlyUtxos: [{ txid: CB_IMMATURE.txid, vout: 0 }],
				tipHeight: 900_050 // 51 confirmations → immature
			})
		).rejects.toMatchObject({ code: 'immature_coinbase' });
	});

	it('skips an immature coinbase in automatic selection', async () => {
		// The only candidate is immature → nothing mature left to spend.
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [CB_IMMATURE],
				recipients: [{ address: RECIPIENT, amount: 30_000 }],
				feeRate: 10,
				tipHeight: 900_050
			})
		).rejects.toMatchObject({ code: 'no_utxos' });
	});

	it('spends a MATURE coinbase (its full previous transaction is required)', async () => {
		const fund = fundingTx([{ address: RECEIVE_0, value: 60_000 }]);
		const mature: SpendableUtxo = {
			txid: fund.txid,
			vout: 0,
			value: 60_000,
			height: 800_000,
			address: RECEIVE_0,
			chain: 0,
			index: 0,
			coinbase: true
		};
		const draft = await constructPsbt({
			...COMMON,
			utxos: [mature],
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 10,
			fetchRawTx: async (txid) => {
				if (txid === fund.txid) return fund.hex;
				throw new Error(`no such tx ${txid}`);
			},
			tipHeight: 900_000 // >> 100 confirmations → mature
		});
		expect(draft.amount).toBe(30_000);
	});

	it('refuses a coinbase spend when the previous transaction cannot be fetched', async () => {
		const mature: SpendableUtxo = { ...CB_IMMATURE, txid: '55'.repeat(32), height: 800_000 };
		await expect(
			constructPsbt({
				...COMMON,
				utxos: [mature],
				recipients: [{ address: RECIPIENT, amount: 30_000 }],
				feeRate: 10,
				tipHeight: 900_000 // mature, but no fetchRawTx provided
			})
		).rejects.toMatchObject({ code: 'construction_failed' });
	});
});
