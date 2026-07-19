// Spend-record lifecycle engine — the single implementation of the
// draft → awaiting-signature → completed/superseded lifecycle that both the
// single-sig (transactions.ts) and multisig (multisigTransactions.ts) services
// run their rows through (cairn-rg99).
//
// Design rule (arch advisor, 2026-07-07, recorded on the bead): do NOT model
// single-sig as "M=1 multisig" — script types, PSBT finalization, and signer
// coordination genuinely differ and stay in the callers. What is unified here
// is the other axis: "a spend record has one lifecycle", parameterized by
// storage location (TxTableSpec — the same {table, ownerColumn} closed-union
// pattern feeBump.ts proved), with construction/signing injected as callbacks.
//
// This is money-moving code carried over verbatim from the two prior parallel
// implementations. The atomic broadcast claim (claimBroadcast) is the
// double-broadcast guard — previously "the most dangerous line in the codebase
// to have two of"; it now exists exactly once. Two prior single-character
// divergences between the sides were deliberately unified (see executeBroadcast
// steps 7-8) and are documented on cairn-rg99.
//
// Import discipline: this is a LEAF module. It imports db/chain/psbt utilities
// only; TxTableSpec/ConstructedSpendDetails come from feeBump.ts as TYPE-ONLY
// imports (erased at runtime, so no module cycle), and walletSync stays a
// dynamic import (walletSync → transactions → spendLifecycle would otherwise
// close an eval-time cycle). transactions.ts re-exports this module's moved
// symbols (BroadcastError by class identity — tests assert instanceof) so every
// existing import site keeps working unchanged.

import { base64 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from './db';
import { getChain } from './chain';
import { withLock } from './keyedLock';
import { broadcastPackage } from './packageRelay';
import { friendlyBroadcastRejection } from './broadcastRejection';
import { checkSelectedInputsChainDepth, type ChainDepthWarning } from './chainDepth';
import {
	summarizePsbt,
	PsbtError,
	type SpendableUtxo,
	type UnconfirmedTrust
} from './bitcoin/psbt';
import type { TxTableSpec, ConstructedSpendDetails } from './feeBump';
import { childLogger } from './logger';

const log = childLogger('spendLifecycle');

/** The wallet-dirty kind (walletSync.ts) each table's rows belong to. */
export function walletKindFor(spec: TxTableSpec): 'wallet' | 'multisig' {
	return spec.table === 'transactions' ? 'wallet' : 'multisig';
}

// ------------------------------------------------------------ shared errors

export class BroadcastError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'already_sent' | 'incomplete' | 'mismatch' | 'rejected'
	) {
		super(message);
		this.name = 'BroadcastError';
	}
}

// -------------------------------------------------- row-shape shared helpers

/**
 * How batch rows persist: `recipient` holds the FIRST address and `amount` the
 * TOTAL sats (so every single-recipient consumer keeps reading something
 * sensible), while the full per-recipient breakdown goes to the `recipients`
 * JSON column, NULL for single sends.
 */
export function recipientsJson(
	recipients: { address: string; amount: number }[]
): string | null {
	return recipients.length > 1 ? JSON.stringify(recipients) : null;
}

/** Parse the batch `recipients` JSON column; null/garbage falls back to the
 *  single-recipient shape derived from the recipient/amount columns. */
export function parseRecipients(
	raw: unknown,
	recipient: string,
	amount: number
): { address: string; amount: number }[] {
	if (typeof raw === 'string' && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed.map((p) => ({ address: String(p.address), amount: Number(p.amount) }));
			}
		} catch {
			/* fall through to the single-recipient shape */
		}
	}
	return [{ address: recipient, amount }];
}

// ------------------------------------------------------ coin reservation
//
// cairn QA R7 §4.7 B4 (P0): concurrent draft builds against the same wallet
// all read the same live Electrum UTXO set with no notion of "already claimed
// by another draft". Automatic selection excludes any coin referenced by one
// of the owner's OTHER in-flight drafts; coin control may still deliberately
// re-target a reserved coin (RBF/respend), surfaced as a non-blocking warning.

