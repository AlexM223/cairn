// Unsigned-transaction construction (BIP174 PSBTs) for single-sig wallets.
//
// Cairn never holds private keys: this module builds and serializes PSBTs
// from Electrum UTXO data; signing happens elsewhere (hardware device, or
// any external PSBT-capable wallet). Coin selection and fee math run here —
// deliberately independent of Bitcoin Core's wallet RPCs, because the
// default deployment has no Core node behind it.

import { Transaction, selectUTXO, p2wpkh, Address, OutScript, Script, NETWORK } from '@scure/btc-signer';
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
	/**
	 * Trust classification for an UNCONFIRMED coin (height <= 0), per
	 * docs/CPFP-UNCONFIRMED-PLAN.md §6. `'own-change'` = funded by a transaction
	 * this wallet itself broadcast (safe to spend — only your own conflicting
	 * spend could invalidate it); `'received'` = funded by someone else's still-
	 * unconfirmed transaction (risky — they could still replace it). Absent for
	 * confirmed coins, and treated conservatively as `'received'` when unknown, so
	 * automatic selection never silently depends on a stranger's unconfirmed tx.
	 */
	unconfirmedTrust?: UnconfirmedTrust;
}

/** Result of a coinbase-ness check: definitive, or unverifiable after a chain
 *  fetch failure (cairn-7fmd). */
export type CoinbaseStatus = boolean | 'unknown';

/** How much an unconfirmed coin can be trusted (see SpendableUtxo.unconfirmedTrust). */
export type UnconfirmedTrust = 'own-change' | 'received';

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
 * Estimated vsize of a transaction with `numInputs` inputs of the given
 * single-sig script type and outputs paying `outputAddresses`. Uses the exact
 * same per-input/overhead/output tables the coin selector prices fees with, so a
 * caller (e.g. the CPFP builder) computing a fee from this number and then
 * building the real tell through constructPsbt gets a matching vsize back.
 * Throws for a script type the input table doesn't cover.
 */
export function estimateTxVsize(
	scriptType: string,
	numInputs: number,
	outputAddresses: string[]
): number {
	const perInput = INPUT_VSIZE[scriptType];
	if (perInput == null) {
		throw new PsbtError(`Cannot size inputs for ${scriptType} wallets.`, 'construction_failed');
	}
	return (
		TX_OVERHEAD_VSIZE +
		numInputs * perInput +
		outputAddresses.reduce((s, a) => s + outputVsize(a), 0)
	);
}

// ------------------------------------------------------ shared spend rules
//
// constructPsbt and constructMultisigPsbt enforce the exact same recipient,
// fee, coin-eligibility, and coinbase-maturity rules with the exact same
// user-facing messages. These helpers are the single source of those rules —
// multisigPsbt.ts used to carry a verbatim copy of each block.

/**
 * Recipient / fee-rate validation shared by single-sig and multisig PSBT
 * construction. Returns whether this spend is a send-max sweep: 'max' sweeps
 * the whole (candidate) balance — meaningless alongside other recipients, so
 * it is only accepted as the sole output.
 */
