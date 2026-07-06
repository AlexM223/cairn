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
import { getPortfolioDetail } from './portfolio';

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
});
