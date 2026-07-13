// cairn-9v9g follow-up — extends sendBoundaryMatrix.test.ts with boundary
// combinations NOT already covered there: dust-at-threshold combined with
// coin-control, multi-recipient dust interactions, sweep-to-dust across
// varied UTXO counts/fee rates, zero-balance wallets hit with non-sweep
// requests, and fee-alone-exceeds-total-input-value (as opposed to the
// existing "short by exactly 1 sat" cases).
//
// Same pure construction-layer style as sendBoundaryMatrix.test.ts (no DB, no
// chain) — fixtures and the plain-language guard are copied verbatim from
// there so both files stay independently readable.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { constructPsbt, PsbtError, type SpendableUtxo } from './psbt';
import {
	constructMultisigPsbt,
	type MultisigConstructParams,
	type MultisigScriptType
} from './multisigPsbt';
import { deriveMultisigAddress, type MultisigConfig, type MultisigKeyDescriptor } from './multisig';

// ── shared plain-language guard (verbatim copy of sendBoundaryMatrix.test.ts) ─

const ERROR_CODES = [
	'invalid_recipient',
	'invalid_amount',
	'insufficient_funds',
	'no_utxos',
	'immature_coinbase',
	'construction_failed'
];

function expectPlainLanguage(message: string): void {
	expect(message.length).toBeGreaterThan(0);
	expect(message).not.toMatch(/^[A-Z][a-zA-Z]*(Error)?:/);
	expect(message).not.toContain('[object Object]');
	expect(message).not.toContain('undefined');
	expect(message).not.toContain('NaN');
	expect(message).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/);
	for (const code of ERROR_CODES) {
		expect(message).not.toContain(code);
	}
	expect(message).toMatch(/[.!?]$/);
}

async function expectPlainRejection(
	p: Promise<unknown>,
	code: PsbtError['code']
): Promise<PsbtError> {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(PsbtError);
	const err = caught as PsbtError;
	expect(err.code).toBe(code);
	expectPlainLanguage(err.message);
	return err;
}

// ── single-sig fixtures (verbatim copy of sendBoundaryMatrix.test.ts) ───────

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0 (p2wpkh)
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0 (p2wpkh)
const RECIPIENT_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const RECIPIENT_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const RECIPIENT_P2SH = '3P14159f73E4gFr7JterCCQh9QjiTjiZrG';

const COMMON = {
	xpub: ZPUB,
	changeAddress: CHANGE_0,
	changeIndex: 0,
	origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
};

function utxo(value: number, opts: Partial<SpendableUtxo> = {}): SpendableUtxo {
	return {
		txid: '11'.repeat(32),
		vout: 0,
		value,
		height: 800_000,
		address: RECEIVE_0,
		chain: 0,
		index: 0,
		...opts
	};
}

/** Deterministic unique hex txid, distinct from the '11'.repeat(32) default. */
function txidN(n: number): string {
	return n.toString(16).padStart(64, '0');
}

// ── multisig fixtures (verbatim copy of sendBoundaryMatrix.test.ts) ─────────

const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number): MultisigKeyDescriptor {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return { xpub: account.publicExtendedKey, fingerprint, path: BIP48_PATH };
}
const MS_KEYS = [1, 2, 3].map(makeSigner);

function msConfig(scriptType: MultisigScriptType): MultisigConfig & { scriptType: MultisigScriptType } {
	return { threshold: 2, keys: MS_KEYS, scriptType };
}
const MS_P2WSH = msConfig('p2wsh');

function msUtxo(cfg: MultisigConfig, value: number, opts: Partial<SpendableUtxo> = {}): SpendableUtxo {
	return {
		txid: '11'.repeat(32),
		vout: 0,
		value,
		height: 800_000,
		address: deriveMultisigAddress(cfg, 0, 0).address,
		chain: 0,
		index: 0,
		...opts
	};
}

function msBuild(over: Partial<MultisigConstructParams> = {}): ReturnType<typeof constructMultisigPsbt> {
	return constructMultisigPsbt({
		config: MS_P2WSH,
		utxos: [msUtxo(MS_P2WSH, 200_000)],
		recipients: [{ address: RECIPIENT_P2WPKH, amount: 50_000 }],
		feeRate: 5,
		changeIndex: 0,
		...over
	});
}

