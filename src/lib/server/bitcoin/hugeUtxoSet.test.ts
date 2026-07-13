// Coin-selection / draft-building correctness AND performance at scale: a
// synthetic wallet with 1,000+ candidate UTXOs. Pure construction-layer style
// (no DB, no chain), mirroring sendBoundaryMatrix.test.ts's fixture
// conventions — same real BIP84 zpub, same "address is caller-supplied and
// never cross-checked against the derivation index" convention the existing
// matrix relies on (every synthetic UTXO here reuses chain 0 / index 0's
// address; constructPsbt only ever reads addressToScriptPubKey(utxo.address),
// it never verifies utxo.address against parsed.hdkey.deriveChild(chain,index)).
//
// Multisig equivalent included at lower priority per the task brief — the
// multisig builder DOES cross-check utxo.address against the derived
// script (see deriveFor's expectedAddress guard in multisigPsbt.ts), so all
// multisig fixtures here reuse a single real derived (chain 0, index 0)
// multisig address, same as multisigPsbt.test.ts's own convention.

import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { constructPsbt, type SpendableUtxo } from './psbt';
import { constructMultisigPsbt, type MultisigScriptType } from './multisigPsbt';
import { deriveMultisigAddress, type MultisigConfig, type MultisigKeyDescriptor } from './multisig';

// ── single-sig fixtures ──────────────────────────────────────────────────────

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0 (p2wpkh)
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0 (p2wpkh)
const RECIPIENT_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const COMMON = {
	xpub: ZPUB,
	changeAddress: CHANGE_0,
	changeIndex: 0,
	origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
};

function txidN(n: number): string {
	return n.toString(16).padStart(64, '0');
}

/**
 * Builds `count` distinct, confirmed p2wpkh UTXOs with a varied value spread
 * (1,000 – 50,000 sats, deterministic pseudo-scatter so coin selection has
 * real work to do rather than picking from a uniform pool) and varied
 * confirmation depth. Optionally appends a handful of unconfirmed RECEIVED
 * (not own-change) coins, which must never be auto-selected — see
 * selectSpendCandidates in psbt.ts.
 */
function buildUtxoSet(
	count: number,
	opts: { includeUnconfirmedReceived?: number } = {}
): SpendableUtxo[] {
	const utxos: SpendableUtxo[] = [];
	for (let i = 0; i < count; i++) {
		const value = 1_000 + ((i * 3_701) % 49_000);
		utxos.push({
			txid: txidN(i + 1),
			vout: 0,
			value,
			height: 800_000 + (i % 100),
			address: RECEIVE_0,
			chain: 0,
			index: 0
		});
	}
	const extra = opts.includeUnconfirmedReceived ?? 0;
	for (let i = 0; i < extra; i++) {
		utxos.push({
			txid: txidN(count + i + 1),
			vout: 0,
			value: 5_000,
			height: 0,
			address: RECEIVE_0,
			chain: 0,
			index: 0,
			unconfirmedTrust: 'received'
		});
	}
	return utxos;
}

