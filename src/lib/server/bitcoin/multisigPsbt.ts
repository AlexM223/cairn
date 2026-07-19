// Multisig (multisig) PSBT construction, signature combining, quorum progress,
// and finalization — everything a Bitcoin Core deployment would delegate to
// walletcreatefundedpsbt / combinepsbt / finalizepsbt, done locally with
// @scure/btc-signer from Electrum UTXO data. Cairn never holds private keys:
// multisig spends are built here, signed one hardware key at a time elsewhere,
// and merged back through combineMultisigPsbts.
//
// Quorum progress is never stored — it is derived from the PSBT itself via
// multisigPsbtProgress, the single progress authority every endpoint shares, so
// the UI can never disagree with the actual signature state.

import { Transaction, p2ms, p2sh, p2wsh, Script } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
	deriveMultisigAddress,
	multisigKeyDerivations,
	type MultisigConfig
} from './multisig';
import {
	PsbtError,
	assertSameTransaction,
	RBF_SEQUENCE,
	selectSpendCandidates,
	validateRecipientsAndFeeRate,
	type SpendableUtxo,
	type RecipientSpec
} from './psbt';
import { addressToScriptPubKey, getDefaultNetwork, networkParams } from './xpub';
import { signingMassFromFetchedParents, type SigningMass } from './signingMass';
import type { ChainNetwork } from '$lib/types';

/** The only sighash flag Cairn accepts on a co-signer signature: SIGHASH_ALL —
 *  the whole-transaction commitment. Enforced in combineMultisigPsbts. */
const SIGHASH_ALL = 0x01;

/** Script wrapping for the multisig's multisig — mirrors multisigs.ts's type without
 *  importing the DB layer (this module stays pure/chain-free for tests). */
export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/**
 * The shape deriveMultisigAddress returns once script-type support lands in
 * multisig.ts (p2sh variants carry redeemScript; bare p2sh has no
 * witnessScript). Typed locally so this module compiles against both the
 * current p2wsh-only library and the extended one; the scripts themselves are
 * recomputed from sortedPubkeys below, which is correct under either version.
 */
interface DerivedMultisigAddress {
	address: string;
	witnessScript?: Uint8Array;
	redeemScript?: Uint8Array;
	sortedPubkeys: Uint8Array[];
}

export class MultisigPsbtError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'different_transaction'
			| 'foreign_signature'
			| 'wrong_sighash'
			| 'invalid_finalization'
			| 'not_enough_signatures'
			| 'combine_failed'
	) {
		super(message);
		this.name = 'MultisigPsbtError';
	}
}

const DUST_SATS = 546;

// ------------------------------------------------------------ fee estimation
//
// Exact M-of-N input sizing instead of Bastion's flat 110 vB/input:
//
//   multisig script    |script| = 1 (OP_M) + N x (1 push byte + 33 pubkey)
//                                + 1 (OP_N) + 1 (OP_CHECKMULTISIG)
//                                = 3 + 34N bytes
//
//   p2wsh input        non-witness: 36 outpoint + 4 nSequence + 1 empty
//                      scriptSig length = 41 vB.
//                      witness: 1 (item count) + 1 (empty push — the
//                      CHECKMULTISIG dummy) + M x 73 (72-byte DER+sighash
//                      upper bound, plus its length byte) + varint(|script|)
//                      + |script| weight units, divided by 4 and rounded UP
//                      per input (conservative).
//
//   p2sh-p2wsh input   as p2wsh, plus the scriptSig push of the 34-byte
//                      redeemScript (OP_0 PUSH32 <sha256>): 41 + 35 = 76 vB
//                      of non-witness bytes + the same witness.
//
//   p2sh input         no witness; scriptSig = OP_0 + M x 73 + pushdata
//                      overhead + |script|, all at full weight.
//
// Signatures are costed at their 72-byte ceiling, and every division rounds
// up — the estimate can only ever pay slightly MORE per vB than requested,
// never less (verified in tests against the finalized transaction's real
// vsize). Outputs are costed from their actual scriptPubKey length rather
// than a flat 34 vB, so p2wsh/p2tr destinations (43 vB) are priced right.

const SIG_PUSH_BYTES = 73; // 1 length byte + <=72-byte DER signature incl. sighash flag

