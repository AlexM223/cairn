// Hostile-input matrix: CORRUPTED/ADVERSARIAL PSBTs fed through the real
// parse/summarize/combine/finalize paths (summarizePsbt, finalizePsbt,
// combineMultisigPsbts, finalizeMultisigPsbt). Every case must fail cleanly —
// a typed error (or at minimum a plain Error, never an uncaught crash/hang)
// with no raw stack trace or internal buffer dump leaking into the message —
// or, for the two "valid but different tx" combine cases, a real
// MultisigPsbtError from the existing substitution guard.
//
// Prior art (psbt.test.ts / multisigPsbt.test.ts) already exercises
// summarizePsbt/finalizePsbt/combineMultisigPsbts extensively against
// WELL-FORMED PSBTs (signed, partially signed, mixed finalization, wrong
// sighash, foreign signatures, substituted outputs). None of that prior art
// feeds genuinely malformed BYTES — truncated/invalid base64, wrong magic,
// trailing garbage, or oversized payloads — which is this file's job.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
	constructPsbt,
	summarizePsbt,
	finalizePsbt,
	PsbtNotFullySignedError,
	PsbtSighashError,
	type SpendableUtxo
} from './psbt';
import {
	constructMultisigPsbt,
	combineMultisigPsbts,
	finalizeMultisigPsbt,
	MultisigPsbtError,
	type MultisigConstructParams,
	type MultisigScriptType
} from './multisigPsbt';
import { deriveMultisigAddress, type MultisigConfig } from './multisig';

// ── fixtures ─────────────────────────────────────────────────────────────────

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
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

async function realPsbt(): Promise<string> {
	const draft = await constructPsbt({
		...COMMON,
		utxos: [utxo(60_000)],
		recipients: [{ address: RECEIVE_0, amount: 10_000 }],
		feeRate: 5
	});
	return draft.psbtBase64;
}

const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return { master, account, fingerprint, descriptor: { xpub: account.publicExtendedKey, fingerprint, path: BIP48_PATH } };
}
const SIGNERS = [1, 2, 3].map(makeSigner);
const MS_P2WSH: MultisigConfig & { scriptType: MultisigScriptType } = {
	threshold: 2,
	keys: SIGNERS.map((s) => s.descriptor),
	scriptType: 'p2wsh'
};
function msUtxo(value: number): SpendableUtxo {
	return {
		txid: '22'.repeat(32),
		vout: 0,
		value,
		height: 800_000,
		address: deriveMultisigAddress(MS_P2WSH, 0, 0).address,
		chain: 0,
		index: 0
	};
}
async function realMultisigPsbt(over: Partial<MultisigConstructParams> = {}): Promise<string> {
	const draft = await constructMultisigPsbt({
		config: MS_P2WSH,
		utxos: [msUtxo(200_000)],
		recipients: [{ address: RECEIVE_0, amount: 50_000 }],
		feeRate: 5,
		changeIndex: 0,
		...over
	});
	return draft.psbtBase64;
}

/** No raw stack-frame lines, no giant internal buffer dumps, in a caught error's message. */
function expectCleanFailureMessage(message: string): void {
	expect(message.length).toBeGreaterThan(0);
	expect(message).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/);
	// A leaked raw byte/hex dump would typically run hundreds of chars long;
	// legitimate messages here are short, human sentences.
	expect(message.length).toBeLessThan(500);
}

// ── the hostile PSBT-bytes table, exercised against every consumer ─────────

