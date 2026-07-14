// Malformed-input coverage for the send/draft validation layer:
// validateRecipientsAndFeeRate (exercised through constructPsbt /
// constructMultisigPsbt) PLUS the request-body coercion function
// readSpendRequest/toAmount in walletApi.ts (~line 50-65). toAmount() rejects
// hex strings and array shapes outright (cairn-ozc5); anything else it
// coerces via Number() still has to be caught downstream by
// validateRecipientsAndFeeRate (bounds/positivity/dust checks).
//
// Same pure construction-layer style as sendBoundaryMatrix.test.ts (no DB, no
// chain); fixtures and the plain-language guard are copied verbatim from
// there. readSpendRequest is exercised directly against a minimal fake
// RequestEvent (just a real Request object) — every case here stays inside
// the single-recipient / no-coin-control path, so requireFeature (which needs
// a real session/user) is never reached, and no fuller SvelteKit locals stub
// is required.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { RequestEvent } from '@sveltejs/kit';
import { constructPsbt, PsbtError, type SpendableUtxo } from './psbt';
import {
	constructMultisigPsbt,
	type MultisigConstructParams,
	type MultisigScriptType
} from './multisigPsbt';
import { deriveMultisigAddress, type MultisigConfig, type MultisigKeyDescriptor } from './multisig';
import { readSpendRequest } from '../walletApi';

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
const RECIPIENT_P2TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

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

// ── multisig fixtures (verbatim copy of sendBoundaryMatrix.test.ts) ─────────

const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number): MultisigKeyDescriptor {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return { xpub: account.publicExtendedKey, fingerprint, path: BIP48_PATH };
}
const MS_KEYS = [1, 2, 3].map(makeSigner);
const MS_P2WSH: MultisigConfig & { scriptType: MultisigScriptType } = {
	threshold: 2,
	keys: MS_KEYS,
	scriptType: 'p2wsh'
};
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

// ═══════════════════════════════════════ 1. NEGATIVE / NaN / FRACTIONAL AMOUNTS

describe('malformed amount: negative, NaN, and fractional values', () => {
	it('single-sig: a negative amount (-1000) is rejected as invalid_amount, plain language', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: -1000 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('positive number');
	});

	it('single-sig: NaN amounts from Number(undefined) / Number("") / Number("not a number") are all rejected as invalid_amount', async () => {
		const naNish = [Number(undefined), Number('not a number')]; // both NaN
		for (const amount of naNish) {
			expect(Number.isNaN(amount)).toBe(true);
			await expectPlainRejection(
				constructPsbt({
					...COMMON,
					utxos: [utxo(60_000)],
					recipients: [{ address: RECIPIENT_P2WPKH, amount }],
					feeRate: 5
				}),
				'invalid_amount'
			);
		}
	});

	it('single-sig: Number("") is 0 (NOT NaN) — still rejected, but via the "must be positive" branch rather than the integer check', async () => {
		expect(Number('')).toBe(0);
		expect(Number.isNaN(Number(''))).toBe(false);
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: Number('') }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('positive number');
	});

	it('single-sig: a fractional/non-integer amount (100.5 sats) is rejected as invalid_amount', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 100.5 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('positive number');
	});

	it('multisig: negative, NaN, and fractional amounts are all rejected the same way (shared validateRecipientsAndFeeRate)', async () => {
		for (const amount of [-1000, NaN, 100.5]) {
			await expectPlainRejection(msBuild({ recipients: [{ address: RECIPIENT_P2WPKH, amount }] }), 'invalid_amount');
		}
	});
});

// ═══════════════════════════════════════ 2. OVERFLOW / EDGE-OF-RANGE AMOUNTS