function varintLen(n: number): number {
	return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

function multisigScriptLen(n: number): number {
	return 3 + 34 * n;
}

/** Worst-case witness size in weight units for an M-of-N CHECKMULTISIG spend. */
function witnessWeight(m: number, n: number): number {
	const scriptLen = multisigScriptLen(n);
	return 1 + 1 + m * SIG_PUSH_BYTES + varintLen(scriptLen) + scriptLen;
}

/** Conservative per-input vsize for one multisig input, by script type. */
export function multisigInputVsize(scriptType: MultisigScriptType, m: number, n: number): number {
	if (scriptType === 'p2wsh') {
		return 41 + Math.ceil(witnessWeight(m, n) / 4);
	}
	if (scriptType === 'p2sh-p2wsh') {
		// scriptSig carries one push of the 34-byte OP_0 PUSH32 redeem script.
		return 41 + 35 + Math.ceil(witnessWeight(m, n) / 4);
	}
	// Legacy p2sh: everything rides in the scriptSig at full weight.
	const scriptLen = multisigScriptLen(n);
	const pushOverhead = scriptLen <= 75 ? 1 : scriptLen <= 255 ? 2 : 3;
	const scriptSigLen = 1 + m * SIG_PUSH_BYTES + pushOverhead + scriptLen;
	return 36 + 4 + varintLen(scriptSigLen) + scriptSigLen;
}

/** vsize of one output paying the given address (8 amount + varint + script). */
function outputVsize(address: string): number {
	const spk = addressToScriptPubKey(address);
	return 8 + varintLen(spk.length) + spk.length;
}

// 4 version + 4 locktime + in/out count varints + segwit marker/flag (2 WU),
// rounded up — matches psbt.ts's constant.
const TX_OVERHEAD_VSIZE = 11;

/**
 * Estimated vsize of a multisig transaction with `numInputs` inputs of this
 * config's script type/quorum and outputs paying `outputAddresses`. Uses the
 * exact same per-input/overhead/output tables constructMultisigPsbt prices fees
 * with, so the multisig CPFP builder can compute a child fee from this number
 * and get a matching vsize back when it builds the real tx. Mirrors
 * psbt.ts's estimateTxVsize (single-sig). See docs/CPFP-UNCONFIRMED-PLAN.md §3.
 */
export function estimateMultisigTxVsize(
	scriptType: MultisigScriptType,
	m: number,
	n: number,
	numInputs: number,
	outputAddresses: string[]
): number {
	return (
		TX_OVERHEAD_VSIZE +
		numInputs * multisigInputVsize(scriptType, m, n) +
		outputAddresses.reduce((s, a) => s + outputVsize(a), 0)
	);
}

// ---------------------------------------------------------------- construction

export interface MultisigConstructParams {
	/** Multisig descriptor config plus its script wrapping (toMultisigConfig's shape). */
	config: MultisigConfig & { scriptType: MultisigScriptType };
	utxos: SpendableUtxo[];
	/**
	 * One or more outputs to pay; a single send is a length-1 array. 'max'
	 * sweeps every candidate coin and is only valid as the sole recipient.
	 */
	recipients: RecipientSpec[];
	feeRate: number; // sat/vB
	/**
	 * The connected node's own relay floor (sat/vB) — resolved by the service
	 * layer from ChainService.getMinFeeRate() and threaded through to
	 * validateRecipientsAndFeeRate (cairn-eacw.2), so a multisig spend can price a
	 * sub-1 fee on a node that relays below 1 sat/vB. Omitted → 1 sat/vB default.
	 */
	minFeeRate?: number;
	/** Change-chain index the change output derives at (chain 1). */
	changeIndex: number;
	/**
	 * The network to encode/decode addresses against (cairn-xqnn7 follow-up),
	 * matching psbt.ts's ConstructParams.network. Defaults to
	 * {@link getDefaultNetwork}, kept in sync with the configured chain
	 * backend, so a regtest/testnet multisig's own bcrt1/tb1 addresses
	 * construct correctly instead of failing against @scure/btc-signer's
	 * mainnet-only NETWORK constant.
	 */
	network?: ChainNetwork;
	/** Raw prev-tx fetch — REQUIRED for legacy p2sh multisigs (nonWitnessUtxo);
	 *  attached alongside witnessUtxo for segwit multisigs when available. */
	fetchRawTx?: (txid: string) => Promise<string>;
	/** Manual coin control: restrict selection to these coins (candidate
	 *  allowlist, not a force-spend list). Ignored when empty. */
	onlyUtxos?: { txid: string; vout: number }[];
	/** RBF replacement: spend EXACTLY the provided utxos (no greedy selection, no
	 *  eligibility/maturity filtering) so the replacement conflicts with the
	 *  original on every input. The whole fee increase comes out of change; a
	 *  change output is required. See bumpMultisigTransaction. */
	exactInputs?: boolean;
	/** Current chain tip height — enables coinbase maturity checking (an immature
	 *  coinbase input is skipped in auto-selection, rejected if explicitly chosen). */
	tipHeight?: number;
}

export interface ConstructedMultisigPsbt {
	psbtBase64: string;
	fee: number; // sats
	feeRate: number; // sat/vB actually paid (fee / estimated vsize)
	vsize: number; // estimate (upper bound; real is never larger)
	amount: number; // total sats across all recipients
	recipient: string; // first recipient — display/storage anchor
	recipients: { address: string; amount: number }[];
	change: { address: string; value: number; index: number } | null;
	inputs: { txid: string; vout: number; value: number; address: string }[];
	/**
	 * Signing-mass estimate over the chosen inputs' parent transactions,
	 * scaled by this multisig's quorum — every one of the M signers processes the
	 * full mass (see signingMass.ts). OPTIONAL by design: computed only from
	 * parents already fetched for nonWitnessUtxo; when any parent wasn't
	 * fetched (no fetchRawTx for a segwit multisig) the block is omitted rather
	 * than understated, and mass computation can never fail construction.
	 */
	signingMass?: SigningMass;
}

function toBigInt(sats: number): bigint {
	return BigInt(Math.round(sats));
}

/** The three scripts a multisig spend can need, computed from the BIP-67 sorted
 *  child pubkeys — deterministic and independent of which multisig.ts fields
 *  are populated. */
function multisigScripts(
	threshold: number,
	sortedPubkeys: Uint8Array[],
	scriptType: MultisigScriptType,
	net: ReturnType<typeof networkParams>
): { scriptPubKey: Uint8Array; witnessScript?: Uint8Array; redeemScript?: Uint8Array } {
	const ms = p2ms(threshold, sortedPubkeys);
	if (scriptType === 'p2wsh') {
		const w = p2wsh(ms, net);
		return { scriptPubKey: w.script, witnessScript: ms.script };
	}
	if (scriptType === 'p2sh-p2wsh') {
		const w = p2wsh(ms, net);
		const s = p2sh(w, net);
		// The p2sh redeem script IS the p2wsh output script (OP_0 PUSH32 <hash>).
		return { scriptPubKey: s.script, witnessScript: ms.script, redeemScript: w.script };
	}
	const s = p2sh(ms, net);
	return { scriptPubKey: s.script, redeemScript: ms.script };
}

/**
 * Build an unsigned multisig PSBT. Everything Bastion's Core node did lands here:
 * per-input witnessScript / redeemScript attachment, one bip32Derivation entry
 * PER MULTISIG KEY (all N — this is what lets signers find their key and what
 * powers per-key attribution in the progress tracker), the same N derivations
 * on the change output (hardware wallets verify change really pays the multisig
 * back), and RBF signaling on every input. Pure with respect to the chain —
 * deterministic and unit-testable.
 */
export async function constructMultisigPsbt(params: MultisigConstructParams): Promise<ConstructedMultisigPsbt> {
	const { config, feeRate } = params;
	const scriptType = config.scriptType;
	const threshold = config.threshold;
	const keyCount = config.keys.length;
	// See MultisigConstructParams.network: the network every address in this
	// build is encoded/decoded against, defaulting to the configured chain
	// backend — matches deriveMultisigAddress's own default (multisig.ts).
	const network = params.network ?? getDefaultNetwork();
	const net = networkParams(network);

	// Recipient/fee validation and coin eligibility + coinbase maturity are the
	// shared spend rules in psbt.ts (validateRecipientsAndFeeRate /
	// selectSpendCandidates) — one source for both wallet types. Confirmed coins
	// are still preferred first (the sort below).
	const { sendMax } = validateRecipientsAndFeeRate(params.recipients, feeRate, params.minFeeRate);
	const { spendable, coinControl } = selectSpendCandidates(params, 'multisig');

	// ---- per-address derivation cache (several UTXOs can share an address) --
	const derivationCache = new Map<
		string,
		{
			scripts: ReturnType<typeof multisigScripts>;
			bip32Derivation: [Uint8Array, { fingerprint: number; path: number[] }][];
		}
	>();
	function deriveFor(chain: 0 | 1, index: number, expectedAddress?: string) {
		const key = `${chain}/${index}`;
		const hit = derivationCache.get(key);
		if (hit) return hit;
		const derived = deriveMultisigAddress(config, chain, index, network) as DerivedMultisigAddress;
		const scripts = multisigScripts(threshold, derived.sortedPubkeys, scriptType, net);
		// Guard against a config/script-type mismatch: the coin's scriptPubKey
		// must be exactly what this multisig's keys produce at this path. A failure
		// here means the address library and this builder disagree (e.g. a p2sh
		// multisig before script-type support landed) — better a clear refusal than
		// a PSBT no device can sign.
		if (
			expectedAddress &&
			bytesToHex(scripts.scriptPubKey) !== bytesToHex(addressToScriptPubKey(expectedAddress))
		) {
			throw new PsbtError(
				`The coin at ${chain}/${index} does not match this multisig's ${scriptType} script — refusing to build from inconsistent data.`,
				'construction_failed'
			);
		}
		const entry = {
			scripts,
			bip32Derivation: multisigKeyDerivations(config, chain, index).map(
				(d) =>
					[d.pubkey, { fingerprint: d.fingerprint, path: d.path }] as [
						Uint8Array,
						{ fingerprint: number; path: number[] }
					]
			)
		};
		derivationCache.set(key, entry);
		return entry;
	}

	// ---- raw prev-tx plumbing (verified against the requested txid) ---------
	const prevTxCache = new Map<string, Uint8Array>();
	async function rawPrevTx(txid: string): Promise<Uint8Array> {
		const hit = prevTxCache.get(txid);
		if (hit) return hit;
		if (!params.fetchRawTx) {
			throw new PsbtError(
				'Legacy multisig inputs need raw previous transactions.',
				'construction_failed'
			);
		}
		const raw = await params.fetchRawTx(txid);
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

	type PsbtInput = Record<string, unknown>;
	async function buildInput(utxo: SpendableUtxo): Promise<PsbtInput> {
		// A coinbase input always needs its full previous transaction to sign.
		if (utxo.coinbase === true && !params.fetchRawTx) {
			throw new PsbtError(
				'Spending a mining reward needs its full previous transaction, which is unavailable right now.',
				'construction_failed'
			);
		}
		const { scripts, bip32Derivation } = deriveFor(utxo.chain, utxo.index, utxo.address);
		const input: PsbtInput = {
			txid: hexToBytes(utxo.txid),
			index: utxo.vout,
			sequence: RBF_SEQUENCE,
			bip32Derivation
		};
		if (scriptType === 'p2sh') {
			// Legacy: signers hash the full previous transaction, so it is required.
			input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
			input.redeemScript = scripts.redeemScript;
		} else {
			input.witnessUtxo = {
				script: addressToScriptPubKey(utxo.address),
				amount: toBigInt(utxo.value)
			};
			input.witnessScript = scripts.witnessScript;
			if (scriptType === 'p2sh-p2wsh') input.redeemScript = scripts.redeemScript;
			// Full prev tx alongside witnessUtxo when available: a bare amount is
			// the classic fee-lying surface and several devices warn without it —
			// and for a coinbase input it's mandatory, not just belt-and-braces.
			if (utxo.coinbase === true || params.fetchRawTx) input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
		}
		return input;
	}

	const inputVsize = multisigInputVsize(scriptType, threshold, keyCount);

	// ------------------------------------------------------------- send max
	if (sendMax) {
		const recipient = params.recipients[0].address;
		const totalIn = spendable.reduce((s, u) => s + u.value, 0);
		const vsize = TX_OVERHEAD_VSIZE + spendable.length * inputVsize + outputVsize(recipient);
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
		for (const u of spendable) tx.addInput(await buildInput(u));
		tx.addOutputAddress(recipient, toBigInt(amount), net);
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
			signingMass: signingMassFromFetchedParents(spendable, prevTxCache, {
				threshold,
				totalKeys: keyCount
			})
		};
	}

	// ---------------------------------------------------- normal coin selection
	// Largest-first accumulation priced with the exact M-of-N input size above.
	// After each added coin, check whether the total covers amount + fee with a
	// change output; failing that, whether it covers a changeless spend (the
	// sub-dust remainder is then absorbed into the fee, standard practice).
	const recipients = params.recipients.map((r) => ({
		address: r.address,
		amount: r.amount as number
	}));
	const totalAmount = recipients.reduce((s, r) => s + r.amount, 0);
	const recipientsVsize = recipients.reduce((s, r) => s + outputVsize(r.address), 0);

	// The change output derives on the multisig's change chain at changeIndex.
	const changeDerived = deriveMultisigAddress(
		config,
		1,
		params.changeIndex,
		network
	) as DerivedMultisigAddress;
	const changeAddress = changeDerived.address;
	const changeVsize = outputVsize(changeAddress);

	const chosen: SpendableUtxo[] = [];
	let totalIn = 0;
	let fee = 0;
	let changeValue = 0;
	let hasChange = false;

	if (params.exactInputs) {
		// ---------------------------------------- exact inputs (RBF replacement)
		// Spend every provided coin exactly as given so the replacement conflicts
		// with the original on every input. Same recipients; the entire fee increase
		// comes out of the change output (a changeless original has nowhere to take
		// it from — the caller refuses that before reaching here).
		chosen.push(...spendable);
		totalIn = spendable.reduce((s, u) => s + u.value, 0);
		const baseVsize = TX_OVERHEAD_VSIZE + chosen.length * inputVsize + recipientsVsize;
		fee = Math.ceil((baseVsize + changeVsize) * feeRate);
		changeValue = totalIn - totalAmount - fee;
		if (changeValue < DUST_SATS) {
			throw new PsbtError(
				'The change output is too small to absorb the higher fee at this rate.',
				'insufficient_funds'
			);
		}
		hasChange = true;
	} else {
		// Confirmed coins first (unconfirmed own-change only when confirmed can't
		// cover the spend), then largest-value-first within each group.
		const candidates = [...spendable].sort(
			(a, b) => Number(b.height > 0) - Number(a.height > 0) || b.value - a.value
		);
		let funded = false;
		for (const u of candidates) {
			chosen.push(u);
			totalIn += u.value;
			const baseVsize = TX_OVERHEAD_VSIZE + chosen.length * inputVsize + recipientsVsize;
			const feeWithChange = Math.ceil((baseVsize + changeVsize) * feeRate);
			if (totalIn >= totalAmount + feeWithChange + DUST_SATS + 1) {
				fee = feeWithChange;
				changeValue = totalIn - totalAmount - fee;
				hasChange = true;
				funded = true;
				break;
			}
			const feeWithout = Math.ceil(baseVsize * feeRate);
			if (totalIn >= totalAmount + feeWithout) {
				// Changeless: whatever exceeds the computed fee (< dust + change cost)
				// goes to the miner rather than creating an unspendable output.
				fee = totalIn - totalAmount;
				funded = true;
				break;
			}
		}
		if (!funded) {
			throw new PsbtError(
				coinControl
					? "The selected coins don't cover that amount plus the network fee — select more coins or lower the amount."
					: 'Not enough confirmed funds to cover that amount plus the network fee.',
				'insufficient_funds'
			);
		}
	}

	// Deterministic input order (txid asc, vout asc — BIP-69).
	chosen.sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);

	const tx = new Transaction();
	for (const u of chosen) tx.addInput(await buildInput(u));

	// BIP-69 output order: value asc, scriptPubKey hex tiebreak.
	const outs = [
		...recipients.map((r) => ({ address: r.address, value: r.amount })),
		...(hasChange ? [{ address: changeAddress, value: changeValue }] : [])
	].sort(
		(a, b) =>
			a.value - b.value ||
			bytesToHex(addressToScriptPubKey(a.address)).localeCompare(
				bytesToHex(addressToScriptPubKey(b.address))
			)
	);
	for (const o of outs) tx.addOutputAddress(o.address, toBigInt(o.value), net);

	// Mark the change output with ALL N key derivations plus its scripts:
	// hardware wallets use these to verify change pays back to the same M-of-N
	// multisig (instead of listing it as a second recipient), and the progress /
	// summary code uses the derivations to identify change on resume.
	if (hasChange) {
		const { scripts, bip32Derivation } = deriveFor(1, params.changeIndex);
		const changeScript = bytesToHex(scripts.scriptPubKey);
		for (let i = 0; i < tx.outputsLength; i++) {
			const out = tx.getOutput(i);
			if (out.script && bytesToHex(out.script) === changeScript) {
				tx.updateOutput(i, {
					bip32Derivation,
					...(scripts.witnessScript ? { witnessScript: scripts.witnessScript } : {}),
					...(scripts.redeemScript ? { redeemScript: scripts.redeemScript } : {})
				});
				break;
			}
		}
	}

	const vsize =
		TX_OVERHEAD_VSIZE +
		chosen.length * inputVsize +
		recipientsVsize +
		(hasChange ? changeVsize : 0);

	return {
		psbtBase64: base64.encode(tx.toPSBT()),
		fee,
		feeRate: Math.round((fee / vsize) * 100) / 100,
		vsize,
		amount: totalAmount,
		recipient: recipients[0].address,
		recipients,
		change: hasChange
			? { address: changeAddress, value: changeValue, index: params.changeIndex }
			: null,
		inputs: chosen.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			address: u.address
		})),
		signingMass: signingMassFromFetchedParents(chosen, prevTxCache, {
			threshold,
			totalKeys: keyCount
		})
	};
}

