// Unit tests for the stale-while-revalidate engine (cairn-2zxt). These exercise
// `singleFlightThrottled` directly — the pure single-flight + throttle core that
// refreshWalletSnapshot / refreshMultisigSnapshot both wrap — so the guarantees
// (throttle returns cached without scanning; concurrent callers coalesce to ONE
// scan) are covered without a live Electrum backend or a wallet fixture.

import { describe, it, expect, vi } from 'vitest';
import {
	singleFlightThrottled,
	THROTTLE_MS,
	createLimiter,
	runPortfolioRefreshPass,
	isConnectClassError,
	summarizeWalletSnapshot,
	summarizeMultisigSnapshot,
	finalizeCachedBalance,
	EMPTY_WALLET_SNAPSHOT,
	EMPTY_MULTISIG_SNAPSHOT,
	type PortfolioRefreshItem,
	type WalletSnapshot,
	type MultisigSnapshot
} from './walletSync';

/** A doScan that resolves only when you call its returned `resolve`, and counts
 *  how many times it was invoked. */
function deferredScan<T>() {
	let calls = 0;
	let resolveOne: (v: T) => void;
	const doScan = () => {
		calls += 1;
		return new Promise<T>((res) => {
			resolveOne = res;
		});
	};
	return {
		doScan,
		get calls() {
			return calls;
		},
		resolve: (v: T) => resolveOne(v)
	};
}

describe('singleFlightThrottled — throttle', () => {
	it('returns the cached snapshot WITHOUT scanning when last sync is within the window', async () => {
		const map = new Map<string, Promise<string>>();
		const scan = deferredScan<string>();
		const readCached = vi.fn(() => 'CACHED');

		const now = () => 1_000_000;
		const result = await singleFlightThrottled(map, 'wallet:1', {
			lastSyncedAt: now() - 5_000, // 5s ago — well inside 20s
			readCached,
			doScan: scan.doScan,
			now
		});

		expect(result).toBe('CACHED');
		expect(readCached).toHaveBeenCalledOnce();
		expect(scan.calls).toBe(0); // never re-scanned
		expect(map.size).toBe(0); // nothing left in flight
	});

	it('re-scans once the snapshot is older than the throttle window', async () => {
		const map = new Map<string, Promise<string>>();
		const scan = deferredScan<string>();
		const now = () => 1_000_000;

		const p = singleFlightThrottled(map, 'wallet:1', {
			lastSyncedAt: now() - (THROTTLE_MS + 1), // just past the window
			readCached: () => 'CACHED',
			doScan: scan.doScan,
			now
		});
		expect(scan.calls).toBe(1);
		scan.resolve('FRESH');
		expect(await p).toBe('FRESH');
	});

	it('re-scans when there is no snapshot yet (lastSyncedAt null)', async () => {
		const map = new Map<string, Promise<string>>();
		const scan = deferredScan<string>();

		const p = singleFlightThrottled(map, 'wallet:1', {
			lastSyncedAt: null,
			readCached: () => 'CACHED',
			doScan: scan.doScan
		});
		expect(scan.calls).toBe(1);
		scan.resolve('FRESH');
		expect(await p).toBe('FRESH');
	});

	it('force bypasses the throttle and re-scans even within the window', async () => {
		const map = new Map<string, Promise<string>>();
		const scan = deferredScan<string>();
		const now = () => 1_000_000;

		const p = singleFlightThrottled(map, 'wallet:1', {
			force: true,
			lastSyncedAt: now() - 1_000, // 1s ago — would normally throttle
			readCached: () => 'CACHED',
			doScan: scan.doScan,
			now
		});
		expect(scan.calls).toBe(1);
		scan.resolve('FRESH');
		expect(await p).toBe('FRESH');
	});
});