/** BTC-denominated amount for user-facing messages — trims trailing zeros. */
function formatBtc(sats: number): string {
	return `${(sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} BTC`;
}

/**
 * Coins referenced by a set of in-flight draft rows, keyed by "txid:vout" →
 * the id(s) of every draft that references it. Pure: a PSBT's input list is
 * read the same way regardless of which table stored it.
 */
export function coinsReservedByDrafts(rows: { id: number; psbt: string }[]): Map<string, number[]> {
	const reserved = new Map<string, number[]>();
	for (const row of rows) {
		let inputs: { txid: string; vout: number }[];
		try {
			inputs = summarizePsbt(row.psbt).inputs;
		} catch {
			continue; // an unparsable stored draft can't be reasoned about — reserves nothing
		}
		for (const inp of inputs) {
			const key = `${inp.txid}:${inp.vout}`;
			const ids = reserved.get(key);
			if (ids) ids.push(row.id);
			else reserved.set(key, [row.id]);
		}
	}
	return reserved;
}

/** In-flight (pre-broadcast) draft coin references for one wallet/multisig. */
export function reservedSpendCoins(spec: TxTableSpec, ownerId: number): Map<string, number[]> {
	const rows = db
		.prepare(
			`SELECT id, psbt FROM ${spec.table}
			 WHERE ${spec.ownerColumn} = ? AND status IN ('draft', 'awaiting_signature')`
		)
		.all(ownerId) as { id: number; psbt: string }[];
	return coinsReservedByDrafts(rows);
}

/** Non-blocking notice that a coin-control build deliberately selected a coin
 *  another in-flight draft also references (RBF/respend stays possible). */
export interface ReservationWarning {
	message: string;
	draftIds: number[];
	coins: { txid: string; vout: number }[];
}

export function reservationErrorMessage(reservedSats: number, draftIds: number[]): string {
	const ids = draftIds.map((id) => `#${id}`).join(', ');
	const one = draftIds.length === 1;
	return (
		`${formatBtc(reservedSats)} is reserved by pending draft${one ? '' : 's'} ${ids} — ` +
		`complete or abort ${one ? 'it' : 'them'} first.`
	);
}

/** Built from the ACTUALLY chosen inputs, so it only fires when a coin-control
 *  build really did land on a reserved coin (never a false positive from a
 *  candidate that selection didn't end up using). */
export function reservationWarningFor(
	chosenInputs: { txid: string; vout: number }[],
	reserved: Map<string, number[]>
): ReservationWarning | null {
	if (reserved.size === 0) return null;
	const hits = chosenInputs.filter((i) => reserved.has(`${i.txid}:${i.vout}`));
	if (hits.length === 0) return null;
	const draftIds = [...new Set(hits.flatMap((i) => reserved.get(`${i.txid}:${i.vout}`)!))].sort(
		(a, b) => a - b
	);
	const ids = draftIds.map((id) => `#${id}`).join(', ');
	const one = draftIds.length === 1;
	return {
		message:
			`${hits.length === 1 ? 'This coin is' : 'These coins are'} also referenced by pending ` +
			`draft${one ? '' : 's'} ${ids} — broadcasting this transaction may conflict with ${one ? 'it' : 'them'}.`,
		draftIds,
		coins: hits.map((i) => ({ txid: i.txid, vout: i.vout }))
	};
}

// ----------------------------------------------------- unconfirmed-coin trust

/**
 * Txids this wallet/multisig has itself broadcast — the signal that
 * distinguishes an unconfirmed coin that is our OWN change (safe to spend)
 * from one received from a stranger's still-unconfirmed tx (risky).
 */