// ------------------------------------------------------------------- combine

/** The multisig CHECKMULTISIG threshold M encoded as a script's leading opcode
 *  (OP_1..OP_16 => 0x51..0x60); null when it isn't a recognizable small-int op. */
function scriptThreshold(script: Uint8Array): number | null {
	if (script.length === 0) return null;
	const op = script[0];
	return op >= 0x51 && op <= 0x60 ? op - 0x50 : null;
}

/** True when a byte array is a DER-encoded ECDSA signature ending in the
 *  SIGHASH_ALL flag byte — the only signature form a CHECKMULTISIG witness may
 *  contain for Cairn to adopt an incoming finalization. */
function isSighashAllDerSig(item: Uint8Array): boolean {
	return item.length >= 9 && item[0] === 0x30 && item[item.length - 1] === SIGHASH_ALL;
}

/**
 * cairn-vo6z guard. Validate an incoming PSBT's finalization for input `index`
 * against the multisig scripts CAIRN ITSELF attached to the base input, and
 * return the finalization fields safe to adopt — or throw.
 *
 * combineMultisigPsbts used to copy an incoming finalScriptWitness /
 * finalScriptSig verbatim once the base input wasn't yet finalized. Since
 * assertSameTransaction only pins the unsigned inputs/outputs (never the witness),
 * a cosigner could attach GARBAGE finalization — zero real signatures — that
 * durably marked the shared draft "ready to broadcast" while the network rejects
 * it, and honest signers couldn't recover: an availability DoS on shared funds
 * that also contradicted MANUAL §18.9's "tampered PSBT rejected" claim.
 *
 * We bind the finalization to the base input's authoritative witnessScript /
 * redeemScript (a garbage or foreign witness can't reproduce it) and require
 * every embedded signature to be a SIGHASH_ALL ECDSA signature meeting the
 * script's own quorum — refusing anything else. Legitimate finalizations (e.g.
 * a cosigner tool like Bitcoin Core that finalizes as it adds the last signature
 * and strips its partialSig into the witness — cairn-8y3b) reproduce the exact
 * witnessScript and carry real SIGHASH_ALL signatures, so they pass untouched.
 */
