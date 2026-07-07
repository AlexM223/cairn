// Regression tests for cairn-1ynt and cairn-rr94.
//
// cairn-1ynt (fix cairn-lo8): getPortfolioDetail must scan every wallet
// CONCURRENTLY (Promise.all), not serially — a serial loop made the dashboard
// take (number of wallets × scan latency) to load.
//
// cairn-rr94 (fix cairn-ednl): a failed scan must log a warning carrying the
// wallet's identity, and exclude ONLY that wallet from the aggregated totals —
// previously the failure was swallowed silently, understating the balance with
// no trace to diagnose the partial outage.
//
// portfolioWarm.test.ts covers warmPortfolioCache (the background pass); this
// file covers the user-facing aggregation, getPortfolioDetail.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WalletScanResult } from './bitcoin/walletScan';
import type { MultisigRow } from './wallets/multisig';

// Logger seam: portfolio.ts creates `const log = childLogger('portfolio')` at
// import time, so the mock must be in place before the module loads (vi.mock is
// hoisted). Every childLogger() caller in the graph shares this spy; assertions
// clear it first and match on structured context, so that sharing is harmless.
const logMock = vi.hoisted(() => {
	const log: Record<string, unknown> = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn()
	};
	log.child = () => log;
	return log as {
		warn: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
		fatal: ReturnType<typeof vi.fn>;
		child: () => unknown;
	};
});

const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	scanMultisig: vi.fn(),
	listMultisigs: vi.fn(),
	getTip: vi.fn()
}));

vi.mock('./logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log'
}));
// The real scans hit Electrum; the real chain facade opens sockets. Mock the
// seams portfolio.ts imports so only the aggregation logic runs.
vi.mock('./bitcoin/walletScan', () => ({ scanWallet: mocks.scanWallet }));
vi.mock('./multisigScan', () => ({ scanMultisig: mocks.scanMultisig }));
vi.mock('./wallets/multisig', () => ({ listMultisigs: mocks.listMultisigs }));
vi.mock('./chain', () => ({ getChain: () => ({ getTip: mocks.getTip }) }));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getPortfolioDetail, PORTFOLIO_SCAN_TIMEOUT_MS } from './portfolio';

// ---- fixtures -----------------------------------------------------------------

const SCAN_DELAY_MS = 100;

function scanResult(
	confirmed: number,
	unconfirmed = 0,
	txs: WalletScanResult['txs'] = []
): WalletScanResult {
	return { addresses: [], txs, confirmed, unconfirmed };
}

let userId: number;

function makeWallet(name: string, xpub: string): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, ?, ?, 'p2wpkh')")
		.run(userId, name, xpub);
	return Number(res.lastInsertRowid);
}