describe('malformed amount: overflow and edge-of-JS-safe-integer amounts (UTXO-set-independent — no real wallet holds this much)', () => {
	it('an amount far beyond the entire 21M BTC supply in sats is a positive integer per Number.isInteger, and validateRecipientsAndFeeRate has NO explicit upper-bound guard for it — it is only ever caught downstream as insufficient_funds', async () => {
		const beyondSupply = 2_100_000_000_000_000 + 1; // 21,000,000 BTC in sats, +1
		expect(Number.isInteger(beyondSupply)).toBe(true);
		expect(beyondSupply > 0).toBe(true);
		// Confirms there is no dedicated upper-bound check: this amount clears
		// every validation gate up to coin selection, and is rejected there,
		// exactly like a merely-too-large-for-this-wallet amount would be.
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: beyondSupply }],
				feeRate: 5
			}),
			'insufficient_funds'
		);
	});

	it('an amount exactly at Number.MAX_SAFE_INTEGER is safely rejected as insufficient_funds — no crash, no hang', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: Number.MAX_SAFE_INTEGER }],
				feeRate: 5
			}),
			'insufficient_funds'
		);
	});

	it('an amount ONE ABOVE Number.MAX_SAFE_INTEGER is safely rejected as insufficient_funds — no crash, no hang, no silent precision loss that fools validation', async () => {
		const overSafe = Number.MAX_SAFE_INTEGER + 1;
		// Still an "integer" per Number.isInteger (IEEE-754 can represent 2^53
		// exactly) — confirms the rejection is genuinely from coin selection, not
		// from Number.isInteger suddenly returning false and short-circuiting into
		// the "must be a positive number" message instead.
		expect(Number.isInteger(overSafe)).toBe(true);
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: RECIPIENT_P2WPKH, amount: overSafe }],
				feeRate: 5
			}),
			'insufficient_funds'
		);
	});

	it('multisig: the same beyond-supply amount is safely rejected as insufficient_funds', async () => {
		await expectPlainRejection(
			msBuild({ recipients: [{ address: RECIPIENT_P2WPKH, amount: 2_100_000_000_000_001 }] }),
			'insufficient_funds'
		);
	});

	it('a huge numeric amount alongside a send-max sentinel is rejected as "single recipient only" BEFORE either amount is ever evaluated — there is no shared arithmetic surface between send-max and an oversized literal amount, since \'max\' is checked by strict string equality, never coerced through the numeric path', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [
					{ address: RECIPIENT_P2WPKH, amount: 'max' },
					{ address: RECIPIENT_P2PKH, amount: Number.MAX_SAFE_INTEGER }
				],
				feeRate: 5
			}),
			'invalid_amount'
		);
	});
});

// ═══════════════════════════════════════ 3. readSpendRequest / toAmount() COERCION

/** Minimal fake RequestEvent — just enough for readJson's readCappedBody
 *  (event.request.headers.get + event.request.text()). Every case below stays
 *  single-recipient / no-coin-control, so requireFeature (which needs a real
 *  session) is never reached. */