function validatedFinalization(
	cur: { witnessScript?: Uint8Array; redeemScript?: Uint8Array },
	inc: { finalScriptWitness?: Uint8Array[]; finalScriptSig?: Uint8Array },
	index: number
): { finalScriptWitness?: Uint8Array[]; finalScriptSig?: Uint8Array } {
	const fail = (why: string): never => {
		throw new MultisigPsbtError(
			`The finalized signature data for input ${index + 1} ${why} — refusing to adopt it. If a cosigner's tool finalized the transaction, ask them to share the PSBT with its individual signatures instead of a finalized one.`,
			'invalid_finalization'
		);
	};

	// Segwit multisig (p2wsh, p2sh-p2wsh): the witness stack is
	// <dummy> <sig_1> … <sig_M> <witnessScript>. Bind the trailing element to the
	// witnessScript Cairn attached at construction.
	if (cur.witnessScript && cur.witnessScript.length > 0) {
		const witness = inc.finalScriptWitness ?? [];
		if (witness.length < 2) fail('is missing its witness data');
		const trailing = witness[witness.length - 1];
		if (bytesToHex(trailing) !== bytesToHex(cur.witnessScript)) {
			fail("doesn't match this multisig's script");
		}
		const sigItems = witness.slice(0, -1).filter((w) => w.length > 0);
		if (sigItems.length === 0) fail('carries no signatures');
		for (const sig of sigItems) {
			if (!isSighashAllDerSig(sig)) fail('contains a signature that is not a SIGHASH_ALL signature');
		}
		const m = scriptThreshold(cur.witnessScript);
		if (m !== null && sigItems.length < m) fail('does not carry enough signatures to be complete');
		// Adopt the validated witness. For p2sh-p2wsh, rebuild the scriptSig from
		// the authoritative redeemScript rather than trusting the incoming one.
		const adopted: { finalScriptWitness?: Uint8Array[]; finalScriptSig?: Uint8Array } = {
			finalScriptWitness: witness
		};
		if (cur.redeemScript && cur.redeemScript.length > 0) {
			adopted.finalScriptSig = Script.encode([cur.redeemScript]);
		}
		return adopted;
	}

	// Legacy p2sh multisig: everything rides in the scriptSig
	// (OP_0 <sig_1> … <sig_M> <redeemScript>).
	if (cur.redeemScript && cur.redeemScript.length > 0) {
		if (!inc.finalScriptSig || inc.finalScriptSig.length === 0) fail('is missing its scriptSig');
		let decoded: (number | Uint8Array | bigint)[];
		try {
			decoded = Script.decode(inc.finalScriptSig!) as (number | Uint8Array | bigint)[];
		} catch {
			return fail('could not be parsed');
		}
		const trailing = decoded[decoded.length - 1];
		if (!(trailing instanceof Uint8Array) || bytesToHex(trailing) !== bytesToHex(cur.redeemScript)) {
			fail("doesn't match this multisig's script");
		}
		const sigItems = decoded
			.slice(0, -1)
			.filter((d): d is Uint8Array => d instanceof Uint8Array && d.length > 0);
		if (sigItems.length === 0) fail('carries no signatures');
		for (const sig of sigItems) {
			if (!isSighashAllDerSig(sig)) fail('contains a signature that is not a SIGHASH_ALL signature');
		}
		const m = scriptThreshold(cur.redeemScript);
		if (m !== null && sigItems.length < m) fail('does not carry enough signatures to be complete');
		return { finalScriptSig: inc.finalScriptSig };
	}

	// No authoritative script on the base input — we cannot validate the
	// finalization (Cairn's own drafts always carry it), so refuse to adopt.
	return fail('could not be validated against this multisig');
}

