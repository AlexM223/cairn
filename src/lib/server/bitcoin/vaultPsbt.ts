// Multisig (vault) PSBT construction, signature combining, quorum progress,
// and finalization — everything a Bitcoin Core deployment would delegate to
// walletcreatefundedpsbt / combinepsbt / finalizepsbt, done locally with
// @scure/btc-signer from Electrum UTXO data. Cairn never holds private keys:
// vault spends are built here, signed one hardware key at a time elsewhere,
// and merged back through combineVaultPsbts.
//
// Quorum progress is never stored — it is derived from the PSBT itself via
// vaultPsbtProgress, the single progress authority every endpoint shares, so
// the UI can never disagree with the actual signature state.

import { Transaction, p2ms, p2sh, p2wsh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
	deriveVaultAddress,
	vaultKeyDerivations,
	type VaultConfig
} from './multisig';
import {
	PsbtError,
	assertSameTransaction,
	MAX_FEE_RATE,
	RBF_SEQUENCE,
	type SpendableUtxo,
	type RecipientSpec
} from './psbt';
import { addressToScriptPubKey, isValidAddress } from './xpub';
import { signingMassFromFetchedParents, type SigningMass } from './signingMass';

/** Script wrapping for the vault's multisig — mirrors vaults.ts's type without
 *  importing the DB layer (this module stays pure/chain-free for tests). */
export type VaultScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/**
 * The shape deriveVaultAddress returns once script-type support lands in
 * multisig.ts (p2sh variants carry redeemScript; bare p2sh has no
 * witnessScript). Typed locally so this module compiles against both the
 * current p2wsh-only library and the extended one; the scripts themselves are
 * recomputed from sortedPubkeys below, which is correct under either version.
 */
interface DerivedVaultAddress {
	address: string;
	witnessScript?: Uint8Array;
	redeemScript?: Uint8Array;
	sortedPubkeys: Uint8Array[];
}

