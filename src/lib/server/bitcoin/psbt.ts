// Unsigned-transaction construction (BIP174 PSBTs) for watch-only wallets.
//
// Cairn never holds private keys: this module builds and serializes PSBTs
// from Electrum UTXO data; signing happens elsewhere (hardware device, or
// any external PSBT-capable wallet). Coin selection and fee math run here —
// deliberately independent of Bitcoin Core's wallet RPCs, because the
// default deployment has no Core node behind it.

import { Transaction, selectUTXO, p2wpkh, Address, OutScript, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { parseXpub, addressToScriptPubKey, isValidAddress } from './xpub';
import type { ScriptType } from '$lib/types';

/** A spendable output attributed to a wallet-derived address. */
export interface SpendableUtxo {
	txid: string;
	vout: number;
	value: number; // sats
	height: number; // 0 = unconfirmed
	address: string;
	chain: 0 | 1; // receive / change
	index: number;
}

export interface KeyOrigin {
	/** Master key fingerprint, 8 hex chars. */
	fingerprint: string;
	/** Account origin path, e.g. "m/84'/0'/0'". */
	path: string;
}

export interface ConstructParams {
	xpub: string;
	utxos: SpendableUtxo[];
	recipient: string;
	/** Amount in sats, or 'max' to sweep every provided UTXO. */
	amount: number | 'max';
	feeRate: number; // sat/vB
	changeAddress: string;
	changeIndex: number;
	/** When present, BIP32 derivation info is embedded so signers can match keys. */
	origin?: KeyOrigin | null;
	/** Raw prev-tx fetch, required for legacy (p2pkh) inputs only. */
	fetchRawTx?: (txid: string) => Promise<string>;
	/**
	 * Spend every provided UTXO exactly as given, skipping coin selection (and
	 * the confirmed-only filter). Used for RBF replacements, which must spend
	 * the same inputs as the transaction they replace so the two necessarily
	 * conflict. Requires a numeric amount; change = inputs − amount − fee.
	 */
	exactInputs?: boolean;
}

export interface ConstructedPsbt {
	psbtBase64: string;
	fee: number; // sats
	feeRate: number; // sat/vB actually paid (fee / estimated vsize)
	vsize: number; // estimate
	amount: number; // sats to the recipient
	recipient: string;
	change: { address: string; value: number; index: number } | null;
	inputs: { txid: string; vout: number; value: number; address: string }[];
}

export class PsbtError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'invalid_recipient'
			| 'invalid_amount'
			| 'insufficient_funds'
			| 'no_utxos'
			| 'construction_failed'
	) {
		super(message);
		this.name = 'PsbtError';
	}
}

/** Default account origin per script type (BIP44/49/84 mainnet). */
export const DEFAULT_ORIGIN_PATH: Record<ScriptType, string> = {
	p2pkh: "m/44'/0'/0'",
	'p2sh-p2wpkh': "m/49'/0'/0'",
	p2wpkh: "m/84'/0'/0'",
	p2tr: "m/86'/0'/0'"
};

// Approximate virtual sizes for fee estimation (sat/vB pricing).
const INPUT_VSIZE: Record<string, number> = { p2pkh: 148, 'p2sh-p2wpkh': 91, p2wpkh: 68 };
const OUTPUT_VSIZE = 34; // worst-case-ish; fine for estimates
const TX_OVERHEAD_VSIZE = 11;
const DUST_SATS = 546;

/**
 * Hard server-side fee-rate ceiling (sat/vB). Even at the worst fee spikes in
 * Bitcoin's history, next-block confirmation never cost four figures per vB —
 * anything above this is a typo (sats-total pasted into a rate field) that
 * would burn real money. UI warnings kick in far lower; this is the backstop.
 */
export const MAX_FEE_RATE = 1000;

/**
 * Input nSequence for every transaction Cairn builds. Any value below
 * 0xfffffffe opts in to BIP-125 replace-by-fee, so a stuck transaction can be
 * fee-bumped later; 0xfffffffd is the conventional choice — it signals RBF,
 * keeps nLockTime enforceable, and (bit 31 set) leaves BIP-68 relative
 * locktime disabled.
 */
export const RBF_SEQUENCE = 0xfffffffd;

const HARDENED = 0x80000000;