/**
 * Merge the partial signatures of `incoming` into `base` — Cairn's local
 * combinepsbt. Both PSBTs must commit to the IDENTICAL unsigned transaction
 * (same inputs, same outputs); anything else is refused with a clear error
 * rather than silently adopted. Idempotent: re-submitting a PSBT whose
 * signatures are already present is harmless (signers re-exporting the same
 * file must never wedge a session), and a re-sign with a different nonce from
 * an already-counted key is ignored rather than treated as a conflict.
 *
 * Every incoming signature's pubkey must appear in that input's
 * bip32Derivation list — a signature from a key outside the multisig is rejected
 * (it could never contribute to the witness and indicates the wrong device or
 * the wrong wallet signed).
 *
 * If the incoming PSBT arrives already finalized (a device that completes the
 * quorum may finalize and strip partialSig), its finalization is adopted ONLY
 * after validatedFinalization binds it to this multisig's own witnessScript /
 * redeemScript and confirms every embedded signature is a real SIGHASH_ALL
 * signature — a cosigner cannot brick a shared draft with garbage finalization
 * (cairn-vo6z). A finalization that fails validation is refused with
 * 'invalid_finalization'.
 *
 * Every incoming signature must also be flagged SIGHASH_ALL (trailing byte
 * 0x01). A co-signer or a buggy/malicious device could otherwise slip in a
 * SIGHASH_SINGLE / SIGHASH_NONE / ANYONECANPAY signature that Cairn would count
 * toward quorum and broadcast — such a signature commits to less than the whole
 * transaction and could be legally replayed onto a different, attacker-chosen
 * transaction spending the same input (cairn-srte). We reject anything but
 * SIGHASH_ALL at combine time rather than trusting the finalize path.
 */
