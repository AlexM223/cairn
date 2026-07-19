// cairn-9v9g — send-flow boundary matrix: zero balance, dust, amount<=fee,
// amount+fee exceeding balance by exactly 1 sat, sweep/send-max, and the
// min-relay-fee floor/ceiling, table-driven across BOTH PSBT builders
// (constructPsbt for single-sig, constructMultisigPsbt for multisig).
//
// This file pins the pure construction-layer behavior (no DB, no chain —
// same style as psbt.test.ts / multisigPsbt.test.ts). The higher-level
// buildDraft/buildMultisigDraft wiring and the send API routes are covered
// separately in sendBoundaryDraft.test.ts and
// routes/api/wallets/[id]/psbt/server.test.ts.
//
// Every rejection case also asserts the message is PLAIN LANGUAGE: no raw
// PsbtError `code` token leaking as the visible text, no stack traces, no
// "[object Object]"/"undefined"/"NaN", and the message reads as a full
// sentence a non-technical user could act on.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { constructPsbt, PsbtError, type SpendableUtxo } from './psbt';
import {
	constructMultisigPsbt,
	type MultisigConstructParams,
	type MultisigScriptType
} from './multisigPsbt';
import { deriveMultisigAddress, type MultisigConfig, type MultisigKeyDescriptor } from './multisig';

// ── shared plain-language guard ─────────────────────────────────────────────

/** All PsbtError `code` values — none of these enum tokens may appear verbatim
 *  in a user-facing message (that would be raw jargon, not plain language). */
const ERROR_CODES = [
	'invalid_recipient',
	'invalid_amount',
	'insufficient_funds',
	'no_utxos',
	'immature_coinbase',
	'construction_failed'
];

/** Asserts a message is plain, user-presentable language: a real sentence,
 *  no raw error-code tokens, no stack/exception artifacts. */
function expectPlainLanguage(message: string): void {
	expect(message.length).toBeGreaterThan(0);
	expect(message).not.toMatch(/^[A-Z][a-zA-Z]*(Error)?:/); // "Error:", "TypeError:", ...
	expect(message).not.toContain('[object Object]');
	expect(message).not.toContain('undefined');
	expect(message).not.toContain('NaN');
	expect(message).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/); // stack-frame lines
	for (const code of ERROR_CODES) {
		expect(message).not.toContain(code);
	}
	// Reads as an actual sentence (starts uppercase or a quoted value, ends in
	// terminal punctuation) rather than a bare identifier or fragment.
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

// ── single-sig fixtures (BIP84 doc vectors — public test keys only) ─────────

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
// A p2pkh xpub/address pair and a p2sh-p2wpkh (ypub-style) pair, so the
// script-type dimension of the matrix has real fixtures rather than only
// p2wpkh. Derived once via HDKey directly from ZPUB's underlying account key
// so no private material is needed — SpendableUtxo.address is caller-supplied
// anyway (constructPsbt trusts it and re-derives the scriptPubKey).
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0 (p2wpkh)
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0 (p2wpkh)
const RECIPIENT_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const RECIPIENT_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const RECIPIENT_P2SH = '3P14159f73E4gFr7JterCCQh9QjiTjiZrG';
const RECIPIENT_P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const RECIPIENT_P2TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'; // BIP-86 vector

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

// ── multisig fixtures (mirrors bitcoin/multisigPsbt.test.ts) ────────────────

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

// ═══════════════════════════════════════════════════════════ 1. ZERO BALANCE

describe('boundary: zero balance', () => {
	it('single-sig: no UTXOs at all → no_utxos, plain message', async () => {
		const err = await expectPlainRejection(
			constructPsbt({ ...COMMON, utxos: [], recipients: [{ address: RECIPIENT_P2WPKH, amount: 1_000 }], feeRate: 5 }),
			'no_utxos'
		);
		expect(err.message.toLowerCase()).toContain('no spendable coins');
	});

	it('single-sig: only unconfirmed received (untrusted) coins present behaves as zero spendable balance', async () => {
		// A wallet whose only coin is an unconfirmed RECEIVED (not own-change)
		// output must not auto-spend it — the candidate set collapses to empty,
		// same user-facing outcome as a truly empty wallet.
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000, { height: 0, unconfirmedTrust: 'received' })],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 1_000 }],
				feeRate: 5
			}),
			'no_utxos'
		);
		expect(err.message.toLowerCase()).toContain('no spendable coins');
	});

	it('multisig: no UTXOs at all → no_utxos, plain message naming "multisig"', async () => {
		const err = await expectPlainRejection(msBuild({ utxos: [] }), 'no_utxos');
		expect(err.message.toLowerCase()).toContain('no spendable coins');
		expect(err.message.toLowerCase()).toContain('multisig');
	});
});

