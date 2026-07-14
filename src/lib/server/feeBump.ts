// Fee-bump engine shared by the single-sig (transactions.ts) and multisig
// (multisigTransactions.ts) transaction services. RBF replacement and CPFP
// child construction follow the exact same rules for both wallet types —
// BIP-125 signaling and rule-4 minimums, the CPFP package fee math and its
// guardrails, and the draft-insert shape — so those live once here,
// parameterized by the pieces that genuinely differ: which table a draft
// row lands in, how the original's inputs are recovered and the replacement
// PSBT is built, and what happens after a draft is saved (multisig freezes
// its signing roster and notifies cosigners).
//
// This is money-moving code: every check, message, and error code here was
// carried over verbatim from the two prior parallel implementations
// (docs/CPFP-UNCONFIRMED-PLAN.md §3; architecture review 2026-07-06 §4).

import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { db } from './db';
import { getChain } from './chain';
import { MAX_FEE_RATE, type SpendableUtxo } from './bitcoin/psbt';
import { checkUnconfirmedChainDepth, type ChainDepthWarning } from './chainDepth';

export class BumpError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'not_found'
			| 'not_bumpable'
			| 'confirmed'
			| 'superseded'
			| 'already_replaced'
			| 'not_rbf'
			| 'no_change'
			| 'fee_too_low'
	) {
		super(message);
		this.name = 'BumpError';
	}
}

export class CpfpError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'not_found'
			| 'no_unconfirmed_output'
			| 'already_confirmed'
			| 'parent_unavailable'
			| 'parent_fee_unknown'
			| 'not_needed'
			| 'coin_too_small'
	) {
		super(message);
		this.name = 'CpfpError';
	}
}

/** BIP-125 signaling threshold: any input sequence below this opts in to RBF. */
export const RBF_SIGNAL_MAX_SEQUENCE = 0xfffffffe;

/**
 * The CPFP fee math (docs/CPFP-UNCONFIRMED-PLAN.md §3). Given the stuck parent's
 * own vsize + fee and the child's estimated vsize, the child must pay enough
 * that the whole PACKAGE (parent + child) averages `targetRate`:
 *
 *   child_fee = ceil(targetRate * (parent_vsize + child_vsize)) - parent_fee
 *
 * Returns the child fee in sats, floored to the child's own minimum-relay
 * requirement — `floorRate` sat/vB over its own size, the node's actual relay
 * floor (cairn-eacw.3/.7) rather than a hardcoded 1, so a sub-1 target can
 * price a genuinely sub-1 child on a node that will relay it. Defaults to 1
 * for callers that haven't threaded a probed floor through. A result <= 0
 * means the parent already meets the target on its own — the caller surfaces
 * "not needed".
 */
export function cpfpChildFee(
	targetRate: number,
	parentVsize: number,
	parentFee: number,
	childVsize: number,
	floorRate = 1
): number {
	const packageFee = Math.ceil(targetRate * (parentVsize + childVsize));
	const childFee = packageFee - parentFee;
	// The child must independently clear the node's relay floor even if the
	// formula returns something tiny (rare, but possible when the parent already
	// paid most of the way there).
	return Math.max(childFee, Math.ceil(floorRate * childVsize));
}

/**
 * Which parallel transaction table a bump/CPFP draft writes to. Both tables
 * share the exact column shape this module inserts; the names are a closed
 * union chosen by the caller — never user input — so template interpolation
 * into SQL is safe (matching db.ts's existing table-name-ternary pattern).
 */
export interface TxTableSpec {
	table: 'transactions' | 'multisig_transactions';
	ownerColumn: 'wallet_id' | 'multisig_id';
}

/** The stored-row fields the shared skeletons read — satisfied by both
 *  SavedTransaction and SavedMultisigTransaction. */
export interface BumpableTxRow {
	status: string;
	txid: string | null;
	fee: number;
	feeRate: number;
	changeIndex: number | null;
	psbt: string;
}

/** The constructed-PSBT fields the skeletons check and persist — satisfied by
 *  both ConstructedPsbt and ConstructedMultisigPsbt. */