/** "m/84'/0'/0'" → [0x80000054, 0x80000000, 0x80000000]; throws on nonsense. */
export function parseOriginPath(path: string): number[] {
	const parts = path.replace(/^m\//, '').split('/');
	return parts.map((p) => {
		const hardened = /['hH]$/.test(p);
		const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
		if (!Number.isInteger(n) || n < 0) throw new PsbtError(`Bad path segment "${p}"`, 'construction_failed');
		return hardened ? n + HARDENED : n;
	});
}

function toBigInt(sats: number): bigint {
	return BigInt(Math.round(sats));
}

/**
 * Build an unsigned PSBT. Pure with respect to the chain: every external
 * datum (UTXOs, prev txs) comes in through params, which keeps this
 * deterministic and unit-testable.
 */
export async function constructPsbt(params: ConstructParams): Promise<ConstructedPsbt> {
	const { recipient, feeRate } = params;

	if (!isValidAddress(recipient)) {
		throw new PsbtError('That does not look like a valid Bitcoin address.', 'invalid_recipient');
	}
	if (!Number.isFinite(feeRate) || feeRate < 1) {
		throw new PsbtError('Fee rate must be at least 1 sat/vB.', 'invalid_amount');
	}
	if (feeRate > MAX_FEE_RATE) {
		throw new PsbtError(
			`A fee rate above ${MAX_FEE_RATE} sat/vB is almost certainly a mistake — refusing to build this transaction.`,
			'invalid_amount'
		);
	}
	if (params.amount !== 'max' && (!Number.isInteger(params.amount) || params.amount <= 0)) {
		throw new PsbtError('Amount must be a positive number of sats.', 'invalid_amount');
	}

	const parsed = parseXpub(params.xpub);
	const scriptType = parsed.scriptType;
	if (!(scriptType in INPUT_VSIZE)) {
		throw new PsbtError(`Spending from ${scriptType} wallets is not supported yet.`, 'construction_failed');
	}

	// Confirmed coins only: unconfirmed inputs make the new tx's confirmation
	// hostage to someone else's, and RBF could invalidate it entirely.
	// Exact-inputs mode (RBF replacement) skips the filter: the inputs are the
	// original transaction's own, whose funding txs were already confirmed
	// when the original was built.
	const spendable = params.exactInputs
		? params.utxos
		: params.utxos.filter((u) => u.height > 0);
	if (spendable.length === 0) {
		throw new PsbtError('This wallet has no confirmed coins to spend.', 'no_utxos');
	}

	const originPath = params.origin ? parseOriginPath(params.origin.path) : null;
	const fingerprint = params.origin
		? parseInt(params.origin.fingerprint, 16) >>> 0
		: null;

	// Assemble selectUTXO-shaped inputs, attributing derivation info when the
	// wallet's key origin is known (hardware signers need it to find keys).
	const prevTxCache = new Map<string, Uint8Array>();
	async function rawPrevTx(txid: string): Promise<Uint8Array> {
		const hit = prevTxCache.get(txid);
		if (hit) return hit;
		if (!params.fetchRawTx) {
			throw new PsbtError('Legacy inputs need raw previous transactions.', 'construction_failed');
		}
		const raw = await params.fetchRawTx(txid);
		// Verify the fetched tx actually hashes to the txid we asked for BEFORE
		// handing it to the PSBT builder — btc-signer enforces the same check
		// inside addInput, but its error is opaque; a mismatch here means the
		// chain source returned inconsistent data and deserves a clear message.
		let bytes: Uint8Array;
		let actualTxid: string;
		try {
			bytes = hexToBytes(raw);
			actualTxid = Transaction.fromRaw(bytes, {
				allowUnknownInputs: true,
				allowUnknownOutputs: true,
				disableScriptCheck: true
			}).id;
		} catch {
			throw new PsbtError(
				`The previous transaction ${txid} could not be parsed — the chain source returned bad data.`,
				'construction_failed'
			);
		}
		if (actualTxid !== txid) {
			throw new PsbtError(
				`The chain source returned the wrong previous transaction (asked for ${txid}, got ${actualTxid}) — refusing to build from inconsistent data.`,
				'construction_failed'
			);
		}
		prevTxCache.set(txid, bytes);
		return bytes;
	}

	const inputs = [];
	for (const utxo of spendable) {
		const child = parsed.hdkey.deriveChild(utxo.chain).deriveChild(utxo.index);
		if (!child.publicKey) throw new PsbtError('Key derivation failed.', 'construction_failed');

		const input: Record<string, unknown> = {
			txid: hexToBytes(utxo.txid),
			index: utxo.vout,
			// Signal BIP-125 replaceability on every input (see RBF_SEQUENCE).
			sequence: RBF_SEQUENCE
		};

		if (scriptType === 'p2pkh') {
			input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
		} else {
			input.witnessUtxo = {
				script: addressToScriptPubKey(utxo.address),
				amount: toBigInt(utxo.value)
			};
			// Segwit v0 inputs also get the full previous transaction: a bare
			// witnessUtxo amount is an unverifiable assertion (the classic
			// fee-lying surface), and several hardware signers warn or refuse
			// without it. Taproot inputs would not need this (BIP-341 commits to
			// all input amounts), but p2tr spending is not supported yet anyway.
			// witnessUtxo stays alongside — segwit signers use it for the sighash.
			if (scriptType !== 'p2tr' && params.fetchRawTx) {
				input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
			}
			if (scriptType === 'p2sh-p2wpkh') {
				// Redeem script = the wrapped v0 keyhash program.
				input.redeemScript = p2wpkh(child.publicKey, NETWORK).script;
			}
		}

		if (originPath && fingerprint !== null) {
			input.bip32Derivation = [
				[child.publicKey, { fingerprint, path: [...originPath, utxo.chain, utxo.index] }]
			];
		}

		inputs.push(input);
	}

	// ------------------------------------------------------------- send max
	if (params.amount === 'max') {
		const totalIn = spendable.reduce((s, u) => s + u.value, 0);
		const vsize =
			TX_OVERHEAD_VSIZE + spendable.length * INPUT_VSIZE[scriptType] + OUTPUT_VSIZE;
		const fee = Math.ceil(vsize * feeRate);
		const amount = totalIn - fee;
		if (amount <= DUST_SATS) {
			throw new PsbtError(
				'After fees there would be nothing left to send at this fee rate.',
				'insufficient_funds'
			);
		}
		const tx = new Transaction();
		for (const input of inputs) tx.addInput(input);
		tx.addOutputAddress(recipient, toBigInt(amount), NETWORK);
		return {
			psbtBase64: base64.encode(tx.toPSBT()),
			fee,
			feeRate: Math.round((fee / vsize) * 100) / 100,
			vsize,
			amount,
			recipient,
			change: null,
			inputs: spendable.map((u) => ({
				txid: u.txid,
				vout: u.vout,
				value: u.value,
				address: u.address
			}))
		};
	}

	let tx: Transaction;
	let fee: number;
	let chosen: SpendableUtxo[];
	let changeExpected: boolean;

	if (params.exactInputs) {
		// ------------------------------------- exact inputs (RBF replacement)
		// Spend every provided coin exactly as given: an RBF replacement must
		// conflict with the transaction it replaces, and spending the identical
		// input set guarantees that. The recipient keeps the same output; the
		// entire fee increase comes out of the change output. Adding extra
		// inputs when change runs short would alter what the user originally
		// reviewed, so that case is rejected instead (a possible future
		// extension).
		chosen = spendable;
		const totalIn = chosen.reduce((s, u) => s + u.value, 0);
		const vsizeEst =
			TX_OVERHEAD_VSIZE + chosen.length * INPUT_VSIZE[scriptType] + 2 * OUTPUT_VSIZE;
		fee = Math.ceil(vsizeEst * feeRate);
		const change = totalIn - params.amount - fee;
		if (change < DUST_SATS) {
			throw new PsbtError(
				'The change output is too small to absorb the higher fee at this rate.',
				'insufficient_funds'
			);
		}
		tx = new Transaction();
		for (const input of inputs) tx.addInput(input);
		// Deterministic BIP69-style output order (value asc, script tiebreak),
		// matching what the coin selector emits on the normal path.
		const outs = [
			{ address: recipient, value: params.amount },
			{ address: params.changeAddress, value: change }
		].sort(
			(a, b) =>
				a.value - b.value ||
				bytesToHex(addressToScriptPubKey(a.address)).localeCompare(
					bytesToHex(addressToScriptPubKey(b.address))
				)
		);
		for (const o of outs) tx.addOutputAddress(o.address, toBigInt(o.value), NETWORK);
		changeExpected = true;
	} else {
		// ----------------------------------------------- normal coin selection
		// NOTE: btc-signer's `dust` option is NOT a sats threshold — passing 546
		// there silently burns any change below ~18k sats into the fee. The
		// library's default dust handling is correct; do not "tune" it.
		const selection = selectUTXO(
			inputs as never,
			[{ address: recipient, amount: toBigInt(params.amount) }],
			'default',
			{
				changeAddress: params.changeAddress,
				feePerByte: toBigInt(Math.ceil(feeRate)),
				bip69: true,
				createTx: true,
				network: NETWORK,
				allowLegacyWitnessUtxo: true
			}
		);

		if (!selection || !selection.tx) {
			throw new PsbtError(
				'Not enough confirmed funds to cover that amount plus the network fee.',
				'insufficient_funds'
			);
		}

		tx = selection.tx;
		fee = Number(selection.fee);

		// Recover which of our UTXOs the selector chose, by (txid, vout).
		chosen = [];
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			const txidHex = inp.txid ? bytesToHex(inp.txid) : null;
			const match = spendable.find((u) => u.txid === txidHex && u.vout === inp.index);
			if (match) chosen.push(match);
		}
		changeExpected = selection.change === true;
	}

	const totalIn = chosen.reduce((s, u) => s + u.value, 0);
	const changeValue = totalIn - params.amount - fee;
	const hasChange = changeExpected && changeValue > 0;

	// Mark the change output with its BIP32 derivation when the key origin is
	// known: hardware signers use it to verify change really pays back to the
	// wallet (instead of listing it as a second recipient), and summarizePsbt
	// uses it to identify change when a saved draft is re-opened.
	if (hasChange && originPath && fingerprint !== null) {
		const changeScript = bytesToHex(addressToScriptPubKey(params.changeAddress));
		const changeChild = parsed.hdkey.deriveChild(1).deriveChild(params.changeIndex);
		if (!changeChild.publicKey) throw new PsbtError('Key derivation failed.', 'construction_failed');
		for (let i = 0; i < tx.outputsLength; i++) {
			const out = tx.getOutput(i);
			if (out.script && bytesToHex(out.script) === changeScript) {
				tx.updateOutput(i, {
					bip32Derivation: [
						[changeChild.publicKey, { fingerprint, path: [...originPath, 1, params.changeIndex] }]
					]
				});
				break;
			}
		}
	}

	const vsize = Math.max(
		1,
		TX_OVERHEAD_VSIZE +
			chosen.length * INPUT_VSIZE[scriptType] +
			(hasChange ? 2 : 1) * OUTPUT_VSIZE
	);

	return {
		psbtBase64: base64.encode(tx.toPSBT()),
		fee,
		feeRate: Math.round((fee / vsize) * 100) / 100,
		vsize,
		amount: params.amount,
		recipient,
		change: hasChange
			? { address: params.changeAddress, value: changeValue, index: params.changeIndex }
			: null,
		inputs: chosen.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			address: u.address
		}))
	};
}