// ═══════════════════════════════════════════════════════ 2. DUST (send-max +
//    RBF-change — the two places DUST_SATS is actually enforced; see the
//    "known gap" section at the bottom for the un-enforced plain-recipient case)

describe('boundary: dust threshold (send-max sweep result)', () => {
	// Deterministic by construction: vsize = TX_OVERHEAD(11) + 1*INPUT_VSIZE.p2wpkh(68)
	// + outputVsize(p2wpkh recipient)(31) = 110 vB. At feeRate 1 sat/vB, fee = 110.
	// amount = totalIn - fee; rejected when amount <= dustThreshold(recipient) — 294
	// for a p2wpkh destination (cairn-7ld60: this call site used to compare against
	// the flat legacy DUST_SATS=546 constant instead of the recipient's own
	// per-script-type floor; see the "dust threshold (plain recipient amount,
	// pre-flight)" block above for the full matrix).
	const FEE_AT_1_SAT_VB = 110;
	const P2WPKH_DUST = 294;

	it('single-sig: sweep result of EXACTLY 294 sats (the p2wpkh dust ceiling) is rejected', async () => {
		const totalIn = FEE_AT_1_SAT_VB + P2WPKH_DUST;
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(totalIn)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 1
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain('nothing left to send');
	});

	it('single-sig: sweep result of 295 sats (one above the dust ceiling) succeeds', async () => {
		const totalIn = FEE_AT_1_SAT_VB + P2WPKH_DUST + 1;
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(totalIn)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 1
		});
		expect(draft.amount).toBe(P2WPKH_DUST + 1);
		expect(draft.change).toBeNull();
	});

	it('single-sig, coin-control sweep at the same dust boundary gets the coin-control-flavored message', async () => {
		const totalIn = FEE_AT_1_SAT_VB + P2WPKH_DUST;
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(totalIn)],
				onlyUtxos: [{ txid: '11'.repeat(32), vout: 0 }],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 1
			}),
			'insufficient_funds'
		);
		expect(err.message.toLowerCase()).toContain("don't cover the network fee");
	});

	it('multisig: sweep dust boundary rejects at exactly the ceiling, succeeds one sat above', async () => {
		// multisigInputVsize for a 2-of-3 p2wsh input is larger than single-sig's
		// flat 68 — read it back from a real build rather than hand-deriving the
		// CHECKMULTISIG witness formula, then confirm the +/-1 boundary around it.
		const probe = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 10_000_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 1
		});
		const vsize = probe.vsize;
		const feeAt1 = Math.ceil(vsize * 1);

		await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, feeAt1 + 546)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 1
			}),
			'insufficient_funds'
		);
		const ok = await msBuild({
			utxos: [msUtxo(MS_P2WSH, feeAt1 + 547)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 1
		});
		expect(ok.amount).toBe(547);
	});
});

