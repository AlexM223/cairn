import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { deriveMultisigAddress, type MultisigConfig, type MultisigKeyDescriptor } from './multisig';
import { setDefaultNetwork } from './xpub';
import { summarizePsbt, RBF_SEQUENCE, PsbtError, type SpendableUtxo } from './psbt';
import {
	constructMultisigPsbt,
	combineMultisigPsbts,
	multisigPsbtProgress,
	finalizeMultisigPsbt,
	multisigInputVsize,
	MultisigPsbtError,
	type MultisigScriptType
} from './multisigPsbt';
import {
	computeSigningMass,
	parentVsizeFromRawTx,
	clearParentMassCache
} from './signingMass';

// ── deterministic cosigner fixtures ─────────────────────────────────────────
// Master seeds 0x01…0x05, accounts at the BIP-48 wsh path. Test-only keys —
// the same fixture family multisig.test.ts uses, but keeping the MASTER so
// tests can produce real signatures the way a hardware device would.
const BIP48_PATH = "m/48'/0'/0'/2'";

interface TestSigner {
	master: HDKey;
	account: HDKey;
	fingerprint: string;
	descriptor: MultisigKeyDescriptor;
}

function makeSigner(seedByte: number): TestSigner {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return {
		master,
		account,
		fingerprint,
		descriptor: { xpub: account.publicExtendedKey, fingerprint, path: BIP48_PATH }
	};
}

const SIGNERS = [1, 2, 3, 4, 5].map(makeSigner);

/** A signer at an arbitrary account path — for the shared-seed fixtures where
 *  several cosigner keys carry the SAME master fingerprint (cairn-x54). */
function makeAccountSigner(seedByte: number, accountPath: string): TestSigner {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(accountPath);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return {
		master,
		account,
		fingerprint,
		descriptor: { xpub: account.publicExtendedKey, fingerprint, path: accountPath }
	};
}

type TestConfig = MultisigConfig & { scriptType: MultisigScriptType };
function config(threshold: number, count: number, scriptType: MultisigScriptType = 'p2wsh'): TestConfig {
	return { threshold, keys: SIGNERS.slice(0, count).map((s) => s.descriptor), scriptType };
}

const MULTISIG_2OF3 = config(2, 3);
const MULTISIG_3OF5 = config(3, 5);

/** A multisig UTXO at <chain>/<index>, using the config's real derived address. */
function multisigUtxo(
	cfg: TestConfig,
	value: number,
	opts: { chain?: 0 | 1; index?: number; txid?: string; height?: number } = {}
): SpendableUtxo {
	const chain = opts.chain ?? 0;
	const index = opts.index ?? 0;
	return {
		txid: opts.txid ?? '11'.repeat(32),
		vout: 0,
		value,
		height: opts.height ?? 800_000,
		address: deriveMultisigAddress(cfg, chain, index).address,
		chain,
		index
	};
}

// All six standard destination types (P2PKH / P2SH / P2WPKH / P2WSH / P2TR).
const DEST_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const DEST_P2SH = '3P14159f73E4gFr7JterCCQh9QjiTjiZrG';
const DEST_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const DEST_P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const DEST_P2TR = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const RECIPIENT = DEST_P2WPKH;

/**
 * Sign every input with one cosigner, exactly the way a device does: read the
 * input's embedded bip32Derivation, derive the matching child from the
 * signer's ACCOUNT key by the path's trailing <chain>/<index>, sign. Matching
 * is by pubkey so placeholder fingerprints don't matter.
 */
function signWith(psbtBase64: string, signer: TestSigner, onlyInput?: number): string {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
	for (let i = 0; i < tx.inputsLength; i++) {
		if (onlyInput !== undefined && i !== onlyInput) continue;
		const derivs = tx.getInput(i).bip32Derivation ?? [];
		for (const [pubkey, { path }] of derivs) {
			const chain = path[path.length - 2];
			const index = path[path.length - 1];
			const child = signer.account.deriveChild(chain).deriveChild(index);
			if (child.publicKey && bytesToHex(child.publicKey) === bytesToHex(pubkey)) {
				tx.signIdx(child.privateKey!, i);
			}
		}
	}
	return base64.encode(tx.toPSBT());
}

function partialSigCount(psbtBase64: string, inputIdx: number): number {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
	return tx.getInput(inputIdx).partialSig?.length ?? 0;
}

/** A synthetic funding tx with its REAL txid, for nonWitnessUtxo paths. */
function fundingTx(outputs: { address: string; value: number }[]): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

const FEE_RATE = 5;

async function build2of3(overrides: Record<string, unknown> = {}) {
	return constructMultisigPsbt({
		config: MULTISIG_2OF3,
		utxos: [multisigUtxo(MULTISIG_2OF3, 200_000)],
		recipients: [{ address: RECIPIENT, amount: 50_000 }],
		feeRate: FEE_RATE,
		changeIndex: 0,
		...overrides
	});
}

// ── construction ─────────────────────────────────────────────────────────────