describe('singleFlightThrottled — single-flight', () => {
	it('two concurrent calls trigger only ONE real scan and share the result', async () => {
		const map = new Map<string, Promise<string>>();
		const scan = deferredScan<string>();

		const a = singleFlightThrottled(map, 'wallet:7', {
			lastSyncedAt: null,
			readCached: () => 'CACHED',
			doScan: scan.doScan
		});
		const b = singleFlightThrottled(map, 'wallet:7', {
			lastSyncedAt: null,
			readCached: () => 'CACHED',
			doScan: scan.doScan
		});

		// Same in-flight promise handed to both callers; scan invoked exactly once.
		expect(a).toBe(b);
		expect(scan.calls).toBe(1);
		expect(map.size).toBe(1);

		scan.resolve('FRESH');
		expect(await a).toBe('FRESH');
		expect(await b).toBe('FRESH');

		// Cleared once settled, so the next call can scan again.
		expect(map.size).toBe(0);
	});

	it('a fresh call after the first settles starts a new scan', async () => {
		const map = new Map<string, Promise<string>>();
		const first = deferredScan<string>();

		const a = singleFlightThrottled(map, 'wallet:9', {
			lastSyncedAt: null,
			readCached: () => 'CACHED',
			doScan: first.doScan
		});
		first.resolve('ONE');
		expect(await a).toBe('ONE');

		const second = deferredScan<string>();
		const b = singleFlightThrottled(map, 'wallet:9', {
			lastSyncedAt: null,
			readCached: () => 'CACHED',
			doScan: second.doScan
		});
		expect(second.calls).toBe(1); // not coalesced with the already-settled first
		second.resolve('TWO');
		expect(await b).toBe('TWO');
	});

	it('clears the in-flight entry even when the scan rejects', async () => {
		const map = new Map<string, Promise<string>>();
		let calls = 0;
		const doScan = () => {
			calls += 1;
			return Promise.reject(new Error('electrum down'));
		};

		await expect(
			singleFlightThrottled(map, 'wallet:1', {
				lastSyncedAt: null,
				readCached: () => 'CACHED',
				doScan
			})
		).rejects.toThrow('electrum down');

		expect(calls).toBe(1);
		expect(map.size).toBe(0); // failure must not leave a stuck in-flight entry
	});
});

// --------------------------------------------------------------- scan semaphore

/** Flush the microtask queue (and one macrotask turn) so a limiter's internal
 *  `.finally` → pump chain has fully settled before the next assertion. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A task whose promise you resolve manually, tracking peak concurrency. */
function makeConcurrencyProbe() {
	let active = 0;
	let peak = 0;
	const pending: Array<() => void> = [];
	const task = () => {
		active++;
		peak = Math.max(peak, active);
		return new Promise<void>((resolve) => {
			pending.push(() => {
				active--;
				resolve();
			});
		});
	};
	return {
		task,
		get peak() {
			return peak;
		},
		get running() {
			return pending.length;
		},
		/** Complete the oldest still-running task. */
		releaseOne() {
			const done = pending.shift();
			if (done) done();
		}
	};
}

