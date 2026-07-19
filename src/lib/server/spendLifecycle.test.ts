// Parity regression suite for the shared spend-record lifecycle engine
// (spendLifecycle.ts, cairn-rg99): every scenario here runs IDENTICALLY against
// both storage locations — the single-sig `transactions` table and the multisig
// `multisig_transactions` table — so any future edit that forks the two wallet
// types' broadcast-claim behavior again (the pre-rg99 state: two copies of "the
// most dangerous line in the codebase") fails this suite immediately.
//
// These tests drive the engine directly with stub preparePsbt/finalize
// callbacks: the claim/dedup/supersede/forgery machinery is what's under test,
// not PSBT construction (the per-side suites — transactions.test.ts,
// multisigTransactions.test.ts, the concurrency and disruption suites — pin
// the full wire-level paths).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import type { TxTableSpec } from './feeBump';
import {
	BroadcastError,
	claimBroadcast,
	releaseBroadcastClaim,
	findCompletedDuplicate,
	deleteSpendDraft,
	executeBroadcast,
	ownBroadcastedTxids,
	reservedSpendCoins,
	DUPLICATE_BROADCAST_MESSAGE,
	type BroadcastableRow
} from './spendLifecycle';

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: { broadcast: broadcastMock },
		getTx: vi.fn(),
		getTxHex: vi.fn()
	})
}));

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM multisig_transactions; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const TXID_A = 'ab'.repeat(32);
const TXID_B = 'cd'.repeat(32);

interface SeedFields {
	status?: string;
	txid?: string | null;
	psbt?: string;
	replacesTxid?: string | null;
	/** SQLite datetime modifier for broadcast_started_at, e.g. '-120 seconds';
	 *  'now' for a fresh claim; undefined leaves it NULL. */
	claimAge?: string;
}

/** One wallet type's storage location plus the seeding it needs. */
interface Side {
	name: string;
	spec: TxTableSpec;
	seedOwner: (tag: string) => Promise<number>;
	seedRow: (ownerId: number, fields?: SeedFields) => number;
}

function seedRowIn(spec: TxTableSpec, ownerId: number, fields: SeedFields = {}): number {
	const claim =
		fields.claimAge === undefined
			? 'NULL'
			: fields.claimAge === 'now'
				? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
				: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${fields.claimAge}')`;
	const res = db
		.prepare(
			`INSERT INTO ${spec.table} (${spec.ownerColumn}, status, psbt, txid, replaces_txid, recipient, amount, fee, fee_rate, broadcast_started_at)
			 VALUES (?, ?, ?, ?, ?, 'bc1qrecipient', 1000, 200, 1.5, ${claim})`
		)
		.run(
			ownerId,
			fields.status ?? 'draft',
			fields.psbt ?? 'cHNidP8=',
			fields.txid ?? null,
			fields.replacesTxid ?? null
		);
	return Number(res.lastInsertRowid);
}

function rowIn(
	spec: TxTableSpec,
	rowId: number
): {
	id: number;
	status: string;
	txid: string | null;
	psbt: string;
	replacesTxid: string | null;
	claim: string | null;
} | null {
	const r = db
		.prepare(
			`SELECT id, status, txid, psbt, replaces_txid, broadcast_started_at FROM ${spec.table} WHERE id = ?`
		)
		.get(rowId) as Record<string, unknown> | undefined;
	if (!r) return null;
	return {
		id: r.id as number,
		status: r.status as string,
		txid: (r.txid as string | null) ?? null,
		psbt: r.psbt as string,
		replacesTxid: (r.replaces_txid as string | null) ?? null,
		claim: (r.broadcast_started_at as string | null) ?? null
	};
}

const SINGLE_SIG_SPEC: TxTableSpec = { table: 'transactions', ownerColumn: 'wallet_id' };
const MULTISIG_SPEC: TxTableSpec = { table: 'multisig_transactions', ownerColumn: 'multisig_id' };