beforeEach(() => {
	db.exec(
		'DELETE FROM balance_snapshots; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = registerUser({ email: 'folio@example.com', displayName: 'Folio' }).id;

	logMock.warn.mockClear();
	mocks.scanWallet.mockReset();
	mocks.scanMultisig.mockReset();
	mocks.listMultisigs.mockReset().mockReturnValue([]);
	mocks.getTip.mockReset().mockResolvedValue({ height: 250, hash: 'h'.repeat(64) });
});

// ---- cairn-1ynt: concurrency ----------------------------------------------------

describe('getPortfolioDetail concurrency (cairn-1ynt / cairn-lo8)', () => {
	it('scans all wallets concurrently, well under the serial sum, with correct totals', async () => {
		const balances: Record<string, number> = {
			xpubA: 100_000,
			xpubB: 250_000,
			xpubC: 50_000
		};
		for (const xpub of Object.keys(balances)) makeWallet(`Wallet ${xpub}`, xpub);

		// Track in-flight overlap directly (deterministic), plus wall-clock as the
		// user-visible symptom: 3 × 100ms serial would be ≥300ms; concurrent ≈100ms.
		let active = 0;
		let maxActive = 0;
		mocks.scanWallet.mockImplementation(
			(xpub: string) =>
				new Promise<WalletScanResult>((resolve) => {
					active++;
					maxActive = Math.max(maxActive, active);
					setTimeout(() => {
						active--;
						resolve(scanResult(balances[xpub], 1_000));
					}, SCAN_DELAY_MS);
				})
		);

		const t0 = performance.now();
		const detail = await getPortfolioDetail(userId);
		const elapsed = performance.now() - t0;

		expect(maxActive).toBe(3); // all three scans were in flight at once
		expect(elapsed).toBeLessThan(250); // << 3 × 100ms serial floor

		expect(detail.walletCount).toBe(3);
		expect(detail.scannedCount).toBe(3);
		expect(detail.confirmed).toBe(400_000);
		expect(detail.unconfirmed).toBe(3_000);
		// Allocation is sorted largest-first and carries every wallet.
		expect(detail.allocation.map((a) => a.balance)).toEqual([250_000, 100_000, 50_000]);
	});

	it('computes recent-activity confirmations from the chain tip', async () => {
		makeWallet('Active', 'xpubA');
		mocks.scanWallet.mockResolvedValue(
			scanResult(10_000, 0, [
				{ txid: 'a'.repeat(64), height: 240, time: 1_700_000_000, delta: 10_000, fee: 200 }
			])
		);

		const detail = await getPortfolioDetail(userId);

		expect(detail.recentActivity).toHaveLength(1);
		// tip 250, tx at 240 → 250 - 240 + 1 = 11 confirmations
		expect(detail.recentActivity[0].confirmations).toBe(11);
		expect(detail.recentActivity[0].direction).toBe('in');
		expect(detail.recentActivity[0].sats).toBe(10_000);
	});
});

// ---- cairn-rr94: failed scans log and exclude only the failure -------------------

describe('getPortfolioDetail failed scans (cairn-rr94 / cairn-ednl)', () => {
	it('logs a warning with the wallet id and excludes only the failed wallet', async () => {
		makeWallet('Good A', 'xpubA');
		const badId = makeWallet('Bad', 'xpubBAD');
		makeWallet('Good B', 'xpubB');

		const balances: Record<string, number> = { xpubA: 100_000, xpubB: 200_000 };
		mocks.scanWallet.mockImplementation((xpub: string) =>
			xpub === 'xpubBAD'
				? Promise.reject(new Error('electrum down'))
				: Promise.resolve(scanResult(balances[xpub]))
		);

		const detail = await getPortfolioDetail(userId);

		// The two healthy wallets still sum correctly; only the failure is dropped.
		expect(detail.confirmed).toBe(300_000);
		expect(detail.walletCount).toBe(3);
		expect(detail.scannedCount).toBe(2);
		expect(detail.allocation.map((a) => a.name).sort()).toEqual(['Good A', 'Good B']);

		// Exactly one warning, carrying the failed wallet's identity and the error.
		expect(logMock.warn).toHaveBeenCalledTimes(1);
		const [ctx, msg] = logMock.warn.mock.calls[0] as [Record<string, unknown>, string];
		expect(ctx).toMatchObject({ walletId: badId, kind: 'wallet' });
		expect(ctx.err).toBeInstanceOf(Error);
		expect(String(msg)).toMatch(/excluded/);
	});

	it('logs a warning with the multisig id when a multisig scan fails', async () => {
		makeWallet('Solo', 'xpubA');
		mocks.scanWallet.mockResolvedValue(scanResult(100_000));
		mocks.listMultisigs.mockReturnValue([{ id: 77, name: 'Vault' } as MultisigRow]);
		mocks.scanMultisig.mockRejectedValue(new Error('electrum down'));

		const detail = await getPortfolioDetail(userId);

		expect(detail.confirmed).toBe(100_000);
		expect(detail.walletCount).toBe(2);
		expect(detail.scannedCount).toBe(1);
		expect(detail.allocation.map((a) => a.name)).toEqual(['Solo']);

		expect(logMock.warn).toHaveBeenCalledTimes(1);
		const [ctx, msg] = logMock.warn.mock.calls[0] as [Record<string, unknown>, string];
		expect(ctx).toMatchObject({ multisigId: 77, kind: 'multisig' });
		expect(ctx.err).toBeInstanceOf(Error);
		expect(String(msg)).toMatch(/excluded/);
	});

	// cairn-3gvb / cairn-hy8z: a wallet scan that never settles (a hung Electrum
	// round-trip through a broken proxy, not a clean rejection) used to hang
	// Promise.all forever — the whole dashboard response, not just one wallet.
	it('never lets one stuck wallet scan hang the whole dashboard response', async () => {
		vi.useFakeTimers();
		try {
			makeWallet('Good', 'xpubA');
			const stuckId = makeWallet('Stuck', 'xpubSTUCK');
			mocks.scanWallet.mockImplementation((xpub: string) =>
				xpub === 'xpubSTUCK'
					? new Promise<WalletScanResult>(() => {
							/* never resolves or rejects — simulates a hung round-trip */
						})
					: Promise.resolve(scanResult(100_000))
			);

			const detailPromise = getPortfolioDetail(userId);
			// Fast-forward past the scan's timeout budget without waiting in real time.
			await vi.advanceTimersByTimeAsync(PORTFOLIO_SCAN_TIMEOUT_MS + 1_000);
			const detail = await detailPromise;

			expect(detail.walletCount).toBe(2);
			expect(detail.scannedCount).toBe(1);
			expect(detail.confirmed).toBe(100_000);
			expect(detail.allocation.map((a) => a.name)).toEqual(['Good']);

			expect(logMock.warn).toHaveBeenCalledTimes(1);
			const [ctx, msg] = logMock.warn.mock.calls[0] as [Record<string, unknown>, string];
			expect(ctx).toMatchObject({ walletId: stuckId, kind: 'wallet' });
			expect(String(msg)).toMatch(/excluded/);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---- cairn-3gvb / cairn-xsuq: per-wallet scan budget ---------------------------

describe('getPortfolioDetail per-wallet timeout (cairn-3gvb / cairn-xsuq)', () => {
	it('excludes a wallet whose scan never settles, without blocking the rest', async () => {
		makeWallet('Fast', 'xpubFast');
		makeWallet('Hangs', 'xpubHang');
		// The hung scan models a broken SOCKS5/Tor proxy where every dial hangs: it
		// neither resolves nor rejects. Before the fix, Promise.all would wait on it
		// indefinitely; now the per-wallet budget cuts it loose.
		mocks.scanWallet.mockImplementation((xpub: string) =>
			xpub === 'xpubHang'
				? new Promise<WalletScanResult>(() => {})
				: Promise.resolve(scanResult(120_000))
		);

		vi.useFakeTimers();
		try {
			const pending = getPortfolioDetail(userId);
			// Advance past the 10s per-wallet budget so the hung scan times out.
			await vi.advanceTimersByTimeAsync(10_000);
			const detail = await pending;

			expect(detail.walletCount).toBe(2);
			expect(detail.scannedCount).toBe(1); // only the fast wallet counted
			expect(detail.confirmed).toBe(120_000);
			expect(detail.allocation.map((a) => a.name)).toEqual(['Fast']);
			// The over-budget wallet logged the same exclusion warning a hard failure does.
			expect(
				logMock.warn.mock.calls.some(([, msg]) => /excluded from totals/.test(String(msg)))
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---- cairn-ittq: balance-history backfill on first scan -------------------------

import { buildBackfillPoints, getBalanceSeries } from './portfolio';
import type { WalletTx } from '$lib/types';

const HOUR = 3600;
const DAY = 86400;

function tx(time: number | null, delta: number, height = 100): WalletTx {
	return { txid: 't'.repeat(64), height, time, delta, fee: null };
}

describe('buildBackfillPoints (cairn-ittq)', () => {
	const NOW_MS = 1_700_000_000_000;
	const nowS = Math.floor(NOW_MS / 1000);

	it('derives running balances from confirmed txs in time order', () => {
		const points = buildBackfillPoints(
			[tx(nowS - 3 * HOUR, -20_000), tx(nowS - 10 * HOUR, 50_000), tx(nowS - 5 * HOUR, 30_000)],
			60_000,
			NOW_MS
		);
		expect(points).toEqual([
			{ t: nowS - 10 * HOUR, sats: 50_000 },
			{ t: nowS - 5 * HOUR, sats: 80_000 },
			{ t: nowS - 3 * HOUR, sats: 60_000 }
		]);
	});

	it('returns [] when there are no confirmed txs', () => {
		expect(buildBackfillPoints([], 0, NOW_MS)).toEqual([]);
		expect(buildBackfillPoints([tx(null, 5_000, 0)], 0, NOW_MS)).toEqual([]);
	});

	it('refuses (null) when a confirmed tx has no timestamp', () => {
		expect(buildBackfillPoints([tx(null, 5_000, 100)], 5_000, NOW_MS)).toBeNull();
	});

	it('refuses (null) when deltas do not reconstruct the confirmed balance', () => {
		expect(buildBackfillPoints([tx(nowS - HOUR, 5_000)], 9_999, NOW_MS)).toBeNull();
	});

	it('ignores unconfirmed txs in the running sum', () => {
		const points = buildBackfillPoints(
			[tx(nowS - HOUR, 5_000), tx(null, 1_000, 0)],
			5_000,
			NOW_MS
		);
		expect(points).toEqual([{ t: nowS - HOUR, sats: 5_000 }]);
	});

	it('collapses same-second txs into the final balance at that instant', () => {
		const t0 = nowS - 2 * HOUR;
		const points = buildBackfillPoints([tx(t0, 10_000), tx(t0, -4_000)], 6_000, NOW_MS);
		expect(points).toEqual([{ t: t0, sats: 6_000 }]);
	});

	it('downsamples the >30d band to one point per day and carries in pre-horizon history', () => {
		const horizonS = Math.floor((NOW_MS - 396 * DAY * 1000) / 1000);
		const oldDay = nowS - 100 * DAY; // in the daily band
		const points = buildBackfillPoints(
			[
				tx(horizonS - 50 * DAY, 200_000), // before the 13-month horizon
				tx(oldDay, 10_000),
				tx(oldDay + HOUR, 5_000), // same UTC day → dropped
				tx(nowS - HOUR, 1_000) // recent → full resolution
			],
			216_000,
			NOW_MS
		);
		expect(points).toEqual([
			{ t: horizonS, sats: 200_000 }, // carry-in at the horizon edge
			{ t: oldDay, sats: 210_000 },
			{ t: nowS - HOUR, sats: 216_000 }
		]);
	});
});

describe('backfill through getPortfolioDetail (cairn-ittq)', () => {
	it('populates the balance series from an imported wallet’s history on first scan, once', async () => {
		const nowS = Math.floor(Date.now() / 1000);
		makeWallet('Imported', 'xpubHist');
		mocks.scanWallet.mockResolvedValue(
			scanResult(75_000, 0, [
				tx(nowS - 20 * DAY, 100_000),
				tx(nowS - 10 * DAY, -25_000)
			])
		);

		const detail = await getPortfolioDetail(userId);

		// Historical points chart immediately (plus possibly a current tick).
		expect(detail.balanceSeries.length).toBeGreaterThanOrEqual(2);
		expect(detail.balanceSeries[0]).toEqual({ t: nowS - 20 * DAY, sats: 100_000 });
		expect(detail.balanceSeries[1]).toEqual({ t: nowS - 10 * DAY, sats: 75_000 });
		// Lookback changes work on day one.
		expect(detail.change.d7).toBe(0);
		expect(detail.change.d30).toBeNull(); // history starts 20d ago

		const countAfterFirst = (
			db.prepare('SELECT COUNT(*) AS c FROM balance_snapshots WHERE user_id = ?').get(userId) as {
				c: number;
			}
		).c;

		// Second load: backfill must not duplicate rows.
		await getPortfolioDetail(userId);
		const countAfterSecond = (
			db.prepare('SELECT COUNT(*) AS c FROM balance_snapshots WHERE user_id = ?').get(userId) as {
				c: number;
			}
		).c;
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	it('skips backfill (with a warning) when history cannot reconstruct the balance', async () => {
		const nowS = Math.floor(Date.now() / 1000);
		makeWallet('Odd', 'xpubOdd');
		// Confirmed tx with no timestamp → refuse rather than chart nonsense.
		mocks.scanWallet.mockResolvedValue(scanResult(5_000, 0, [tx(null, 5_000, 120)]));

		const detail = await getPortfolioDetail(userId);
		// Only the current sampling tick may exist; no historical points.
		expect(detail.balanceSeries.every((p) => p.t >= nowS - 5)).toBe(true);
		expect(
			logMock.warn.mock.calls.some(([, msg]) => /backfill skipped/.test(String(msg)))
		).toBe(true);
	});
});

describe('getBalanceSeries carry-forward (cairn-ittq)', () => {
	it('sums latest-known per-wallet balances at unaligned timestamps', () => {
		const a = makeWallet('A', 'xpubA');
		const b = makeWallet('B', 'xpubB');
		const ins = db.prepare(
			"INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, 'wallet', ?, ?, ?)"
		);
		ins.run(userId, a, '2026-01-01T00:00:00.000Z', 10_000);
		ins.run(userId, b, '2026-01-02T00:00:00.000Z', 5_000); // A carries forward
		ins.run(userId, a, '2026-01-03T00:00:00.000Z', 20_000); // B carries forward

		expect(getBalanceSeries(userId).map((p) => p.sats)).toEqual([10_000, 15_000, 25_000]);
	});

	it('excludes rows for wallets that no longer exist', () => {
		const a = makeWallet('A', 'xpubA');
		const ins = db.prepare(
			"INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, 'wallet', ?, ?, ?)"
		);
		ins.run(userId, a, '2026-01-01T00:00:00.000Z', 10_000);
		ins.run(userId, 999_999, '2026-01-02T00:00:00.000Z', 7_777); // deleted wallet's orphan

		expect(getBalanceSeries(userId).map((p) => p.sats)).toEqual([10_000]);
	});
});