export interface ConstructedSpendDetails {
	psbtBase64: string;
	fee: number;
	feeRate: number;
	vsize: number;
	amount: number;
	recipient: string;
	recipients: { address: string; amount: number }[];
	change: { address: string; value: number; index: number } | null;
}

/** Batch sends persist the full breakdown; single sends rely on the
 *  recipient/amount columns (same convention both services always used). */
function recipientsJson(recipients: { address: string; amount: number }[]): string | null {
	return recipients.length > 1 ? JSON.stringify(recipients) : null;
}

/** A SQLite UNIQUE-constraint violation (node:sqlite reports it in the message).
 *  Used to turn the atomic one-replacement-per-original index (db.ts, cairn-yabj)
 *  into the same 'already_replaced' outcome the sequential existence check gives. */
function isUniqueViolation(e: unknown): boolean {
	return e instanceof Error && /unique constraint/i.test(e.message);
}

/**
 * Build and persist a replace-by-fee (BIP-125) replacement for a
 * broadcast-but-unconfirmed transaction: identical inputs, same recipients and
 * amounts, higher fee taken entirely out of the change output. The replacement
 * is saved as a fresh draft (replaces_txid → the original's txid) and re-enters
 * the caller's normal sign-and-broadcast flow; the original is marked
 * 'superseded' only once the replacement actually broadcasts.
 *
 * The caller has already resolved access and loaded the row; `buildReplacement`
 * carries everything wallet-type-specific (input recovery, change-address
 * derivation, the construct*Psbt call) and runs only after every shared
 * precondition below has passed, with the validated change index in hand.
 */