describe('constructMultisigPsbt (p2wsh)', () => {
	it('attaches witnessScript, witnessUtxo, RBF sequence, and ALL N key derivations per input', async () => {
		const draft = await build2of3();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBe(1);
		const inp = tx.getInput(0);
		expect(inp.witnessUtxo).toBeDefined();
		expect(inp.witnessScript).toBeDefined();
		expect(inp.redeemScript).toBeUndefined(); // native segwit — no wrapper
		expect(inp.sequence).toBe(RBF_SEQUENCE);

		// Witness script: OP_2 <3 × 33-byte keys> OP_3 OP_CHECKMULTISIG.
		const ws = inp.witnessScript!;
		expect(ws[0]).toBe(0x52);
		expect(ws[ws.length - 2]).toBe(0x53);
		expect(ws[ws.length - 1]).toBe(0xae);

		// One derivation entry per multisig key — this is what lets each device find
		// its key AND what powers per-key signature attribution.
		const derivs = inp.bip32Derivation ?? [];
		expect(derivs).toHaveLength(3);
		const fps = derivs.map(([, d]) => (d.fingerprint >>> 0).toString(16).padStart(8, '0'));
		for (const s of SIGNERS.slice(0, 3)) expect(fps).toContain(s.fingerprint);
		// Full path = account origin + chain + index.
		for (const [, d] of derivs) {
			expect(d.path).toHaveLength(6);
			expect(d.path.slice(4)).toEqual([0, 0]);
		}
	});

	it('derives change on the multisig change chain and marks it with all N derivations + witnessScript', async () => {
		const draft = await build2of3({ changeIndex: 4 });
		expect(draft.change).not.toBeNull();
		expect(draft.change!.index).toBe(4);
		expect(draft.change!.address).toBe(deriveMultisigAddress(MULTISIG_2OF3, 1, 4).address);

		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		let found = false;
		for (let i = 0; i < tx.outputsLength; i++) {
			const out = tx.getOutput(i);
			if ((out.bip32Derivation?.length ?? 0) > 0) {
				found = true;
				expect(out.bip32Derivation).toHaveLength(3);
				expect(out.witnessScript).toBeDefined();
				expect(Number(out.amount)).toBe(draft.change!.value);
				for (const [, d] of out.bip32Derivation!) expect(d.path.slice(4)).toEqual([1, 4]);
			}
		}
		expect(found).toBe(true);
	});

	it('conserves value and prices the fee from the real M-of-N size', async () => {
		const draft = await build2of3();
		const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(draft.amount + draft.fee + (draft.change?.value ?? 0));

		// The formula's per-input size for 2-of-3 p2wsh: 41 + ceil((2 + 2·73 + 1 + 105)/4) = 105 vB.
		expect(multisigInputVsize('p2wsh', 2, 3)).toBe(105);
		expect(draft.vsize).toBe(11 + 105 + 31 + 43); // overhead + input + p2wpkh out + p2wsh change
		expect(draft.fee).toBe(Math.ceil(draft.vsize * FEE_RATE));
	});

	it('pays every standard destination type, including bc1p taproot', async () => {
		const recipients = [
			{ address: DEST_P2PKH, amount: 10_000 },
			{ address: DEST_P2SH, amount: 11_000 },
			{ address: DEST_P2WPKH, amount: 12_000 },
			{ address: DEST_P2WSH, amount: 13_000 },
			{ address: DEST_P2TR, amount: 14_000 }
		];
		const draft = await build2of3({ recipients });
		expect(draft.amount).toBe(60_000);
		const summary = summarizePsbt(draft.psbtBase64);
		for (const r of recipients) {
			expect(summary.outputs).toContainEqual({ address: r.address, value: r.amount });
		}
	});

	it('sweeps everything on send-max with a single recipient and no change', async () => {
		const draft = await build2of3({ recipients: [{ address: DEST_P2TR, amount: 'max' }] });
		expect(draft.change).toBeNull();
		expect(draft.amount).toBe(200_000 - draft.fee);
		const summary = summarizePsbt(draft.psbtBase64);
		expect(summary.outputCount).toBe(1);
		expect(summary.outputs[0]).toEqual({ address: DEST_P2TR, value: draft.amount });
	});

	it('rejects send-max alongside other recipients', async () => {
		await expect(
			build2of3({
				recipients: [
					{ address: RECIPIENT, amount: 'max' },
					{ address: DEST_P2TR, amount: 5_000 }
				]
			})
		).rejects.toMatchObject({ code: 'invalid_amount' });
	});

	it('rejects invalid recipients, fee rates, and unaffordable amounts like psbt.ts does', async () => {
		await expect(
			build2of3({ recipients: [{ address: 'garbage', amount: 1_000 }] })
		).rejects.toMatchObject({ code: 'invalid_recipient' });
		await expect(build2of3({ feeRate: 0 })).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(build2of3({ feeRate: 1001 })).rejects.toMatchObject({ code: 'invalid_amount' });
		await expect(
			build2of3({ recipients: [{ address: RECIPIENT, amount: 999_999_999 }] })
		).rejects.toMatchObject({ code: 'insufficient_funds' });
		await expect(
			build2of3({ utxos: [multisigUtxo(MULTISIG_2OF3, 200_000, { height: 0 })] })
		).rejects.toMatchObject({ code: 'no_utxos' });
	});

	it('restricts selection to the coin-control allowlist', async () => {
		const a = multisigUtxo(MULTISIG_2OF3, 200_000, { txid: 'aa'.repeat(32) });
		const b = multisigUtxo(MULTISIG_2OF3, 300_000, { txid: 'bb'.repeat(32), index: 1 });
		const draft = await build2of3({
			utxos: [a, b],
			onlyUtxos: [{ txid: a.txid, vout: a.vout }]
		});
		expect(draft.inputs).toHaveLength(1);
		expect(draft.inputs[0].txid).toBe(a.txid);
	});

	it('refuses coins whose script does not match the multisig (config/script-type mismatch guard)', async () => {
		const foreign: SpendableUtxo = {
			...multisigUtxo(MULTISIG_2OF3, 200_000),
			address: DEST_P2WSH // a p2wsh address, but not THIS multisig's script
		};
		await expect(build2of3({ utxos: [foreign] })).rejects.toThrow(/does not match this multisig/);
	});
});