export function ownBroadcastedTxids(spec: TxTableSpec, ownerId: number): Set<string> {
	const rows = db
		.prepare(`SELECT txid FROM ${spec.table} WHERE ${spec.ownerColumn} = ? AND txid IS NOT NULL`)
		.all(ownerId) as { txid: string }[];
	return new Set(rows.map((r) => r.txid.toLowerCase()));
}

/** Tag each UNCONFIRMED coin as own-change vs received; confirmed coins pass
 *  through untouched (their trust is irrelevant to selection). */
export function classifyUnconfirmedTrust(
	utxos: SpendableUtxo[],
	ownTxids: Set<string>
): SpendableUtxo[] {
	return utxos.map((u) => {
		if (u.height > 0) return u;
		const trust: UnconfirmedTrust = ownTxids.has(u.txid.toLowerCase())
			? 'own-change'
			: 'received';
		return { ...u, unconfirmedTrust: trust };
	});
}

// --------------------------------------------------------- row persistence

/** The constructed-PSBT fields a persisted draft needs, plus the chosen input
 *  set the chain-depth/reservation warnings key off. Satisfied by both
 *  ConstructedPsbt and ConstructedMultisigPsbt. */
export interface DraftSpendDetails extends ConstructedSpendDetails {
	inputs: { txid: string; vout: number }[];
}

/**
 * Insert a fresh 'draft' row. Deliberately does NOT catch anything: a SQLite
 * UNIQUE violation must bubble to the caller (feeBump.ts's RBF race guard
 * depends on exactly that behavior for its own insert; this one shares the
 * discipline).
 */