describe('boundary: dust threshold (RBF replacement change output)', () => {
	// exactInputs spends a single given coin verbatim; the entire fee increase
	// comes out of change, and change < dustThreshold(changeAddress) is refused
	// outright rather than silently altering what the user already reviewed.
	// CHANGE_0 is a p2wpkh address, so its floor is 294 (cairn-7ld60: this call
	// site used to compare against the flat legacy DUST_SATS=546 constant
	// instead of the change output's own per-script-type floor).
	it('single-sig: change of exactly 293 (one under dust) is rejected; 294 succeeds', async () => {
		// vsizeEst = 11 + 1*68 (input) + outputVsize(recipient, p2wpkh=31) + outputVsize(change, p2wpkh=31) = 141
		const vsizeEst = 11 + 68 + 31 + 31;
		const feeRate = 1;
		const fee = Math.ceil(vsizeEst * feeRate);
		const amount = 30_000;
		const P2WPKH_DUST = 294;

		const failing = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(amount + fee + P2WPKH_DUST - 1)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount }],
				feeRate,
				exactInputs: true
			}),
			'insufficient_funds'
		);
		expect(failing.message.toLowerCase()).toContain('too small to absorb');

		const ok = await constructPsbt({
			...COMMON,
			utxos: [utxo(amount + fee + P2WPKH_DUST)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount }],
			feeRate,
			exactInputs: true
		});
		expect(ok.change).not.toBeNull();
		expect(ok.change!.value).toBe(P2WPKH_DUST);
	});
});

// ═══════════ 2b. DUST (plain recipient amount, pre-flight) — cairn-ykk6
//
// Previously a plain (non-sweep) recipient amount had NO pre-flight dust
// check at all — see git history for the "KNOWN GAP" block this replaces.
// validateRecipientsAndFeeRate (psbt.ts) now rejects any non-'max' amount
// below that destination's per-script-type dust floor, computed the same way
// Bitcoin Core's GetDustThreshold() does (outputVsize + assumed spend cost,
// witness-discounted for segwit destinations, at the 3 sat/vB dust-relay
// rate): P2PKH 546, P2SH 540, P2WPKH 294, P2WSH 330, P2TR 330.

describe('boundary: dust threshold (plain recipient amount, pre-flight) — cairn-ykk6', () => {
	const CASES: { label: string; address: string; threshold: number }[] = [
		{ label: 'p2pkh', address: RECIPIENT_P2PKH, threshold: 546 },
		{ label: 'p2sh', address: RECIPIENT_P2SH, threshold: 540 },
		{ label: 'p2wpkh', address: RECIPIENT_P2WPKH, threshold: 294 },
		{ label: 'p2wsh', address: RECIPIENT_P2WSH, threshold: 330 },
		{ label: 'p2tr', address: RECIPIENT_P2TR, threshold: 330 }
	];

	for (const { label, address, threshold } of CASES) {
		it(`single-sig: ${label} destination — exactly ${threshold} sats is allowed, ${threshold - 1} is rejected pre-flight`, async () => {
			const ok = await constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address, amount: threshold }],
				feeRate: 5
			});
			expect(ok.amount).toBe(threshold);

			const err = await expectPlainRejection(
				constructPsbt({
					...COMMON,
					utxos: [utxo(60_000)],
					recipients: [{ address, amount: threshold - 1 }],
					feeRate: 5
				}),
				'invalid_amount'
			);
			expect(err.message.toLowerCase()).toContain('too small to send');
			// Plain language per Cairn UX philosophy: no raw jargon like "dust" or
			// "vB"/"vsize" leaking into the user-facing message.
			expect(err.message.toLowerCase()).not.toContain('dust');
			expect(err.message.toLowerCase()).not.toMatch(/vsize|sat\/vb/);
		});
	}

	it('multisig: p2wpkh destination — exactly 294 sats is allowed, 293 is rejected pre-flight', async () => {
		const ok = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 294 }],
			feeRate: 5
		});
		expect(ok.amount).toBe(294);

		const err = await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, 60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 293 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
	});

	it('multisig: p2tr destination — exactly 330 sats is allowed, 329 is rejected pre-flight', async () => {
		const ok = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 60_000)],
			recipients: [{ address: RECIPIENT_P2TR, amount: 330 }],
			feeRate: 5
		});
		expect(ok.amount).toBe(330);

		await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, 60_000)],
				recipients: [{ address: RECIPIENT_P2TR, amount: 329 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
	});

	it('single-sig: multi-recipient dust rejection names the offending address, not a generic message', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 10_000 },
					{ address: RECIPIENT_P2PKH, amount: 100 } // well under the 546 p2pkh floor
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message).toContain(RECIPIENT_P2PKH);
	});

	it('send-max amounts are exempt from the plain-amount dust loop (its own post-selection sweep-result check runs instead)', async () => {
		// A sweep of a small-but-fee-covering UTXO must not be evaluated against
		// dustThreshold as if 'max' were a literal sat amount.
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(2_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 1
		});
		expect(draft.change).toBeNull();
		expect(draft.amount).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════════════════ 3. AMOUNT <= FEE (legitimate)

describe('boundary: amount <= fee is legal (not an error) as long as the output clears dust', () => {
	it('single-sig: a 1,000-sat send at a fee rate whose fee vastly exceeds it still builds', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 1_000 }],
			feeRate: 500
		});
		expect(draft.amount).toBe(1_000);
		expect(draft.fee).toBeGreaterThan(draft.amount);
		expect(draft.change).toBeNull(); // fee eats the rest changelessly
	});

	it('multisig: same amount<=fee case builds with fee exceeding amount', async () => {
		const draft = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 1_000 }],
			feeRate: 200
		});
		expect(draft.amount).toBe(1_000);
		expect(draft.fee).toBeGreaterThan(draft.amount);
	});
});

