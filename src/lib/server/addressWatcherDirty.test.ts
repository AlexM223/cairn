// cairn-wcxw — sync engine Phase 1: Electrum status-hash dirty-tracking.
//
// The address watcher already holds a live scripthash subscription for every
// watched address; before this change it threw away the STATUS HASH those
// subscriptions carry and let walletSync full-rescan on a blind 20s timer. These
// tests pin the two halves of the fix that live in addressWatcher:
//
//   1. reconcileStatus() — persist the last-seen status per (wallet, scripthash)
//      and mark the OWNING WALLET dirty on a real change (or an absent baseline),
//      a no-op on an unchanged status. This is what a clean-skip in walletSync
//      keys off, so a false-clean here would silently show a stale balance.
//   2. watchDepthFor() — the WATCH_WINDOW blind-spot fix: the watch set must
//      cover the whole scanned set (highest used index + GAP_LIMIT), or a deposit
//      to a far-out address fires no event and never marks the wallet dirty.
//
// reconcileStatus / watchDepthFor are synchronous DB functions, so these drive
// them directly via _internals rather than booting the full watcher.

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';

// Keep the import graph off a real Electrum socket — these tests never call the
// chain, but mocking matches addressWatcher.test.ts and avoids any lazy dial.
vi.mock('./chain/index', () => ({
	getChain: () => ({
		electrum: { getHistory: vi.fn(async () => []) },
		getTip: vi.fn(async () => ({ height: 0 })),
		getTx: vi.fn(async () => {
			throw new Error('not used');
		})
	})
}));
vi.mock('./notifications', () => ({ notify: vi.fn() }));

import { _internals } from './addressWatcher';

const { state, reconcileStatus, watchDepthFor, WATCH_WINDOW } = _internals;

function statusRow(kind: string, walletId: number, scripthash: string): string | null | undefined {
	const row = db
		.prepare(
			'SELECT status FROM scripthash_status WHERE wallet_kind = ? AND wallet_id = ? AND scripthash = ?'
		)
		.get(kind, walletId, scripthash) as { status: string | null } | undefined;
	return row === undefined ? undefined : row.status;
}

function dirtySince(kind: string, walletId: number): number | null {
	const row = db
		.prepare('SELECT dirty_since FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?')
		.get(kind, walletId) as { dirty_since: number | null } | undefined;
	return row?.dirty_since ?? null;
}