describe('createLimiter', () => {
	it('never runs more than `concurrency` tasks at once', async () => {
		const run = createLimiter(2);
		const probe = makeConcurrencyProbe();

		// Fire 5 tasks; only 2 may run concurrently.
		const all = Promise.all(Array.from({ length: 5 }, () => run(probe.task)));

		await tick(); // let the synchronous pump start the first batch
		expect(probe.running).toBe(2);
		expect(probe.peak).toBe(2);

		// Drain, one at a time — each completion admits exactly one queued task.
		for (let i = 0; i < 5; i++) {
			probe.releaseOne();
			await tick();
		}
		await all;
		expect(probe.peak).toBe(2); // cap was never exceeded across the whole run
	});

	it('releases its slot even when a wrapped task rejects', async () => {
		const run = createLimiter(1);
		await expect(run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		// Slot freed → a subsequent task still runs.
		await expect(run(() => Promise.resolve('ok'))).resolves.toBe('ok');
	});
});

// -------------------------------------------------------- coalesced refresh pass

describe('runPortfolioRefreshPass', () => {
	const item = (id: number, lastSyncedAt: number | null): PortfolioRefreshItem => ({
		kind: 'wallet',
		id,
		lastSyncedAt
	});

	it('scans most-stale-first (never-synced ahead of the oldest timestamp)', async () => {
		const now = () => 1_000_000;
		const order: number[] = [];
		const items = [
			item(1, now() - 100_000), // synced 100s ago
			item(2, null), // never synced — most stale
			item(3, now() - 500_000) // synced 500s ago
		];

		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => {
				order.push(it.id);
				return {};
			},
			{ concurrency: 1, now } // serial so order is deterministic
		);

		expect(order).toEqual([2, 3, 1]); // null, then oldest → newest
		expect(summary.refreshed).toBe(3);
		expect(summary.skipped).toBe(0);
	});

	it('skips (without scanning) anything synced within the throttle window', async () => {
		const now = () => 1_000_000;
		const scanned: number[] = [];
		const items = [
			item(1, now() - 5_000), // 5s ago — inside 20s window → skip
			item(2, now() - (THROTTLE_MS + 1)), // just past window → scan
			item(3, null) // never synced → scan
		];

		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => {
				scanned.push(it.id);
				return {};
			},
			{ concurrency: 1, now }
		);

		expect(scanned.sort()).toEqual([2, 3]);
		expect(summary.refreshed).toBe(2);
		expect(summary.skipped).toBe(1);
	});

	it('caps concurrency at the requested limit', async () => {
		const probe = makeConcurrencyProbe();
		const items = Array.from({ length: 6 }, (_, i) => item(i + 1, null));

		const pass = runPortfolioRefreshPass(items, () => probe.task().then(() => ({})), {
			concurrency: 2,
			now: () => 0
		});

		await tick();
		expect(probe.running).toBe(2);

		while (probe.running > 0) {
			probe.releaseOne();
			await tick();
		}
		const summary = await pass;
		expect(probe.peak).toBe(2);
		expect(summary.refreshed).toBe(6);
	});

	it('aborts the remaining queue on a connect-class failure', async () => {
		const now = () => 1_000_000;
		const scanned: number[] = [];
		// Most-stale-first order will be 1,2,3,4 (all null). The 2nd scan throws a
		// fatal (connect-class) error; with concurrency 1 nothing after it runs.
		const items = [item(1, null), item(2, null), item(3, null), item(4, null)];

		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => {
				scanned.push(it.id);
				if (it.id === 2) throw new Error('Electrum connect to host:50002 timed out after 15000ms');
				return {};
			},
			{ concurrency: 1, now, isFatal: isConnectClassError }
		);

		expect(scanned).toEqual([1, 2]); // stopped after the fatal failure
		expect(summary.aborted).toBe(true);
		expect(summary.failed).toBe(1);
		expect(summary.refreshed).toBe(1);
	});

	it('a non-fatal per-item failure does NOT abort the pass', async () => {
		const items = [item(1, null), item(2, null), item(3, null)];
		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => {
				if (it.id === 2) throw new Error('some odd wallet-specific glitch');
				return {};
			},
			{ concurrency: 1, now: () => 0 }
		);

		expect(summary.aborted).toBe(false);
		expect(summary.failed).toBe(1);
		expect(summary.refreshed).toBe(2); // 1 and 3 still ran
	});

	it('counts a null scan result (vanished/not-owned) as skipped, not failed', async () => {
		const items = [item(1, null), item(2, null)];
		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => (it.id === 1 ? null : {}),
			{ concurrency: 1, now: () => 0 }
		);
		expect(summary.refreshed).toBe(1);
		expect(summary.skipped).toBe(1);
		expect(summary.failed).toBe(0);
	});
});