function fakeSpendEvent(body: unknown): RequestEvent {
	const request = new Request('http://localhost/api/wallets/1/psbt', {
		method: 'POST',
		body: JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

describe('readSpendRequest / toAmount(): body coercion of a malformed amount field (walletApi.ts ~line 59: `Number(a)`, no bounds-checking)', () => {
	// Cases where the coercion result is safely caught downstream (NaN, or a
	// too-small/non-positive number) — checked together for brevity.
	const SAFE_CASES: { label: string; amount: unknown; expectedNumber?: number }[] = [
		{ label: 'SQL-injection-flavored string "100; DROP TABLE transactions" -> NaN', amount: '100; DROP TABLE transactions' },
		{ label: 'empty string "" -> 0', amount: '', expectedNumber: 0 },
		{ label: 'plain object {} -> NaN', amount: {} },
		{ label: 'multi-element array [1, 2] -> NaN (Number([1,2]) reads its "1,2" string form)', amount: [1, 2] },
		{ label: 'boolean true -> 1 (still rejected: 1 sat is below every script type\'s dust floor)', amount: true, expectedNumber: 1 },
		{ label: 'boolean false -> 0', amount: false, expectedNumber: 0 },
		{ label: 'null -> 0', amount: null, expectedNumber: 0 },
		{ label: 'undefined / omitted field -> NaN', amount: undefined }
	];

	for (const { label, amount, expectedNumber } of SAFE_CASES) {
		it(`amount ${label} — readSpendRequest coerces it, constructPsbt rejects the result as invalid_amount (never a crash or silent acceptance)`, async () => {
			const req = await readSpendRequest(
				fakeSpendEvent({ recipient: RECIPIENT_P2WPKH, amount, feeRate: 5 })
			);
			if (expectedNumber !== undefined) expect(req.recipients[0].amount).toBe(expectedNumber);
			await expectPlainRejection(
				constructPsbt({ ...COMMON, utxos: [utxo(1_000_000_000)], recipients: req.recipients, feeRate: req.feeRate }),
				'invalid_amount'
			);
		});
	}

	// FIXED (cairn-ozc5): a hex-formatted string amount ("0x2710") used to be
	// silently coerced by JavaScript's Number() to its decimal value (10,000)
	// and sail through validateRecipientsAndFeeRate with no complaint.
	// toAmount() now rejects any string that isn't a plain decimal literal, so
	// this is caught as invalid_amount instead of accepted as 10,000 sats.
	it('hex string amount "0x2710" is rejected as invalid_amount, not silently coerced to 10,000 sats', async () => {
		const req = await readSpendRequest(
			fakeSpendEvent({ recipient: RECIPIENT_P2WPKH, amount: '0x2710', feeRate: 5 })
		);
		expect(req.recipients[0].amount).toBeNaN();
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(1_000_000_000)],
				recipients: req.recipients,
				feeRate: req.feeRate
			}),
			'invalid_amount'
		);
	});

	// FIXED (cairn-ozc5): a single-element JSON array ([10000]) used to be
	// silently coerced by Number() to its lone element (Number([10000]) ===
	// 10000, because a single-element array's default toString() is just that
	// element's own string form) and sail through validation exactly like a
	// plain number would. toAmount() now rejects any array outright.
	it('single-element array amount [10000] is rejected as invalid_amount, not silently coerced to 10,000 sats', async () => {
		const req = await readSpendRequest(
			fakeSpendEvent({ recipient: RECIPIENT_P2WPKH, amount: [10_000], feeRate: 5 })
		);
		expect(req.recipients[0].amount).toBeNaN();
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(1_000_000_000)],
				recipients: req.recipients,
				feeRate: req.feeRate
			}),
			'invalid_amount'
		);
	});

	// Not marked BUG: scientific notation is standard decimal-number syntax
	// (unlike the hex/array cases above, "1e10" reads unambiguously as ten
	// billion to any JS number parser), and the coerced value is still fully
	// bounds-checked downstream. Documented here so the behavior is pinned and
	// visible, not because it is unsafe.
	it('scientific notation amount "1e10" is coerced to 10,000,000,000 sats and accepted (ordinary Number() parsing, not a bug)', async () => {
		const req = await readSpendRequest(
			fakeSpendEvent({ recipient: RECIPIENT_P2WPKH, amount: '1e10', feeRate: 5 })
		);
		expect(req.recipients[0].amount).toBe(10_000_000_000);
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(20_000_000_000)],
			recipients: req.recipients,
			feeRate: req.feeRate
		});
		expect(draft.amount).toBe(10_000_000_000);
	});
});

// ═══════════════════════════════════════ 4. INVALID / MALFORMED / WRONG-NETWORK ADDRESSES

const b58check = createBase58check(sha256);

/** Re-encodes a bech32 (v0) address under a different HRP, producing a
 *  legitimately-checksummed address for a different network — used instead of
 *  a hand-typed test vector so the checksum is guaranteed valid. */
function reencodeBech32(address: string, hrp: string): string {
	const dec = bech32.decode(address as `${string}1${string}`);
	return bech32.encode(hrp as never, dec.words);
}