const sides: Side[] = [
	{
		name: 'single-sig (transactions)',
		spec: SINGLE_SIG_SPEC,
		seedOwner: async (tag) => {
			const user = await registerUser({
				email: `${tag}-ss@example.com`,
				password: 'correct horse battery',
				displayName: 'u'
			});
			const res = db
				.prepare(
					"INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, 'W', 'xpub', ?, 'p2wpkh')"
				)
				.run(user.id, `xpub-${tag}`);
			return Number(res.lastInsertRowid);
		},
		seedRow: (ownerId, fields) => seedRowIn(SINGLE_SIG_SPEC, ownerId, fields)
	},
	{
		name: 'multisig (multisig_transactions)',
		spec: MULTISIG_SPEC,
		seedOwner: async (tag) => {
			const user = await registerUser({
				email: `${tag}-ms@example.com`,
				password: 'correct horse battery',
				displayName: 'u'
			});
			const res = db
				.prepare(
					"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'V', 2, 'p2wsh')"
				)
				.run(user.id);
			return Number(res.lastInsertRowid);
		},
		seedRow: (ownerId, fields) => seedRowIn(MULTISIG_SPEC, ownerId, fields)
	}
];

/** Run executeBroadcast with stub callbacks: the engine machinery is under
 *  test, not PSBT handling. `finalTxid` is what finalize (and, unless
 *  overridden, the mocked server) reports. */
function runBroadcast(side: Side, ownerId: number, rowId: number, finalTxid = TXID_A) {
	const reload = (id: number): BroadcastableRow | null => rowIn(side.spec, id);
	const tx = reload(rowId)!;
	return executeBroadcast<BroadcastableRow>({
		spec: side.spec,
		ownerId,
		txId: rowId,
		tx,
		preparePsbt: (tx) => ({ psbt: tx.psbt, tx }),
		finalize: () => ({ rawHex: 'deadbeef', txid: finalTxid }),
		reload
	});
}

beforeEach(() => {
	wipe();
	broadcastMock.mockReset();
	setSetting('registration_mode', 'open');
});