describe('isConnectClassError', () => {
	it('matches ElectrumClient connect/timeout/closed error strings', () => {
		for (const msg of [
			'Electrum connect to host:50002 timed out after 15000ms',
			'Electrum request timed out after 15000ms: blockchain.scripthash.get_balance',
			'Not connected to host:50002',
			'Electrum connection error (host:50002): read ECONNRESET',
			'Electrum connection closed (host:50002)',
			'Electrum connection lost (host:50002)',
			'Client is closed'
		]) {
			expect(isConnectClassError(new Error(msg)), msg).toBe(true);
		}
	});

	it('matches raw socket errno codes', () => {
		expect(isConnectClassError(new Error('connect ECONNREFUSED 10.0.0.1:50002'))).toBe(true);
		expect(isConnectClassError(new Error('getaddrinfo EAI_AGAIN electrum.example'))).toBe(true);
	});

	it('does NOT match ordinary wallet/logic errors', () => {
		expect(isConnectClassError(new Error('Wallet not found'))).toBe(false);
		expect(isConnectClassError(new Error('invalid xpub checksum'))).toBe(false);
		expect(isConnectClassError('some string')).toBe(false);
	});
});

// ------------------------------------------------------- list-view summary blob

describe('summarizeWalletSnapshot / finalizeCachedBalance', () => {
	const walletWith = (scan: WalletSnapshot['scan']): WalletSnapshot => ({
		...EMPTY_WALLET_SNAPSHOT,
		scan
	});

	it('returns null for a snapshot with no scan (never-synced shell)', () => {
		expect(summarizeWalletSnapshot(EMPTY_WALLET_SNAPSHOT)).toBeNull();
		expect(finalizeCachedBalance(null)).toBeNull();
	});

	it('carries balance and newest CONFIRMED time as last activity', () => {
		const snap = walletWith({
			addresses: [],
			confirmed: 150_000,
			unconfirmed: 0,
			txs: [
				{ txid: 'a', height: 800_000, time: 1_700_000_000, delta: 100_000, fee: 200 },
				{ txid: 'b', height: 800_100, time: 1_700_500_000, delta: 50_000, fee: 200 }
			]
		});
		const summary = summarizeWalletSnapshot(snap)!;
		expect(summary.confirmed).toBe(150_000);
		expect(summary.unconfirmed).toBe(0);
		expect(summary.hasPending).toBe(false);
		expect(summary.latestConfirmedTime).toBe(1_700_500_000); // newest confirmed

		const bal = finalizeCachedBalance(summary)!;
		expect(bal).toEqual({ confirmed: 150_000, unconfirmed: 0, lastActivity: 1_700_500_000 });
	});

	it('reports a pending tx as live "now" rather than a frozen timestamp', () => {
		const snap = walletWith({
			addresses: [],
			confirmed: 0,
			unconfirmed: 40_000,
			txs: [{ txid: 'p', height: 0, time: null, delta: 40_000, fee: 100 }]
		});
		const summary = summarizeWalletSnapshot(snap)!;
		expect(summary.hasPending).toBe(true);
		expect(summary.latestConfirmedTime).toBeNull();

		const before = Math.floor(Date.now() / 1000);
		const bal = finalizeCachedBalance(summary)!;
		expect(bal.lastActivity).toBeGreaterThanOrEqual(before);
	});

	it('summarizes a multisig snapshot from its detail slice', () => {
		const snap: MultisigSnapshot = {
			...EMPTY_MULTISIG_SNAPSHOT,
			detail: {
				balance: { confirmed: 900_000, unconfirmed: 10_000 },
				addresses: [],
				history: [{ txid: 'm', height: 810_000, time: 1_699_000_000, delta: 900_000, fee: 300 }],
				utxoCount: 1
			}
		};
		const summary = summarizeMultisigSnapshot(snap)!;
		expect(summary).toEqual({
			confirmed: 900_000,
			unconfirmed: 10_000,
			hasPending: false,
			latestConfirmedTime: 1_699_000_000
		});
	});
});