// ------------------------------------------------------------ PSBT utilities

export interface PsbtSummary {
	inputCount: number;
	outputCount: number;
	outputs: { address: string | null; value: number }[];
	/**
	 * Per-input coin references, txid in display (explorer) hex order. value is
	 * sats from witnessUtxo, or from the referenced output of nonWitnessUtxo;
	 * null only when the PSBT genuinely carries neither.
	 */
	inputs: { txid: string; vout: number; value: number | null }[];
	/** The output identified as change (via its bip32Derivation), when identifiable. */
	change: { vout: number; value: number } | null;
	/** Signature completeness: how many inputs carry at least one signature. */
	signedInputs: number;
	complete: boolean;
}

/** Best-effort address for a scriptPubKey; null for non-standard scripts. */
export function addressFromScript(script: Uint8Array): string | null {
	try {
		// btc-signer's OutScript union and Address's expected input differ only
		// in ArrayBuffer generics — safe to bridge.
		return Address(NETWORK).encode(OutScript.decode(script) as never);
	} catch {
		return null;
	}
}

/** Parse any base64 PSBT into a review-friendly summary. Throws on garbage. */
export function summarizePsbt(psbtBase64: string): PsbtSummary {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	const outputs: PsbtSummary['outputs'] = [];
	let change: PsbtSummary['change'] = null;
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		outputs.push({
			address: out.script ? addressFromScript(out.script) : null,
			value: Number(out.amount ?? 0n)
		});
		// constructPsbt marks the change output with the wallet's derivation
		// info; a PSBT without it (foreign origin, no known fingerprint) simply
		// has no identifiable change.
		if (change === null && (out.bip32Derivation?.length ?? 0) > 0) {
			change = { vout: i, value: Number(out.amount ?? 0n) };
		}
	}
	let signedInputs = 0;
	const inputs: PsbtSummary['inputs'] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		// Prefer witnessUtxo's amount; otherwise read the referenced output of
		// the embedded previous transaction. btc-signer keeps txid bytes in
		// display order (matching Transaction.id), so plain hex is correct.
		let value: number | null = null;
		if (inp.witnessUtxo) {
			value = Number(inp.witnessUtxo.amount);
		} else if (inp.nonWitnessUtxo && inp.index !== undefined) {
			const prevOut = inp.nonWitnessUtxo.outputs[inp.index];
			if (prevOut) value = Number(prevOut.amount);
		}
		inputs.push({
			txid: inp.txid ? bytesToHex(inp.txid) : '',
			vout: inp.index ?? 0,
			value
		});
		// Fields can be present-but-empty on unsigned inputs (btc-signer
		// materializes an empty finalScriptSig) — require actual content.
		const hasSig =
			(inp.partialSig?.length ?? 0) > 0 ||
			(inp.finalScriptWitness?.length ?? 0) > 0 ||
			(inp.finalScriptSig?.length ?? 0) > 0 ||
			(inp.tapKeySig?.length ?? 0) > 0;
		if (hasSig) signedInputs++;
	}
	return {
		inputCount: tx.inputsLength,
		outputCount: tx.outputsLength,
		outputs,
		inputs,
		change,
		signedInputs,
		complete: signedInputs === tx.inputsLength && tx.inputsLength > 0
	};
}