export function validateRecipientsAndFeeRate(
	recipients: RecipientSpec[],
	feeRate: number
): { sendMax: boolean } {
	if (!Array.isArray(recipients) || recipients.length === 0) {
		throw new PsbtError('At least one recipient is required.', 'invalid_recipient');
	}
	for (const r of recipients) {
		if (!isValidAddress(r.address)) {
			throw new PsbtError(
				recipients.length === 1
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
	const sendMax = recipients.some((r) => r.amount === 'max');
	if (sendMax && recipients.length > 1) {
		throw new PsbtError(
			'Send-max only works with a single recipient — a sweep cannot be split across several destinations.',
			'invalid_amount'
		);
	}
	for (const r of recipients) {
		if (r.amount !== 'max' && (!Number.isInteger(r.amount) || r.amount <= 0)) {
			throw new PsbtError(
				recipients.length === 1
					? 'Amount must be a positive number of sats.'
					: `The amount for ${r.address} must be a positive number of sats.`,
				'invalid_amount'
			);
		}
	}
	return { sendMax };
}

/**
 * Candidate-coin eligibility + coinbase-maturity filtering shared by
 * single-sig and multisig spends (see docs/CPFP-UNCONFIRMED-PLAN.md §1, §6):
 *
 *  - exactInputs (RBF replacement): spend the original tx's own inputs
 *    verbatim — they were already confirmed when the original was built, so
 *    eligibility and maturity filtering are skipped entirely.
 *  - coin control: the user picked coins explicitly, so honor exactly that
 *    set, INCLUDING an unconfirmed received coin they knowingly opted into —
 *    but reject an explicitly-chosen immature mining reward (or one whose
 *    coinbase-ness couldn't be verified inside the maturity window,
 *    cairn-7fmd) with a clear message rather than building an invalid tx.
 *  - automatic: confirmed coins plus the wallet's OWN unconfirmed change,
 *    never an unconfirmed coin received from elsewhere — a normal send must
 *    not silently become hostage to a stranger's unconfirmed tx. Immature and
 *    unverifiable-young coinbase coins are silently dropped.
 *
 * `walletNoun` labels the coin source in user-facing errors ("wallet" or
 * "multisig"); the callers' selection preferences (confirmed-first ordering,
 * low-mass bias) stay caller-side.
 */
export function selectSpendCandidates(
	params: {
		utxos: SpendableUtxo[];
		onlyUtxos?: { txid: string; vout: number }[];
		exactInputs?: boolean;
		tipHeight?: number;
	},
	walletNoun: string
): { spendable: SpendableUtxo[]; coinControl: boolean } {
	const coinControl = (params.onlyUtxos?.length ?? 0) > 0;
	let spendable: SpendableUtxo[];
	if (params.exactInputs) {
		spendable = params.utxos;
	} else if (coinControl) {
		const allow = new Set(params.onlyUtxos!.map((o) => `${o.txid}:${o.vout}`));
		spendable = params.utxos.filter((u) => allow.has(`${u.txid}:${u.vout}`));
		if (spendable.length === 0) {
			throw new PsbtError(
				'None of the selected coins are spendable right now — they may be already spent.',
				'no_utxos'
			);
		}
	} else {
		spendable = params.utxos.filter(
			(u) => u.height > 0 || u.unconfirmedTrust === 'own-change'
		);
	}
	if (spendable.length === 0) {
		throw new PsbtError(`This ${walletNoun} has no spendable coins right now.`, 'no_utxos');
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
				throw new PsbtError(`This ${walletNoun} has no mature coins to spend right now.`, 'no_utxos');
			}
		}
	}

	return { spendable, coinControl };
}

/**
 * Build an unsigned PSBT. Pure with respect to the chain: every external
 * datum (UTXOs, prev txs) comes in through params, which keeps this
 * deterministic and unit-testable.
 */
export async function constructPsbt(params: ConstructParams): Promise<ConstructedPsbt> {
	const { feeRate } = params;

	const { sendMax } = validateRecipientsAndFeeRate(params.recipients, feeRate);

	const parsed = parseXpub(params.xpub);
	const scriptType = parsed.scriptType;
	if (!(scriptType in INPUT_VSIZE)) {
		throw new PsbtError(`Spending from ${scriptType} wallets is not supported yet.`, 'construction_failed');
	}

	// Coin eligibility + coinbase maturity (shared rules — see
	// selectSpendCandidates). Confirmed coins are still preferred (the two-pass
	// selection on the normal path below only reaches for unconfirmed change
	// when confirmed can't cover it).
	const candidates = selectSpendCandidates(params, 'wallet');
	const coinControl = candidates.coinControl;
	let spendable = candidates.spendable;

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

	// Segwit inputs' nonWitnessUtxo fetch is DEFERRED past coin selection (see
	// fetchChosenPrevTxs below, and the attach steps at each selection branch):
	// selection only ever reads witnessUtxo's amount, so fetching the full
	// previous transaction for every CANDIDATE here — most of which never end
	// up spent — paid for one serial Electrum round-trip per candidate before a
	// single input was even chosen (cairn perf: send-flow prev-tx fetch fixed
	// upstream of coin selection). p2pkh carries no witnessUtxo at all —
	// selectUTXO can only learn a legacy input's value from its full previous
	// transaction — so that fetch cannot be deferred and stays eager below.
	const deferredNonWitness = scriptType !== 'p2pkh' && scriptType !== 'p2tr' && !!params.fetchRawTx;

	const inputs: Record<string, unknown>[] = [];
	for (const utxo of spendable) {
		// Coinbase inputs MUST carry the full previous transaction — hardware
		// signers require it to safely sign a mining reward. Every non-p2tr input
		// gets nonWitnessUtxo when fetchRawTx is present (eagerly for p2pkh here,
		// deferred to the chosen set for segwit below); this only rejects the
		// pathological case of a coinbase spend with no fetcher configured at all.
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
			// Legacy inputs carry no witnessUtxo — selectUTXO can only learn their
			// value from the full previous transaction, so this fetch cannot wait
			// for selection to run.
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
			// Fetched AFTER selection, for only the coins actually chosen (see
			// fetchChosenPrevTxs + each branch's attach step below) — never here,
			// over the full candidate set.
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

	/**
	 * Fetch nonWitnessUtxo for exactly the CHOSEN coins, concurrently — the
	 * entire point of deferring past the per-candidate loop above. Fires one
	 * rawPrevTx per UNIQUE txid (prevTxCache already dedupes coins that share a
	 * parent, and rawPrevTx itself keeps the existing hash-verification and, via
	 * chain/index.ts's getTxHex, a cross-build LRU) and lets them race instead
	 * of paying N serial round-trips. No-op when this wallet doesn't defer
	 * (p2pkh, p2tr, or no fetchRawTx configured).
	 */
	async function fetchChosenPrevTxs(chosenUtxos: SpendableUtxo[]): Promise<void> {
		if (!deferredNonWitness) return;
		const uniqueTxids = [...new Set(chosenUtxos.map((u) => u.txid))];
		await Promise.all(uniqueTxids.map((txid) => rawPrevTx(txid)));
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
		// Send-max spends every candidate, so "chosen" is the whole set — no
		// reduction in fetch count here, but the fetch still runs concurrently
		// rather than serially (Part B of the fix).
		await fetchChosenPrevTxs(spendable);
		if (deferredNonWitness) {
			for (let i = 0; i < inputs.length; i++) {
				const raw = prevTxCache.get(spendable[i].txid);
				if (raw) inputs[i].nonWitnessUtxo = raw;
			}
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
		// exactInputs spends every provided coin, so "chosen" is the whole set —
		// no reduction in fetch count here, but still concurrent rather than
		// serial (Part B of the fix).
		await fetchChosenPrevTxs(chosen);
		if (deferredNonWitness) {
			for (let i = 0; i < inputs.length; i++) {
				const raw = prevTxCache.get(spendable[i].txid);
				if (raw) inputs[i].nonWitnessUtxo = raw;
			}
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
		const runSelection = (candidateInputs: typeof inputs) =>
			selectUTXO(
				candidateInputs as never,
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

		// Prefer confirmed coins: try to fund the send from confirmed inputs alone
		// first, and only reach for the wallet's own unconfirmed change (already
		// the sole unconfirmed coins here — received-unconfirmed was excluded
		// above) when confirmed coins can't cover the amount plus fee. `inputs` is
		// 1:1 with `spendable`, so a positional filter yields the confirmed subset.
		const hasUnconfirmed = spendable.some((u) => u.height <= 0);
		const confirmedInputs = hasUnconfirmed
			? inputs.filter((_, i) => spendable[i].height > 0)
			: inputs;

		let selection = confirmedInputs.length > 0 ? runSelection(confirmedInputs) : null;
		if ((!selection || !selection.tx) && hasUnconfirmed) {
			selection = runSelection(inputs);
		}

		if (!selection || !selection.tx) {
			throw new PsbtError(
				coinControl
					? "The selected coins don't cover that amount plus the network fee — select more coins or lower the amount."
					: 'Not enough funds to cover that amount plus the network fee.',
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

		// THE FIX: only now — knowing exactly which coins selectUTXO picked —
		// fetch their previous transactions, concurrently. btc-signer already
		// built `tx` from the witnessUtxo-only candidate inputs during
		// selection, so wire nonWitnessUtxo in with updateInput now that the
		// winners are known (mirrors how the change output's bip32Derivation is
		// patched in below).
		await fetchChosenPrevTxs(chosen);
		if (deferredNonWitness) {
			for (let i = 0; i < tx.inputsLength; i++) {
				const inp = tx.getInput(i);
				const txidHex = inp.txid ? bytesToHex(inp.txid) : null;
				const raw = txidHex ? prevTxCache.get(txidHex) : undefined;
				if (raw) tx.updateInput(i, { nonWitnessUtxo: raw });
			}
		}
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
	/**
	 * Whether every input has enough signature material to finalize/broadcast.
	 * Threshold-aware (qa-findings-R3.md ~line 228): see `summarizePsbt`'s
	 * `threshold` parameter. For a plain single-sig PSBT (the default,
	 * threshold 1) this is exactly "every input has at least one signature."
	 */
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

/**
 * Parse any base64 PSBT into a review-friendly summary. Throws on garbage.
 *
 * `threshold` (default 1) makes `complete` multisig-quorum-aware
 * (qa-findings-R3.md ~line 228): the original computation counted an input as
 * signed the moment it carried ANY signature material — correct for
 * single-sig (1 signature IS complete) but wrong for a multisig PSBT with a
 * threshold above 1, where `summary.complete` could report `true` at, say, a
 * 1-of-2 moment while the separate quorum-aware progress object
 * (`multisigPsbtProgress`, the authority the multisig endpoints and UI
 * actually gate on) correctly reported `false` in the very same API response.
 * Callers that hold a multisig's threshold (the multisig transaction API,
 * the multisig send-review page) pass it through; every single-sig call site
 * omits it and keeps the exact original semantics.
 *
 * This does NOT duplicate multisigPsbtProgress's per-key fingerprint
 * attribution (irrelevant here — this summary never reports per-signer
 * detail) — just a raw per-input signature count against the threshold,
 * finalized inputs always counting as met.
 */
export function summarizePsbt(psbtBase64: string, threshold = 1): PsbtSummary {
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
	let quorumMetInputs = 0;
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
		// A finalized input (script-path or key-path) is complete by
		// construction regardless of threshold — finalizing can strip the
		// per-input partialSig data that would otherwise let us count it.
		const finalized =
			(inp.finalScriptWitness?.length ?? 0) > 0 || (inp.finalScriptSig?.length ?? 0) > 0;
		// Raw per-input signature count: one per cosigner's partialSig entry
		// (script-path multisig), or the single taproot key-path signature.
		// Fields can be present-but-empty on unsigned inputs (btc-signer
		// materializes an empty finalScriptSig) — require actual content.
		const sigCount = (inp.partialSig?.length ?? 0) + ((inp.tapKeySig?.length ?? 0) > 0 ? 1 : 0);
		const hasSig = finalized || sigCount > 0;
		if (hasSig) signedInputs++;
		if (finalized || sigCount >= Math.max(threshold, 1)) quorumMetInputs++;
	}
	return {
		inputCount: tx.inputsLength,
		outputCount: tx.outputsLength,
		outputs,
		inputs,
		change,
		signedInputs,
		complete: quorumMetInputs === tx.inputsLength && tx.inputsLength > 0
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

/** Shape shared by @scure/btc-signer's cloned per-input data (psbt.TransactionInput) —
 *  narrowed to just the fields the finalized/signed/unsigned classification below needs. */
interface FinalizeClassifiableInput {
	finalScriptSig?: Uint8Array;
	finalScriptWitness?: Uint8Array[];
	partialSig?: [Uint8Array, Uint8Array][];
	tapKeySig?: Uint8Array;
	tapScriptSig?: unknown[];
}

/**
 * True when an input already carries BIP174 finalizer output (final_scriptSig /
 * final_scriptwitness) rather than a raw partial_sig — e.g. Bitcoin Core's
 * descriptorprocesspsbt/walletprocesspsbt, whose `finalize` param defaults to
 * `true`. Mirrors multisigPsbt.ts's inputFinalized() (kept file-local: the two
 * finalizers are otherwise independent and there's no shared PSBT-input helper
 * module yet).
 */
function isInputFinalized(inp: FinalizeClassifiableInput): boolean {
	return (inp.finalScriptSig?.length ?? 0) > 0 || (inp.finalScriptWitness?.length ?? 0) > 0;
}

/** True when an input carries no signature material at all — not already
 *  finalized, and no partial/taproot signature to finalize from either. */
function isInputUnsigned(inp: FinalizeClassifiableInput): boolean {
	if (isInputFinalized(inp)) return false;
	if (inp.partialSig && inp.partialSig.length) return false;
	if (inp.tapKeySig) return false;
	if (inp.tapScriptSig && inp.tapScriptSig.length) return false;
	return true;
}

/**
 * Thrown by finalizePsbt when one or more inputs genuinely carry no signature
 * yet (as opposed to a parse/finalize-mechanics failure) — carries the exact
 * counts so callers can render an accurate, non-raw message instead of
 * btc-signer's library-internal exception text.
 */
export class PsbtNotFullySignedError extends Error {
	constructor(
		message: string,
		public readonly unsignedCount: number,
		public readonly totalCount: number
	) {
		super(message);
		this.name = 'PsbtNotFullySignedError';
	}
}

/**
 * The only sighash flag Cairn broadcasts: SIGHASH_ALL (0x01), the
 * whole-transaction commitment. A SIGHASH_SINGLE / SIGHASH_NONE / ANYONECANPAY
 * signature commits to less than the entire transaction and could be replayed
 * onto a different, attacker-chosen transaction spending the same input — so it
 * is refused at finalization, mirroring multisigPsbt.ts's combine-time check
 * (cairn-u2r5). assertSameTransaction only pins the CURRENT draft, so it cannot
 * catch a wrong-sighash signature on its own.
 */
const SIGHASH_ALL = 0x01;

/** Thrown by finalizePsbt when an input carries a signature flagged with a
 *  sighash type other than SIGHASH_ALL. Carries the (0-based) input index so
 *  callers can render an accurate, plain-language message. */
export class PsbtSighashError extends Error {
	constructor(
		message: string,
		public readonly inputIndex: number
	) {
		super(message);
		this.name = 'PsbtSighashError';
	}
}

/** SIGHASH classification of one witness/scriptSig stack item: whether it is a
 *  signature and, if so, whether it commits with SIGHASH_ALL. Non-signatures
 *  (pubkeys, redeem/witness scripts, the CHECKMULTISIG dummy) are 'skip'. */
function stackItemSighash(item: Uint8Array): 'ok' | 'bad' | 'skip' {
	if (item.length === 0) return 'skip';
	// DER-encoded ECDSA signature (SEQUENCE tag 0x30) carries its sighash flag as
	// the trailing byte.
	if (item[0] === 0x30) return item[item.length - 1] === SIGHASH_ALL ? 'ok' : 'bad';
	// 64-byte BIP-340 Schnorr signature = implicit SIGHASH_DEFAULT (== ALL).
	if (item.length === 64) return 'ok';
	// 65-byte Schnorr signature carries an explicit trailing sighash byte; a
	// 65-byte item starting 0x04 is an uncompressed pubkey, not a signature.
	if (item.length === 65 && item[0] !== 0x04) return item[64] === SIGHASH_ALL ? 'ok' : 'bad';
	return 'skip';
}

/** True when a DER ECDSA signature ends in the SIGHASH_ALL flag byte. */
function ecdsaSighashAll(sig: Uint8Array): boolean {
	return sig.length > 0 && sig[sig.length - 1] === SIGHASH_ALL;
}

/** True when a BIP-340 Schnorr signature commits with SIGHASH_ALL: 64 bytes is
 *  SIGHASH_DEFAULT (the taproot ALL-equivalent), 65 bytes must end in 0x01. */
function schnorrSighashAll(sig: Uint8Array): boolean {
	if (sig.length === 64) return true;
	if (sig.length === 65) return sig[64] === SIGHASH_ALL;
	return false;
}

/** The subset of a parsed PSBT input the sighash guard inspects. */
interface SighashCheckableInput {
	sighashType?: number;
	partialSig?: [Uint8Array, Uint8Array][];
	tapKeySig?: Uint8Array;
	tapScriptSig?: [unknown, Uint8Array][];
	finalScriptSig?: Uint8Array;
	finalScriptWitness?: Uint8Array[];
}

/**
 * Refuse any input signed with a sighash type other than SIGHASH_ALL, before it
 * is finalized or passed through (cairn-u2r5). Guards BOTH sibling paths in
 * finalizePsbt: the inputs Cairn finalizes itself (partialSig / tapKeySig) AND
 * the inputs an external signer already finalized (their assembled
 * finalScriptWitness / finalScriptSig), so neither is left unchecked.
 */
function assertInputSighashAll(inp: SighashCheckableInput, index: number): void {
	const reject = () => {
		throw new PsbtSighashError(
			`Input ${index + 1} is signed with a sighash type other than SIGHASH_ALL. Cairn only broadcasts signatures that commit to the entire transaction — re-sign with the default (SIGHASH_ALL) setting.`,
			index
		);
	};
	// PSBT_IN_SIGHASH_TYPE (BIP174 field 0x03): an explicit non-ALL declaration is
	// refused up front. SIGHASH_DEFAULT (0) is taproot's ALL-equivalent, allowed.
	if (inp.sighashType !== undefined && inp.sighashType !== SIGHASH_ALL && inp.sighashType !== 0) {
		reject();
	}
	for (const [, sig] of inp.partialSig ?? []) if (!ecdsaSighashAll(sig)) reject();
	if (inp.tapKeySig && !schnorrSighashAll(inp.tapKeySig)) reject();
	for (const entry of inp.tapScriptSig ?? []) {
		const sig = entry[1];
		if (sig instanceof Uint8Array && !schnorrSighashAll(sig)) reject();
	}
	for (const item of inp.finalScriptWitness ?? []) if (stackItemSighash(item) === 'bad') reject();
	if (inp.finalScriptSig && inp.finalScriptSig.length > 0) {
		let decoded: (number | Uint8Array | bigint)[] = [];
		try {
			decoded = Script.decode(inp.finalScriptSig) as (number | Uint8Array | bigint)[];
		} catch {
			decoded = [];
		}
		for (const item of decoded) {
			if (item instanceof Uint8Array && stackItemSighash(item) === 'bad') reject();
		}
	}
}

/**
 * Finalize a fully-signed PSBT and extract the raw transaction hex ready for
 * broadcast.
 *
 * Inputs an external signer already finalized (Core's descriptorprocesspsbt /
 * walletprocesspsbt default to finalize=true, replacing partial_sig with final
 * witness/scriptSig data per BIP174) are left untouched rather than re-run
 * through btc-signer's finalizeIdx(), which has no "already finalized?"
 * short-circuit and throws "Not enough partial sign" on such inputs. Only
 * inputs that still carry a partial/taproot signature (the normal, not-yet-
 * finalized path) are finalized here.
 *
 * Throws PsbtNotFullySignedError when one or more inputs have no signature at
 * all yet; throws a plain Error (parse failure, malformed signature data,
 * etc.) for anything else — callers must not surface that raw message to end
 * users (cairn QA F3).
 */
export function finalizePsbt(psbtBase64: string): { rawHex: string; txid: string } {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	const total = tx.inputsLength;

	let unsigned = 0;
	for (let i = 0; i < total; i++) {
		const inp = tx.getInput(i);
		// Funds-safety gate (cairn-u2r5): every signature on this input must commit
		// to the WHOLE transaction (SIGHASH_ALL). Checked for both already-finalized
		// pass-through inputs and the ones finalizeIdx handles below.
		assertInputSighashAll(inp, i);
		if (isInputFinalized(inp)) continue; // already done by the external signer — pass through
		if (isInputUnsigned(inp)) {
			unsigned++;
			continue; // no signature to finalize from — don't hand this to finalizeIdx
		}
		tx.finalizeIdx(i);
	}
	if (unsigned > 0) {
		throw new PsbtNotFullySignedError(
			`${unsigned} of ${total} input${total === 1 ? '' : 's'} still need${unsigned === 1 ? 's' : ''} a signature.`,
			unsigned,
			total
		);
	}
	// Defensive: finalizeIdx above either finalizes an input or throws, so this
	// should always hold once the loop completes with unsigned === 0. Kept as a
	// belt-and-suspenders check (mirrors finalizeMultisigPsbt's same guard)
	// rather than trusting that invariant silently.
	if (!tx.isFinal) throw new Error('Transaction has unfinalized inputs.');
	return { rawHex: tx.hex, txid: tx.id };
}