// ═══════════════ 1. DUST-AT-THRESHOLD COMBINED WITH COIN-CONTROL (onlyUtxos)

describe('boundary: plain-recipient dust threshold combined with coin-control (onlyUtxos)', () => {
	it('single-sig: p2wpkh dust boundary (294/293) still holds when restricted to one specific coin via onlyUtxos', async () => {
		const coinA = txidN(1);
		const coinB = txidN(2);
		const utxos = [utxo(60_000, { txid: coinA }), utxo(60_000, { txid: coinB })];

		const ok = await constructPsbt({
			...COMMON,
			utxos,
			onlyUtxos: [{ txid: coinB, vout: 0 }],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 294 }],
			feeRate: 5
		});
		expect(ok.amount).toBe(294);
		// Coin control actually restricted selection to the allow-listed coin.
		expect(ok.inputs).toHaveLength(1);
		expect(ok.inputs[0].txid).toBe(coinB);

		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos,
				onlyUtxos: [{ txid: coinB, vout: 0 }],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 293 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
	});

	it('single-sig: dust pre-flight rejects BEFORE coin control even looks at the allow-list (an allow-list naming a nonexistent coin still gets the dust message, not a "not spendable" message)', async () => {
		// Recipient/fee validation (including the dust pre-flight) runs before
		// selectSpendCandidates ever inspects onlyUtxos — so a request that is
		// simultaneously bad on both dimensions surfaces the dust complaint.
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				onlyUtxos: [{ txid: txidN(99), vout: 0 }], // does not match any real coin
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 100 }], // under the 294 floor
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
	});
});

// ═══════════════ 2. MULTIPLE RECIPIENTS UNDER-DUST SIMULTANEOUSLY

describe('boundary: multiple recipients under-dust in the same request', () => {
	it('single-sig: two simultaneously-dusty recipients — only the FIRST offending address is named (validateRecipientsAndFeeRate throws on the first match in array order, it does not collect every offender)', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2PKH, amount: 100 }, // under the 546 p2pkh floor
					{ address: RECIPIENT_P2SH, amount: 50 } // ALSO under the 540 p2sh floor
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message).toContain(RECIPIENT_P2PKH);
		// Current behavior: the second offender is never mentioned because the
		// validation loop throws on the first bad recipient it finds — pinned
		// here rather than asserted as ideal (a "both amounts are too small"
		// message would arguably be more helpful, but this is what the code does).
		expect(err.message).not.toContain(RECIPIENT_P2SH);
	});

	it('single-sig: reversing recipient order changes WHICH address gets named, confirming it is genuinely first-match, not address-sorted or amount-sorted', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2SH, amount: 50 },
					{ address: RECIPIENT_P2PKH, amount: 100 }
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message).toContain(RECIPIENT_P2SH);
		expect(err.message).not.toContain(RECIPIENT_P2PKH);
	});
});

// ═══════ 3. ONE DUSTY RECIPIENT + ONE FINE RECIPIENT — WHOLE DRAFT REJECTED

describe('boundary: one under-dust recipient among otherwise-fine recipients rejects the WHOLE draft, not a partial build', () => {
	it('single-sig: dusty recipient FIRST, fine recipient second — rejected, nothing partially built', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2PKH, amount: 100 }, // dust
					{ address: RECIPIENT_P2WPKH, amount: 10_000 } // fine
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
	});

	it('single-sig: fine recipient FIRST, dusty recipient second — still rejected (the dust check scans every recipient, not just the first)', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 10_000 }, // fine
					{ address: RECIPIENT_P2PKH, amount: 100 } // dust
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
	});

	it('multisig: same one-dusty-one-fine case rejects the whole draft', async () => {
		await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, 200_000)],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 10_000 },
					{ address: RECIPIENT_P2PKH, amount: 100 }
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
	});
});

// ═══════════════ 4. SWEEP-TO-DUST ACROSS VARIED UTXO COUNTS AND FEE RATES