// ── network threading (cairn-xqnn7 follow-up) ───────────────────────────────
//
// Same bug as constructPsbt (psbt.ts): constructMultisigPsbt built every
// output via @scure/btc-signer's mainnet-only NETWORK constant, so a
// regtest/testnet multisig's own bcrt1/tb1 receive/change addresses failed
// downstream in Transaction.addOutputAddress even though address derivation
// (deriveMultisigAddress) was already network-aware.
describe('constructMultisigPsbt: network threading (cairn-xqnn7 follow-up)', () => {
	afterEach(() => setDefaultNetwork('mainnet'));

	const b58 = base58check(sha256);
	/** Re-encode a mainnet extended key with different SLIP-132 version bytes
	 *  (mirrors xpub.test.ts's withVersion helper) — key RESOLUTION (resolveKey,
	 *  multisig.ts) validates each cosigner xpub against the configured chain
	 *  backend too, so a regtest multisig config needs regtest-versioned (vpub)
	 *  cosigner keys, not just a regtest address-encoding request. */
	function withVersion(extendedKey: string, version: number): string {
		const raw = new Uint8Array(b58.decode(extendedKey));
		raw[0] = (version >>> 24) & 0xff;
		raw[1] = (version >>> 16) & 0xff;
		raw[2] = (version >>> 8) & 0xff;
		raw[3] = version & 0xff;
		return b58.encode(raw);
	}
	const REGTEST_MULTISIG_2OF3: TestConfig = {
		threshold: 2,
		keys: MULTISIG_2OF3.keys.map((k) => ({ ...k, xpub: withVersion(k.xpub, 0x045f1cf6) })),
		scriptType: 'p2wsh'
	};

	it('builds a regtest multisig PSBT with bcrt1 inputs/outputs under a regtest chain backend (no explicit network param)', async () => {
		setDefaultNetwork('regtest');
		const receive0 = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 0, 0).address;
		const change0 = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 1, 0).address;
		const recipient = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 0, 1).address;
		expect(receive0.startsWith('bcrt1q')).toBe(true);
		expect(change0.startsWith('bcrt1q')).toBe(true);

		const utxo: SpendableUtxo = {
			txid: '11'.repeat(32),
			vout: 0,
			value: 200_000,
			height: 800_000,
			address: receive0,
			chain: 0,
			index: 0
		};
		const draft = await constructMultisigPsbt({
			config: REGTEST_MULTISIG_2OF3,
			utxos: [utxo],
			recipients: [{ address: recipient, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		expect(draft.recipient).toBe(recipient);
		expect(draft.change?.address).toBe(change0);

		const summary = summarizePsbt(draft.psbtBase64, 2);
		expect(summary.outputs.some((o) => o.address === recipient)).toBe(true);
		expect(summary.outputs.some((o) => o.address === change0)).toBe(true);
	});

	it('an explicit params.network="regtest" builds bcrt1 outputs when the chain backend is also regtest', async () => {
		setDefaultNetwork('regtest');
		const receive0 = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 0, 0, 'regtest').address;
		const change0 = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 1, 0, 'regtest').address;
		const recipient = deriveMultisigAddress(REGTEST_MULTISIG_2OF3, 0, 1, 'regtest').address;

		const utxo: SpendableUtxo = {
			txid: '11'.repeat(32),
			vout: 0,
			value: 200_000,
			height: 800_000,
			address: receive0,
			chain: 0,
			index: 0
		};
		const draft = await constructMultisigPsbt({
			config: REGTEST_MULTISIG_2OF3,
			utxos: [utxo],
			recipients: [{ address: recipient, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0,
			network: 'regtest'
		});
		expect(draft.recipient.startsWith('bcrt1')).toBe(true);
		expect(draft.change?.address.startsWith('bcrt1')).toBe(true);
	});

	it('mainnet multisig construction is unchanged: bc1 recipient/change, network omitted', async () => {
		const draft = await build2of3({});
		expect(draft.recipient.startsWith('bc1')).toBe(true);
		expect(draft.change?.address.startsWith('bc1')).toBe(true);
	});
});

describe('unconfirmed coin selection (cairn-u9ob.1)', () => {
	it('auto-spends unconfirmed own-change but never an unconfirmed received coin', async () => {
		const ownChange: SpendableUtxo = {
			...multisigUtxo(MULTISIG_2OF3, 200_000, { txid: 'dd'.repeat(32), chain: 1, index: 0, height: 0 }),
			unconfirmedTrust: 'own-change'
		};
		const draft = await build2of3({ utxos: [ownChange] });
		expect(draft.inputs[0].txid).toBe(ownChange.txid);

		const received: SpendableUtxo = {
			...multisigUtxo(MULTISIG_2OF3, 200_000, { txid: 'ee'.repeat(32), height: 0 }),
			unconfirmedTrust: 'received'
		};
		await expect(build2of3({ utxos: [received] })).rejects.toMatchObject({ code: 'no_utxos' });
	});

	it('spends a received unconfirmed coin only when the user picks it via coin control', async () => {
		const received: SpendableUtxo = {
			...multisigUtxo(MULTISIG_2OF3, 200_000, { txid: 'ff'.repeat(32), height: 0 }),
			unconfirmedTrust: 'received'
		};
		const draft = await build2of3({
			utxos: [received],
			onlyUtxos: [{ txid: received.txid, vout: received.vout }]
		});
		expect(draft.inputs[0].txid).toBe(received.txid);
	});
});

// ── sign → combine → progress → finalize ────────────────────────────────────

describe('multisig signing lifecycle (2-of-3 p2wsh)', () => {
	it('walks 0 → 1 → 2 signatures with correct progress at every step, then finalizes', async () => {
		const draft = await build2of3();

		const p0 = multisigPsbtProgress(draft.psbtBase64, 2);
		expect(p0).toMatchObject({ required: 2, collected: 0, complete: false, inputCount: 1 });
		expect(p0.signedFingerprints).toEqual([]);
		expect(p0.remainingFingerprints.sort()).toEqual(
			SIGNERS.slice(0, 3)
				.map((s) => s.fingerprint)
				.sort()
		);

		// Key 1 signs — 1 of 2, not complete, attributed by fingerprint.
		const signed1 = signWith(draft.psbtBase64, SIGNERS[0]);
		const combined1 = combineMultisigPsbts(draft.psbtBase64, signed1);
		const p1 = multisigPsbtProgress(combined1, 2);
		expect(p1.collected).toBe(1);
		expect(p1.complete).toBe(false);
		expect(p1.signedFingerprints).toEqual([SIGNERS[0].fingerprint]);
		expect(p1.remainingFingerprints).toContain(SIGNERS[1].fingerprint);
		expect(p1.remainingFingerprints).toContain(SIGNERS[2].fingerprint);
		// Per-key attribution by pubkey: exactly key 1's origin is signed.
		expect(p1.keys).toHaveLength(3);
		expect(p1.keys.filter((k) => k.signed)).toEqual([
			{ fingerprint: SIGNERS[0].fingerprint, path: BIP48_PATH, signed: true }
		]);

		// 1-of-2 does NOT finalize (quorum enforcement).
		expect(() => finalizeMultisigPsbt(combined1)).toThrow(MultisigPsbtError);
		expect(() => finalizeMultisigPsbt(combined1)).toThrow(/enough signatures/);

		// Key 2 signs the CURRENT combined PSBT (adding to prior signatures).
		const signed2 = signWith(combined1, SIGNERS[1]);
		const combined2 = combineMultisigPsbts(combined1, signed2);
		const p2 = multisigPsbtProgress(combined2, 2);
		expect(p2.collected).toBe(2);
		expect(p2.complete).toBe(true);
		expect(p2.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint].sort()
		);

		// Finalize + extract: the raw transaction parses and carries the witness.
		const { rawHex, txid, vsize } = finalizeMultisigPsbt(combined2);
		const parsed = Transaction.fromRaw(hexToBytes(rawHex), {
			allowUnknownInputs: true,
			allowUnknownOutputs: true,
			disableScriptCheck: true
		});
		expect(parsed.id).toBe(txid);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
		// Conservative estimate: the real vsize never exceeds it, so the real
		// fee rate never drops below what was requested.
		expect(vsize).toBeLessThanOrEqual(draft.vsize);
		expect(draft.fee / vsize).toBeGreaterThanOrEqual(FEE_RATE);
	});

	it('also completes when both signers work from the SAME unsigned PSBT in parallel', async () => {
		const draft = await build2of3();
		const signedA = signWith(draft.psbtBase64, SIGNERS[0]);
		const signedB = signWith(draft.psbtBase64, SIGNERS[2]); // key 3 instead of key 2
		let combined = combineMultisigPsbts(draft.psbtBase64, signedA);
		combined = combineMultisigPsbts(combined, signedB);
		expect(multisigPsbtProgress(combined, 2)).toMatchObject({ collected: 2, complete: true });
		expect(() => finalizeMultisigPsbt(combined)).not.toThrow();
	});

	it('reports the MINIMUM per-input signature count on multi-input spends', async () => {
		const utxos = [
			multisigUtxo(MULTISIG_2OF3, 100_000, { txid: 'aa'.repeat(32), index: 0 }),
			multisigUtxo(MULTISIG_2OF3, 100_000, { txid: 'bb'.repeat(32), index: 1 })
		];
		const draft = await build2of3({ utxos, recipients: [{ address: RECIPIENT, amount: 150_000 }] });
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		expect(tx.inputsLength).toBe(2);

		// Key 1 signs both inputs; key 2 signs only input 0 — the transaction is
		// only as signed as its least-signed input.
		let psbt = signWith(draft.psbtBase64, SIGNERS[0]);
		psbt = signWith(psbt, SIGNERS[1], 0);
		const p = multisigPsbtProgress(psbt, 2);
		expect(p.inputCount).toBe(2);
		expect(p.collected).toBe(1);
		expect(p.complete).toBe(false);
	});

	it('forces collected ≥ required once finalized, even with attribution stripped', async () => {
		const draft = await build2of3();
		let combined = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		combined = combineMultisigPsbts(combined, signWith(combined, SIGNERS[1]));

		// Simulate a signer that finalized before returning: partialSig stripped,
		// only the final witness remains.
		const tx = Transaction.fromPSBT(base64.decode(combined));
		tx.finalize();
		const finalized = base64.encode(tx.toPSBT());

		const p = multisigPsbtProgress(finalized, 2);
		expect(p.complete).toBe(true);
		expect(p.collected).toBeGreaterThanOrEqual(2); // never "1 of 2" on a complete tx
	});

	it('still attributes earlier signers when the last signer\'s tool finalizes (cairn-8y3b)', async () => {
		// The 2026-07-06 quorum-matrix repro: a cosigner tool (Bitcoin Core
		// descriptorprocesspsbt, and many others) FINALIZES the PSBT as it adds the
		// quorum-completing signature, stripping only its own partialSig into the
		// witness. Earlier signers' partialSigs survive on the combined PSBT, so
		// progress must still attribute them — not report "0 of N signed" at the
		// exact moment the transaction became complete.
		const draft = await build2of3();
		const combinedA = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));

		// Signer 1's tool: takes the combined PSBT, adds its signature, finalizes.
		const bWork = combineMultisigPsbts(combinedA, signWith(combinedA, SIGNERS[1]));
		const bTx = Transaction.fromPSBT(base64.decode(bWork));
		bTx.finalize();
		const bFinalized = base64.encode(bTx.toPSBT());

		const result = combineMultisigPsbts(combinedA, bFinalized);
		// The earlier signer's partialSig survives the combine (sanity check).
		expect(partialSigCount(result, 0)).toBe(1);

		const p = multisigPsbtProgress(result, 2);
		expect(p.complete).toBe(true);
		expect(p.collected).toBe(2); // a complete tx is fully signed
		// Signer 0 (whose partialSig survived) IS attributed — no longer "0 of 2".
		expect(p.signedFingerprints).toEqual([SIGNERS[0].fingerprint]);
		expect(p.keys.find((k) => k.fingerprint === SIGNERS[0].fingerprint)?.signed).toBe(true);
		// Signer 1 (the finalizer) is the only unattributable one — its signature
		// now lives in the witness, not in a partialSig entry.
		expect(p.keys.find((k) => k.fingerprint === SIGNERS[1].fingerprint)?.signed).toBe(false);
	});

	it('excludes the 00000000 placeholder fingerprint from attribution but still counts its signature', async () => {
		const cfg: TestConfig = {
			threshold: 2,
			scriptType: 'p2wsh',
			keys: [
				SIGNERS[0].descriptor,
				{ ...SIGNERS[1].descriptor, fingerprint: '00000000' },
				SIGNERS[2].descriptor
			]
		};
		const draft = await constructMultisigPsbt({
			config: cfg,
			utxos: [multisigUtxo(cfg, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		const signed = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[1]));
		const p = multisigPsbtProgress(signed, 2);
		expect(p.collected).toBe(1); // the signature counts toward quorum…
		expect(p.signedFingerprints).toEqual([]); // …but cannot be attributed
		expect(p.remainingFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[2].fingerprint].sort()
		);
		// The per-key view CAN attribute it — the pubkey match is exact, and the
		// placeholder key's origin path still identifies it.
		expect(p.keys.filter((k) => k.signed)).toEqual([
			{ fingerprint: '00000000', path: BIP48_PATH, signed: true }
		]);
	});
});