// ═══════════════════ 4. AMOUNT + FEE EXCEEDS BALANCE BY EXACTLY 1 SAT (exactInputs)

describe('boundary: amount + fee exceeds available balance by exactly 1 sat', () => {
	it('single-sig (exactInputs/RBF path): balance short by 1 sat rejects; exact balance succeeds changeless', async () => {
		// changeless requires totalIn - amount - feeWithoutChange == 0 in the RBF
		// path's change<dust branch — but exactInputs ALWAYS reserves a change
		// output slot (see multisigPsbt/psbt exactInputs branch), so the minimum
		// viable totalIn for this path is amount + fee + dustThreshold(changeAddress),
		// not 0. CHANGE_0 is p2wpkh, so its floor is 294 (cairn-7ld60: this call
		// site used to anchor on the flat legacy DUST_SATS=546 constant instead).
		// The "exactly 1 sat short" boundary is therefore anchored at that floor.
		const vsizeEst = 11 + 68 + 31 + 31; // 1 input, 1 recipient out, 1 change out (p2wpkh)
		const fee = Math.ceil(vsizeEst * 1);
		const amount = 30_000;
		const P2WPKH_DUST = 294;
		const floor = amount + fee + P2WPKH_DUST;

		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(floor - 1)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount }],
				feeRate: 1,
				exactInputs: true
			}),
			'insufficient_funds'
		);
		const ok = await constructPsbt({
			...COMMON,
			utxos: [utxo(floor)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount }],
			feeRate: 1,
			exactInputs: true
		});
		expect(ok.change!.value).toBe(P2WPKH_DUST);
	});

	it('single-sig (normal auto-selection): balance short by 1 sat for a changeless spend rejects; exact balance succeeds', async () => {
		// A changeless normal-path spend (no exactInputs) with ONE candidate coin:
		// vsize = 11 (overhead) + 68 (1 p2wpkh input) + 31 (1 p2wpkh recipient out) = 110.
		const vsize = 11 + 68 + 31;
		const feeRate = 1;
		const fee = Math.ceil(vsize * feeRate);
		const amount = 30_000;

		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(amount + fee - 1)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount }],
				feeRate
			}),
			'insufficient_funds'
		);
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(amount + fee)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount }],
			feeRate
		});
		expect(draft.amount).toBe(amount);
		expect(draft.fee).toBe(fee);
		expect(draft.change).toBeNull();
	});

	it('multisig (normal auto-selection): balance short by 1 sat rejects; exact balance succeeds changeless', async () => {
		// Read the real changeless vsize back from a build that comfortably
		// affords it, then use it to construct the +/-1 boundary — multisig
		// per-input vsize depends on the M-of-N witness formula, not a flat table.
		const probe = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 10_000_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 30_000 }],
			feeRate: 1
		});
		// probe has change (huge input); derive the changeless vsize by dropping
		// the change output's vsize contribution — simpler: binary-probe the exact
		// changeless total directly against the real builder instead of
		// hand-deriving the multisig witness-size formula.
		const amount = 30_000;
		const feeRate = 1;
		// Binary search the minimal totalIn that succeeds changeless, bounded by
		// the probe's own numbers (it comfortably succeeds with change).
		let lo = amount; // definitely insufficient
		let hi = probe.amount + probe.fee + (probe.change?.value ?? 0); // definitely sufficient
		while (lo + 1 < hi) {
			const mid = Math.floor((lo + hi) / 2);
			try {
				await msBuild({
					utxos: [msUtxo(MS_P2WSH, mid)],
					recipients: [{ address: RECIPIENT_P2WPKH, amount }],
					feeRate
				});
				hi = mid;
			} catch {
				lo = mid;
			}
		}
		// hi is the minimal sufficient totalIn (changeless, since it's the exact
		// floor) — confirm the -1/±0 boundary precisely.
		await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, hi - 1)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount }],
				feeRate
			}),
			'insufficient_funds'
		);
		const ok = await msBuild({
			utxos: [msUtxo(MS_P2WSH, hi)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount }],
			feeRate
		});
		expect(ok.amount).toBe(amount);
		expect(ok.change).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════ 5. SWEEP / SEND-MAX

