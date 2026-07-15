// Tests for the dashboard stale-while-revalidate portfolio path (cairn —
// dashboard SWR / event-loop blocking):
//
//   • portfolioSnapshot.ts — the persisted per-user aggregate GET reads.
//   • portfolio.assemblePortfolio — building that aggregate from already-scanned
//     wallets, with NO Electrum work (the whole point: GET never scans).
//   • walletSync.buildPortfolioAggregate — the refresh pass rebuilding + persisting
//     the aggregate from the per-wallet snapshots it just wrote.
//   • portfolio.getBalanceSeries / downsampleSeries — the bounded, downsampled
//     balance series that no longer reads every historical row unbounded.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scan seams must never be touched by the cache-first aggregate path. Mock
// them as spies so we can assert zero calls (and so an accidental scan can't hit
// a real Electrum backend during the test).
const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	scanMultisig: vi.fn()
}));
vi.mock('./bitcoin/walletScan', async (orig) => ({
	...(await orig<typeof import('./bitcoin/walletScan')>()),
	scanWallet: mocks.scanWallet
}));
vi.mock('./multisigScan', async (orig) => ({
	...(await orig<typeof import('./multisigScan')>()),
	scanMultisig: mocks.scanMultisig
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { readPortfolioSnapshot, writePortfolioSnapshot } from './portfolioSnapshot';
import { assemblePortfolio, getBalanceSeries, downsampleSeries, type AggregateInput } from './portfolio';
import { buildPortfolioAggregate } from './walletSync';
import type { PortfolioDetail, WalletTx } from '$lib/types';
import type { WalletSnapshot } from './walletSync';

let userId: number;

function makeWallet(name: string, xpub: string): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, ?, ?, 'p2wpkh')")
		.run(userId, name, xpub);
	return Number(res.lastInsertRowid);
}

/** Persist a wallet_snapshots row exactly as the refresh pass would. */
function writeWalletSnapshot(
	walletId: number,
	confirmed: number,
	unconfirmed: number,
	txs: WalletTx[],
	tipHeight = 250
): void {
	const snap: WalletSnapshot = {
		scan: { addresses: [], txs, confirmed, unconfirmed },
		receive: null,
		coinbaseUtxos: [],
		tipHeight,
		maturingTotal: 0,
		speedUp: [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, NULL, ?)
		 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET snapshot = excluded.snapshot,
		   last_synced_at = excluded.last_synced_at`
	).run(walletId, JSON.stringify(snap), Date.now());
}

function tx(txid: string, delta: number, height: number, time: number | null): WalletTx {
	return { txid, height, time, delta, fee: null };
}

function aggInput(
	id: number,
	name: string,
	confirmed: number,
	unconfirmed = 0,
	txs: AggregateInput['txs'] = []
): AggregateInput {
	return { kind: 'wallet', id, name, href: `/wallets/${id}`, confirmed, unconfirmed, txs };
}

beforeEach(async () => {
	db.exec(
		'DELETE FROM balance_snapshots; DELETE FROM wallet_snapshots; DELETE FROM portfolio_snapshot; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (await registerUser({ email: 'agg@example.com', displayName: 'Agg' })).id;
	mocks.scanWallet.mockReset();
	mocks.scanMultisig.mockReset();
});

// --------------------------------------------------------- persistence round-trip

describe('portfolioSnapshot persistence', () => {
	it('reads null when no aggregate has been persisted', () => {
		expect(readPortfolioSnapshot(userId)).toBeNull();
	});

	it('round-trips a PortfolioDetail aggregate', () => {
		const detail: PortfolioDetail = {
			walletCount: 1,
			scannedCount: 1,
			confirmed: 123,
			unconfirmed: 0,
			allocation: [],
			recentActivity: [],
			balanceSeries: [],
			sparklines: {},
			change: { d1: null, d30: null, d365: null, all: null }
		};
		writePortfolioSnapshot(userId, detail, 1_700_000_000_000);
		const row = readPortfolioSnapshot(userId);
		expect(row).not.toBeNull();
		expect(row!.detail.confirmed).toBe(123);
		expect(row!.lastSyncedAt).toBe(1_700_000_000_000);
	});
});

// ------------------------------------------------ cache-first aggregate (no scan)

describe('assemblePortfolio (cache-first: builds the aggregate without scanning)', () => {
	it('aggregates totals, allocation and activity with ZERO scan calls', () => {
		const a = makeWallet('A', 'xpubA');
		const b = makeWallet('B', 'xpubB');
		const detail = assemblePortfolio(userId, 2, 250, [
			aggInput(a, 'A', 100_000, 1_000, [tx('a'.repeat(64), 100_000, 240, 1_700_000_000)]),
			aggInput(b, 'B', 250_000, 0, [])
		]);

		expect(detail.confirmed).toBe(350_000);
		expect(detail.unconfirmed).toBe(1_000);
		expect(detail.walletCount).toBe(2);
		expect(detail.scannedCount).toBe(2);
		// Largest allocation first.
		expect(detail.allocation.map((s) => s.balance)).toEqual([250_000, 100_000]);
		// Activity confirmations computed from the passed tip (250 - 240 + 1 = 11).
		expect(detail.recentActivity).toHaveLength(1);
		expect(detail.recentActivity[0].confirmations).toBe(11);

		// The whole point: the cache-first aggregate path never scans Electrum.
		expect(mocks.scanWallet).not.toHaveBeenCalled();
		expect(mocks.scanMultisig).not.toHaveBeenCalled();
	});

	it('records a balance tick only when every wallet was scanned (no partial dips)', () => {
		const a = makeWallet('A', 'xpubA');
		const b = makeWallet('B', 'xpubB');

		// Partial: 1 of 2 wallets present → no snapshot tick recorded.
		assemblePortfolio(userId, 2, 250, [aggInput(a, 'A', 100_000)]);
		expect(
			(db.prepare('SELECT COUNT(*) c FROM balance_snapshots WHERE user_id = ?').get(userId) as {
				c: number;
			}).c
		).toBe(0);

		// Complete: 2 of 2 → a tick (one row per wallet) is recorded.
		assemblePortfolio(userId, 2, 250, [aggInput(a, 'A', 100_000), aggInput(b, 'B', 50_000)]);
		expect(
			(db.prepare('SELECT COUNT(*) c FROM balance_snapshots WHERE user_id = ?').get(userId) as {
				c: number;
			}).c
		).toBe(2);
	});
});

// ------------------------------------------ refresh pass persists the aggregate

describe('buildPortfolioAggregate (refresh pass persists from per-wallet snapshots)', () => {
	it('computes + persists the aggregate from wallet_snapshots, no scanning', () => {
		const a = makeWallet('A', 'xpubA');
		const b = makeWallet('B', 'xpubB');
		writeWalletSnapshot(a, 100_000, 500, [tx('a'.repeat(64), 100_000, 240, 1_700_000_000)], 250);
		writeWalletSnapshot(b, 250_000, 0, [], 250);

		buildPortfolioAggregate(userId);

		const row = readPortfolioSnapshot(userId);
		expect(row).not.toBeNull();
		expect(row!.detail.confirmed).toBe(350_000);
		expect(row!.detail.unconfirmed).toBe(500);
		expect(row!.detail.walletCount).toBe(2);
		expect(row!.detail.scannedCount).toBe(2);
		expect(row!.detail.allocation.map((s) => s.balance)).toEqual([250_000, 100_000]);
		// Built from persisted snapshots — never from a live scan.
		expect(mocks.scanWallet).not.toHaveBeenCalled();
	});

	it('counts a never-synced wallet toward walletCount but not scannedCount', () => {
		const a = makeWallet('A', 'xpubA');
		makeWallet('B (never synced)', 'xpubB'); // no wallet_snapshots row
		writeWalletSnapshot(a, 100_000, 0, [], 250);

		buildPortfolioAggregate(userId);

		const row = readPortfolioSnapshot(userId)!;
		expect(row.detail.walletCount).toBe(2);
		expect(row.detail.scannedCount).toBe(1);
		expect(row.detail.confirmed).toBe(100_000);
	});
});

// ---------------------------------------------------- bounded balance series

describe('getBalanceSeries bounding + downsampleSeries', () => {
	it('excludes snapshot rows older than the ~400-day window', () => {
		const a = makeWallet('A', 'xpubA');
		const now = Date.parse('2026-07-09T00:00:00.000Z');
		const ins = db.prepare(
			"INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, 'wallet', ?, ?, ?)"
		);
		// One row well outside the window, one inside — only the recent one is read.
		ins.run(userId, a, new Date(now - 500 * 86400_000).toISOString(), 999_999);
		ins.run(userId, a, new Date(now - 5 * 86400_000).toISOString(), 42_000);

		const series = getBalanceSeries(userId, now);
		expect(series).toHaveLength(1);
		expect(series[0].sats).toBe(42_000);
	});

	it('downsamples to at most the cap, keeping the first and last points', () => {
		const series = Array.from({ length: 5_000 }, (_, i) => ({ t: i, sats: i }));
		const out = downsampleSeries(series, 400);
		expect(out.length).toBeLessThanOrEqual(400);
		expect(out[0]).toEqual({ t: 0, sats: 0 });
		expect(out[out.length - 1]).toEqual({ t: 4_999, sats: 4_999 }); // newest preserved exactly
	});

	it('is a no-op when already within the cap', () => {
		const series = [
			{ t: 1, sats: 10 },
			{ t: 2, sats: 20 }
		];
		expect(downsampleSeries(series, 400)).toBe(series);
	});
});