// ── per-key attribution when fingerprints collide (cairn-x54) ────────────────
//
// Three cosigner keys derived from ONE master seed at different BIP-48
// accounts: all share the master fingerprint, so fingerprint-based attribution
// is inherently blind here — after ONE signature it marks every key signed,
// which is exactly the bug that wedged the signing stepper. Only the
// per-pubkey `keys` attribution can say who actually signed.

describe('per-key attribution with a shared master fingerprint (cairn-x54)', () => {
	const ACCOUNT_PATHS = ["m/48'/0'/0'/2'", "m/48'/0'/1'/2'", "m/48'/0'/2'/2'"];
	const SHARED = ACCOUNT_PATHS.map((p) => makeAccountSigner(7, p));
	const CFG: TestConfig = {
		threshold: 2,
		scriptType: 'p2wsh',
		keys: SHARED.map((s) => s.descriptor)
	};

	async function buildShared() {
		return constructMultisigPsbt({
			config: CFG,
			utxos: [multisigUtxo(CFG, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
	}

	it('attributes a signature to exactly the key that made it — not every key sharing the fingerprint', async () => {
		expect(new Set(SHARED.map((s) => s.fingerprint)).size).toBe(1); // the collision is real

		const draft = await buildShared();
		const combined = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SHARED[0]));
		const p = multisigPsbtProgress(combined, 2);

		// The counts were never wrong — 1 of 2 — and still aren't.
		expect(p.collected).toBe(1);
		expect(p.complete).toBe(false);

		// The legacy fingerprint view is blind here (kept for aggregate/legacy
		// consumers): one shared fingerprint, reported wholesale as signed.
		expect(p.signedFingerprints).toEqual([SHARED[0].fingerprint]);
		expect(p.remainingFingerprints).toEqual([]);

		// The per-key view is not: exactly key 1's origin signed, keys 2/3 not.
		expect(p.keys).toHaveLength(3);
		expect(p.keys.filter((k) => k.signed)).toEqual([
			{ fingerprint: SHARED[0].fingerprint, path: ACCOUNT_PATHS[0], signed: true }
		]);
		expect(
			p.keys
				.filter((k) => !k.signed)
				.map((k) => k.path)
				.sort()
		).toEqual([ACCOUNT_PATHS[1], ACCOUNT_PATHS[2]].sort());

		// Next-signer math — what the UI stepper derives its queue from: mapping
		// the roster against the signed (fingerprint, path) identities leaves
		// keys 2 and 3 unsigned, so a REAL next key exists and the "sign with
		// key 2" panel has something to render.
		const signedIds = new Set(
			p.keys.filter((k) => k.signed).map((k) => `${k.fingerprint}|${k.path}`)
		);
		const nextSigners = CFG.keys.filter(
			(k) => !signedIds.has(`${k.fingerprint.toLowerCase()}|${k.path}`)
		);
		expect(nextSigners).toHaveLength(2);
		expect(nextSigners[0].path).toBe(ACCOUNT_PATHS[1]);
	});

	it('completes the quorum through key 2 and attributes both signers', async () => {
		const draft = await buildShared();
		let combined = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SHARED[0]));
		combined = combineMultisigPsbts(combined, signWith(combined, SHARED[1]));
		const p = multisigPsbtProgress(combined, 2);
		expect(p.collected).toBe(2);
		expect(p.complete).toBe(true);
		expect(
			p.keys
				.filter((k) => k.signed)
				.map((k) => k.path)
				.sort()
		).toEqual([ACCOUNT_PATHS[0], ACCOUNT_PATHS[1]].sort());
		expect(() => finalizeMultisigPsbt(combined)).not.toThrow();
	});

	it('never fabricates attribution once finalization strips per-input data', async () => {
		const draft = await buildShared();
		let combined = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SHARED[0]));
		combined = combineMultisigPsbts(combined, signWith(combined, SHARED[1]));
		const tx = Transaction.fromPSBT(base64.decode(combined));
		tx.finalize();
		const p = multisigPsbtProgress(base64.encode(tx.toPSBT()), 2);
		expect(p.complete).toBe(true);
		expect(p.collected).toBeGreaterThanOrEqual(2);
		// Attribution is unknowable now — no key may be (falsely) marked signed.
		// The UI renders the quorum-met state from `complete` instead.
		expect(p.keys.every((k) => !k.signed)).toBe(true);
	});
});