export function combineMultisigPsbts(basePsbt: string, incomingPsbt: string): string {
	try {
		assertSameTransaction(basePsbt, incomingPsbt);
	} catch (e) {
		throw new MultisigPsbtError(
			e instanceof Error && e.name === 'PsbtMismatchError'
				? e.message
				: 'The signed PSBT could not be read.',
			'different_transaction'
		);
	}

	let base: Transaction;
	let incoming: Transaction;
	try {
		base = Transaction.fromPSBT(base64.decode(basePsbt.trim()));
		incoming = Transaction.fromPSBT(base64.decode(incomingPsbt.trim()));
	} catch {
		throw new MultisigPsbtError('The signed PSBT could not be read.', 'combine_failed');
	}

	for (let i = 0; i < base.inputsLength; i++) {
		const cur = base.getInput(i);
		const inc = incoming.getInput(i);

		// The unsigned draft carries every multisig key's derivation on each input —
		// that list is the membership check for arriving signatures.
		const multisigPubkeys = new Set((cur.bip32Derivation ?? []).map(([pk]) => bytesToHex(pk)));
		const present = new Set((cur.partialSig ?? []).map(([pk]) => bytesToHex(pk)));

		const additions: [Uint8Array, Uint8Array][] = [];
		for (const [pubkey, sig] of inc.partialSig ?? []) {
			const pkHex = bytesToHex(pubkey);
			if (!multisigPubkeys.has(pkHex)) {
				throw new MultisigPsbtError(
					`The signature for input ${i + 1} is from a key that isn't one of this multisig's keys — it looks like the wrong device or the wrong wallet signed.`,
					'foreign_signature'
				);
			}
			// A legacy/segwit-v0 ECDSA signature is DER bytes followed by a single
			// sighash-flag byte; that byte MUST be SIGHASH_ALL (0x01). Anything else
			// (SIGHASH_SINGLE/NONE, or any ANYONECANPAY variant) commits to less than
			// the full transaction and is refused — see the doc comment above.
			if (sig.length === 0 || sig[sig.length - 1] !== SIGHASH_ALL) {
				throw new MultisigPsbtError(
					`The signature for input ${i + 1} is not a SIGHASH_ALL signature — Cairn only accepts signatures that commit to the entire transaction. Re-sign with default (SIGHASH_ALL) settings.`,
					'wrong_sighash'
				);
			}
			if (present.has(pkHex)) continue; // idempotent re-submission
			additions.push([pubkey, sig]);
		}
		if (additions.length > 0) {
			base.updateInput(i, { partialSig: [...(cur.partialSig ?? []), ...additions] }, true);
		}

		// Adopt finalization produced by the quorum-completing signer — but ONLY
		// after validating it against this multisig's own scripts (cairn-vo6z).
		// Copying an incoming witness verbatim let a cosigner brick a shared draft
		// with garbage finalization; validatedFinalization binds it to the base
		// input's authoritative witnessScript / redeemScript and requires real
		// SIGHASH_ALL signatures, throwing 'invalid_finalization' otherwise.
		const curFinal = (cur.finalScriptWitness?.length ?? 0) > 0 || (cur.finalScriptSig?.length ?? 0) > 0;
		const incFinal = (inc.finalScriptWitness?.length ?? 0) > 0 || (inc.finalScriptSig?.length ?? 0) > 0;
		if (!curFinal && incFinal) {
			const adopted = validatedFinalization(cur, inc, i);
			if (adopted.finalScriptWitness) {
				base.updateInput(i, { finalScriptWitness: adopted.finalScriptWitness }, true);
			}
			if (adopted.finalScriptSig) {
				base.updateInput(i, { finalScriptSig: adopted.finalScriptSig }, true);
			}
		}
	}

	return base64.encode(base.toPSBT());
}

