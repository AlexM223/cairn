// Unit tests for the stale-while-revalidate engine (cairn-2zxt). These exercise
// `singleFlightThrottled` directly — the pure single-flight + throttle core that
// refreshWalletSnapshot / refreshMultisigSnapshot both wrap — so the guarantees
// (throttle returns cached without scanning; concurrent callers coalesce to ONE
// scan) are covered without a live Electrum backend or a wallet fixture.

import { describe, it, expect, vi } from 'vitest';
import { singleFlightThrottled, THROTTLE_MS } from './walletSync';

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