describe('combineMultisigPsbts', () => {
	it('is idempotent for already-present signatures (re-submission is harmless)', async () => {
		const draft = await build2of3();
		const signed1 = signWith(draft.psbtBase64, SIGNERS[0]);
		const once = combineMultisigPsbts(draft.psbtBase64, signed1);
		const twice = combineMultisigPsbts(once, signed1);
		expect(partialSigCount(once, 0)).toBe(1);
		expect(partialSigCount(twice, 0)).toBe(1);
		expect(multisigPsbtProgress(twice, 2).collected).toBe(1);
	});

	it('tolerates a re-sign with a different nonce from an already-counted key', async () => {
		const draft = await build2of3();
		const once = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		// The same key signs the ORIGINAL unsigned PSBT again — same pubkey,
		// (potentially) different signature bytes. Must not throw or double-count.
		const again = signWith(draft.psbtBase64, SIGNERS[0]);
		const combined = combineMultisigPsbts(once, again);
		expect(partialSigCount(combined, 0)).toBe(1);
	});

	it('rejects a PSBT for a DIFFERENT transaction with a clear error', async () => {
		const a = await build2of3();
		const b = await build2of3({ recipients: [{ address: RECIPIENT, amount: 51_000 }] });
		expect(() => combineMultisigPsbts(a.psbtBase64, signWith(b.psbtBase64, SIGNERS[0]))).toThrow(
			MultisigPsbtError
		);
		try {
			combineMultisigPsbts(a.psbtBase64, b.psbtBase64);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
		}
	});

	it("rejects a signature from a key that isn't part of the multisig", async () => {
		const draft = await build2of3();
		// Borrow REAL signature bytes (structurally valid DER) and attach them
		// under a pubkey from outside the multisig — signer 4 of 5.
		const signed = Transaction.fromPSBT(base64.decode(signWith(draft.psbtBase64, SIGNERS[0])));
		const sigBytes = signed.getInput(0).partialSig![0][1];
		const foreignPubkey = SIGNERS[3].account.deriveChild(0).deriveChild(0).publicKey!;

		const tampered = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		tampered.updateInput(0, { partialSig: [[foreignPubkey, sigBytes]] }, true);
		const tamperedB64 = base64.encode(tampered.toPSBT());

		expect(() => combineMultisigPsbts(draft.psbtBase64, tamperedB64)).toThrow(
			/isn't one of this multisig's keys/
		);
		try {
			combineMultisigPsbts(draft.psbtBase64, tamperedB64);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('foreign_signature');
		}
	});

	// A device's signature is DER bytes + a trailing sighash-flag byte. Cairn must
	// only ever combine SIGHASH_ALL (0x01) signatures — anything else commits to
	// less than the whole tx and could be replayed onto another transaction
	// spending the same input (cairn-srte).
	/** Re-flag input 0's (real, membership-valid) signature with a non-ALL sighash. */
	async function draftWithSighash(flag: number): Promise<{ draft: string; tampered: string }> {
		const draft = await build2of3();
		const signed = Transaction.fromPSBT(base64.decode(signWith(draft.psbtBase64, SIGNERS[0])));
		const [pubkey, sig] = signed.getInput(0).partialSig![0];
		const reflagged = new Uint8Array(sig);
		reflagged[reflagged.length - 1] = flag; // swap only the trailing sighash byte

		const tampered = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		tampered.updateInput(0, { partialSig: [[pubkey, reflagged]] }, true);
		return { draft: draft.psbtBase64, tampered: base64.encode(tampered.toPSBT()) };
	}

	it.each([
		['SIGHASH_NONE', 0x02],
		['SIGHASH_SINGLE', 0x03],
		['SIGHASH_ALL|ANYONECANPAY', 0x81],
		['SIGHASH_SINGLE|ANYONECANPAY', 0x83]
	])('rejects a %s signature during combine', async (_label, flag) => {
		const { draft, tampered } = await draftWithSighash(flag);
		try {
			combineMultisigPsbts(draft, tampered);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('wrong_sighash');
		}
	});

	it('accepts a normal SIGHASH_ALL signature (the default) unchanged', async () => {
		const draft = await build2of3();
		const signed = signWith(draft.psbtBase64, SIGNERS[0]);
		// Sanity-check the fixture: btc-signer's default trailing byte IS 0x01.
		const tx = Transaction.fromPSBT(base64.decode(signed));
		const sig = tx.getInput(0).partialSig![0][1];
		expect(sig[sig.length - 1]).toBe(0x01);
		expect(partialSigCount(combineMultisigPsbts(draft.psbtBase64, signed), 0)).toBe(1);
	});
});

// ── finalization-adoption guard on the combine path (cairn-vo6z) ─────────────
//
// combineMultisigPsbts used to copy an incoming finalScriptWitness /
// finalScriptSig verbatim whenever the base input wasn't yet finalized. Since
// assertSameTransaction only pins the unsigned inputs/outputs (never the
// witness), a cosigner could attach GARBAGE finalization — zero real signatures
// — that durably marked a shared draft ready-to-broadcast while the network
// rejects it, and honest signers couldn't recover: an availability DoS on shared
// funds that also contradicted MANUAL §18.9's "tampered PSBT rejected" claim.
describe('combineMultisigPsbts finalization guard (cairn-vo6z)', () => {
	/** Reproduce a LEGITIMATE finalized cosigner PSBT: signer B takes the combined
	 *  PSBT, adds its signature, and finalizes (stripping partialSig into a real
	 *  witness) — exactly the Bitcoin-Core-style flow cairn-8y3b pins. */
	async function legitFinalized() {
		const draft = await build2of3();
		const combinedA = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		const bWork = combineMultisigPsbts(combinedA, signWith(combinedA, SIGNERS[1]));
		const bTx = Transaction.fromPSBT(base64.decode(bWork));
		bTx.finalize();
		return { draft, combinedA, bFinalized: base64.encode(bTx.toPSBT()) };
	}

	/** Rebuild `finalizedB64` with input 0's witness stack mutated in place. */
	function withWitness(finalizedB64: string, mutate: (w: Uint8Array[]) => void): string {
		const tx = Transaction.fromPSBT(base64.decode(finalizedB64));
		const w = (tx.getInput(0).finalScriptWitness ?? []).map((x) => new Uint8Array(x));
		mutate(w);
		tx.updateInput(0, { finalScriptWitness: w }, true);
		return base64.encode(tx.toPSBT());
	}

	it('adopts a LEGITIMATE finalized cosigner PSBT unchanged (flow unaffected)', async () => {
		const { combinedA, bFinalized } = await legitFinalized();
		const result = combineMultisigPsbts(combinedA, bFinalized);
		// Earlier signer's partialSig survives; the transaction reads complete and
		// finalizes for broadcast.
		expect(partialSigCount(result, 0)).toBe(1);
		expect(multisigPsbtProgress(result, 2)).toMatchObject({ complete: true });
		expect(() => finalizeMultisigPsbt(result)).not.toThrow();
	});

	it('rejects GARBAGE finalization attached to an unsigned draft (the DoS)', async () => {
		const draft = await build2of3();
		// A witness shaped like a CHECKMULTISIG spend but carrying no real data —
		// zero valid signatures, wrong trailing script.
		const tampered = withWitness(draft.psbtBase64, (w) => {
			w.length = 0;
			w.push(new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array([9, 9, 9, 9]));
		});
		try {
			combineMultisigPsbts(draft.psbtBase64, tampered);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('invalid_finalization');
		}
	});

	it("rejects a finalization whose trailing witnessScript isn't this multisig's", async () => {
		const { combinedA, bFinalized } = await legitFinalized();
		// Flip a byte inside the trailing witnessScript element: real signatures,
		// but bound to a script this multisig never produced.
		const tampered = withWitness(bFinalized, (w) => {
			const script = w[w.length - 1];
			script[script.length - 1] ^= 0xff;
		});
		try {
			combineMultisigPsbts(combinedA, tampered);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('invalid_finalization');
		}
	});

	it('rejects a finalization whose signatures are re-flagged to a non-ALL sighash', async () => {
		const { combinedA, bFinalized } = await legitFinalized();
		// Re-flag the DER signatures (all but the leading dummy and trailing script)
		// from SIGHASH_ALL to SIGHASH_SINGLE.
		const tampered = withWitness(bFinalized, (w) => {
			for (let i = 1; i < w.length - 1; i++) {
				const sig = w[i];
				if (sig.length > 0) sig[sig.length - 1] = 0x03;
			}
		});
		try {
			combineMultisigPsbts(combinedA, tampered);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('invalid_finalization');
		}
	});

	it('rejects a finalization with the correct script but the signatures blanked out', async () => {
		const { combinedA, bFinalized } = await legitFinalized();
		const tampered = withWitness(bFinalized, (w) => {
			for (let i = 1; i < w.length - 1; i++) w[i] = new Uint8Array(0);
		});
		try {
			combineMultisigPsbts(combinedA, tampered);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('invalid_finalization');
		}
	});

	// Sibling entry point: broadcastStatelessPsbt finalizes a client-submitted PSBT
	// directly via finalizeMultisigPsbt, NOT through the validated combine — so the
	// finalize path must re-validate any finalization present when the input still
	// carries this multisig's witnessScript.
	it('finalizeMultisigPsbt rejects a directly-submitted tampered finalization', async () => {
		const { combinedA, bFinalized } = await legitFinalized();
		// A validly-combined (thus witnessScript-retaining) finalized PSBT…
		const good = combineMultisigPsbts(combinedA, bFinalized);
		expect(() => finalizeMultisigPsbt(good)).not.toThrow(); // control: legit broadcast

		// …with its trailing witnessScript element corrupted must be refused here too.
		const tampered = withWitness(good, (w) => {
			const script = w[w.length - 1];
			script[script.length - 1] ^= 0xff;
		});
		try {
			finalizeMultisigPsbt(tampered);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('invalid_finalization');
		}
	});
});