// ------------------------------------------------------------------ progress

/**
 * Per-key signature attribution. A key is identified by its ORIGIN — master
 * fingerprint plus account-level path — because that pair is what tells two
 * cosigner keys apart even when they were derived from the SAME seed at
 * different BIP-48 accounts and therefore share a fingerprint (cairn-x54).
 * The `signed` flag itself is computed by exact PUBKEY match: a key is signed
 * only when its own bip32Derivation-derived pubkey at an input's chain/index
 * appears in that input's partialSig list.
 */
export interface MultisigKeyAttribution {
	/** Master fingerprint, 8-hex lowercase (the '00000000' placeholder included
	 *  — the path can still disambiguate such keys). */
	fingerprint: string;
	/** Account-level origin path — the bip32Derivation path minus its trailing
	 *  <chain>/<index>, formatted "m/48'/0'/0'/2'"; "m" for origin-less keys. */
	path: string;
	/** True when this key's own derived pubkey has a partial signature on at
	 *  least one not-yet-finalized input. */
	signed: boolean;
}

export interface MultisigSigningProgress {
	/** Quorum M — signatures needed to spend. */
	required: number;
	/** Signatures collected: the MINIMUM per-input count (a transaction is only
	 *  as signed as its least-signed input), forced up to `required` once the
	 *  PSBT is finalizable — finalization strips per-key data, and a complete
	 *  transaction is by definition fully signed. */
	collected: number;
	/** True when every input can be finalized (checked by actually finalizing a
	 *  throwaway parse — the same authority broadcast uses, so UI and server
	 *  can never disagree). */
	complete: boolean;
	/**
	 * Per-key attribution by pubkey — one entry per distinct key origin
	 * (fingerprint + account path) found in the PSBT's bip32Derivation entries.
	 * THIS is what per-key UI must render from: unlike `signedFingerprints`, it
	 * never conflates two keys that share a master fingerprint. May be empty
	 * (or all-unsigned) on a finalized PSBT — finalization strips per-input
	 * data, so once `complete` is true attribution can be unknowable and
	 * callers must trust `complete`/`collected` instead of these flags.
	 */
	keys: MultisigKeyAttribution[];
	/** Master fingerprints (8-hex lowercase) whose signatures are present,
	 *  attributed via each input's bip32Derivation. The '00000000' placeholder
	 *  is excluded, and a finalized PSBT may legitimately return [] here —
	 *  per-key data is stripped at finalization. NOTE: fingerprints do NOT
	 *  identify keys — two keys from the same seed at different accounts share
	 *  one fingerprint. Kept for aggregate/back-compat consumers; per-key UI
	 *  must use `keys`. */
	signedFingerprints: string[];
	/** Multisig-key fingerprints with no signature yet (placeholder excluded). */
	remainingFingerprints: string[];
	inputCount: number;
}

function fingerprintHex(fp: number): string {
	return (fp >>> 0).toString(16).padStart(8, '0');
}

const HARDENED_OFFSET = 0x80000000;

/** Account-level origin of a bip32Derivation path: everything before the
 *  trailing <chain>/<index>, formatted the way MultisigKeyDescriptor.path is
 *  ("m/48'/0'/0'/2'"); "m" when the key carries no origin. */