describe('boundary: sweep / send-max', () => {
	it('single-sig: sweeps every candidate coin, none left as change', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000), utxo(40_000, { txid: '22'.repeat(32) })],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 5
		});
		expect(draft.inputs).toHaveLength(2);
		expect(draft.change).toBeNull();
		expect(draft.amount).toBe(100_000 - draft.fee);
	});

	it('single-sig: send-max combined with a second recipient is rejected (not a sweep at all)', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 'max' },
					{ address: RECIPIENT_P2PKH, amount: 1_000 }
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('single recipient');
	});

	it('multisig: sweeps every candidate coin, none left as change', async () => {
		const draft = await msBuild({
			utxos: [msUtxo(MS_P2WSH, 200_000), msUtxo(MS_P2WSH, 100_000, { txid: '22'.repeat(32) })],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
			feeRate: 5
		});
		expect(draft.inputs).toHaveLength(2);
		expect(draft.change).toBeNull();
	});

	it('multisig: send-max over an EMPTY wallet is a zero-balance rejection, not a dust one', async () => {
		await expectPlainRejection(
			msBuild({ utxos: [], recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }] }),
			'no_utxos'
		);
	});
});

// ═══════════════════════════════════════════════════ 6. MIN-RELAY-FEE BOUNDARY

describe('boundary: fee-rate floor (min-relay-fee) and ceiling', () => {
	it('single-sig: feeRate exactly 1 sat/vB (the floor) succeeds', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
			feeRate: 1
		});
		expect(draft.feeRate).toBeGreaterThanOrEqual(1);
	});

	it('single-sig: feeRate below the node floor is rejected with a plain floor message', async () => {
		// No minFeeRate passed → the historical 1 sat/vB default floor, so 0.99 is
		// below it and is refused quoting that floor (cairn-eacw.2).
		const belowFloor = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: 0.99
			}),
			'invalid_amount'
		);
		expect(belowFloor.message).toContain('below what your node will relay');
		expect(belowFloor.message).toContain('1 sat/vB');
		// Zero is refused by the absolute sanity bound (independent of the floor),
		// with its own greater-than-zero message.
		const zero = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: 0
			}),
			'invalid_amount'
		);
		expect(zero.message).toBe('Enter a fee rate greater than zero.');
	});

	it('single-sig: a sub-1 fee builds when the node floor is below it (cairn-eacw.2)', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
			feeRate: 0.5,
			minFeeRate: 0.1
		});
		expect(draft.amount).toBe(10_000);
		// The paid rate reflects the sub-1 request (fee is ceil(vsize * 0.5)).
		expect(draft.feeRate).toBeLessThan(1);
		expect(draft.feeRate).toBeGreaterThan(0);
	});

	it('single-sig: minFeeRate of exactly 0 is a legitimate ultra-low floor, not "unknown" — 0.5 builds (cairn-eacw.8)', async () => {
		// A node with minrelaytxfee=0.00000001 BTC/kvB (0.001 sat/vB) reports a
		// raw relay floor that round2()'s to exactly 0 (ChainService.
		// getMinFeeRate()). That must NOT be treated the same as "floor unknown"
		// (whose sentinel is 1) — found live verifying cairn-eacw.8 on regtest,
		// where this silently re-imposed the 1 sat/vB floor and rejected a real
		// 0.5 sat/vB send the node would have happily relayed.
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
			feeRate: 0.5,
			minFeeRate: 0
		});
		expect(draft.amount).toBe(10_000);
		expect(draft.feeRate).toBeLessThan(1);
		expect(draft.feeRate).toBeGreaterThan(0);
	});

	it('single-sig: 0.5 is rejected when the node floor is 1 (incapable node), floor-aware copy', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: 0.5,
				minFeeRate: 1
			}),
			'invalid_amount'
		);
		expect(err.message).toContain('below what your node will relay');
		expect(err.message).toContain('1 sat/vB');
	});

	it('single-sig: a negative fee rate is rejected the same way as zero', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: -5
			}),
			'invalid_amount'
		);
	});

	it('single-sig: feeRate exactly at MAX_FEE_RATE (1000) succeeds; 1001 is rejected as a fat-finger guard', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(1_000_000)],
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
			feeRate: 1000
		});
		expect(draft.amount).toBe(10_000);

		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(1_000_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 10_000 }],
				feeRate: 1001
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('almost certainly a mistake');
	});

	it('multisig: feeRate floor and ceiling behave identically (shared validateRecipientsAndFeeRate)', async () => {
		await expect(
			msBuild({ feeRate: 1, utxos: [msUtxo(MS_P2WSH, 200_000)] })
		).resolves.toBeDefined();
		const err = await expectPlainRejection(msBuild({ feeRate: 0 }), 'invalid_amount');
		expect(err.message).toBe('Enter a fee rate greater than zero.');
		// Sub-1 below the default floor quotes the floor (parity with single-sig).
		const belowFloor = await expectPlainRejection(msBuild({ feeRate: 0.99 }), 'invalid_amount');
		expect(belowFloor.message).toContain('below what your node will relay');
		await expectPlainRejection(msBuild({ feeRate: 1001 }), 'invalid_amount');
	});

	it('multisig: a sub-1 fee builds when the node floor allows it (cairn-eacw.2 parity)', async () => {
		const draft = await msBuild({ feeRate: 0.5, minFeeRate: 0.1 });
		expect(draft.amount).toBe(50_000);
		expect(draft.feeRate).toBeLessThan(1);
		expect(draft.feeRate).toBeGreaterThan(0);
	});
});