// ── PSBT-substitution guard on the multisig combine path (cairn-sera) ────────
//
// Pins the cairn-973 fix (assertSameTransaction wired into combineMultisigPsbts):
// a co-signer — or a compromised coordinator between two co-signers — must not
// be able to swap in a signed PSBT for a DIFFERENT transaction built from the
// same coins. psbt.test.ts covers the single-sig guard; this is the multisig
// combine path, where the substituted PSBT arrives carrying a real cosigner
// signature and would otherwise be merged toward quorum and broadcast.

describe('multisig PSBT substitution guard (cairn-sera)', () => {
	const OTHER_RECIPIENT = DEST_P2WSH;

	it('rejects combining draft A with a co-signed PSBT that pays a DIFFERENT RECIPIENT from the same coins', async () => {
		// Same UTXO set, same amount and fee — only the destination differs.
		const a = await build2of3({ recipients: [{ address: RECIPIENT, amount: 50_000 }] });
		const b = await build2of3({ recipients: [{ address: OTHER_RECIPIENT, amount: 50_000 }] });
		expect(a.inputs).toEqual(b.inputs); // the substitution is input-identical

		const signedB = signWith(b.psbtBase64, SIGNERS[0]);
		expect(() => combineMultisigPsbts(a.psbtBase64, signedB)).toThrow(MultisigPsbtError);
		try {
			combineMultisigPsbts(a.psbtBase64, signedB);
			expect.unreachable();
		} catch (e) {
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
			expect((e as MultisigPsbtError).message).toMatch(/different outputs/);
		}
	});

	it('rejects combining draft A with a co-signed PSBT that pays a DIFFERENT AMOUNT to the same recipient', async () => {
		const a = await build2of3({ recipients: [{ address: RECIPIENT, amount: 50_000 }] });
		const b = await build2of3({ recipients: [{ address: RECIPIENT, amount: 150_000 }] });

		const signedB = signWith(b.psbtBase64, SIGNERS[1]);
		try {
			combineMultisigPsbts(a.psbtBase64, signedB);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigPsbtError);
			expect((e as MultisigPsbtError).code).toBe('different_transaction');
		}
	});

	it('does NOT trip on a properly co-signed copy of the SAME draft (signatures only)', async () => {
		const draft = await build2of3({ recipients: [{ address: RECIPIENT, amount: 50_000 }] });
		// Two cosigners sign the identical transaction independently — combining
		// each back into the draft must succeed and reach quorum.
		const signedA = signWith(draft.psbtBase64, SIGNERS[0]);
		const signedB = signWith(draft.psbtBase64, SIGNERS[1]);
		let combined!: string;
		expect(() => {
			combined = combineMultisigPsbts(draft.psbtBase64, signedA);
			combined = combineMultisigPsbts(combined, signedB);
		}).not.toThrow();
		expect(multisigPsbtProgress(combined, 2)).toMatchObject({ collected: 2, complete: true });
	});
});

// ── quorum matrix ────────────────────────────────────────────────────────────

describe('quorum enforcement (3-of-5 p2wsh)', () => {
	async function build3of5() {
		return constructMultisigPsbt({
			config: MULTISIG_3OF5,
			utxos: [multisigUtxo(MULTISIG_3OF5, 500_000)],
			recipients: [{ address: RECIPIENT, amount: 100_000 }],
			feeRate: FEE_RATE,
			changeIndex: 2
		});
	}

	it('needs exactly 3 signatures: 2 refuse to finalize, 3 finalize and extract', async () => {
		const draft = await build3of5();
		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[2]));

		expect(multisigPsbtProgress(psbt, 3)).toMatchObject({ collected: 2, complete: false });
		expect(() => finalizeMultisigPsbt(psbt)).toThrow(MultisigPsbtError);

		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[4]));
		const p = multisigPsbtProgress(psbt, 3);
		expect(p).toMatchObject({ collected: 3, complete: true });
		expect(p.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[2].fingerprint, SIGNERS[4].fingerprint].sort()
		);

		const { rawHex, txid } = finalizeMultisigPsbt(psbt);
		expect(Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, disableScriptCheck: true }).id).toBe(txid);
	});

	it('per-input size grows with the quorum and key count as the formula says', () => {
		// 3-of-5: 41 + ceil((2 + 3·73 + 1 + 173)/4) = 41 + 99 = 140 vB per input.
		expect(multisigInputVsize('p2wsh', 3, 5)).toBe(140);
		// A 15-of-15 witness script exceeds 252 bytes → 3-byte varint kicks in.
		expect(multisigInputVsize('p2wsh', 15, 15)).toBe(41 + Math.ceil((2 + 15 * 73 + 3 + 513) / 4));
	});
});