function originPathString(path: number[]): string {
	const origin = path.slice(0, -2);
	if (origin.length === 0) return 'm';
	return `m/${origin
		.map((n) => (n >= HARDENED_OFFSET ? `${n - HARDENED_OFFSET}'` : String(n)))
		.join('/')}`;
}

function inputFinalized(inp: {
	finalScriptWitness?: Uint8Array[];
	finalScriptSig?: Uint8Array;
}): boolean {
	return (inp.finalScriptWitness?.length ?? 0) > 0 || (inp.finalScriptSig?.length ?? 0) > 0;
}

/** Finalize-check on a throwaway parse; never touches the caller's PSBT. */
function canFinalize(psbtBase64: string): boolean {
	try {
		const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
		if (tx.isFinal) return true;
		for (let i = 0; i < tx.inputsLength; i++) {
			if (inputFinalized(tx.getInput(i))) continue;
			tx.finalizeIdx(i);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * The single quorum-progress authority (every endpoint and the UI read this
 * shape, so they can never disagree). Throws on unparseable input — callers
 * own the "corrupt PSBT" presentation.
 */
export function multisigPsbtProgress(psbtBase64: string, threshold: number): MultisigSigningProgress {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	const inputCount = tx.inputsLength;

	const allFingerprints = new Set<string>();
	const signedFingerprints = new Set<string>();
	// Per-key states keyed by origin identity (fingerprint + account path) —
	// the pair that stays distinct when several keys share one fingerprint.
	const keyStates = new Map<string, MultisigKeyAttribution>();
	let minSigs = Infinity;

	for (let i = 0; i < inputCount; i++) {
		const inp = tx.getInput(i);
		const byPubkey = new Map<string, { fp: string; keyId: string }>();
		for (const [pubkey, der] of inp.bip32Derivation ?? []) {
			const fp = fingerprintHex(der.fingerprint);
			const path = originPathString(der.path);
			const keyId = `${fp}/${path}`;
			byPubkey.set(bytesToHex(pubkey), { fp, keyId });
			if (!keyStates.has(keyId)) keyStates.set(keyId, { fingerprint: fp, path, signed: false });
			if (fp !== '00000000') allFingerprints.add(fp);
		}

		// Attribute by exact pubkey → key origin, NEVER by bare fingerprint: keys
		// from the same seed at different accounts share a fingerprint, and only
		// this per-pubkey match tells them apart (cairn-x54).
		let count = 0;
		for (const [pubkey] of inp.partialSig ?? []) {
			const hit = byPubkey.get(bytesToHex(pubkey));
			if (hit === undefined) continue; // foreign sig — combine refuses these; don't count
			count++;
			keyStates.get(hit.keyId)!.signed = true;
			if (hit.fp !== '00000000') signedFingerprints.add(hit.fp);
		}

		if (inputFinalized(inp)) {
			// A finalized input's quorum is complete by construction, so its count is
			// the threshold. But the tool that finalized it may have stripped only
			// ITS OWN partialSig into the witness — the EARLIER signers' partialSigs
			// often survive on the combined PSBT (combineMultisigPsbts keeps them).
			// Attribute those (done just above) so the stepper shows "N-1 of N signed"
			// instead of a misleading "0 of N" at the very moment the tx went complete
			// — the one signer whose tool finalized is the only unattributable one
			// (its sig lives in the witness now). Callers still trust complete/collected
			// for the authoritative count (cairn-8y3b).
			minSigs = Math.min(minSigs, threshold);
			continue;
		}

		minSigs = Math.min(minSigs, count);
	}

	const complete = inputCount > 0 && canFinalize(psbtBase64);
	let collected = inputCount === 0 || minSigs === Infinity ? 0 : minSigs;
	// Finalization gotcha: the quorum-completing signature may strip per-input
	// data, leaving the raw count BELOW the threshold — a complete transaction
	// is by definition fully signed, so never report less.
	if (complete) collected = Math.max(collected, threshold);

	return {
		required: threshold,
		collected,
		complete,
		keys: [...keyStates.values()].sort(
			(a, b) => a.path.localeCompare(b.path) || a.fingerprint.localeCompare(b.fingerprint)
		),
		signedFingerprints: [...signedFingerprints].sort(),
		remainingFingerprints: [...allFingerprints].filter((fp) => !signedFingerprints.has(fp)).sort(),
		inputCount
	};
}

// ------------------------------------------------------------------ finalize

/**
 * cairn-vo6z, finalize entry. Validate any finalization ALREADY present on an
 * input when finalizeMultisigPsbt is reached directly — the stateless broadcast
 * flow (broadcastStatelessPsbt) finalizes a client-submitted PSBT WITHOUT going
 * through the validated combine, so this is the sibling entry point to
 * combineMultisigPsbts's adoption guard. Only validates when the input still
 * carries this multisig's authoritative witnessScript / redeemScript; a foreign
 * tool that stripped the script post-finalization (a legitimate broadcast the
 * user assembled elsewhere) can't be checked and is passed through unchanged.
 */
function assertFinalizationValid(
	inp: {
		witnessScript?: Uint8Array;
		redeemScript?: Uint8Array;
		finalScriptWitness?: Uint8Array[];
		finalScriptSig?: Uint8Array;
	},
	index: number
): void {
	const hasScript = (inp.witnessScript?.length ?? 0) > 0 || (inp.redeemScript?.length ?? 0) > 0;
	if (!hasScript) return;
	// Validates the input's finalization against its own authoritative script;
	// throws MultisigPsbtError('invalid_finalization') on a tampered witness.
	validatedFinalization(inp, inp, index);
}

/**
 * Finalize a quorum-complete multisig PSBT and extract the raw transaction ready
 * for broadcast. btc-signer assembles the CHECKMULTISIG witness itself,
 * walking the witness script's pubkeys in order — which IS the BIP-67 order,
 * since the script was built from sorted keys — and taking the first M
 * matching signatures, so signature ordering is handled correctly for both
 * p2wsh and p2sh multisig (verified in tests). Inputs a signer already
 * finalized are left as-is.
 *
 * Throws MultisigPsbtError('not_enough_signatures') below quorum.
 */
export function finalizeMultisigPsbt(psbtBase64: string): {
	rawHex: string;
	txid: string;
	vsize: number;
} {
	let tx: Transaction;
	try {
		tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	} catch {
		throw new MultisigPsbtError('The stored PSBT could not be read.', 'combine_failed');
	}
	// Re-validate any pre-existing finalization BEFORE the finalize loop, so a
	// tampered witness raises 'invalid_finalization' rather than being swallowed
	// by the loop's 'not_enough_signatures' catch (cairn-vo6z, finalize entry).
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		if (inputFinalized(inp)) assertFinalizationValid(inp, i);
	}
	try {
		for (let i = 0; i < tx.inputsLength; i++) {
			if (inputFinalized(tx.getInput(i))) continue;
			tx.finalizeIdx(i);
		}
	} catch (e) {
		throw new MultisigPsbtError(
			`This transaction does not have enough signatures to finalize yet: ${
				e instanceof Error ? e.message : String(e)
			}`,
			'not_enough_signatures'
		);
	}
	if (!tx.isFinal) {
		throw new MultisigPsbtError(
			'This transaction does not have enough signatures to finalize yet.',
			'not_enough_signatures'
		);
	}
	return { rawHex: tx.hex, txid: tx.id, vsize: tx.vsize };
}