/** Insert a bare (clean) snapshot row so markDirty has something to update. */
function seedSnapshot(kind: string, walletId: number, snapshotJson = '{}'): void {
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at, dirty_since)
		 VALUES (?, ?, ?, NULL, ?, NULL)`
	).run(kind, walletId, snapshotJson, Date.now());
}

// Insert a real wallet ROW (walletStillExists only checks the row exists) with a
// unique xpub each time — the real createWallet rejects a duplicate xpub, and
// these tests only need a backing id, not a derivable key.
let xpubSeq = 0;
function makeWallet(): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
		.run(userId, `xpub-wcxw-${xpubSeq++}`);
	return Number(res.lastInsertRowid);
}

let userId: number;

beforeAll(async () => {
	db.exec(
		'DELETE FROM scripthash_status; DELETE FROM wallet_snapshots; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'wcxw-dirty@example.com',
			password: 'correct horse battery',
			displayName: 'Dirty'
		})
	).id;
});

beforeEach(() => {
	db.exec('DELETE FROM scripthash_status; DELETE FROM wallet_snapshots;');
	state.byScripthash.clear();
});

describe('reconcileStatus — dirty marking (cairn-wcxw)', () => {
	it('marks the wallet dirty and records the baseline on an ABSENT baseline', () => {
		const walletId = makeWallet();
		const sh = 'aa'.repeat(16);
		seedSnapshot('wallet', walletId);
		state.byScripthash.set(sh, { kind: 'wallet', walletId, userId, address: 'addr' });

		reconcileStatus(sh, 'statusA');

		expect(statusRow('wallet', walletId, sh)).toBe('statusA');
		expect(dirtySince('wallet', walletId)).not.toBeNull();
	});

	it('is a NO-OP for an unchanged status (does not re-dirty a clean wallet)', () => {
		const walletId = makeWallet();
		const sh = 'bb'.repeat(16);
		seedSnapshot('wallet', walletId);
		state.byScripthash.set(sh, { kind: 'wallet', walletId, userId, address: 'addr' });

		// Establish the baseline, then clear the dirty flag (simulate a completed scan).
		reconcileStatus(sh, 'statusA');
		db.prepare('UPDATE wallet_snapshots SET dirty_since = NULL WHERE wallet_kind = ? AND wallet_id = ?').run(
			'wallet',
			walletId
		);

		// Same status again (e.g. a reconnect resubscribe replay of an idle address).
		reconcileStatus(sh, 'statusA');
		expect(dirtySince('wallet', walletId)).toBeNull(); // stayed clean — the efficiency win
	});

	it('re-marks dirty when the status actually changes (new tx / confirmation / reorg / RBF)', () => {
		const walletId = makeWallet();
		const sh = 'cc'.repeat(16);
		seedSnapshot('wallet', walletId);
		state.byScripthash.set(sh, { kind: 'wallet', walletId, userId, address: 'addr' });

		reconcileStatus(sh, 'statusA');
		db.prepare('UPDATE wallet_snapshots SET dirty_since = NULL WHERE wallet_kind = ? AND wallet_id = ?').run(
			'wallet',
			walletId
		);

		reconcileStatus(sh, 'statusB'); // the status hash changed → chain moved
		expect(statusRow('wallet', walletId, sh)).toBe('statusB');
		expect(dirtySince('wallet', walletId)).not.toBeNull();
	});

	it('records the baseline for a never-synced wallet (mark-dirty is a harmless no-op)', () => {
		const walletId = makeWallet();
		const sh = 'dd'.repeat(16);
		// No snapshot row — a never-synced wallet. It scans by absence anyway; the
		// baseline still records so steady-state reconciliation works once it syncs.
		state.byScripthash.set(sh, { kind: 'wallet', walletId, userId, address: 'addr' });

		reconcileStatus(sh, 'statusA');
		expect(statusRow('wallet', walletId, sh)).toBe('statusA');
		expect(dirtySince('wallet', walletId)).toBeNull(); // no snapshot row to mark
	});

	it('ignores a scripthash that is not (or no longer) watched', () => {
		const walletId = makeWallet();
		const sh = 'ee'.repeat(16);
		seedSnapshot('wallet', walletId);
		// NOT in byScripthash → reconcile must do nothing.
		reconcileStatus(sh, 'statusA');
		expect(statusRow('wallet', walletId, sh)).toBeUndefined();
		expect(dirtySince('wallet', walletId)).toBeNull();
	});

	it('does not seed rows for a deleted wallet (walletStillExists fails closed)', () => {
		const ghostId = 999_123;
		const sh = 'ff'.repeat(16);
		// byScripthash lingers but the wallet row never existed → treated as gone.
		state.byScripthash.set(sh, { kind: 'wallet', walletId: ghostId, userId, address: 'addr' });
		reconcileStatus(sh, 'statusA');
		expect(statusRow('wallet', ghostId, sh)).toBeUndefined();
	});
});

describe('watchDepthFor — WATCH_WINDOW blind-spot fix (cairn-wcxw)', () => {
	it('falls back to the WATCH_WINDOW floor when there is no snapshot', () => {
		expect(watchDepthFor('wallet', 123456)).toEqual([WATCH_WINDOW, WATCH_WINDOW]);
	});

	it('extends the receive-chain watch depth to cover a scan past index 30 (single-sig)', () => {
		const walletId = makeWallet();
		// A scan that used receive index 34 — beyond the old fixed window of 30.
		const snapshot = JSON.stringify({
			scan: {
				addresses: [
					{ index: 0, change: false, used: true },
					{ index: 34, change: false, used: true },
					{ index: 2, change: true, used: true }
				]
			}
		});
		seedSnapshot('wallet', walletId, snapshot);
		// receive: max(30, 34 + GAP_LIMIT(20) + 1) = 55; change: max(30, 2+20+1)=30.
		expect(watchDepthFor('wallet', walletId)).toEqual([55, WATCH_WINDOW]);
	});

	it('reads the multisig snapshot shape (chain/index/used)', () => {
		const msId = 77;
		const snapshot = JSON.stringify({
			detail: {
				addresses: [
					{ index: 40, chain: 0, used: true },
					{ index: 5, chain: 1, used: true },
					{ index: 90, chain: 0, used: false } // unused → ignored
				]
			}
		});
		seedSnapshot('multisig', msId, snapshot);
		// receive: max(30, 40+20+1)=61; change: max(30, 5+20+1)=30.
		expect(watchDepthFor('multisig', msId)).toEqual([61, WATCH_WINDOW]);
	});

	it('ignores unused addresses when computing the highest used index', () => {
		const walletId = makeWallet();
		const snapshot = JSON.stringify({
			scan: { addresses: [{ index: 50, change: false, used: false }] }
		});
		seedSnapshot('wallet', walletId, snapshot);
		// No used address → both chains fall back to the floor.
		expect(watchDepthFor('wallet', walletId)).toEqual([WATCH_WINDOW, WATCH_WINDOW]);
	});
});