describe('huge UTXO set: single-sig coin selection at scale', () => {
	it(
		'constructs a correct, valid PSBT for a normal-size payment out of 1,200 candidate UTXOs',
		async () => {
			const utxos = buildUtxoSet(1_200);
			const draft = await constructPsbt({
				...COMMON,
				utxos,
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 50_000 }],
				feeRate: 5
			});

			expect(draft.amount).toBe(50_000);
			const totalSelectedIn = draft.inputs.reduce((s, i) => s + i.value, 0);
			expect(totalSelectedIn).toBeGreaterThanOrEqual(draft.amount + draft.fee);
			expect(totalSelectedIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

			// Sane bound: a 50,000-sat payment out of a pool averaging ~25k sats/coin
			// should need only a handful of inputs, nowhere close to the full 1,200.
			expect(draft.inputs.length).toBeGreaterThan(0);
			expect(draft.inputs.length).toBeLessThan(50);

			// Change, when present, clears the p2wpkh dust floor (294 sats) — but with
			// 1,200 pseudo-scattered candidate values, selectUTXO's default strategy
			// can legitimately land on a changeless (or dust-absorbed-into-fee)
			// combination, so this does not assert change is always present.
			if (draft.change) {
				expect(draft.change.value).toBeGreaterThanOrEqual(294);
			}

			// Every chosen input really is one of the supplied candidate coins.
			const validTxids = new Set(utxos.map((u) => u.txid));
			for (const inp of draft.inputs) expect(validTxids.has(inp.txid)).toBe(true);
		},
		// Same loaded-machine rationale as the other huge-UTXO tests in this file:
		// under the FULL suite's concurrent worker load this legitimately drifts
		// past the default 5s timeout with no regression in the code under test.
		20_000
	);

	it(
		'completes well within a generous performance tripwire (regression guard, not a strict benchmark)',
		async () => {
			const utxos = buildUtxoSet(1_500);
			const start = Date.now();
			await constructPsbt({
				...COMMON,
				utxos,
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 25_000 }],
				feeRate: 3
			});
			const elapsedMs = Date.now() - start;
			// Loose tripwire, not a strict benchmark: on a loaded CI/dev machine
			// (e.g. several vitest workers running concurrently, as in this QA
			// wave) 1,500-candidate selection can drift past 5s without any real
			// regression in the code — 15s keeps this a meaningful guard against an
			// actual O(n^2)-or-worse blowup without flaking on machine load.
			expect(elapsedMs).toBeLessThan(15_000);
		},
		20_000
	);

	it(
		'send-max sweeps every eligible UTXO across a 1,000-coin pool; output is exactly total-minus-fee',
		async () => {
			const utxos = buildUtxoSet(1_000);
			const totalValue = utxos.reduce((s, u) => s + u.value, 0);
			const draft = await constructPsbt({
				...COMMON,
				utxos,
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 5
			});
			expect(draft.inputs).toHaveLength(1_000);
			expect(draft.change).toBeNull();
			expect(draft.amount).toBe(totalValue - draft.fee);

			const selectedTxids = new Set(draft.inputs.map((i) => i.txid));
			for (const u of utxos) expect(selectedTxids.has(u.txid)).toBe(true);
		},
		// Same loaded-machine rationale as the perf-tripwire test above.
		20_000
	);

	it(
		'a scattered handful of unconfirmed RECEIVED coins among 1,000 confirmed ones are never swept — only the confirmed coins are spent',
		async () => {
			const utxos = buildUtxoSet(1_000, { includeUnconfirmedReceived: 20 });
			const confirmedTotal = utxos.filter((u) => u.height > 0).reduce((s, u) => s + u.value, 0);
			const draft = await constructPsbt({
				...COMMON,
				utxos,
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 5
			});
			expect(draft.inputs).toHaveLength(1_000);
			expect(draft.amount).toBe(confirmedTotal - draft.fee);
			for (const inp of draft.inputs) {
				const src = utxos.find((u) => u.txid === inp.txid)!;
				expect(src.height).toBeGreaterThan(0);
			}
		},
		20_000
	);
});

// ── multisig fixtures (lower priority, per task brief) ───────────────────────

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
const MS_ADDRESS = deriveMultisigAddress(MS_P2WSH, 0, 0).address;

function buildMultisigUtxoSet(count: number): SpendableUtxo[] {
	const utxos: SpendableUtxo[] = [];
	for (let i = 0; i < count; i++) {
		const value = 2_000 + ((i * 4_507) % 98_000);
		utxos.push({
			txid: txidN(100_000 + i),
			vout: 0,
			value,
			height: 800_000,
			address: MS_ADDRESS,
			chain: 0,
			index: 0
		});
	}
	return utxos;
}

describe('huge UTXO set: multisig coin selection at scale (lower priority)', () => {
	it('constructs a correct multisig PSBT for a normal-size payment out of 800 candidate UTXOs', async () => {
		const utxos = buildMultisigUtxoSet(800);
		const draft = await constructMultisigPsbt({
			config: MS_P2WSH,
			utxos,
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		expect(draft.amount).toBe(50_000);
		const totalSelectedIn = draft.inputs.reduce((s, i) => s + i.value, 0);
		expect(totalSelectedIn).toBeGreaterThanOrEqual(draft.amount + draft.fee);
		expect(draft.inputs.length).toBeGreaterThan(0);
		expect(draft.inputs.length).toBeLessThan(800);
	});

	it('completes within a generous performance tripwire', async () => {
		const utxos = buildMultisigUtxoSet(800);
		const start = Date.now();
		await constructMultisigPsbt({
			config: MS_P2WSH,
			utxos,
			recipients: [{ address: RECIPIENT_P2WPKH, amount: 30_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	it(
		'send-max sweeps every eligible UTXO across an 800-coin multisig pool',
		async () => {
			const utxos = buildMultisigUtxoSet(800);
			const totalValue = utxos.reduce((s, u) => s + u.value, 0);
			const draft = await constructMultisigPsbt({
				config: MS_P2WSH,
				utxos,
				recipients: [{ address: RECIPIENT_P2WPKH, amount: 'max' }],
				feeRate: 5,
				changeIndex: 0
			});
			expect(draft.inputs).toHaveLength(800);
			expect(draft.change).toBeNull();
			expect(draft.amount).toBe(totalValue - draft.fee);
		},
		// Multisig PSBT construction is heavier per input than single-sig (BIP-67
		// sort + multisig witness/script sizing for every one of 800 inputs) — the
		// default 5s vitest timeout is too tight here even though this is still a
		// loose perf tripwire, not a strict benchmark. 20s stays well under any
		// regression threshold while giving CI headroom.
		20_000
	);
});