/** Re-encodes a base58check (P2PKH/P2SH) address under a different version
 *  byte — same technique as reencodeBech32, for legacy addresses. */
function reencodeBase58(address: string, newVersion: number): string {
	const payload = b58check.decode(address);
	const out = new Uint8Array(payload);
	out[0] = newVersion;
	return b58check.encode(out);
}

/** A structurally well-formed bech32m address using witness version 17 —
 *  segwit versions only go up to 16 (OP_1..OP_16); 17 does not exist. */
function fakeWitnessV17(): string {
	const dec = bech32m.decode(RECIPIENT_P2TR as `${string}1${string}`);
	return bech32m.encode('bc', [17, ...dec.words.slice(1)]);
}

describe('malformed / wrong-network addresses are rejected cleanly via isValidAddress, not crashed on', () => {
	const CASES: { label: string; address: string }[] = [
		{ label: 'testnet bech32 (tb1...)', address: reencodeBech32(RECIPIENT_P2WPKH, 'tb') },
		{ label: 'regtest bech32 (bcrt1...)', address: reencodeBech32(RECIPIENT_P2WPKH, 'bcrt') },
		{ label: 'testnet legacy p2pkh (m/n-prefixed, version 0x6f)', address: reencodeBase58(RECIPIENT_P2PKH, 0x6f) },
		{ label: 'testnet legacy p2sh (2-prefixed, version 0xc4)', address: reencodeBase58(RECIPIENT_P2SH, 0xc4) },
		{ label: 'bech32 with a corrupted checksum (last char flipped)', address: RECIPIENT_P2WPKH.slice(0, -1) + (RECIPIENT_P2WPKH.at(-1) === '4' ? '5' : '4') },
		{
			label: 'bech32 with mixed-case (checksum breaks per BIP173, which forbids mixed case)',
			address: RECIPIENT_P2WPKH.slice(0, 5) + RECIPIENT_P2WPKH.slice(5, 10).toUpperCase() + RECIPIENT_P2WPKH.slice(10)
		},
		{ label: 'truncated bech32 (last 6 chars dropped)', address: RECIPIENT_P2WPKH.slice(0, -6) },
		{ label: 'empty string address', address: '' },
		{ label: 'segwit witness version 17 (does not exist — v0..v16 only)', address: fakeWitnessV17() }
	];

	for (const { label, address } of CASES) {
		it(`${label} is rejected with a plain-language message, not a crash or stack trace`, async () => {
			const err = await expectPlainRejection(
				constructPsbt({
					...COMMON,
					utxos: [utxo(60_000)],
					recipients: [{ address, amount: 10_000 }],
					feeRate: 5
				}),
				'invalid_recipient'
			);
			expect(err.message.toLowerCase()).toContain('valid bitcoin address');
		});
	}

	it('a null address (bypassing the type system — e.g. a malformed request body reaching this deep) is rejected cleanly, not a TypeError from address.trim()', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: null as unknown as string, amount: 10_000 }],
				feeRate: 5
			}),
			'invalid_recipient'
		);
	});

	it('an undefined address is rejected cleanly, not a TypeError', async () => {
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: undefined as unknown as string, amount: 10_000 }],
				feeRate: 5
			}),
			'invalid_recipient'
		);
	});

	it('multisig: a testnet bech32 address is rejected the same way as single-sig (shared validateRecipientsAndFeeRate)', async () => {
		await expectPlainRejection(
			msBuild({ recipients: [{ address: reencodeBech32(RECIPIENT_P2WPKH, 'tb'), amount: 10_000 }] }),
			'invalid_recipient'
		);
	});

	it('multisig: an empty string address is rejected the same way as single-sig', async () => {
		await expectPlainRejection(
			msBuild({ recipients: [{ address: '', amount: 10_000 }] }),
			'invalid_recipient'
		);
	});
});