/**
 * A PSBT's transaction "commitment": the exact inputs it spends and outputs
 * it creates. Signing changes none of these — so a signed PSBT that differs
 * here is not the transaction the user reviewed.
 */
function commitment(psbtBase64: string): { inputs: string; outputs: string } {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));

	const inputs: string[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		inputs.push(`${inp.txid ? bytesToHex(inp.txid) : ''}:${inp.index ?? ''}`);
	}
	const outputs: string[] = [];
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		outputs.push(`${out.script ? bytesToHex(out.script) : ''}:${out.amount ?? 0n}`);
	}
	// Order-sensitive: a reordered transaction is a different transaction, and
	// our construction emits BIP69-canonical order that signers don't touch.
	return { inputs: inputs.join('|'), outputs: outputs.join('|') };
}

export class PsbtMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PsbtMismatchError';
	}
}

/**
 * Verify a signed PSBT commits to the SAME inputs and outputs as the reviewed
 * draft — the guard against a malicious or buggy signer returning a
 * transaction that pays a different destination than the one approved. Wired
 * into both the upload and broadcast paths of the transactions service.
 * Throws PsbtMismatchError when they diverge.
 */
export function assertSameTransaction(draftPsbtBase64: string, signedPsbtBase64: string): void {
	let a: { inputs: string; outputs: string };
	let b: { inputs: string; outputs: string };
	try {
		a = commitment(draftPsbtBase64);
		b = commitment(signedPsbtBase64);
	} catch {
		throw new PsbtMismatchError('The signed transaction could not be read.');
	}
	if (a.outputs !== b.outputs) {
		throw new PsbtMismatchError(
			'The signed transaction pays different outputs than the one you reviewed. It was not accepted.'
		);
	}
	if (a.inputs !== b.inputs) {
		throw new PsbtMismatchError(
			'The signed transaction spends different inputs than the one you reviewed. It was not accepted.'
		);
	}
}

/**
 * Finalize a fully-signed PSBT and extract the raw transaction hex ready for
 * broadcast. Throws (with btc-signer's reason) when signatures are missing.
 */
export function finalizePsbt(psbtBase64: string): { rawHex: string; txid: string } {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	tx.finalize();
	return { rawHex: tx.hex, txid: tx.id };
}