export class VaultPsbtError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'different_transaction'
			| 'foreign_signature'
			| 'not_enough_signatures'
			| 'combine_failed'
	) {
		super(message);
		this.name = 'VaultPsbtError';
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

/** Conservative per-input vsize for one vault input, by script type. */
export function vaultInputVsize(scriptType: VaultScriptType, m: number, n: number): number {
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

// ---------------------------------------------------------------- construction

export interface VaultConstructParams {
	/** Vault descriptor config plus its script wrapping (toVaultConfig's shape). */
	config: VaultConfig & { scriptType: VaultScriptType };
	utxos: SpendableUtxo[];
	/**
	 * One or more outputs to pay; a single send is a length-1 array. 'max'
	 * sweeps every candidate coin and is only valid as the sole recipient.
	 */
	recipients: RecipientSpec[];
	feeRate: number; // sat/vB
	/** Change-chain index the change output derives at (chain 1). */
	changeIndex: number;
	/** Raw prev-tx fetch — REQUIRED for legacy p2sh vaults (nonWitnessUtxo);
	 *  attached alongside witnessUtxo for segwit vaults when available. */
	fetchRawTx?: (txid: string) => Promise<string>;
	/** Manual coin control: restrict selection to these coins (candidate
	 *  allowlist, not a force-spend list). Ignored when empty. */
	onlyUtxos?: { txid: string; vout: number }[];
}

export interface ConstructedVaultPsbt {
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
	 * scaled by this vault's quorum — every one of the M signers processes the
	 * full mass (see signingMass.ts). OPTIONAL by design: computed only from
	 * parents already fetched for nonWitnessUtxo; when any parent wasn't
	 * fetched (no fetchRawTx for a segwit vault) the block is omitted rather
	 * than understated, and mass computation can never fail construction.
	 */
	signingMass?: SigningMass;
}

function toBigInt(sats: number): bigint {
	return BigInt(Math.round(sats));
}

/** The three scripts a vault spend can need, computed from the BIP-67 sorted
 *  child pubkeys — deterministic and independent of which multisig.ts fields
 *  are populated. */
function vaultScripts(
	threshold: number,
	sortedPubkeys: Uint8Array[],
	scriptType: VaultScriptType
): { scriptPubKey: Uint8Array; witnessScript?: Uint8Array; redeemScript?: Uint8Array } {
	const ms = p2ms(threshold, sortedPubkeys);
	if (scriptType === 'p2wsh') {
		const w = p2wsh(ms, NETWORK);
		return { scriptPubKey: w.script, witnessScript: ms.script };
	}
	if (scriptType === 'p2sh-p2wsh') {
		const w = p2wsh(ms, NETWORK);
		const s = p2sh(w, NETWORK);
		// The p2sh redeem script IS the p2wsh output script (OP_0 PUSH32 <hash>).
		return { scriptPubKey: s.script, witnessScript: ms.script, redeemScript: w.script };
	}
	const s = p2sh(ms, NETWORK);
	return { scriptPubKey: s.script, redeemScript: ms.script };
}

/**
 * Build an unsigned vault PSBT. Everything Bastion's Core node did lands here:
 * per-input witnessScript / redeemScript attachment, one bip32Derivation entry
 * PER VAULT KEY (all N — this is what lets signers find their key and what
 * powers per-key attribution in the progress tracker), the same N derivations
 * on the change output (hardware wallets verify change really pays the vault
 * back), and RBF signaling on every input. Pure with respect to the chain —
 * deterministic and unit-testable.
 */
export async function constructVaultPsbt(params: VaultConstructParams): Promise<ConstructedVaultPsbt> {
	const { config, feeRate } = params;
	const scriptType = config.scriptType;
	const threshold = config.threshold;
	const keyCount = config.keys.length;

	// ---- recipient / fee validation (same rules and messages as psbt.ts) ----
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

	// ---- candidate coins: confirmed only, optionally coin-controlled --------
	let spendable = params.utxos.filter((u) => u.height > 0);
	if (spendable.length === 0) {
		throw new PsbtError('This vault has no confirmed coins to spend.', 'no_utxos');
	}
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

	// ---- per-address derivation cache (several UTXOs can share an address) --
	const derivationCache = new Map<
		string,
		{
			scripts: ReturnType<typeof vaultScripts>;
			bip32Derivation: [Uint8Array, { fingerprint: number; path: number[] }][];
		}
	>();
	function deriveFor(chain: 0 | 1, index: number, expectedAddress?: string) {
		const key = `${chain}/${index}`;
		const hit = derivationCache.get(key);
		if (hit) return hit;
		const derived = deriveVaultAddress(config, chain, index) as DerivedVaultAddress;
		const scripts = vaultScripts(threshold, derived.sortedPubkeys, scriptType);
		// Guard against a config/script-type mismatch: the coin's scriptPubKey
		// must be exactly what this vault's keys produce at this path. A failure
		// here means the address library and this builder disagree (e.g. a p2sh
		// vault before script-type support landed) — better a clear refusal than
		// a PSBT no device can sign.
		if (
			expectedAddress &&
			bytesToHex(scripts.scriptPubKey) !== bytesToHex(addressToScriptPubKey(expectedAddress))
		) {
			throw new PsbtError(
				`The coin at ${chain}/${index} does not match this vault's ${scriptType} script — refusing to build from inconsistent data.`,
				'construction_failed'
			);
		}
		const entry = {
			scripts,
			bip32Derivation: vaultKeyDerivations(config, chain, index).map(
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
			// the classic fee-lying surface and several devices warn without it.
			if (params.fetchRawTx) input.nonWitnessUtxo = await rawPrevTx(utxo.txid);
		}
		return input;
	}

	const inputVsize = vaultInputVsize(scriptType, threshold, keyCount);

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

	// The change output derives on the vault's change chain at changeIndex.
	const changeDerived = deriveVaultAddress(config, 1, params.changeIndex) as DerivedVaultAddress;
	const changeAddress = changeDerived.address;
	const changeVsize = outputVsize(changeAddress);

	const candidates = [...spendable].sort((a, b) => b.value - a.value);
	const chosen: SpendableUtxo[] = [];
	let totalIn = 0;
	let fee = 0;
	let changeValue = 0;
	let hasChange = false;
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
	for (const o of outs) tx.addOutputAddress(o.address, toBigInt(o.value), NETWORK);

	// Mark the change output with ALL N key derivations plus its scripts:
	// hardware wallets use these to verify change pays back to the same M-of-N
	// vault (instead of listing it as a second recipient), and the progress /
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
 * bip32Derivation list — a signature from a key outside the vault is rejected
 * (it could never contribute to the witness and indicates the wrong device or
 * the wrong wallet signed).
 *
 * If the incoming PSBT arrives already finalized (a device that completes the
 * quorum may finalize and strip partialSig), the final witness is carried
 * through so the signature work isn't lost.
 */
export function combineVaultPsbts(basePsbt: string, incomingPsbt: string): string {
	try {
		assertSameTransaction(basePsbt, incomingPsbt);
	} catch (e) {
		throw new VaultPsbtError(
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
		throw new VaultPsbtError('The signed PSBT could not be read.', 'combine_failed');
	}

	for (let i = 0; i < base.inputsLength; i++) {
		const cur = base.getInput(i);
		const inc = incoming.getInput(i);

		// The unsigned draft carries every vault key's derivation on each input —
		// that list is the membership check for arriving signatures.
		const vaultPubkeys = new Set((cur.bip32Derivation ?? []).map(([pk]) => bytesToHex(pk)));
		const present = new Set((cur.partialSig ?? []).map(([pk]) => bytesToHex(pk)));

		const additions: [Uint8Array, Uint8Array][] = [];
		for (const [pubkey, sig] of inc.partialSig ?? []) {
			const pkHex = bytesToHex(pubkey);
			if (!vaultPubkeys.has(pkHex)) {
				throw new VaultPsbtError(
					`The signature for input ${i + 1} is from a key that isn't one of this vault's keys — it looks like the wrong device or the wrong wallet signed.`,
					'foreign_signature'
				);
			}
			if (present.has(pkHex)) continue; // idempotent re-submission
			additions.push([pubkey, sig]);
		}
		if (additions.length > 0) {
			base.updateInput(i, { partialSig: [...(cur.partialSig ?? []), ...additions] }, true);
		}

		// Adopt finalization produced by the quorum-completing signer.
		const curFinal = (cur.finalScriptWitness?.length ?? 0) > 0 || (cur.finalScriptSig?.length ?? 0) > 0;
		if (!curFinal) {
			if ((inc.finalScriptWitness?.length ?? 0) > 0) {
				base.updateInput(i, { finalScriptWitness: inc.finalScriptWitness }, true);
			}
			if ((inc.finalScriptSig?.length ?? 0) > 0) {
				base.updateInput(i, { finalScriptSig: inc.finalScriptSig }, true);
			}
		}
	}

	return base64.encode(base.toPSBT());
}

// ------------------------------------------------------------------ progress

export interface VaultSigningProgress {
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
	/** Master fingerprints (8-hex lowercase) whose signatures are present,
	 *  attributed via each input's bip32Derivation. The '00000000' placeholder
	 *  is excluded, and a finalized PSBT may legitimately return [] here —
	 *  per-key data is stripped at finalization. */
	signedFingerprints: string[];
	/** Vault-key fingerprints with no signature yet (placeholder excluded). */
	remainingFingerprints: string[];
	inputCount: number;
}

function fingerprintHex(fp: number): string {
	return (fp >>> 0).toString(16).padStart(8, '0');
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
export function vaultPsbtProgress(psbtBase64: string, threshold: number): VaultSigningProgress {
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	const inputCount = tx.inputsLength;

	const allFingerprints = new Set<string>();
	const signedFingerprints = new Set<string>();
	let minSigs = Infinity;

	for (let i = 0; i < inputCount; i++) {
		const inp = tx.getInput(i);
		const byPubkey = new Map<string, string>();
		for (const [pubkey, der] of inp.bip32Derivation ?? []) {
			const fp = fingerprintHex(der.fingerprint);
			byPubkey.set(bytesToHex(pubkey), fp);
			if (fp !== '00000000') allFingerprints.add(fp);
		}

		if (inputFinalized(inp)) {
			// Finalized inputs carry the quorum by construction; their partialSig
			// (and often bip32Derivation) has been stripped, so per-key attribution
			// is no longer possible for them.
			minSigs = Math.min(minSigs, threshold);
			continue;
		}

		let count = 0;
		for (const [pubkey] of inp.partialSig ?? []) {
			const fp = byPubkey.get(bytesToHex(pubkey));
			if (fp === undefined) continue; // foreign sig — combine refuses these; don't count
			count++;
			if (fp !== '00000000') signedFingerprints.add(fp);
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
		signedFingerprints: [...signedFingerprints].sort(),
		remainingFingerprints: [...allFingerprints].filter((fp) => !signedFingerprints.has(fp)).sort(),
		inputCount
	};
}

// ------------------------------------------------------------------ finalize

/**
 * Finalize a quorum-complete vault PSBT and extract the raw transaction ready
 * for broadcast. btc-signer assembles the CHECKMULTISIG witness itself,
 * walking the witness script's pubkeys in order — which IS the BIP-67 order,
 * since the script was built from sorted keys — and taking the first M
 * matching signatures, so signature ordering is handled correctly for both
 * p2wsh and p2sh multisig (verified in tests). Inputs a signer already
 * finalized are left as-is.
 *
 * Throws VaultPsbtError('not_enough_signatures') below quorum.
 */
export function finalizeVaultPsbt(psbtBase64: string): {
	rawHex: string;
	txid: string;
	vsize: number;
} {
	let tx: Transaction;
	try {
		tx = Transaction.fromPSBT(base64.decode(psbtBase64.trim()));
	} catch {
		throw new VaultPsbtError('The stored PSBT could not be read.', 'combine_failed');
	}
	try {
		for (let i = 0; i < tx.inputsLength; i++) {
			if (inputFinalized(tx.getInput(i))) continue;
			tx.finalizeIdx(i);
		}
	} catch (e) {
		throw new VaultPsbtError(
			`This transaction does not have enough signatures to finalize yet: ${
				e instanceof Error ? e.message : String(e)
			}`,
			'not_enough_signatures'
		);
	}
	if (!tx.isFinal) {
		throw new VaultPsbtError(
			'This transaction does not have enough signatures to finalize yet.',
			'not_enough_signatures'
		);
	}
	return { rawHex: tx.hex, txid: tx.id, vsize: tx.vsize };
}