describe.each(sides)('spend-lifecycle parity — $name', (side) => {
	describe('claimBroadcast (the atomic double-broadcast guard)', () => {
		it('lets exactly one caller claim; a second claim is refused while fresh', async () => {
			const ownerId = await side.seedOwner('claim1');
			const rowId = side.seedRow(ownerId);
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(true);
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(false);
		});

		it('refuses to claim a row that already has a txid or is completed', async () => {
			const ownerId = await side.seedOwner('claim2');
			const withTxid = side.seedRow(ownerId, { status: 'awaiting_signature', txid: TXID_A });
			const completed = side.seedRow(ownerId, { status: 'completed' });
			expect(claimBroadcast(side.spec, ownerId, withTxid)).toBe(false);
			expect(claimBroadcast(side.spec, ownerId, completed)).toBe(false);
		});

		it('refuses a claim scoped to the wrong owner', async () => {
			const ownerId = await side.seedOwner('claim3');
			const rowId = side.seedRow(ownerId);
			expect(claimBroadcast(side.spec, ownerId + 999, rowId)).toBe(false);
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(true);
		});

		it('lets a retry reclaim a stale (>60s, crashed-mid-broadcast) claim', async () => {
			const ownerId = await side.seedOwner('claim4');
			const stale = side.seedRow(ownerId, { claimAge: '-120 seconds' });
			const fresh = side.seedRow(ownerId, { claimAge: '-10 seconds' });
			expect(claimBroadcast(side.spec, ownerId, stale)).toBe(true);
			expect(claimBroadcast(side.spec, ownerId, fresh)).toBe(false);
		});

		it('releaseBroadcastClaim makes the row claimable again', async () => {
			const ownerId = await side.seedOwner('claim5');
			const rowId = side.seedRow(ownerId);
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(true);
			releaseBroadcastClaim(side.spec, rowId);
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(true);
		});
	});

	describe('findCompletedDuplicate', () => {
		it('finds a different completed row with the same txid, case-insensitively', async () => {
			const ownerId = await side.seedOwner('dup1');
			const completed = side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
			const self = side.seedRow(ownerId);
			expect(findCompletedDuplicate(side.spec, ownerId, TXID_A.toUpperCase(), self)).toBe(
				completed
			);
			// The row itself is never its own duplicate.
			expect(findCompletedDuplicate(side.spec, ownerId, TXID_A, completed)).toBeNull();
		});

		it('ignores non-completed rows and other owners', async () => {
			const ownerId = await side.seedOwner('dup2');
			const otherOwner = await side.seedOwner('dup2other');
			side.seedRow(ownerId, { status: 'superseded', txid: TXID_A });
			side.seedRow(ownerId, { status: 'awaiting_signature', txid: TXID_A });
			side.seedRow(otherOwner, { status: 'completed', txid: TXID_A });
			const self = side.seedRow(ownerId);
			expect(findCompletedDuplicate(side.spec, ownerId, TXID_A, self)).toBeNull();
		});
	});

	describe('deleteSpendDraft', () => {
		it('deletes a plain draft, refuses completed/superseded history', async () => {
			const ownerId = await side.seedOwner('del1');
			const draft = side.seedRow(ownerId);
			const completed = side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
			const superseded = side.seedRow(ownerId, { status: 'superseded', txid: TXID_B });
			expect(deleteSpendDraft(side.spec, ownerId, draft)).toBe(true);
			expect(deleteSpendDraft(side.spec, ownerId, completed)).toBe(false);
			expect(deleteSpendDraft(side.spec, ownerId, superseded)).toBe(false);
		});

		it('refuses a row with a fresh in-flight claim but allows a stale one (cairn-ytnc)', async () => {
			const ownerId = await side.seedOwner('del2');
			const inFlight = side.seedRow(ownerId, { claimAge: '-10 seconds' });
			const crashed = side.seedRow(ownerId, { claimAge: '-120 seconds' });
			expect(deleteSpendDraft(side.spec, ownerId, inFlight)).toBe(false);
			expect(deleteSpendDraft(side.spec, ownerId, crashed)).toBe(true);
		});
	});

	describe('executeBroadcast', () => {
		it('happy path: completes the row with txid + the authoritative psbt, claim consumed', async () => {
			const ownerId = await side.seedOwner('bc1');
			const rowId = side.seedRow(ownerId, { psbt: 'cHNidP8=' });
			broadcastMock.mockResolvedValue(TXID_A);
			const result = await runBroadcast(side, ownerId, rowId);
			expect(result.txid).toBe(TXID_A);
			expect(result.duplicate).toBeUndefined();
			const row = rowIn(side.spec, rowId)!;
			expect(row.status).toBe('completed');
			expect(row.txid).toBe(TXID_A);
			// The completed row keeps the authoritative PSBT bytes — for multisig
			// this is a value-level no-op rewrite of what attach already stored
			// (the rg99 unification), never a mutation.
			expect(row.psbt).toBe('cHNidP8=');
			expect(broadcastMock).toHaveBeenCalledTimes(1);
		});

		it('refuses a row that already carries a txid before touching callbacks', async () => {
			const ownerId = await side.seedOwner('bc2');
			const rowId = side.seedRow(ownerId, { status: 'awaiting_signature', txid: TXID_A });
			await expect(runBroadcast(side, ownerId, rowId)).rejects.toMatchObject({
				code: 'already_sent'
			});
			expect(broadcastMock).not.toHaveBeenCalled();
		});

		it('early duplicate: identical txid already completed → superseded, no network call', async () => {
			const ownerId = await side.seedOwner('bc3');
			side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
			const rowId = side.seedRow(ownerId);
			const result = await runBroadcast(side, ownerId, rowId);
			expect(result.duplicate).toBe(true);
			expect(result.message).toBe(DUPLICATE_BROADCAST_MESSAGE);
			const row = rowIn(side.spec, rowId)!;
			expect(row.status).toBe('superseded');
			expect(row.txid).toBe(TXID_A);
			expect(row.claim).toBeNull();
			expect(broadcastMock).not.toHaveBeenCalled();
		});

		it('late duplicate: a concurrent identical broadcast completing mid-flight → superseded', async () => {
			const ownerId = await side.seedOwner('bc4');
			const rowId = side.seedRow(ownerId);
			// Simulate the race: while OUR network call is in flight, another
			// byte-identical draft completes with the same txid.
			broadcastMock.mockImplementation(async () => {
				side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
				return TXID_A;
			});
			const result = await runBroadcast(side, ownerId, rowId);
			expect(result.duplicate).toBe(true);
			expect(rowIn(side.spec, rowId)!.status).toBe('superseded');
			expect(broadcastMock).toHaveBeenCalledTimes(1);
		});

		it('forged server txid: refuses to record, releases the claim, row stays retryable (cairn-ziwm)', async () => {
			const ownerId = await side.seedOwner('bc5');
			const rowId = side.seedRow(ownerId);
			broadcastMock.mockResolvedValue(TXID_B); // server lies
			await expect(runBroadcast(side, ownerId, rowId, TXID_A)).rejects.toMatchObject({
				code: 'rejected'
			});
			const row = rowIn(side.spec, rowId)!;
			expect(row.status).toBe('draft');
			expect(row.txid).toBeNull();
			expect(row.claim).toBeNull(); // retryable
			expect(claimBroadcast(side.spec, ownerId, rowId)).toBe(true);
		});

		it('network rejection: friendly BroadcastError, claim released', async () => {
			const ownerId = await side.seedOwner('bc6');
			const rowId = side.seedRow(ownerId);
			broadcastMock.mockRejectedValue(new Error('dust')); // not package-rescuable
			await expect(runBroadcast(side, ownerId, rowId)).rejects.toBeInstanceOf(BroadcastError);
			const row = rowIn(side.spec, rowId)!;
			expect(row.status).toBe('draft');
			expect(row.claim).toBeNull();
		});

		it('claim race: the loser of two overlapping broadcasts gets already_sent', async () => {
			const ownerId = await side.seedOwner('bc7');
			const rowId = side.seedRow(ownerId);
			// First caller is mid-network (fresh claim on the row) when the second
			// caller arrives.
			let release: (v: string) => void;
			broadcastMock.mockImplementation(() => new Promise((r) => (release = r)));
			const first = runBroadcast(side, ownerId, rowId);
			await new Promise((r) => setImmediate(r)); // let first reach the network await
			await expect(runBroadcast(side, ownerId, rowId)).rejects.toMatchObject({
				code: 'already_sent'
			});
			release!(TXID_A);
			const result = await first;
			expect(result.txid).toBe(TXID_A);
			expect(rowIn(side.spec, rowId)!.status).toBe('completed');
			expect(broadcastMock).toHaveBeenCalledTimes(1);
		});

		it("supersedes the RBF-replaced original — and ONLY rows recorded as 'completed'", async () => {
			const ownerId = await side.seedOwner('bc8');
			// The genuine original: completed with txid A.
			const original = side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
			// Decoy sharing the txid but NOT a completed live payment. Pins the
			// unified predicate (status = 'completed'): the pre-rg99 multisig form
			// (status != 'superseded') would have flipped this row too.
			const decoy = side.seedRow(ownerId, { status: 'awaiting_signature', txid: TXID_A });
			// The replacement draft, built to displace txid A.
			const replacement = side.seedRow(ownerId, { replacesTxid: TXID_A });
			broadcastMock.mockResolvedValue(TXID_B);
			const result = await runBroadcast(side, ownerId, replacement, TXID_B);
			expect(result.txid).toBe(TXID_B);
			expect(rowIn(side.spec, replacement)!.status).toBe('completed');
			expect(rowIn(side.spec, original)!.status).toBe('superseded');
			expect(rowIn(side.spec, decoy)!.status).toBe('awaiting_signature');
		});
	});

	describe('shared row helpers', () => {
		it('ownBroadcastedTxids returns lowercased txids of broadcast rows only', async () => {
			const ownerId = await side.seedOwner('own1');
			side.seedRow(ownerId, { status: 'completed', txid: TXID_A.toUpperCase() });
			side.seedRow(ownerId, { status: 'draft' });
			const txids = ownBroadcastedTxids(side.spec, ownerId);
			expect(txids).toEqual(new Set([TXID_A]));
		});

		it('reservedSpendCoins only counts pre-broadcast (draft/awaiting) rows', async () => {
			const ownerId = await side.seedOwner('res1');
			// Unparsable PSBTs reserve nothing, but only in-flight rows are even read.
			side.seedRow(ownerId, { status: 'completed', txid: TXID_A });
			side.seedRow(ownerId, { status: 'superseded', txid: TXID_B });
			side.seedRow(ownerId, { status: 'draft' });
			expect(reservedSpendCoins(side.spec, ownerId).size).toBe(0);
		});
	});
});

// Cross-side identity: the two wallet types must resolve to DIFFERENT storage
// locations (a copy-paste that pointed both at one table would corrupt data)
// while sharing one engine.
describe('spec sanity', () => {
	it('the two specs are distinct and complete', () => {
		expect(SINGLE_SIG_SPEC.table).not.toBe(MULTISIG_SPEC.table);
		expect(SINGLE_SIG_SPEC.ownerColumn).not.toBe(MULTISIG_SPEC.ownerColumn);
	});
});