describe('boundary: sweep-to-dust result across varied input counts and fee rates (extends the single-UTXO/1-sat-per-vB case in sendBoundaryMatrix.test.ts)', () => {
	const CASES = [
		{ n: 1, feeRate: 2 },
		{ n: 2, feeRate: 5 },
		{ n: 3, feeRate: 10 },
		{ n: 5, feeRate: 3 }
	];

	for (const { n, feeRate } of CASES) {
		it(`single-sig: ${n} input(s) at ${feeRate} sat/vB — sweep landing exactly at the dust ceiling (546) rejects, one sat above (547) succeeds`, async () => {
			const vsize = 11 + n * 68 + 31; // TX_OVERHEAD + n*p2wpkh-input + one p2wpkh recipient output
			const fee = Math.ceil(vsize * feeRate);

			function makeUtxos(totalIn: number): SpendableUtxo[] {
				// n-1 coins of 1 sat each (distinct txids) plus one coin carrying the
				// remainder, so totalIn lands on an exact value while still exercising
				// n real, distinct inputs.
				const coins: SpendableUtxo[] = [];
				for (let i = 0; i < n - 1; i++) {
					coins.push(utxo(1, { txid: txidN(1000 + i) }));
				}
				coins.push(utxo(totalIn - (n - 1), { txid: txidN(2000) }));
				return coins;
			}

			await expectPlainRejection(
				constructPsbt({
					...COMMON,
					utxos: makeUtxos(fee + 546),
					recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
					feeRate
				}),
				'insufficient_funds'
			);

			const draft = await constructPsbt({
				...COMMON,
				utxos: makeUtxos(fee + 547),
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate
			});
			expect(draft.amount).toBe(547);
			expect(draft.change).toBeNull();
			expect(draft.inputs).toHaveLength(n);
		});
	}
});

// ═══════════════ 5. ZERO-BALANCE WALLET ACROSS NON-SWEEP REQUEST SHAPES

describe('boundary: zero-balance wallet with non-sweep / non-generic request shapes', () => {
	it('single-sig: zero UTXOs with coin-control (onlyUtxos) active gets the coin-control-flavored no_utxos message, not the generic "no spendable coins" one', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [],
				onlyUtxos: [{ txid: txidN(1), vout: 0 }],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: 5
			}),
			'no_utxos'
		);
		expect(err.message.toLowerCase()).toContain('already spent');
		expect(err.message.toLowerCase()).not.toContain('no spendable coins');
	});

	it('single-sig: zero UTXOs with multiple recipients still rejects cleanly as no_utxos (not a batch-specific error, and not invalid_amount from the empty candidate set)', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 10_000 },
					{ address: RECIPIENT_P2PKH, amount: 10_000 }
				],
				feeRate: 5
			}),
			'no_utxos'
		);
	});

	it('multisig: zero UTXOs with a plain (non-max) recipient amount rejects with no_utxos, same as the send-max case', async () => {
		await expectPlainRejection(
			msBuild({ utxos: [], recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }] }),
			'no_utxos'
		);
	});
});

// ═══════════════ 6. FEE ALONE EXCEEDS TOTAL INPUT VALUE (not just short by 1 sat)

describe('boundary: fee alone exceeds the ENTIRE input value (as opposed to amount+fee falling short by 1 sat)', () => {
	it('single-sig (normal selection): a high fee rate against a tiny UTXO rejects insufficient_funds cleanly — no negative-value PSBT', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(500)], // fee at 1000 sat/vB (~110 vB) is ~110,000 sats — dwarfs the whole input
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 300 }],
				feeRate: 1000
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain('not enough funds');
	});

	it('single-sig (send-max): fee alone exceeding the swept total rejects cleanly; the sweep amount never goes negative or wraps', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(500)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 1000
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain('nothing left to send');
	});

	it('single-sig (exactInputs/RBF): a fee increase far exceeding available change rejects instead of building a negative-value change output', async () => {
		const amount = 30_000;
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(amount + 1_000)], // barely covers the amount, nowhere near a 1000 sat/vB fee
				recipients: [{ address: RECIPIENT_P2WPKH, amount }],
				feeRate: 1000,
				exactInputs: true
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain('too small to absorb');
	});

	it('multisig (normal selection): fee alone exceeding total input value rejects cleanly', async () => {
		const err = await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, 500)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 300 }],
				feeRate: 1000
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain('not enough confirmed funds');
	});
});