// ═══════════════════════════════════════ 5. WHITESPACE-PADDED ADDRESSES (cairn-3l1e)
//
// FIXED (cairn-3l1e): a whitespace-padded but otherwise valid address used to
// pass isValidAddress (addressToScriptPubKey trims internally) but sail
// through to @scure/btc-signer's tx.addOutputAddress still padded — which does
// NOT trim, and threw its own raw error instead of a friendly PsbtError.
// validateRecipientsAndFeeRate now trims r.address in place, so every
// downstream consumer (constructPsbt/constructMultisigPsbt's own
// `params.recipients` — the same object references) sees the clean value.

describe('whitespace-padded addresses are trimmed before validation, not crashed on downstream (cairn-3l1e)', () => {
	const PAD_CASES: { label: string; pad: (s: string) => string }[] = [
		{ label: 'leading spaces', pad: (s) => `   ${s}` },
		{ label: 'trailing spaces', pad: (s) => `${s}   ` },
		{ label: 'leading and trailing spaces', pad: (s) => `  ${s}  ` },
		{ label: 'leading tab', pad: (s) => `\t${s}` },
		{ label: 'trailing newline', pad: (s) => `${s}\n` },
		{ label: 'mixed tab/newline/space padding on both ends', pad: (s) => `\t\n ${s} \n\t` }
	];

	for (const { label, pad } of PAD_CASES) {
		it(`single-sig: a p2wpkh address padded with ${label} builds successfully, and the persisted recipient is the TRIMMED address (no raw library throw)`, async () => {
			const padded = pad(RECIPIENT_P2WPKH);
			const draft = await constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: padded, amount: 10_000 }],
				feeRate: 5
			});
			expect(draft.recipient).toBe(RECIPIENT_P2WPKH);
			expect(draft.recipients[0].address).toBe(RECIPIENT_P2WPKH);
		});
	}

	it('single-sig: a legacy p2pkh address padded with both leading and trailing whitespace still builds, trimmed', async () => {
		const draft = await constructPsbt({
			...COMMON,
			utxos: [utxo(60_000)],
			recipients: [{ address: `  ${RECIPIENT_P2PKH}  `, amount: 10_000 }],
			feeRate: 5
		});
		expect(draft.recipient).toBe(RECIPIENT_P2PKH);
	});

	it('multisig: a padded address builds successfully via the same shared validateRecipientsAndFeeRate, trimmed', async () => {
		const details = await msBuild({
			recipients: [{ address: `  \t${RECIPIENT_P2WPKH}\n  `, amount: 50_000 }]
		});
		expect(details.recipient).toBe(RECIPIENT_P2WPKH);
	});

	it('an address that is ONLY whitespace is rejected as invalid_recipient, plain language, not a crash', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: '   \t\n  ', amount: 10_000 }],
				feeRate: 5
			}),
			'invalid_recipient'
		);
		expect(err.message.toLowerCase()).toContain('valid bitcoin address');
	});

	it('an address that is still invalid AFTER trimming (whitespace-padded garbage) is rejected as invalid_recipient, not accepted', async () => {
		const err = await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: '  not-a-real-address  ', amount: 10_000 }],
				feeRate: 5
			}),
			'invalid_recipient'
		);
		expect(err.message.toLowerCase()).toContain('valid bitcoin address');
	});

	it('an address that is valid on the WRONG network only after trimming (padded testnet bech32) is still rejected as invalid_recipient, not silently accepted', async () => {
		const paddedTestnet = `  ${reencodeBech32(RECIPIENT_P2WPKH, 'tb')}  `;
		await expectPlainRejection(
			constructPsbt({
				...COMMON,
				utxos: [utxo(60_000)],
				recipients: [{ address: paddedTestnet, amount: 10_000 }],
				feeRate: 5
			}),
			'invalid_recipient'
		);
	});

	it('multisig: an address that is still invalid after trimming is rejected the same way as single-sig', async () => {
		await expectPlainRejection(
			msBuild({ recipients: [{ address: '  garbage-not-an-address  ', amount: 10_000 }] }),
			'invalid_recipient'
		);
	});
});