export async function executeRbfBump<TDraft, TDetails extends ConstructedSpendDetails>(args: {
	spec: TxTableSpec;
	/** The owning wallet/multisig id (the spec.ownerColumn value). */
	ownerId: number;
	tx: BumpableTxRow;
	newFeeRate: number;
	/** Build the replacement PSBT. `minFeeRate` is the node's relay floor, threaded
	 *  through to the builder's validation (cairn-eacw.2) so a replacement whose
	 *  requested rate is sub-1 (bumping an already-sub-1 original) isn't rejected by
	 *  the default 1 sat/vB floor before BIP-125 rule 4 gets its say below. */
	buildReplacement: (stored: Transaction, changeIndex: number, minFeeRate: number) => Promise<TDetails>;
	reloadDraft: (rowId: number) => TDraft | null;
	/** Error to throw when the inserted draft row can't be read back. */
	draftSaveError: () => Error;
	/** Post-save hook (multisig freezes the roster + notifies cosigners). */
	onDraftSaved?: (draft: TDraft) => void;
}): Promise<{ draft: TDraft; details: TDetails }> {
	const { spec, tx, newFeeRate } = args;

	if (tx.status === 'superseded') {
		// 'superseded' now covers two cases (transactions.ts's broadcast dedup,
		// cairn QA R7 B4 sub-case 1): a genuine RBF-replaced original, or a draft
		// that turned out to duplicate another draft's already-broadcast, byte-
		// identical payment. Both are equally "not bumpable from here" — the
		// message stays accurate without needing to tell them apart.
		throw new BumpError('This transaction is no longer bumpable from here — it was superseded.', 'superseded');
	}
	if (tx.status !== 'completed' || !tx.txid) {
		throw new BumpError(
			'Only broadcast transactions can be fee-bumped — this one has not been sent yet.',
			'not_bumpable'
		);
	}

	// One live replacement per original: a second concurrent bump would produce
	// two drafts fighting over the same inputs. This SELECT is only a friendly
	// fast-path — it is NOT the real guarantee, because there are awaits (the
	// confirmation check + buildReplacement) between here and the INSERT below, so
	// a concurrent bump can pass this check and then race us to insert. The
	// authoritative guard is the partial UNIQUE index on (owner, replaces_txid)
	// (db.ts, cairn-yabj); the INSERT's catch maps its violation back through this
	// same helper, so the racing loser and a sequential second caller both see an
	// identical 'already_replaced' error.
	const alreadyReplacedError = (): BumpError | null => {
		const existing = db
			.prepare(`SELECT status FROM ${spec.table} WHERE ${spec.ownerColumn} = ? AND replaces_txid = ?`)
			.get(args.ownerId, tx.txid) as { status: string } | undefined;
		if (!existing) return null;
		return new BumpError(
			existing.status === 'completed'
				? 'This transaction was already replaced by a fee bump.'
				: 'A replacement for this transaction is already in progress — finish or discard it first.',
			'already_replaced'
		);
	};
	const preExisting = alreadyReplacedError();
	if (preExisting) throw preExisting;

	// A confirmed transaction is final; there is no fee left to bump. A failed
	// lookup (mempool eviction, backend outage) does NOT block the bump — a
	// replacement draft is harmless either way, and the network will simply
	// treat it as a fresh transaction if the original is truly gone.
	let confirmed = false;
	try {
		confirmed = (await getChain().getTx(tx.txid)).confirmed;
	} catch {
		confirmed = false;
	}
	if (confirmed) {
		throw new BumpError(
			'This transaction has already confirmed — there is no fee to bump.',
			'confirmed'
		);
	}

	let stored: Transaction;
	try {
		stored = Transaction.fromPSBT(base64.decode(tx.psbt));
	} catch {
		throw new BumpError(
			'The stored transaction could not be read, so it cannot be reconstructed.',
			'not_bumpable'
		);
	}

	// BIP-125 rule 1: every input must signal replaceability. Cairn's builders
	// set RBF_SEQUENCE on all inputs, but a pre-RBF-era or hand-imported PSBT
	// might not — the network would silently ignore a replacement, so refuse
	// up front.
	for (let i = 0; i < stored.inputsLength; i++) {
		if ((stored.getInput(i).sequence ?? 0xffffffff) >= RBF_SIGNAL_MAX_SEQUENCE) {
			throw new BumpError(
				"This transaction doesn't signal RBF (replace-by-fee), so the network won't accept a replacement — it can't be fee-bumped.",
				'not_rbf'
			);
		}
	}

	// The fee increase comes out of change; a changeless original has nowhere
	// to take it from without shortchanging a recipient.
	if (tx.changeIndex === null) {
		throw new BumpError(
			'This transaction has no change output to absorb a higher fee, so it cannot be bumped.',
			'no_change'
		);
	}

	if (!Number.isFinite(newFeeRate) || newFeeRate <= tx.feeRate) {
		throw new BumpError(
			`The new fee rate must be higher than the original's effective ${tx.feeRate} sat/vB.`,
			'fee_too_low'
		);
	}

	// The node's own relay floor (cairn-eacw.2/.3) — threaded into the builder so a
	// sub-1 requested replacement rate isn't refused by the default 1 sat/vB floor.
	// Never throws; falls back to 1 sat/vB.
	const floor = await getChain().getMinFeeRate();
	const details = await args.buildReplacement(stored, tx.changeIndex, floor);

	// BIP-125 rule 4: the replacement must pay for its own relay — at least the
	// original's fee plus (replacement vsize × 1 sat/vB), 1 sat/vB being the
	// default incremental relay fee. Our vsize is the same estimator used for
	// fee pricing, which slightly over-approximates real size — erring toward a
	// marginally higher minimum, never an under-paying replacement.
	const minFee = tx.fee + details.vsize;
	if (details.fee < minFee) {
		const minRate = Math.ceil(minFee / details.vsize);
		throw new BumpError(
			`The replacement must pay at least ${minFee} sats (the original fee plus 1 sat/vB for its own size) — try ${minRate} sat/vB or more.`,
			'fee_too_low'
		);
	}

	let res;
	try {
		res = db
			.prepare(
				`INSERT INTO ${spec.table} (${spec.ownerColumn}, status, psbt, recipient, amount, fee, fee_rate, change_index, replaces_txid, recipients)
				 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				args.ownerId,
				details.psbtBase64,
				details.recipient,
				details.amount,
				details.fee,
				details.feeRate,
				details.change?.index ?? null,
				tx.txid,
				recipientsJson(details.recipients)
			);
	} catch (e) {
		// A concurrent bump won the race and inserted its replacement between our
		// SELECT above and this INSERT — the partial UNIQUE index (db.ts) refuses
		// the duplicate. Surface the exact 'already_replaced' error the sequential
		// path raises; only a genuine constraint violation is treated this way.
		if (isUniqueViolation(e)) {
			throw (
				alreadyReplacedError() ??
				new BumpError('This transaction was already replaced by a fee bump.', 'already_replaced')
			);
		}
		throw e;
	}

	const draft = args.reloadDraft(Number(res.lastInsertRowid));
	if (!draft) throw args.draftSaveError();
	args.onDraftSaved?.(draft);
	return { draft, details };
}

/**
 * Build and persist a child-pays-for-parent (CPFP) draft that accelerates a
 * stuck, still-unconfirmed parent by spending the wallet's own unconfirmed
 * output on it and attaching a high fee, so the parent+child package averages
 * `targetFeeRate`. Unlike RBF this creates a genuinely NEW transaction (no
 * replaces_txid) — the parent stays exactly as broadcast. The qualifying
 * unconfirmed output(s) are forced as inputs via coin control and swept back
 * to the wallet's own change address; the whole thing routes through the
 * caller's PSBT builder, not a second one. See docs/CPFP-UNCONFIRMED-PLAN.md §3.
 *
 * The caller has already resolved access; `walletNoun` names the coin source
 * in user-facing messages ("wallet" or "vault"), and prepareChild/buildChild
 * carry the wallet-type-specific change derivation, vsize estimation, and
 * construct*Psbt call.
 */
export async function executeCpfpDraft<TDraft, TDetails extends ConstructedSpendDetails>(args: {
	spec: TxTableSpec;
	ownerId: number;
	parentTxid: string;
	targetFeeRate: number;
	walletNoun: string;
	getUtxos: () => Promise<SpendableUtxo[]>;
	/** Derive the sweep destination and estimate the child's vsize. */
	prepareChild: (
		qualifying: SpendableUtxo[]
	) => Promise<{ changeAddress: string; changeIndex: number; childVsize: number }>;
	/** Build the sweep PSBT. Thrown PsbtError insufficient_funds / no_utxos is
	 *  mapped to CpfpError coin_too_small by this skeleton — don't map it inside.
	 *  `floor` is the node's relay floor (== the childRate's own lower clamp) —
	 *  pass it as the builder's minFeeRate so a genuinely sub-1 child isn't
	 *  re-rejected by validateRecipientsAndFeeRate's default 1 (cairn-eacw.2). */
	buildChild: (input: {
		qualifying: SpendableUtxo[];
		changeAddress: string;
		changeIndex: number;
		childRate: number;
		floor: number;
	}) => Promise<TDetails>;
	/** Should the thrown builder error be mapped to coin_too_small? (Both
	 *  services map PsbtError insufficient_funds/no_utxos.) */
	isCoinTooSmall: (e: unknown) => boolean;
	reloadDraft: (rowId: number) => TDraft | null;
	draftSaveError: () => Error;
	onDraftSaved?: (draft: TDraft) => void;
}): Promise<{
	draft: TDraft;
	details: TDetails;
	cpfp: { parentVsize: number; parentFee: number; childFee: number; targetRate: number };
	chainDepthWarning: ChainDepthWarning | null;
}> {
	const { parentTxid } = args;

	// The connected node's own relay floor (cairn-eacw.3) — replaces the
	// hardcoded 1 sat/vB assumption so a sub-1 target is allowed down to
	// whatever this node will actually relay (cairn-eacw.7). Never throws;
	// falls back to 1 when the node's capability is unknown.
	const floor = await getChain().getRelayFeeFloor();

	// Cap the target at the same ceiling the PSBT builders enforce — this
	// builder is a caller of them, not a bypass of their validation.
	const targetRate = Math.min(
		Number.isFinite(args.targetFeeRate) ? args.targetFeeRate : 0,
		MAX_FEE_RATE
	);
	if (targetRate < floor) {
		throw new CpfpError(
			`The target fee rate must be at least ${floor} sat/vB.`,
			'not_needed'
		);
	}

	// The qualifying coins: this wallet's own UNCONFIRMED outputs on the parent.
	const qualifying = (await args.getUtxos()).filter(
		(u) => u.txid.toLowerCase() === parentTxid.toLowerCase() && u.height <= 0
	);
	if (qualifying.length === 0) {
		throw new CpfpError(
			`This ${args.walletNoun} has no unconfirmed output on that transaction to bump — CPFP needs a coin you can spend from the stuck transaction.`,
			'no_unconfirmed_output'
		);
	}
	// Defense-in-depth (cairn-oae1.5): CPFP is safe from immature-coinbase spends
	// today only by an IMPLICIT invariant — a coinbase output is always mined at
	// a confirmed height, so it can never satisfy the `height <= 0` filter above.
	// Assert that invariant explicitly (shared by both single-sig and multisig,
	// since both route through this function) so a future change to the
	// qualifying filter can't silently regress into CPFP-ing an unverified or
	// immature mining reward — this should be structurally unreachable.
	if (qualifying.some((u) => u.coinbase === true || u.coinbase === 'unknown')) {
		throw new Error(
			'Internal invariant violated: a coinbase-flagged coin qualified as an unconfirmed CPFP input (coinbase outputs are always confirmed).'
		);
	}

	// The parent's real vsize + fee. A confirmed parent has nothing left to
	// accelerate.
	let parentVsize: number;
	let parentFee: number;
	try {
		const parent = await getChain().getTx(parentTxid);
		if (parent.confirmed) {
			throw new CpfpError('That transaction has already confirmed — no CPFP needed.', 'already_confirmed');
		}
		if (parent.fee == null) {
			throw new CpfpError(
				"The parent transaction's fee is unknown, so the CPFP fee can't be computed.",
				'parent_fee_unknown'
			);
		}
		parentVsize = parent.vsize;
		parentFee = parent.fee;
	} catch (e) {
		if (e instanceof CpfpError) throw e;
		throw new CpfpError(
			'The parent transaction could not be looked up right now — try again in a moment.',
			'parent_unavailable'
		);
	}

	// Child = the qualifying coins swept to the wallet's own change address.
	const { changeAddress, changeIndex, childVsize } = await args.prepareChild(qualifying);

	const childFee = cpfpChildFee(targetRate, parentVsize, parentFee, childVsize, floor);
	// A non-positive raw child fee means the parent already meets the target.
	if (Math.ceil(targetRate * (parentVsize + childVsize)) - parentFee <= 0) {
		throw new CpfpError(
			`That transaction already pays about ${Math.round(parentFee / parentVsize)} sat/vB, which meets your ${Math.round(targetRate)} sat/vB target — no CPFP is needed.`,
			'not_needed'
		);
	}

	// The child's OWN rate (fee over its own size) is what the PSBT builder
	// prices with; clamp to [floor, MAX_FEE_RATE] — the node's own relay floor
	// rather than a hardcoded 1, so a capable node can relay a genuinely sub-1
	// child. Because the caller's vsize estimator uses the same tables its
	// builder does, the swept tx's vsize matches childVsize, so the fee it
	// computes lands on childFee.
	const childRate = Math.min(Math.max(childFee / childVsize, floor), MAX_FEE_RATE);

	let details: TDetails;
	try {
		details = await args.buildChild({ qualifying, changeAddress, changeIndex, childRate, floor });
	} catch (e) {
		// The commonest failure: the qualifying coin can't cover the CPFP fee plus
		// a non-dust output — the plan's "this coin isn't big enough" outcome.
		if (args.isCoinTooSmall(e)) {
			throw new CpfpError(
				'That unconfirmed coin is too small to pay the fee needed to accelerate the parent at this rate — lower the target rate or wait for a confirmation.',
				'coin_too_small'
			);
		}
		throw e;
	}

	const res = db
		.prepare(
			`INSERT INTO ${args.spec.table} (${args.spec.ownerColumn}, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			args.ownerId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			recipientsJson(details.recipients)
		);

	const draft = args.reloadDraft(Number(res.lastInsertRowid));
	if (!draft) throw args.draftSaveError();
	args.onDraftSaved?.(draft);

	// A CPFP child always spends the unconfirmed parent, so its chain is exactly
	// what §5 wants checked — warn (never block) if the parent's ancestor chain is
	// near the limit, which would make even this fee-bumping child likely to be
	// rejected. Degrades silently without the v1 CPFP endpoint.
	const chainDepthWarning = await checkUnconfirmedChainDepth([parentTxid]);
	return {
		draft,
		details,
		cpfp: { parentVsize, parentFee, childFee: details.fee, targetRate },
		chainDepthWarning
	};
}
