// Unsigned-transaction construction (BIP174 PSBTs) for single-sig wallets.
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
import {
	signingMassFromFetchedParents,
	preferLowMassOrder,
	type SigningMass
} from './signingMass';
import { coinbaseMaturity, isImmatureCoinbase } from '$lib/shared/coinbase';
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
	/** Whether this output was created by a coinbase (mining reward) tx.
	 *  Coinbase outputs need 100 confirmations to spend and always carry the full
	 *  previous transaction (nonWitnessUtxo). `true`/`false` = determined,
	 *  `'unknown'` = a chain fetch failed and coinbase-ness is unverifiable (the
	 *  maturity guard treats it conservatively), undefined = not yet determined. */
	coinbase?: CoinbaseStatus;
}

/** Result of a coinbase-ness check: definitive, or unverifiable after a chain
 *  fetch failure (cairn-7fmd). */
export type CoinbaseStatus = boolean | 'unknown';

export interface KeyOrigin {
	/** Master key fingerprint, 8 hex chars. */
	fingerprint: string;
	/** Account origin path, e.g. "m/84'/0'/0'". */
	path: string;
}

/** One transaction output: where and how much. 'max' sweeps everything (sole recipient only). */
export interface RecipientSpec {
	address: string;
	/** Amount in sats, or 'max' to sweep every provided UTXO (single recipient only). */
	amount: number | 'max';
}

export interface ConstructParams {
	xpub: string;
	utxos: SpendableUtxo[];
	/**
	 * One or more outputs to pay. A single-recipient send is a length-1 array.
	 * 'max' is only valid when there is exactly one recipient — a sweep has no
	 * well-defined split across several destinations.
	 */
	recipients: RecipientSpec[];
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
	 * conflict. Requires numeric amounts; change = inputs − amounts − fee.
	 */
	exactInputs?: boolean;
	/**
	 * Manual coin control: an allowlist of (txid, vout) coins. When present,
	 * coin selection runs over ONLY these UTXOs — still confirmed-filtered,
	 * still normal selection semantics (change, send-max over the subset). This
	 * restricts the candidate set; it does NOT force every listed coin to be
	 * spent (that is exactInputs). Ignored when empty.
	 */
	onlyUtxos?: { txid: string; vout: number }[];
	/**
	 * Current chain tip height. When provided, coinbase (mining reward) inputs are
	 * maturity-checked: an immature coinbase (< 100 confirmations) is skipped in
	 * automatic selection and rejected if explicitly chosen via coin control.
	 * Omitted = no maturity check (e.g. RBF, tests without coinbase inputs).
	 */
	tipHeight?: number;
}

export interface ConstructedPsbt {
	psbtBase64: string;
	fee: number; // sats
	feeRate: number; // sat/vB actually paid (fee / estimated vsize)
	vsize: number; // estimate
	amount: number; // total sats across all recipients
	/** First recipient's address — the display/storage anchor for single sends. */
	recipient: string;
	/** Every recipient with its resolved amount ('max' resolved to real sats). */
	recipients: { address: string; amount: number }[];
	change: { address: string; value: number; index: number } | null;
	inputs: { txid: string; vout: number; value: number; address: string }[];
	/**
	 * Signing-mass estimate over the chosen inputs' parent transactions (see
	 * signingMass.ts). OPTIONAL by design: computed only from parents already
	 * fetched for nonWitnessUtxo — when any chosen input's parent wasn't
	 * fetched (no fetchRawTx provided), the whole block is omitted rather than
	 * understated, and mass computation can never fail construction.
	 */
	signingMass?: SigningMass;
}

export class PsbtError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'invalid_recipient'
			| 'invalid_amount'
			| 'insufficient_funds'
			| 'no_utxos'
			| 'immature_coinbase'
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
 * Exact vsize of one output paying `address`: 8-byte value + compactSize
 * script length (all standard scripts are < 253 bytes → 1 byte) + the
 * scriptPubKey itself. Output size varies by destination type — p2wpkh 31,
 * p2sh/p2pkh 32/34, p2wsh/p2tr 43 — so a flat constant would under-price
 * sweeps to taproot/p2wsh destinations.
 */
function outputVsize(address: string): number {
	return 9 + addressToScriptPubKey(address).length;
}