// ═══════════════════════════════════ FORMERLY A KNOWN GAP — fixed, cairn-ykk6
//
// This block used to pin the UNFIXED behavior: DUST_SATS (546, a flat
// constant) was enforced ONLY on the send-max sweep result and the
// RBF-replacement change output — a PLAIN (non-sweep) recipient amount had
// no pre-flight dust check at all, so constructPsbt/buildDraft would build
// and persist a draft paying a sub-dust amount, failing only much later at
// broadcast via mempool relay policy. validateRecipientsAndFeeRate (psbt.ts)
// now rejects these up front (see the "dust threshold (plain recipient
// amount, pre-flight)" block above for the full per-script-type matrix) — the
// gap is closed, so these now assert REJECTION instead of silent success.
describe('formerly KNOWN GAP, now fixed: plain recipient dust is rejected pre-flight', () => {
	it('single-sig: a 100-sat plain recipient amount (well under any real dust threshold) is rejected', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 100 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
	});

	it('multisig: same case — a 100-sat plain recipient amount is rejected', async () => {
		const err = await expectPlainRejection(
			msBuild({
				utxos: [msUtxo(MS_P2WSH, 60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 100 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
	});

	it('single-sig: a 1-sat plain recipient amount to a p2pkh/p2sh/p2wsh destination is also rejected', async () => {
		for (const address of [RECIPIENT_P2PKH, RECIPIENT_P2SH, RECIPIENT_P2WSH]) {
			await expectPlainRejection(
				constructPsbt({
					...COMMON,
					utxos: [utxo(60_000)],
					recipients: [{ address, amount: 1 }],
					feeRate: 5
				}),
				'invalid_amount'
			);
		}
	});
});
