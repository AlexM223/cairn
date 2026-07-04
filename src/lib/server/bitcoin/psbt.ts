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
	const spendable = params.utxos.filter((u) => u.height > 0);
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
		const bytes = hexToBytes(await params.fetchRawTx(txid));
		prevTxCache.set(txid, bytes);
		return bytes;
	}

	const inputs = [];
	for (const utxo of spendable) {
		const child = parsed.hdkey.deriveChild(utxo.chain).deriveChild(utxo.index);
		if (!child.publicKey) throw new PsbtError('Key derivation failed.', 'construction_failed');

		const input: Record<string, unknown> = {
			txid: hexToBytes(utxo.txid),
			index: utxo.vout
		};

		if (scriptType === 'p2pkh') {
			input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
		} else {
			input.witnessUtxo = {
				script: addressToScriptPubKey(utxo.address),
				amount: toBigInt(utxo.value)
			};
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

	// ------------------------------------------------- normal coin selection
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

	const tx = selection.tx;
	const fee = Number(selection.fee);

	// Recover which of our UTXOs the selector chose, by (txid, vout).
	const chosen: SpendableUtxo[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		const txidHex = inp.txid ? bytesToHex(inp.txid) : null;
		const match = spendable.find((u) => u.txid === txidHex && u.vout === inp.index);
		if (match) chosen.push(match);
	}

	const totalIn = chosen.reduce((s, u) => s + u.value, 0);
	const changeValue = totalIn - params.amount - fee;
	const hasChange = selection.change === true && changeValue > 0;
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
	/** Signature completeness: how many inputs carry at least one signature. */
	signedInputs: number;
	complete: boolean;
}

function addressFromScript(script: Uint8Array): string | null {
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
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		outputs.push({
			address: out.script ? addressFromScript(out.script) : null,
			value: Number(out.amount ?? 0n)
		});
	}
	let signedInputs = 0;
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
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
	// Order matters — a reordered tx is a different tx — so no sorting.
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
 * draft. This is the guard against a malicious or buggy signer returning a
 * transaction that pays a different destination than the one approved.
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