/**
 * Build an unsigned PSBT. Pure with respect to the chain: every external
 * datum (UTXOs, prev txs) comes in through params, which keeps this
 * deterministic and unit-testable.
 */
export async function constructPsbt(params: ConstructParams): Promise<ConstructedPsbt> {
	const { feeRate } = params;

	if (!Array.isArray(params.recipients) || params.recipients.length === 0) {
		throw new PsbtError('At least one recipient is required.', 'invalid_recipient');
	}
	for (const r of params.recipients) {
		if (!isValidAddress(r.address)) {
			throw new PsbtError(
				params.recipients.length === 1
					? 'That does not look like a valid Bitcoin address.'
					: `"${r.address}" does not look like a valid Bitcoin address.`,
				'invalid_recipient'
			);
		}
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
	// 'max' sweeps the whole (candidate) balance — meaningless alongside other
	// recipients, so it is only accepted as the sole output.
	const sendMax = params.recipients.some((r) => r.amount === 'max');
	if (sendMax && params.recipients.length > 1) {
		throw new PsbtError(
			'Send-max only works with a single recipient — a sweep cannot be split across several destinations.',
			'invalid_amount'
		);
	}
	for (const r of params.recipients) {
		if (r.amount !== 'max' && (!Number.isInteger(r.amount) || r.amount <= 0)) {
			throw new PsbtError(
				params.recipients.length === 1
					? 'Amount must be a positive number of sats.'
					: `The amount for ${r.address} must be a positive number of sats.`,
				'invalid_amount'
			);
		}
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
	let spendable = params.exactInputs
		? params.utxos
		: params.utxos.filter((u) => u.height > 0);
	if (spendable.length === 0) {
		throw new PsbtError('This wallet has no confirmed coins to spend.', 'no_utxos');
	}

	// Manual coin control: restrict the candidate set to the allowlist. Coins
	// that dropped out of the wallet (spent, reorged to unconfirmed) simply
	// don't match — an empty result gets its own message rather than the
	// generic no-coins one.
	const coinControl = (params.onlyUtxos?.length ?? 0) > 0;
	if (coinControl) {
		const allow = new Set(params.onlyUtxos!.map((o) => `${o.txid}:${o.vout}`));
		spendable = spendable.filter((u) => allow.has(`${u.txid}:${u.vout}`));
		if (spendable.length === 0) {
			throw new PsbtError(
				'None of the selected coins are spendable right now — they may be unconfirmed or already spent.',
				'no_utxos'
			);
		}
	}

	// Coinbase maturity: a coinbase (mining reward) output needs 100 confirmations
	// before consensus lets it be spent. When we know the tip, drop immature ones
	// from automatic selection; if the user explicitly picked one via coin control,
	// reject with a clear message rather than silently building an invalid tx.
	if (params.tipHeight != null && !params.exactInputs) {
		const tip = params.tipHeight;
		// A confirmed coinbase output younger than 100 blocks is definitely immature.
		const isImmature = (u: SpendableUtxo) => u.coinbase === true && isImmatureCoinbase(u.height, tip);
		// A UTXO whose coinbase-ness couldn't be verified (chain hiccup, cairn-7fmd)
		// AND that is still inside the maturity window could be an immature mining
		// reward — we can't prove it's safe, so refuse rather than draft a tx the
		// network may reject. Coins past 100 confirmations are safe regardless.
		const isUnverifiable = (u: SpendableUtxo) =>
			u.coinbase === 'unknown' && isImmatureCoinbase(u.height, tip);

		const immature = spendable.filter(isImmature);
		const unverifiable = spendable.filter(isUnverifiable);

		if (coinControl && unverifiable.length > 0) {
			throw new PsbtError(
				"Couldn't verify whether a selected coin is a mature mining reward — the chain lookup failed. Try again in a moment.",
				'immature_coinbase'
			);
		}
		if (immature.length > 0 && coinControl) {
			const m = coinbaseMaturity(immature[0].height, tip);
			throw new PsbtError(
				`A selected coin is an immature mining reward — it needs ${m.blocksRemaining} more confirmation${m.blocksRemaining === 1 ? '' : 's'} (~${m.etaHours}h) before it can be spent.`,
				'immature_coinbase'
			);
		}

		if (immature.length > 0 || unverifiable.length > 0) {
			// Auto-selection: drop both definitely-immature and unverifiable-young
			// coins so we never build an invalid tx.
			spendable = spendable.filter((u) => !isImmature(u) && !isUnverifiable(u));
			if (spendable.length === 0) {
				throw new PsbtError('This wallet has no mature coins to spend right now.', 'no_utxos');
			}
		}
	}

	// Low-mass selection bias (normal selection only — exact-inputs must spend
	// what it's given, and send-max spends every candidate anyway): stable
	// re-sort by CACHED parent mass so equal-value ties resolve toward coins
	// with light parents. Best-effort by construction — it never fetches a
	// parent (no added latency) and, because selectUTXO's 'default' strategy
	// re-sorts by value internally, it can never change fees or amounts; see
	// preferLowMassOrder. Verified by test: cached mass data reorders which of
	// two equal-value coins is selected.
	if (!params.exactInputs && !sendMax) {
		spendable = preferLowMassOrder(spendable);
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
		// Coinbase inputs MUST carry the full previous transaction — hardware
		// signers require it to safely sign a mining reward. Every non-p2tr input
		// already attaches nonWitnessUtxo when fetchRawTx is present (below); this
		// only rejects the pathological case of a coinbase spend with no fetcher.
		if (utxo.coinbase === true && !params.fetchRawTx) {
			throw new PsbtError(
				'Spending a mining reward needs its full previous transaction, which is unavailable right now.',
				'construction_failed'
			);
		}
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
	// Sweeps every CANDIDATE coin — with a coin-control allowlist active that
	// is the selected subset, so "max" means "everything I picked, minus fee".
	if (sendMax) {
		const recipient = params.recipients[0].address;
		const totalIn = spendable.reduce((s, u) => s + u.value, 0);
		const vsize =
			TX_OVERHEAD_VSIZE + spendable.length * INPUT_VSIZE[scriptType] + outputVsize(recipient);
		const fee = Math.ceil(vsize * feeRate);
		const amount = totalIn - fee;
		if (amount <= DUST_SATS) {
			throw new PsbtError(
				coinControl
					? "The selected coins don't cover the network fee at this rate — select more coins or lower the fee."
					: 'After fees there would be nothing left to send at this fee rate.',
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
			recipients: [{ address: recipient, amount }],
			change: null,
			inputs: spendable.map((u) => ({
				txid: u.txid,
				vout: u.vout,
				value: u.value,
				address: u.address
			})),
			signingMass: signingMassFromFetchedParents(spendable, prevTxCache)
		};
	}

	// Past the send-max gate every amount is a real number.
	const recipients = params.recipients.map((r) => ({
		address: r.address,
		amount: r.amount as number
	}));
	const totalAmount = recipients.reduce((s, r) => s + r.amount, 0);

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
			TX_OVERHEAD_VSIZE +
			chosen.length * INPUT_VSIZE[scriptType] +
			recipients.reduce((s, r) => s + outputVsize(r.address), 0) +
			outputVsize(params.changeAddress);
		fee = Math.ceil(vsizeEst * feeRate);
		const change = totalIn - totalAmount - fee;
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
			...recipients.map((r) => ({ address: r.address, value: r.amount })),
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
			recipients.map((r) => ({ address: r.address, amount: toBigInt(r.amount) })),
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
				coinControl
					? "The selected coins don't cover that amount plus the network fee — select more coins or lower the amount."
					: 'Not enough confirmed funds to cover that amount plus the network fee.',
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
	const changeValue = totalIn - totalAmount - fee;
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
			recipients.reduce((s, r) => s + outputVsize(r.address), 0) +
			(hasChange ? outputVsize(params.changeAddress) : 0)
	);

	return {
		psbtBase64: base64.encode(tx.toPSBT()),
		fee,
		feeRate: Math.round((fee / vsize) * 100) / 100,
		vsize,
		amount: totalAmount,
		recipient: recipients[0].address,
		recipients,
		change: hasChange
			? { address: params.changeAddress, value: changeValue, index: params.changeIndex }
			: null,
		inputs: chosen.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			address: u.address
		})),
		signingMass: signingMassFromFetchedParents(chosen, prevTxCache)
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