// ── exact-input reconstruction (RBF replacement) ─────────────────────────────
describe('constructMultisigPsbt exactInputs (RBF replacement)', () => {
	it('spends EVERY provided coin even when fewer would fund the send, taking the fee from change', async () => {
		const cfg = MULTISIG_2OF3;
		// Two coins; either alone would cover the 50k send — the greedy path would
		// stop at one. exactInputs must use both (an RBF replacement conflicts with
		// the original on every input).
		const utxos = [
			multisigUtxo(cfg, 200_000, { txid: 'a1'.repeat(32) }),
			multisigUtxo(cfg, 180_000, { txid: 'b2'.repeat(32) })
		];
		const draft = await constructMultisigPsbt({
			config: cfg,
			utxos,
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 20,
			changeIndex: 0,
			exactInputs: true
		});
		expect(draft.inputs).toHaveLength(2);
		const built = new Set(draft.inputs.map((i) => `${i.txid}:${i.vout}`));
		expect(built.has(`${'a1'.repeat(32)}:0`)).toBe(true);
		expect(built.has(`${'b2'.repeat(32)}:0`)).toBe(true);
		// Change absorbs the fee: in + change + fee balance to the send amount.
		expect(draft.change).not.toBeNull();
		expect(draft.change!.value + draft.amount + draft.fee).toBe(380_000);
	});

	it('refuses when the change output cannot absorb the fee at the target rate', async () => {
		const cfg = MULTISIG_2OF3;
		// Almost all of the input goes to the recipient — no room for a higher fee.
		const utxos = [multisigUtxo(cfg, 60_000)];
		await expect(
			constructMultisigPsbt({
				config: cfg,
				utxos,
				recipients: [{ address: RECIPIENT, amount: 59_000 }],
				feeRate: 50,
				changeIndex: 0,
				exactInputs: true
			})
		).rejects.toThrow(PsbtError);
	});
});

// ── quorum boundaries: M = 1 and M = N (unanimous) ───────────────────────────
// Every other lifecycle test uses a strict 1 < M < N config (2-of-3, 3-of-5).
// Off-by-one threshold bugs in signature counting/finalization live exactly at
// these edges, so exercise them explicitly (cairn-6zo7).
describe('quorum boundary: 1-of-N (single signature suffices)', () => {
	const CFG_1OF3 = config(1, 3);

	async function build1of3() {
		return constructMultisigPsbt({
			config: CFG_1OF3,
			utxos: [multisigUtxo(CFG_1OF3, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
	}

	it('is not complete with zero signatures and refuses to finalize', async () => {
		const draft = await build1of3();
		const p = multisigPsbtProgress(draft.psbtBase64, 1);
		expect(p).toMatchObject({ required: 1, collected: 0, complete: false });
		expect(() => finalizeMultisigPsbt(draft.psbtBase64)).toThrow(MultisigPsbtError);
	});

	it('completes and finalizes on the FIRST signature, from any single cosigner', async () => {
		const draft = await build1of3();
		// The third key alone must satisfy a 1-of-3 — not just the first.
		const signed = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[2]));
		const p = multisigPsbtProgress(signed, 1);
		expect(p).toMatchObject({ required: 1, collected: 1, complete: true });
		expect(p.signedFingerprints).toEqual([SIGNERS[2].fingerprint]);

		const { rawHex, txid } = finalizeMultisigPsbt(signed);
		expect(
			Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, disableScriptCheck: true }).id
		).toBe(txid);
	});
});