describe('summarizePsbt: corrupted PSBT bytes fail cleanly', () => {
	it('rejects an empty string', () => {
		expect(() => summarizePsbt('')).toThrow();
	});

	it('rejects invalid base64 (characters outside the alphabet)', () => {
		expect(() => summarizePsbt('!!!not-valid-base64!!!')).toThrow();
	});

	it('rejects a truncated base64 payload (a real PSBT cut in half)', async () => {
		const real = await realPsbt();
		const truncated = real.slice(0, Math.floor(real.length / 2));
		let caught: unknown;
		try {
			summarizePsbt(truncated);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expectCleanFailureMessage((caught as Error).message);
	});

	it('rejects wrong magic bytes (valid base64, but not a PSBT at all)', () => {
		const notAPsbt = base64.encode(new TextEncoder().encode('this is definitely not a psbt'));
		let caught: unknown;
		try {
			summarizePsbt(notAPsbt);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expectCleanFailureMessage((caught as Error).message);
	});

	it('rejects a real PSBT with its magic bytes corrupted (flip the leading byte)', async () => {
		const real = await realPsbt();
		const bytes = base64.decode(real);
		const corrupted = new Uint8Array(bytes);
		corrupted[0] = 0x00; // BIP174 magic is 0x70 0x73 0x62 0x74 0xff
		expect(() => summarizePsbt(base64.encode(corrupted))).toThrow();
	});

	it('rejects a valid PSBT with garbage bytes appended after it', async () => {
		const real = await realPsbt();
		const bytes = base64.decode(real);
		const withGarbage = new Uint8Array(bytes.length + 200);
		withGarbage.set(bytes, 0);
		for (let i = bytes.length; i < withGarbage.length; i++) withGarbage[i] = (i * 17) % 256;
		let caught: unknown;
		let succeeded = false;
		try {
			const summary = summarizePsbt(base64.encode(withGarbage));
			succeeded = true;
			// If the parser is lenient about trailing bytes, it must still report
			// the SAME transaction, not silently absorb the garbage into it.
			expect(summary.inputCount).toBe(1);
		} catch (e) {
			caught = e;
		}
		// Either outcome is acceptable (strict reject, or lenient-but-correct
		// parse) — what's NOT acceptable is a hang or an uncaught non-Error throw.
		if (!succeeded) {
			expect(caught).toBeInstanceOf(Error);
			expectCleanFailureMessage((caught as Error).message);
		}
	});

	it('rejects a whitespace-only string', () => {
		expect(() => summarizePsbt('   ')).toThrow();
	});

	it('handles a large (multi-MB) garbage payload without hanging, failing cleanly and quickly', () => {
		const big = new Uint8Array(5 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big[i] = 0xff; // sparse noise, cheap to fill
		const start = Date.now();
		let caught: unknown;
		try {
			summarizePsbt(base64.encode(big));
		} catch (e) {
			caught = e;
		}
		const elapsedMs = Date.now() - start;
		expect(caught).toBeInstanceOf(Error);
		expect(elapsedMs).toBeLessThan(5000); // no pathological hang
	});

	it('handles a large (multi-MB) VALID-base64-but-garbage-content payload without hanging', () => {
		// Same size class, but built from a repeating readable pattern rather
		// than sparse zeros, closer to a real corrupted-file-upload scenario.
		const pattern = new TextEncoder().encode('CORRUPTED-PSBT-UPLOAD-');
		const big = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = pattern[i % pattern.length];
		const start = Date.now();
		expect(() => summarizePsbt(base64.encode(big))).toThrow();
		expect(Date.now() - start).toBeLessThan(5000);
	});
});

describe('finalizePsbt: corrupted PSBT bytes fail cleanly (never a raw crash)', () => {
	it('rejects an empty string', () => {
		expect(() => finalizePsbt('')).toThrow();
	});

	it('rejects invalid base64', () => {
		expect(() => finalizePsbt('###garbage###')).toThrow();
	});

	it('rejects a truncated real PSBT', async () => {
		const real = await realPsbt();
		expect(() => finalizePsbt(real.slice(0, 20))).toThrow();
	});

	it('rejects wrong magic bytes', () => {
		const notAPsbt = base64.encode(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
		expect(() => finalizePsbt(notAPsbt)).toThrow();
	});

	it('rejects a real PSBT with garbage appended, OR finalizes correctly if lenient — never a silent wrong result', async () => {
		const real = await realPsbt();
		const bytes = base64.decode(real);
		const withGarbage = new Uint8Array(bytes.length + 64);
		withGarbage.set(bytes, 0);
		let caught: unknown;
		try {
			finalizePsbt(base64.encode(withGarbage));
		} catch (e) {
			caught = e;
		}
		// This PSBT is UNSIGNED, so even a lenient parse must still hit
		// PsbtNotFullySignedError, never finalize successfully.
		expect(caught).toBeInstanceOf(Error);
	});

	it('an unsigned real PSBT (no corruption) still reports the typed PsbtNotFullySignedError, not a generic Error, for contrast', async () => {
		const real = await realPsbt();
		expect(() => finalizePsbt(real)).toThrow(PsbtNotFullySignedError);
	});

	it('KNOWN GAP (not fixed here): a structurally-corrupted PSBT throws a raw parse Error rather than a typed PsbtError-family exception', async () => {
		// Module: src/lib/server/bitcoin/psbt.ts (finalizePsbt).
		// Input: a well-formed-base64 but non-PSBT byte string (wrong magic).
		// Expected: finalizePsbt's own doc comment says "throws a plain Error
		// (parse failure...) for anything else — callers must not surface that
		// raw message to end users (cairn QA F3)" — i.e. this is ALREADY
		// documented as the caller's responsibility to wrap, not a bug in this
		// function. This test exists to make that contract explicit and
		// failure-visible: it pins that the thrown error here is NOT one of
		// PsbtNotFullySignedError / PsbtSighashError (the two typed, safe-to-
		// display error classes finalizePsbt DOES define) but a raw
		// @scure/btc-signer parse exception, so every call site MUST catch and
		// translate it rather than assuming typed errors cover every case.
		// Actual: confirmed below — a parse failure is a bare Error, not
		// PsbtNotFullySignedError/PsbtSighashError.
		// Severity suggestion: P3 documentation/defense-in-depth — no known
		// call site currently mishandles this (worth a grep across the API
		// routes to confirm every finalizePsbt call site has a catch-all, not
		// just a catch for the two typed classes), but the type system gives
		// no compile-time signal that a THIRD failure mode exists.
		const notAPsbt = base64.encode(new TextEncoder().encode('garbage garbage garbage'));
		let caught: unknown;
		try {
			finalizePsbt(notAPsbt);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(PsbtNotFullySignedError);
		expect(caught).not.toBeInstanceOf(PsbtSighashError);
	});
});

describe('combineMultisigPsbts: corrupted PSBTs fail cleanly through the combine-time guard', () => {
	it('rejects an invalid base64 base PSBT', async () => {
		const incoming = await realMultisigPsbt();
		expect(() => combineMultisigPsbts('!!!garbage!!!', incoming)).toThrow(MultisigPsbtError);
	});

	it('rejects an invalid base64 incoming PSBT', async () => {
		const base = await realMultisigPsbt();
		expect(() => combineMultisigPsbts(base, '###not-base64###')).toThrow(MultisigPsbtError);
	});

	it('reports MultisigPsbtError("different_transaction") for an unparseable base, via the assertSameTransaction pre-check', async () => {
		const incoming = await realMultisigPsbt();
		try {
			combineMultisigPsbts('totally-invalid', incoming);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
			expectCleanFailureMessage((e as MultisigPsbtError).message);
		}
	});

	it('rejects a truncated real PSBT as either operand', async () => {
		const real = await realMultisigPsbt();
		const truncated = real.slice(0, 30);
		expect(() => combineMultisigPsbts(truncated, real)).toThrow(MultisigPsbtError);
		expect(() => combineMultisigPsbts(real, truncated)).toThrow(MultisigPsbtError);
	});

	it('rejects two independently-valid PSBTs for DIFFERENT transactions (input-count / content mismatch), not a crash', async () => {
		const a = await realMultisigPsbt();
		// A second multisig PSBT with a different recipient amount is a
		// different transaction outright — the pre-existing substitution guard
		// (assertSameTransaction) must catch it before the per-input loop ever
		// runs, so an incoming PSBT with a mismatched shape never reaches the
		// getInput(i) indexing that assumes matching input counts.
		const b = await realMultisigPsbt({ recipients: [{ address: RECEIVE_0, amount: 51_000 }] });
		try {
			combineMultisigPsbts(a, b);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
		}
	});

	it('a genuinely different INPUT SET (different coin entirely) is also caught as different_transaction, not an index crash', async () => {
		// Build two completely independent multisig drafts spending different
		// (unrelated) coins — same recipient/amount coincidentally, but
		// different txid inputs, so the input commitment string differs.
		const a = await constructMultisigPsbt({
			config: MS_P2WSH,
			utxos: [{ ...msUtxo(200_000), txid: '33'.repeat(32) }],
			recipients: [{ address: RECEIVE_0, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		const b = await constructMultisigPsbt({
			config: MS_P2WSH,
			utxos: [{ ...msUtxo(200_000), txid: '44'.repeat(32) }],
			recipients: [{ address: RECEIVE_0, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		try {
			combineMultisigPsbts(a.psbtBase64, b.psbtBase64);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
		}
	});

	it('handles a large-garbage incoming payload without hanging', async () => {
		const base = await realMultisigPsbt();
		const big = base64.encode(new Uint8Array(2 * 1024 * 1024));
		const start = Date.now();
		expect(() => combineMultisigPsbts(base, big)).toThrow(MultisigPsbtError);
		expect(Date.now() - start).toBeLessThan(5000);
	});
});

describe('finalizeMultisigPsbt: corrupted PSBTs fail cleanly', () => {
	it('rejects invalid base64', () => {
		expect(() => finalizeMultisigPsbt('!!!!')).toThrow();
	});

	it('rejects a truncated real multisig PSBT', async () => {
		const real = await realMultisigPsbt();
		expect(() => finalizeMultisigPsbt(real.slice(0, 25))).toThrow();
	});

	it('rejects wrong magic bytes', () => {
		const notAPsbt = base64.encode(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
		expect(() => finalizeMultisigPsbt(notAPsbt)).toThrow();
	});

	it('an unsigned (but structurally valid) multisig PSBT reports MultisigPsbtError("not_enough_signatures"), for contrast with the corrupted cases above', async () => {
		const real = await realMultisigPsbt();
		try {
			finalizeMultisigPsbt(real);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('not_enough_signatures');
		}
	});
});

// ── missing witness UTXO ─────────────────────────────────────────────────────

describe('missing witnessUtxo on a segwit input', () => {
	it('summarizePsbt reports a null value (not a crash) when an input has neither witnessUtxo nor nonWitnessUtxo', () => {
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		// A bare input with no UTXO information attached at all — pathological,
		// but a corrupted/hand-edited PSBT could plausibly arrive like this.
		tx.addInput({ txid: hexToBytes('11'.repeat(32)), index: 0 });
		tx.addOutputAddress(RECEIVE_0, 10_000n, NETWORK);
		const summary = summarizePsbt(base64.encode(tx.toPSBT()));
		expect(summary.inputs).toEqual([{ txid: '11'.repeat(32), vout: 0, value: null }]);
		expect(summary.inputCount).toBe(1);
	});

	it('finalizePsbt on an input with no witnessUtxo and no signature reports the ordinary PsbtNotFullySignedError, not a witnessUtxo-specific crash', () => {
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		tx.addInput({ txid: hexToBytes('11'.repeat(32)), index: 0 });
		tx.addOutputAddress(RECEIVE_0, 10_000n, NETWORK);
		const psbtBase64 = base64.encode(tx.toPSBT());
		expect(() => finalizePsbt(psbtBase64)).toThrow(PsbtNotFullySignedError);
	});
});