export function insertDraftRow(
	spec: TxTableSpec,
	ownerId: number,
	details: ConstructedSpendDetails
): number {
	const res = db
		.prepare(
			`INSERT INTO ${spec.table} (${spec.ownerColumn}, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			ownerId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			recipientsJson(details.recipients)
		);
	return Number(res.lastInsertRowid);
}

/** The shared COALESCE lifecycle UPDATE behind updateTransaction /
 *  updateMultisigTransaction (access stays with those callers). */
export function updateSpendRow(
	spec: TxTableSpec,
	txId: number,
	fields: { status?: string; psbt?: string; txid?: string }
): void {
	db.prepare(
		`UPDATE ${spec.table}
		 SET status = COALESCE(?, status),
		     psbt = COALESCE(?, psbt),
		     txid = COALESCE(?, txid),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(fields.status ?? null, fields.psbt ?? null, fields.txid ?? null, txId);
}

/**
 * Atomic conditional draft delete (cairn-up0q): guard and delete are one
 * statement so a concurrent broadcast's claim can't be raced. Completed and
 * superseded rows are history and are never deleted; an in-flight broadcast
 * claim blocks deletion unless it is stale (cairn-ytnc: older than the same
 * 60s window broadcast retry uses — a crashed-mid-broadcast claim must not
 * wedge the row undeletable forever).
 */
export function deleteSpendDraft(spec: TxTableSpec, ownerId: number, txId: number): boolean {
	const result = db
		.prepare(
			`DELETE FROM ${spec.table}
			 WHERE id = ? AND ${spec.ownerColumn} = ?
			   AND status NOT IN ('completed', 'superseded')
			   AND (broadcast_started_at IS NULL
			        OR broadcast_started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`
		)
		.run(txId, ownerId);
	return Number(result.changes) > 0;
}

// ------------------------------------------------------- broadcast dedup
//
// cairn QA R7 B4 sub-case 1 (P1): several drafts built from IDENTICAL inputs,
// recipient, amount and fee rate sign to the byte-identical transaction
// (deterministic ECDSA/RFC6979). Once a wallet has ANY 'completed' row for a
// txid, every OTHER draft that resolves to that same txid is recorded as a
// duplicate ('superseded' — already wired everywhere a terminal, kept-for-the-
// record status needs to be) instead of a second completed send.

/** copy explaining a duplicate resolution — shared by the early and late checks. */
export const DUPLICATE_BROADCAST_MESSAGE =
	'This transaction duplicated another draft that already broadcast the identical payment — no new transaction was sent.';

/**
 * Another (different) row of this owner already recorded as 'completed' with
 * this exact txid — i.e. this call's payment was already delivered by an
 * earlier, identical draft. Case-insensitive: txid casing only has to match
 * what that row's own broadcast recorded.
 */
export function findCompletedDuplicate(
	spec: TxTableSpec,
	ownerId: number,
	txid: string,
	excludeId: number
): number | null {
	const row = db
		.prepare(
			`SELECT id FROM ${spec.table}
			 WHERE ${spec.ownerColumn} = ? AND status = 'completed' AND id != ? AND LOWER(txid) = LOWER(?)
			 LIMIT 1`
		)
		.get(ownerId, excludeId, txid) as { id: number } | undefined;
	return row?.id ?? null;
}

/** Record this draft as a duplicate of an already-completed identical
 *  broadcast, never touching (or re-touching) the network for it. */
function markDuplicateBroadcast(spec: TxTableSpec, txId: number, txid: string): void {
	db.prepare(
		`UPDATE ${spec.table}
		 SET status = 'superseded', txid = ?, broadcast_started_at = NULL,
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(txid, txId);
}

// --------------------------------------------------- atomic broadcast claim

/**
 * Atomically claim the broadcast before touching the network — THE
 * double-broadcast guard. The callers' friendly read-checks are racy on their
 * own: two concurrent calls can both see txid IS NULL while the first is
 * awaiting Electrum. This single guarded UPDATE lets exactly one caller
 * through; the loser sees zero affected rows. A stale claim (crash
 * mid-broadcast) expires after 60s so retry isn't wedged forever.
 */
export function claimBroadcast(spec: TxTableSpec, ownerId: number, txId: number): boolean {
	const claimed = db
		.prepare(
			`UPDATE ${spec.table}
			 SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND ${spec.ownerColumn} = ? AND txid IS NULL AND status != 'completed'
			   AND (broadcast_started_at IS NULL
			        OR broadcast_started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`
		)
		.run(txId, ownerId);
	return Number(claimed.changes) > 0;
}

/** Release the broadcast claim so a failed/refused broadcast stays retryable. */
export function releaseBroadcastClaim(spec: TxTableSpec, txId: number): void {
	db.prepare(`UPDATE ${spec.table} SET broadcast_started_at = NULL WHERE id = ?`).run(txId);
}

// ------------------------------------------------------ package-relay rescue

/** Node rejections that a parent+child package can fix: a below-relay-floor
 *  parent, or a child whose parent isn't in this node's mempool. */
const PACKAGE_RESCUABLE_REJECTION =
	/min relay fee|mempool min fee|min fee not met|missingorspent|missing inputs|bad-txns-inputs|too-long-mempool-chain|package/i;

/**
 * Opportunistic package-relay rescue (cairn-u9ob.8): when a single broadcast is
 * rejected for a reason a fee-paying parent+child package could fix, try to
 * resubmit the just-rejected transaction together with its unconfirmed parent(s)
 * as a package. The parents' raw hex is fetched from the chain (only reachable
 * when they've propagated at all); confirmed parents are excluded. Returns the
 * broadcast txid on success, or null to fall back to surfacing the original
 * rejection. Never throws — pure enhancement, must never make a failure worse.
 */
export async function tryPackageRescue(
	signedPsbtBase64: string,
	childRawHex: string,
	childTxid: string,
	rejectionMsg: string
): Promise<string | null> {
	if (!PACKAGE_RESCUABLE_REJECTION.test(rejectionMsg)) return null;
	try {
		const tx = Transaction.fromPSBT(base64.decode(signedPsbtBase64), {
			allowUnknownInputs: true
		});
		const parentTxids = new Set<string>();
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			if (inp.txid) parentTxids.add(bytesToHex(inp.txid));
		}
		if (parentTxids.size === 0) return null;

		const chain = getChain();
		const parentHexes: string[] = [];
		for (const parentTxid of parentTxids) {
			// A confirmed parent doesn't belong in the package; an unreachable one
			// (never propagated) means we can't build a valid package — bail either way.
			let detail;
			try {
				detail = await chain.getTx(parentTxid);
			} catch {
				return null;
			}
			if (detail.confirmed) continue;
			try {
				parentHexes.push(await chain.getTxHex(parentTxid));
			} catch {
				return null; // parent hex unavailable — can't assemble the package
			}
		}
		if (parentHexes.length === 0) return null; // nothing unconfirmed to rescue

		// Parents first (dependency order), then the child.
		const result = await broadcastPackage([...parentHexes, childRawHex]);
		if (result.status !== 'sent') return null;
		log.info({ childTxid, parents: parentHexes.length }, 'broadcast rescued via package relay');
		return childTxid;
	} catch {
		return null; // any failure → fall back to the original rejection
	}
}

// ---------------------------------------------------------- broadcast engine

/** The stored-row fields the broadcast engine reads — satisfied by both
 *  SavedTransaction and SavedMultisigTransaction. */
export interface BroadcastableRow {
	id: number;
	status: string;
	txid: string | null;
	psbt: string;
	replacesTxid: string | null;
}

/**
 * The shared broadcast pipeline — everything both wallet types do identically
 * once a loaded, access-checked row is in hand. The two genuinely divergent
 * steps are injected:
 *
 * - `preparePsbt(tx)` resolves the authoritative signed PSBT: single-sig
 *   normalizes an optionally-substituted PSBT and enforces the same-transaction
 *   guard; multisig merges a final ride-along signature via the normal attach
 *   path. It must throw BroadcastError for user-facing failures, and may return
 *   a refreshed row (multisig's attach persists the merge).
 * - `finalize(psbt, tx)` produces the raw wire bytes + deterministic txid:
 *   single-sig maps PsbtNotFullySignedError/PsbtSighashError to friendly
 *   messages; multisig gates on quorum first. Must throw BroadcastError on
 *   failure.
 *
 * Everything else runs here exactly once for both sides:
 *  1. already-sent guard (friendly, racy — the claim below is the real gate)
 *  2. early duplicate short-circuit (deterministic txid known pre-network)
 *  3. the atomic broadcast claim
 *  4. Electrum broadcast, with opportunistic package-relay rescue; a failed
 *     broadcast releases the claim and surfaces a friendly rejection
 *  5. reported-txid verification against the locally recomputed deterministic
 *     txid (cairn-ziwm) — on mismatch, release the claim and refuse to record
 *  6. late duplicate re-check (closes the concurrent byte-identical-broadcast
 *     window; node:sqlite is synchronous so the check-write pair can't be
 *     interleaved)
 *  7. completed UPDATE — status/txid/psbt/updated_at. Persisting the
 *     authoritative PSBT is what single-sig always did (the substituted signed
 *     PSBT must survive on the completed row); for multisig it rewrites the
 *     identical bytes the attach path already stored (a value-level no-op,
 *     pinned by spendLifecycle.test.ts). Unification recorded on cairn-rg99.
 *  8. supersede the RBF-replaced original (replaces_txid), best-effort.
 *     Unified from two prior one-line divergences (cairn-rg99): predicate
 *     `status = 'completed'` (the tighter single-sig form — only rows recorded
 *     as the live payment flip) inside try/catch (the safer multisig form —
 *     bookkeeping after money moved must never fail a broadcast that already
 *     succeeded).
 *  9. markWalletDirty so the next send load re-scans live (cairn-g1u2);
 *     dynamic import breaks the walletSync cycle, best-effort.
 */
export async function executeBroadcast<TTx extends BroadcastableRow>(args: {
	spec: TxTableSpec;
	ownerId: number;
	txId: number;
	/** The loaded, access-checked row. */
	tx: TTx;
	preparePsbt: (tx: TTx) => Promise<{ psbt: string; tx: TTx }> | { psbt: string; tx: TTx };
	finalize: (psbt: string, tx: TTx) => { rawHex: string; txid: string };
	reload: (rowId: number) => TTx | null;
}): Promise<{ txid: string; transaction: TTx; duplicate?: boolean; message?: string }> {
	const { spec, ownerId, txId } = args;

	// Friendly already-sent guard — racy on its own; the atomic claim below is
	// the real gate.
	if (args.tx.status === 'completed' || args.tx.txid) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	const { psbt, tx } = await args.preparePsbt(args.tx);

	const finalized = args.finalize(psbt, tx);

	const duplicateResult = (txid: string) => {
		markDuplicateBroadcast(spec, txId, txid);
		return {
			txid,
			transaction: args.reload(txId)!,
			duplicate: true as const,
			message: DUPLICATE_BROADCAST_MESSAGE
		};
	};

	// Early duplicate short-circuit: finalized.txid is a deterministic hash of
	// the exact bytes we're about to send, known BEFORE touching the network.
	if (findCompletedDuplicate(spec, ownerId, finalized.txid, txId) !== null) {
		return duplicateResult(finalized.txid);
	}

	// The atomic claim: exactly one concurrent caller proceeds to the network.
	if (!claimBroadcast(spec, ownerId, txId)) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	let reportedTxid: string;
	try {
		reportedTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		const raw = e instanceof Error ? e.message : String(e);
		// Opportunistic package-relay rescue: if the rejection is one a parent+child
		// package could fix, resubmit with the unconfirmed parent(s). Degrades
		// silently to the original error (cairn-u9ob.8).
		const rescued = await tryPackageRescue(psbt, finalized.rawHex, finalized.txid, raw);
		if (rescued) {
			reportedTxid = rescued;
		} else {
			// Release the claim: a failed broadcast must stay retryable.
			releaseBroadcastClaim(spec, txId);
			// Surface the node's rejection reason in as-plain-as-possible language,
			// always confirming nothing was sent (UX-PLAN §5.3 item 4).
			throw new BroadcastError(friendlyBroadcastRejection(raw), 'rejected');
		}
	}

	// A malicious or misbehaving Electrum server can return an arbitrary txid for
	// a broadcast it silently never performed. The real txid is a deterministic
	// double-SHA256 of the exact bytes we just sent (finalized.txid) — recomputed
	// locally, it cannot be forged. If the server's reported txid disagrees, we do
	// NOT trust that the broadcast happened: release the claim so it stays
	// retryable and refuse to record a bogus "sent" txid (cairn-ziwm).
	if (reportedTxid.trim().toLowerCase() !== finalized.txid.toLowerCase()) {
		releaseBroadcastClaim(spec, txId);
		throw new BroadcastError(
			'The server acknowledged the broadcast with a different transaction id than the one we signed — refusing to record it. Check your Electrum server and try again.',
			'rejected'
		);
	}
	const broadcastTxid = finalized.txid;

	// Late re-check: the network call just awaited above is the one place a
	// concurrent, byte-identical broadcast (a second draft racing this one)
	// could have completed FIRST while we were both mid-flight — the early
	// check above can't see that. node:sqlite is synchronous and Node is
	// single-threaded, so from here down nothing yields until we've written a
	// status: this SELECT-then-UPDATE pair can't itself be interleaved by
	// another request. Whichever caller reaches it first wins 'completed';
	// the other is recorded as a duplicate rather than a second "success".
	if (findCompletedDuplicate(spec, ownerId, broadcastTxid, txId) !== null) {
		return duplicateResult(broadcastTxid);
	}

	updateSpendRow(spec, txId, { status: 'completed', psbt, txid: broadcastTxid });
	const updated = args.reload(txId);

	// A successfully broadcast RBF replacement supersedes the transaction it was
	// built to displace: both spend the same inputs, so only one can ever
	// confirm, and the network has now been told to prefer this one. The
	// original stays on record (it WAS broadcast) but leaves the 'completed'
	// pool so nothing treats it as the live payment anymore. Best-effort:
	// bookkeeping must never fail a broadcast that already succeeded.
	if (updated?.replacesTxid) {
		try {
			db.prepare(
				`UPDATE ${spec.table}
				 SET status = 'superseded',
				     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				 WHERE ${spec.ownerColumn} = ? AND txid = ? AND status = 'completed'`
			).run(ownerId, updated.replacesTxid);
		} catch {
			/* superseded bookkeeping is cosmetic; the replacement is already sent */
		}
	}

	// This wallet's coins just changed (we spent one), so mark it dirty BEFORE
	// returning: the next send load must re-scan live rather than serve the
	// pre-spend snapshot from the clean-wallet fast path (cairn-g1u2). The async
	// watcher notification for the scripthash status change may not have landed
	// yet, so don't rely on it — await the mark so it is guaranteed persisted by
	// the time the broadcast response reaches the client (the import is cached and
	// the write synchronous). Dynamic import breaks the walletSync cycle;
	// best-effort, never throws into the broadcast result.
	try {
		const { markWalletDirty } = await import('./walletSync');
		markWalletDirty(walletKindFor(spec), ownerId);
	} catch {
		/* best-effort: a persist hiccup just means the next load re-scans anyway once
		   the watcher notification or the TTL fires */
	}

	return { txid: broadcastTxid, transaction: updated! };
}

// -------------------------------------------------------- draft-build engine

/**
 * The shared draft-build pipeline: per-owner lock, unconfirmed-coin trust
 * classification, the coinbase-maturity tip fetch, reservation exclusion, the
 * reservation-aware shortfall reframe, draft persistence, and the chain-depth /
 * reservation warnings — everything both wallet types do identically around
 * their genuinely different PSBT construction.
 *
 * - `prepare()` runs FIRST, inside the lock: access resolution + anything the
 *   builder needs (the wallet/multisig row). Returning null = not found.
 * - `getUtxos(ctx)` fetches the live coin set (Electrum-backed, per type).
 * - `buildPsbt(ctx, {utxos, tipHeight})` derives change and constructs the
 *   PSBT (constructPsbt vs constructMultisigPsbt). Thrown PsbtError
 *   insufficient_funds/no_utxos is reframed to the reservation message when
 *   the shortfall was genuinely caused by the reservation exclusion.
 * - `onDraftSaved` is the multisig roster-freeze + notify hook.
 */
export async function executeBuildDraft<TCtx, TTx, TDetails extends DraftSpendDetails>(args: {
	spec: TxTableSpec;
	ownerId: number;
	/** Serializes builds per owner (cairn QA R7 B4 follow-up): the reservation
	 *  read is racy across this function's awaits, so concurrent builds for the
	 *  same owner must not overlap. Namespaced per caller ('wallet:{id}' vs
	 *  'multisig-draft:{id}' — the latter deliberately distinct from
	 *  nextMultisigChangeIndex's inner 'multisig:{id}' lock to avoid deadlock). */
	lockKey: string;
	/** Manual coin control: restrict selection to these coins. */
	onlyUtxos?: { txid: string; vout: number }[];
	prepare: () => Promise<TCtx | null> | TCtx | null;
	notFoundError: () => Error;
	getUtxos: (ctx: TCtx) => Promise<SpendableUtxo[]>;
	buildPsbt: (
		ctx: TCtx,
		build: { utxos: SpendableUtxo[]; tipHeight: number | undefined }
	) => Promise<TDetails>;
	reload: (rowId: number) => TTx | null;
	draftSaveError: () => Error;
	onDraftSaved?: (draft: TTx, ctx: TCtx) => void;
}): Promise<{
	draft: TTx;
	details: TDetails;
	chainDepthWarning: ChainDepthWarning | null;
	reservationWarning: ReservationWarning | null;
}> {
	const { spec, ownerId } = args;
	return withLock(args.lockKey, async () => {
		const ctx = await args.prepare();
		if (ctx === null) throw args.notFoundError();

		// Classify unconfirmed coins so selection can spend our own change but never
		// auto-select a stranger's unconfirmed coin (cairn-u9ob.1).
		const utxos = classifyUnconfirmedTrust(
			await args.getUtxos(ctx),
			ownBroadcastedTxids(spec, ownerId)
		);

		// Tip height enables the coinbase-maturity guard — but only fetch it when a
		// coinbase coin is actually present (the vast majority of wallets have none),
		// and never let a transient tip failure block an ordinary send.
		let tipHeight: number | undefined;
		if (utxos.some((u) => u.coinbase)) {
			try {
				tipHeight = (await getChain().getTip()).height;
			} catch {
				// Tip unavailable — leave tipHeight undefined. selectSpendCandidates
				// fails CLOSED for coinbase-flagged coins when the tip is unknown
				// (cairn-oae1.1): excludes them from auto-selection and rejects an
				// explicit coin-control pick, while ordinary (non-coinbase) sends
				// are completely unaffected.
				tipHeight = undefined;
			}
		}

		// cairn QA R7 B4: exclude coins another in-flight draft of THIS owner
		// already references from automatic selection, so concurrent builds stop
		// colliding on the same coin. Coin control is exempt — a user explicitly
		// naming a reserved coin (RBF/respend) still gets it, flagged below.
		const hasCoinControl = (args.onlyUtxos?.length ?? 0) > 0;
		const reserved = reservedSpendCoins(spec, ownerId);
		let candidateUtxos = utxos;
		let reservedSats = 0;
		const reservedDraftIds = new Set<number>();
		if (!hasCoinControl && reserved.size > 0) {
			candidateUtxos = utxos.filter((u) => {
				const ids = reserved.get(`${u.txid}:${u.vout}`);
				if (!ids) return true;
				reservedSats += u.value;
				for (const id of ids) reservedDraftIds.add(id);
				return false;
			});
		}

		let details: TDetails;
		try {
			details = await args.buildPsbt(ctx, { utxos: candidateUtxos, tipHeight });
		} catch (e) {
			// Only reframe a shortfall genuinely caused by the exclusion above — a
			// wallet that has no coins (or no ELIGIBLE coins) regardless of any
			// reservation keeps its ordinary message.
			if (
				!hasCoinControl &&
				reservedDraftIds.size > 0 &&
				e instanceof PsbtError &&
				(e.code === 'insufficient_funds' || e.code === 'no_utxos')
			) {
				throw new PsbtError(
					reservationErrorMessage(reservedSats, [...reservedDraftIds].sort((a, b) => a - b)),
					e.code
				);
			}
			throw e;
		}

		const rowId = insertDraftRow(spec, ownerId, details);
		const draft = args.reload(rowId);
		if (!draft) throw args.draftSaveError();
		args.onDraftSaved?.(draft, ctx);

		// If this draft actually spends an unconfirmed coin, warn (never block) when
		// its mempool chain is near the ancestor/descendant limit (cairn-u9ob.5).
		// Only touches the network when an unconfirmed coin was selected; degrades
		// silently on backends without the v1 CPFP endpoint.
		const chainDepthWarning = await checkSelectedInputsChainDepth(details.inputs, utxos);
		// Coin control deliberately CAN still land on a reserved coin (RBF/respend) —
		// surface it as a warning, never a block, keyed off what was actually chosen.
		const reservationWarning = hasCoinControl
			? reservationWarningFor(details.inputs, reserved)
			: null;
		return { draft, details, chainDepthWarning, reservationWarning };
	});
}