describe('quorum boundary: N-of-N (unanimous)', () => {
	const CFG_2OF2 = config(2, 2);
	const CFG_3OF3 = config(3, 3);

	it('2-of-2: needs BOTH signatures — one is not enough', async () => {
		const draft = await constructMultisigPsbt({
			config: CFG_2OF2,
			utxos: [multisigUtxo(CFG_2OF2, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		const one = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		expect(multisigPsbtProgress(one, 2)).toMatchObject({ collected: 1, complete: false });
		expect(() => finalizeMultisigPsbt(one)).toThrow(MultisigPsbtError);

		const both = combineMultisigPsbts(one, signWith(one, SIGNERS[1]));
		const p = multisigPsbtProgress(both, 2);
		expect(p).toMatchObject({ collected: 2, complete: true });
		expect(p.remainingFingerprints).toEqual([]);
		expect(() => finalizeMultisigPsbt(both)).not.toThrow();
	});

	it('3-of-3: only the third signature completes the quorum', async () => {
		const draft = await constructMultisigPsbt({
			config: CFG_3OF3,
			utxos: [multisigUtxo(CFG_3OF3, 300_000)],
			recipients: [{ address: RECIPIENT, amount: 100_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		expect(multisigPsbtProgress(psbt, 3)).toMatchObject({ collected: 1, complete: false });
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[1]));
		expect(multisigPsbtProgress(psbt, 3)).toMatchObject({ collected: 2, complete: false });
		expect(() => finalizeMultisigPsbt(psbt)).toThrow(MultisigPsbtError);

		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[2]));
		const p = multisigPsbtProgress(psbt, 3);
		expect(p).toMatchObject({ collected: 3, complete: true });
		expect(p.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint, SIGNERS[2].fingerprint].sort()
		);
		const { txid } = finalizeMultisigPsbt(psbt);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});
});

// ── summarizePsbt threshold-awareness (qa-findings-R3.md ~line 228) ────────
// Regression coverage for the finding: summarizePsbt's `complete` flag used to
// count ANY signature material per input as "signed" — correct for single-sig
// but wrong for multisig, so a 2-of-2 wallet with only ONE signature attached
// reported `summary.complete: true` (1 input, 1 signature present === all
// inputs signed) in the SAME API response where the quorum-aware `progress`
// object correctly said `complete: false`. Pins `summarizePsbt`'s `threshold`
// parameter keeps the two objects in agreement at every step.
describe('summarizePsbt — threshold-aware complete flag', () => {
	const CFG_2OF2 = config(2, 2);

	it('2-of-2: ONE signature is reported incomplete (the exact regression scenario)', async () => {
		const draft = await constructMultisigPsbt({
			config: CFG_2OF2,
			utxos: [multisigUtxo(CFG_2OF2, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		const oneSigned = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));

		// Without a threshold, summarizePsbt still (wrongly, for multisig) treats
		// "any signature at all" as complete — this is the pre-fix bug reproduced,
		// confirming the default really is single-sig semantics, not a no-op.
		expect(summarizePsbt(oneSigned).complete).toBe(true);

		// Threshold-aware: agrees with the quorum-aware progress object.
		const summary = summarizePsbt(oneSigned, CFG_2OF2.threshold);
		const progress = multisigPsbtProgress(oneSigned, CFG_2OF2.threshold);
		expect(summary.complete).toBe(false);
		expect(summary.complete).toBe(progress.complete);
		expect(summary.signedInputs).toBe(1); // "at least one signature" semantics preserved
	});

	it('2-of-2: BOTH signatures are reported complete, agreeing with progress', async () => {
		const draft = await constructMultisigPsbt({
			config: CFG_2OF2,
			utxos: [multisigUtxo(CFG_2OF2, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[1]));

		const summary = summarizePsbt(psbt, CFG_2OF2.threshold);
		const progress = multisigPsbtProgress(psbt, CFG_2OF2.threshold);
		expect(summary.complete).toBe(true);
		expect(progress.complete).toBe(true);
		expect(() => finalizeMultisigPsbt(psbt)).not.toThrow();
	});

	it('2-of-3: every partial state (0, 1, 2 of 3 cosigners) agrees with the quorum-aware progress object', async () => {
		const draft = await build2of3();

		// 0 signed.
		expect(summarizePsbt(draft.psbtBase64, MULTISIG_2OF3.threshold).complete).toBe(false);
		expect(summarizePsbt(draft.psbtBase64, MULTISIG_2OF3.threshold).signedInputs).toBe(0);

		// 1 of 3 signed — still short of the 2-of-3 threshold.
		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		let summary = summarizePsbt(psbt, MULTISIG_2OF3.threshold);
		let progress = multisigPsbtProgress(psbt, MULTISIG_2OF3.threshold);
		expect(summary.complete).toBe(false);
		expect(summary.complete).toBe(progress.complete);
		expect(summary.signedInputs).toBe(1);

		// 2 of 3 signed — quorum met, complete.
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[1]));
		summary = summarizePsbt(psbt, MULTISIG_2OF3.threshold);
		progress = multisigPsbtProgress(psbt, MULTISIG_2OF3.threshold);
		expect(summary.complete).toBe(true);
		expect(progress.complete).toBe(true);
		expect(() => finalizeMultisigPsbt(psbt)).not.toThrow();
	});

	it('single-sig call sites (threshold omitted) keep the original "any signature" semantics', async () => {
		const draft = await constructMultisigPsbt({
			config: CFG_2OF2,
			utxos: [multisigUtxo(CFG_2OF2, 200_000)],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		expect(summarizePsbt(draft.psbtBase64).complete).toBe(false);
		const oneSigned = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		// threshold defaults to 1 — matches pre-fix behavior exactly for callers
		// that never pass one (every single-sig summarizePsbt call site).
		expect(summarizePsbt(oneSigned).complete).toBe(true);
	});
});

// ── wrapped-segwit and legacy script types ──────────────────────────────────
// cairn-3urk: these used to be gated behind describe.runIf(scriptTypeReady(...)),
// a probe for multisig.ts's then-concurrent script-type extension. That support
// has landed, so the precondition is always satisfiable — but the runIf gate
// meant a future regression that made deriveMultisigAddress THROW for p2sh /
// p2sh-p2wsh would silently flip these suites to "skipped" instead of failing.
// They now run unconditionally so any wrapped-segwit/legacy regression fails
// loudly.

describe('p2sh-p2wsh multisigs', () => {
	const CFG = config(2, 3, 'p2sh-p2wsh');

	it('attaches redeemScript + witnessScript, signs, and finalizes', async () => {
		const utxo = multisigUtxo(CFG, 200_000);
		const draft = await constructMultisigPsbt({
			config: CFG,
			utxos: [utxo],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0
		});
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		const inp = tx.getInput(0);
		expect(inp.redeemScript).toBeDefined();
		expect(inp.witnessScript).toBeDefined();
		expect(inp.bip32Derivation).toHaveLength(3);

		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[0]));
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[1]));
		expect(multisigPsbtProgress(psbt, 2)).toMatchObject({ collected: 2, complete: true });
		const { txid } = finalizeMultisigPsbt(psbt);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('legacy p2sh multisigs', () => {
	const CFG = config(2, 3, 'p2sh');

	it('requires nonWitnessUtxo (fetchRawTx), signs, and finalizes', async () => {
		const address = deriveMultisigAddress(CFG, 0, 0).address;
		const fund = fundingTx([{ address, value: 200_000 }]);
		const utxo: SpendableUtxo = {
			txid: fund.txid,
			vout: 0,
			value: 200_000,
			height: 800_000,
			address,
			chain: 0,
			index: 0
		};

		// Without a raw-tx source, legacy construction must refuse.
		await expect(
			constructMultisigPsbt({
				config: CFG,
				utxos: [utxo],
				recipients: [{ address: RECIPIENT, amount: 50_000 }],
				feeRate: FEE_RATE,
				changeIndex: 0
			})
		).rejects.toThrow(/raw previous transactions/);

		const draft = await constructMultisigPsbt({
			config: CFG,
			utxos: [utxo],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0,
			fetchRawTx: async () => fund.hex
		});
		const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
		const inp = tx.getInput(0);
		expect(inp.nonWitnessUtxo).toBeDefined();
		expect(inp.redeemScript).toBeDefined();
		expect(inp.witnessScript).toBeUndefined(); // no witness in a legacy spend

		let psbt = combineMultisigPsbts(draft.psbtBase64, signWith(draft.psbtBase64, SIGNERS[1]));
		psbt = combineMultisigPsbts(psbt, signWith(psbt, SIGNERS[2]));
		expect(multisigPsbtProgress(psbt, 2)).toMatchObject({ collected: 2, complete: true });
		const { txid } = finalizeMultisigPsbt(psbt);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});
});

// ── signingMass parity with the single-sig builder (cairn-194) ───────────────

describe('multisig signingMass', () => {
	beforeEach(() => clearParentMassCache());

	function fundedUtxo(cfg: TestConfig, value = 200_000) {
		const address = deriveMultisigAddress(cfg, 0, 0).address;
		const fund = fundingTx([{ address, value }]);
		const utxo: SpendableUtxo = {
			txid: fund.txid,
			vout: 0,
			value,
			height: 800_000,
			address,
			chain: 0,
			index: 0
		};
		return { fund, utxo };
	}

	it('carries quorum-scaled signingMass when parents are fetched', async () => {
		const { fund, utxo } = fundedUtxo(MULTISIG_2OF3);
		const draft = await constructMultisigPsbt({
			config: MULTISIG_2OF3,
			utxos: [utxo],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: FEE_RATE,
			changeIndex: 0,
			fetchRawTx: async () => fund.hex
		});
		expect(draft.signingMass).toBeDefined();
		// Exactly what the pure assembler produces for M=2, N=3 over this parent.
		expect(draft.signingMass).toEqual(
			computeSigningMass({
				parentVsizes: [parentVsizeFromRawTx(fund.hex)],
				inputCount: 1,
				threshold: 2,
				totalKeys: 3
			})
		);
		// The quorum multiplies the ceremony total: 2 signers each stream the mass.
		const singleSig = computeSigningMass({
			parentVsizes: [parentVsizeFromRawTx(fund.hex)],
			inputCount: 1
		});
		expect(draft.signingMass!.totalSeconds.hi).toBeGreaterThanOrEqual(
			singleSig.totalSeconds.hi * 2
		);
	});

	it('a bigger quorum estimates a longer ceremony on the same coins', async () => {
		const a = fundedUtxo(MULTISIG_2OF3);
		const b = fundedUtxo(MULTISIG_3OF5);
		const build = (cfg: TestConfig, f: { fund: { hex: string }; utxo: SpendableUtxo }) =>
			constructMultisigPsbt({
				config: cfg,
				utxos: [f.utxo],
				recipients: [{ address: RECIPIENT, amount: 50_000 }],
				feeRate: FEE_RATE,
				changeIndex: 0,
				fetchRawTx: async () => f.fund.hex
			});
		const m2 = await build(MULTISIG_2OF3, a);
		const m3 = await build(MULTISIG_3OF5, b);
		expect(m3.signingMass!.totalSeconds.hi).toBeGreaterThan(m2.signingMass!.totalSeconds.hi);
	});

	it('omits signingMass without fetchRawTx (segwit multisig) — construction still succeeds', async () => {
		const draft = await build2of3();
		expect(draft.psbtBase64.length).toBeGreaterThan(0);
		expect(draft.signingMass).toBeUndefined();
	});

	it('carries signingMass on the multisig send-max path', async () => {
		const { fund, utxo } = fundedUtxo(MULTISIG_2OF3);
		const draft = await constructMultisigPsbt({
			config: MULTISIG_2OF3,
			utxos: [utxo],
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate: FEE_RATE,
			changeIndex: 0,
			fetchRawTx: async () => fund.hex
		});
		expect(draft.signingMass).toBeDefined();
		expect(draft.signingMass!.totalParentVsize).toBe(parentVsizeFromRawTx(fund.hex));
	});
});
