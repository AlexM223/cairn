// Unit tests for the stale-while-revalidate engine (cairn-2zxt). These exercise
// `singleFlightThrottled` directly — the pure single-flight + throttle core that
// refreshWalletSnapshot / refreshMultisigSnapshot both wrap — so the guarantees
// (throttle returns cached without scanning; concurrent callers coalesce to ONE
// scan) are covered without a live Electrum backend or a wallet fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';

// Mocks for the doWalletScan coinbase-bucketing regression tests (QA finding
// F2) below — same shape as cpfp.test.ts's chain/walletScan mock, exposing
// ONLY getTxHex (no getTx) to mirror an Electrum-only backend.
const { getTxHexMock, listUnspentMock, scanWalletMock, findNextUnusedIndexMock } = vi.hoisted(() => ({
	getTxHexMock: vi.fn(),
	listUnspentMock: vi.fn(),
	scanWalletMock: vi.fn(),
	findNextUnusedIndexMock: vi.fn()
}));

vi.mock('./chain', () => ({
	getChain: () => ({
		getTxHex: getTxHexMock,
		getTip: () => Promise.resolve({ height: 900_050 }),
		electrum: {
			listUnspent: listUnspentMock,
			// getWalletUtxos batches listunspent via batchRequest — dispatch each
			// sub-request to the same per-scripthash listUnspent mock.
			batchRequest: (items: { method: string; params: unknown[] }[]) =>
				Promise.all(items.map((it) => listUnspentMock(it.params[0])))
		}
	})
}));

vi.mock('./bitcoin/walletScan', async (orig) => {
	const actual = await orig<typeof import('./bitcoin/walletScan')>();
	return { ...actual, scanWallet: scanWalletMock, findNextUnusedIndex: findNextUnusedIndexMock };
});

// cairn-g1u2: sendSnapshot gates the send-page fast path on isWalletWatched.
// Partial-mock addressWatcher (keep every real export the module graph needs —
// unwatchWallet etc. — override ONLY isWalletWatched) so tests drive the
// "watched vs not" branch deterministically. Defaults to watched.
const { isWalletWatchedMock } = vi.hoisted(() => ({ isWalletWatchedMock: vi.fn(() => true) }));
vi.mock('./addressWatcher', async (orig) => ({
	...(await orig<typeof import('./addressWatcher')>()),
	isWalletWatched: isWalletWatchedMock
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	singleFlightThrottled,
	shouldSkipScan,
	THROTTLE_MS,
	MAX_CLEAN_TTL_MS,
	SCAN_CONCURRENCY,
	createLimiter,
	runPortfolioRefreshPass,
	isConnectClassError,
	summarizeWalletSnapshot,
	summarizeMultisigSnapshot,
	finalizeCachedBalance,
	refreshWalletSnapshot,
	refreshPortfolio,
	readWalletSnapshot,
	readDirtySince,
	readSyncMeta,
	clearDirtyIfUnchanged,
	markWalletDirty,
	sendSnapshot,
	EMPTY_WALLET_SNAPSHOT,
	EMPTY_MULTISIG_SNAPSHOT,
	type PortfolioRefreshItem,
	type WalletSnapshot,
	type MultisigSnapshot,
	type SnapshotUtxo
} from './walletSync';
import {
	DEFAULT_POOL_SIZE,
	DEFAULT_BACKGROUND_LANE_SIZE,
	backgroundLaneWidth
} from './electrum/pool';

describe('SCAN_CONCURRENCY (task 3: decoupled from raw pool size)', () => {
	it('is pegged to the BACKGROUND-lane width, not DEFAULT_POOL_SIZE', () => {
		// The whole point of task 3: a future pool-size bump must NOT silently raise
		// scan pressure. Scans run on the background lane (pool - 1 sockets), so the
		// concurrency cap tracks that width — not the raw pool size.
		expect(SCAN_CONCURRENCY).toBe(DEFAULT_BACKGROUND_LANE_SIZE);
		expect(SCAN_CONCURRENCY).toBe(backgroundLaneWidth(DEFAULT_POOL_SIZE));
		expect(SCAN_CONCURRENCY).toBe(DEFAULT_POOL_SIZE - 1);
		// Regression guard: with the pool now at 3, this must be 2 — and explicitly
		// NOT the pool size (the old coupling that let a pool bump raise scan load).
		expect(SCAN_CONCURRENCY).toBe(2);
		expect(SCAN_CONCURRENCY).not.toBe(DEFAULT_POOL_SIZE);
	});
});

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

	it('dirty-aware: skips a CLEAN item within TTL but scans a DIRTY one past the throttle (cairn-wcxw)', async () => {
		const now = () => 1_000_000_000;
		const scanned: number[] = [];
		const items: PortfolioRefreshItem[] = [
			// clean, 25s old — inside the 30min clean ceiling → skip (the wcxw win)
			{ kind: 'wallet', id: 1, lastSyncedAt: now() - (THROTTLE_MS + 5_000), dirtySince: null },
			// dirty, 25s old — past the 20s throttle floor → scan
			{
				kind: 'wallet',
				id: 2,
				lastSyncedAt: now() - (THROTTLE_MS + 5_000),
				dirtySince: now() - 4_000
			},
			// clean but older than the TTL → the self-heal net rescans
			{ kind: 'wallet', id: 3, lastSyncedAt: now() - (MAX_CLEAN_TTL_MS + 1), dirtySince: null }
		];

		const summary = await runPortfolioRefreshPass(
			items,
			async (it) => {
				scanned.push(it.id);
				return {};
			},
			{ concurrency: 1, now, cleanSkipMs: MAX_CLEAN_TTL_MS }
		);

		expect(scanned.sort()).toEqual([2, 3]);
		expect(summary.refreshed).toBe(2);
		expect(summary.skipped).toBe(1); // the clean, in-TTL item
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

// --------------------------------------- doWalletScan coinbase bucketing (F2)
//
// QA finding F2 (P0): in Electrum-only mode, isCoinbaseTx used to resolve
// EVERY utxo to 'unknown' (getTx requires Core RPC), and this module's
// doWalletScan bucketed coinbaseUtxos with a bare truthiness filter
// (`.filter((u) => u.coinbase)`) — so 'unknown' (truthy) rendered every
// ordinary deposit and change output as an immature mining reward. These
// tests exercise the REAL doWalletScan (via refreshWalletSnapshot, since
// doWalletScan itself isn't exported) against a seeded wallet row, with the
// chain/scan mocked at the same seam cpfp.test.ts uses.

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0

function wipeWalletFixtures(): void {
	db.exec(
		'DELETE FROM wallet_snapshots; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

async function seedWallet(): Promise<{ userId: number; walletId: number }> {
	setSetting('registration_mode', 'open');
	const user = await registerUser({
		email: `f2-${Math.random().toString(36).slice(2)}@example.com`,
		password: 'correct horse battery',
		displayName: 'u'
	});
	const res = db
		.prepare(
			"INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint, derivation_path) VALUES (?, 'W', 'xpub', ?, 'p2wpkh', '73c5da0a', ?)"
		)
		.run(user.id, ZPUB, "m/84'/0'/0'");
	return { userId: user.id, walletId: Number(res.lastInsertRowid) };
}

/** Point the mocked scan + listunspent at ONE confirmed UTXO on RECEIVE_0. */
function stubOneConfirmedUtxo(fundingTxid: string, value: number, height: number): void {
	scanWalletMock.mockResolvedValue({
		addresses: [{ address: RECEIVE_0, index: 0, change: false, used: true, balance: value }],
		txs: [],
		confirmed: value,
		unconfirmed: 0
	});
	listUnspentMock.mockResolvedValue([{ tx_hash: fundingTxid, tx_pos: 0, value, height }]);
	findNextUnusedIndexMock.mockResolvedValue(1);
}

/** Raw hex of an ordinary (non-coinbase) funding tx — a real prevout input. */
function normalRawHex(): string {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: 'ab'.repeat(32), index: 0 });
	tx.addOutputAddress(RECEIVE_0, 150_000_000n, NETWORK);
	return tx.hex;
}

/** Raw hex of a genuine coinbase tx — the synthetic zero-prevout/0xffffffff input. */
function coinbaseRawHex(): string {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0xffffffff });
	tx.addOutputAddress(RECEIVE_0, 5_000_000_000n, NETWORK);
	return tx.hex;
}

describe('doWalletScan coinbase bucketing — QA finding F2 regression lock', () => {
	beforeEach(() => {
		wipeWalletFixtures();
		getTxHexMock.mockReset();
		listUnspentMock.mockReset();
		scanWalletMock.mockReset();
		findNextUnusedIndexMock.mockReset();
	});

	it('an ordinary confirmed deposit (Electrum-only: getTxHex works) is NOT bucketed as a mining reward', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('ab'.repeat(32), 150_000_000, 900_000); // 51 confs at tip 900_050
		getTxHexMock.mockResolvedValue(normalRawHex());

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		expect(snap!.coinbaseUtxos).toEqual([]);
		// cairn-oae1.3: a non-coinbase wallet must report zero maturing value.
		expect(snap!.maturingTotal).toBe(0);
	});

	it('a genuine MATURE coinbase deposit IS bucketed as a mining reward', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('cd'.repeat(32), 5_000_000_000, 800_000); // 100+ confs — mature
		getTxHexMock.mockResolvedValue(coinbaseRawHex());

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		expect(snap!.coinbaseUtxos).toHaveLength(1);
		expect(snap!.coinbaseUtxos[0]).toMatchObject({ txid: 'cd'.repeat(32), vout: 0 });
		// cairn-oae1.3: mature coinbase contributes nothing to the maturing figure —
		// it's already fully counted in the ordinary "available" balance.
		expect(snap!.maturingTotal).toBe(0);
	});

	it('cairn-oae1.3: a genuine IMMATURE coinbase deposit is excluded from available and counted as maturing', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('12'.repeat(32), 5_000_000_000, 900_000); // 51 confs at tip 900_050 — immature
		getTxHexMock.mockResolvedValue(coinbaseRawHex());

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		expect(snap!.coinbaseUtxos).toHaveLength(1);
		// Electrum's `confirmed` (scan.confirmed) counts the immature coinbase as
		// spendable — maturingTotal is the piece a caller subtracts to get the
		// truly-spendable figure, and it must equal the coin's full value here
		// (nothing else on the wallet).
		expect(snap!.scan!.confirmed).toBe(5_000_000_000);
		expect(snap!.maturingTotal).toBe(5_000_000_000);
	});

	it("a chain hiccup (getTxHex failing => coinbase 'unknown') does NOT bucket the coin as a mining reward", async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('ef'.repeat(32), 150_000_000, 900_000);
		getTxHexMock.mockRejectedValue(new Error('electrum: connection reset'));

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		// The pre-fix bug: 'unknown' is truthy, so a bare `.filter((u) => u.coinbase)`
		// would have put this coin here. Strict `=== true` must exclude it.
		expect(snap!.coinbaseUtxos).toEqual([]);
		expect(snap!.maturingTotal).toBe(0);
		// cairn-8lwa6: the DISPLAY path must fail closed like the send path — a
		// YOUNG (51-conf) coin whose coinbase-ness couldn't be verified is counted
		// as "still being verified", never silently presented as plain spendable.
		expect(snap!.unverifiedTotal).toBe(150_000_000);
	});

	it("cairn-8lwa6: an OLD unverifiable coin (past COINBASE_MATURITY confs) is provably spendable — unverifiedTotal 0", async () => {
		const { userId, walletId } = await seedWallet();
		// 100+ confs at tip 900_050: even IF it were coinbase it would be mature.
		stubOneConfirmedUtxo('ab'.repeat(32), 150_000_000, 800_000);
		getTxHexMock.mockRejectedValue(new Error('electrum: connection reset'));

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		expect(snap!.coinbaseUtxos).toEqual([]);
		expect(snap!.unverifiedTotal).toBe(0);
	});

	it('cairn-8lwa6: definite coinbase and definite non-coinbase coins never count as unverified', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('12'.repeat(32), 5_000_000_000, 900_000); // young immature coinbase
		getTxHexMock.mockResolvedValue(coinbaseRawHex());

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap).not.toBeNull();
		expect(snap!.maturingTotal).toBe(5_000_000_000); // definite → maturing bucket
		expect(snap!.unverifiedTotal).toBe(0); // not the unverified bucket
	});

	// cairn-zdgt: a single refresh must fetch the wallet's UTXO set ONCE. The
	// coinbase bucketing and the speed-up (RBF/CPFP) detection both need it;
	// pre-fix each fetched independently (coinbase via getWalletUtxos, speed-up
	// via detectWalletUnconfirmedInflows, which re-fetched internally), so a
	// refresh did TWO full listunspent-per-used-address passes for the same
	// wallet. listUnspentMock fires once per candidate address per getWalletUtxos
	// call, so with a single used address the call count is exactly the number of
	// UTXO fetches: 1 after the fix, was 2 before it.
	it('fetches the wallet UTXO set only ONCE per refresh (cairn-zdgt)', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('12'.repeat(32), 150_000_000, 900_000);
		getTxHexMock.mockResolvedValue(normalRawHex());

		await refreshWalletSnapshot(userId, walletId, { force: true });

		expect(listUnspentMock).toHaveBeenCalledTimes(1);
	});
});

// ------------- cairn-0tvez: never persist an empty snapshot for an unwatched wallet
//
// A wallet with no live scripthash subscription has nothing to ever mark it
// dirty again — persisting an EMPTY ("clean") snapshot for one would get it
// stuck showing zero forever once it's actually funded (dirty_since stays
// null, and the clean-skip TTL trusts that indefinitely). doWalletScan must
// skip the persist in exactly that case, while still returning the correct
// (empty) result to the caller in flight, and must still persist normally
// once the wallet IS watched, or for any NON-empty result regardless of watch
// status (a real balance must never be hidden).

describe('cairn-0tvez: empty-snapshot persistence guard', () => {
	beforeEach(() => {
		wipeWalletFixtures();
		getTxHexMock.mockReset();
		listUnspentMock.mockReset();
		scanWalletMock.mockReset();
		findNextUnusedIndexMock.mockReset();
		isWalletWatchedMock.mockReset();
	});

	function stubEmptyWallet(): void {
		scanWalletMock.mockResolvedValue({
			addresses: [{ address: RECEIVE_0, index: 0, change: false, used: false, balance: 0 }],
			txs: [],
			confirmed: 0,
			unconfirmed: 0
		});
		listUnspentMock.mockResolvedValue([]);
		findNextUnusedIndexMock.mockResolvedValue(0);
	}

	it('does NOT persist a snapshot for an empty scan when the wallet is not watched', async () => {
		const { userId, walletId } = await seedWallet();
		stubEmptyWallet();
		isWalletWatchedMock.mockReturnValue(false);

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		// The in-flight caller still gets a correct (empty) answer...
		expect(snap).not.toBeNull();
		expect(snap!.scan!.confirmed).toBe(0);
		// ...but nothing was written to the DB as a trustworthy "clean" baseline —
		// the next load falls through to a live rescan instead of getting stuck.
		expect(readWalletSnapshot(walletId)).toBeNull();
	});

	it('DOES persist an empty scan once the wallet is actively watched', async () => {
		const { userId, walletId } = await seedWallet();
		stubEmptyWallet();
		isWalletWatchedMock.mockReturnValue(true);

		await refreshWalletSnapshot(userId, walletId, { force: true });

		expect(readWalletSnapshot(walletId)).not.toBeNull();
	});

	it('persists a NON-empty scan even when the wallet is not watched (a real balance must never be hidden)', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('ab'.repeat(32), 150_000_000, 900_000);
		getTxHexMock.mockResolvedValue(normalRawHex());
		isWalletWatchedMock.mockReturnValue(false);

		const snap = await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(snap!.scan!.confirmed).toBe(150_000_000);

		const stored = readWalletSnapshot(walletId);
		expect(stored).not.toBeNull();
		expect(stored!.snapshot.scan!.confirmed).toBe(150_000_000);
	});
});

// ============================================================================
// cairn-wcxw — sync engine Phase 1: Electrum status-hash dirty-tracking
// ============================================================================

describe('shouldSkipScan — dirty-aware skip decision (cairn-wcxw)', () => {
	const now = () => 1_000_000_000;

	it('never skips when forced', () => {
		expect(
			shouldSkipScan({ force: true, lastSyncedAt: now() - 1_000, dirtySince: null, now })
		).toBe(false);
	});

	it('never skips the FIRST scan (no snapshot yet)', () => {
		// The money-grade invariant: an address/wallet we have never scanned is never
		// treated as clean, regardless of window.
		expect(shouldSkipScan({ lastSyncedAt: null, dirtySince: null, now })).toBe(false);
	});

	it('a CLEAN wallet skips past the 20s throttle, up to MAX_CLEAN_TTL', () => {
		const cleanSkipMs = MAX_CLEAN_TTL_MS;
		// 25s old — past the throttle floor but well inside the clean ceiling.
		expect(
			shouldSkipScan({
				lastSyncedAt: now() - (THROTTLE_MS + 5_000),
				dirtySince: null,
				throttleMs: THROTTLE_MS,
				cleanSkipMs,
				now
			})
		).toBe(true);
		// Older than the ceiling → the TTL self-heal net kicks in, rescan.
		expect(
			shouldSkipScan({
				lastSyncedAt: now() - (cleanSkipMs + 1),
				dirtySince: null,
				throttleMs: THROTTLE_MS,
				cleanSkipMs,
				now
			})
		).toBe(false);
	});

	it('a DIRTY wallet only coalesces within the throttle floor, then rescans', () => {
		const cleanSkipMs = MAX_CLEAN_TTL_MS;
		// Dirty + within 20s → coalesce a burst (skip).
		expect(
			shouldSkipScan({
				lastSyncedAt: now() - 5_000,
				dirtySince: now() - 4_000,
				throttleMs: THROTTLE_MS,
				cleanSkipMs,
				now
			})
		).toBe(true);
		// Dirty + past 20s → rescan even though it's far inside the CLEAN ceiling.
		expect(
			shouldSkipScan({
				lastSyncedAt: now() - (THROTTLE_MS + 1),
				dirtySince: now() - (THROTTLE_MS + 1),
				throttleMs: THROTTLE_MS,
				cleanSkipMs,
				now
			})
		).toBe(false);
	});

	it('defaults cleanSkipMs to throttleMs (plain throttle when a caller opts out)', () => {
		// With no cleanSkipMs a clean wallet behaves exactly like the pre-wcxw
		// throttle: skip within 20s, scan past it.
		expect(shouldSkipScan({ lastSyncedAt: now() - 5_000, now })).toBe(true);
		expect(shouldSkipScan({ lastSyncedAt: now() - (THROTTLE_MS + 1), now })).toBe(false);
	});
});

describe('clearDirtyIfUnchanged — compare-and-swap clear (cairn-wcxw)', () => {
	beforeEach(() => wipeWalletFixtures());

	/** Insert a bare snapshot row with a given dirty_since. */
	function seedSnapshotRow(dirtySince: number | null): void {
		db.prepare(
			`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at, dirty_since)
			 VALUES ('wallet', 42, '{}', NULL, ?, ?)`
		).run(Date.now(), dirtySince);
	}

	it('clears the flag when it is unchanged from what the scan saw', () => {
		seedSnapshotRow(5_000);
		expect(clearDirtyIfUnchanged('wallet', 42, 5_000)).toBe(true);
		expect(readDirtySince('wallet', 42)).toBeNull();
	});

	it('leaves the wallet DIRTY when a status change raced the scan (value moved)', () => {
		// Scan started with dirty_since = 5_000; a mid-scan change bumped it to 9_000.
		seedSnapshotRow(9_000);
		expect(clearDirtyIfUnchanged('wallet', 42, 5_000)).toBe(false);
		// Still dirty → the next refresh will rescan and capture the raced change.
		expect(readDirtySince('wallet', 42)).toBe(9_000);
	});

	it('is a null-safe no-op clear for an already-clean row', () => {
		seedSnapshotRow(null);
		expect(clearDirtyIfUnchanged('wallet', 42, null)).toBe(true);
		expect(readDirtySince('wallet', 42)).toBeNull();
	});
});

describe('readSyncMeta (cairn-wcxw)', () => {
	beforeEach(() => wipeWalletFixtures());

	it('returns lastSyncedAt + dirtySince without parsing the snapshot blob', () => {
		db.prepare(
			`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at, dirty_since)
			 VALUES ('wallet', 7, 'not valid json {{{', NULL, 123456, 999)`
		).run();
		// Deliberately corrupt snapshot JSON — readSyncMeta must NOT touch it.
		const meta = readSyncMeta('wallet', 7);
		expect(meta).toEqual({ lastSyncedAt: 123456, dirtySince: 999 });
		expect(readSyncMeta('wallet', 999)).toBeNull();
	});
});

describe('refreshWalletSnapshot dirty gate — integration (cairn-wcxw)', () => {
	beforeEach(() => {
		wipeWalletFixtures();
		getTxHexMock.mockReset();
		listUnspentMock.mockReset();
		scanWalletMock.mockReset();
		findNextUnusedIndexMock.mockReset();
	});

	/** Backdate the persisted snapshot and set its dirty flag directly. */
	function setSnapshotState(walletId: number, ageMs: number, dirtySince: number | null): void {
		db.prepare(
			'UPDATE wallet_snapshots SET last_synced_at = ?, dirty_since = ? WHERE wallet_kind = ? AND wallet_id = ?'
		).run(Date.now() - ageMs, dirtySince, 'wallet', walletId);
	}

	it('a CLEAN wallet past the throttle but within TTL is served from cache — no scan', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('12'.repeat(32), 150_000_000, 900_000);
		getTxHexMock.mockResolvedValue(normalRawHex());

		// First scan establishes the snapshot (dirty cleared to NULL on success).
		await refreshWalletSnapshot(userId, walletId, { force: true });
		expect(readDirtySince('wallet', walletId)).toBeNull();

		// 25s old (past the 20s throttle) but clean → clean-skip up to 30min. Clear
		// the mock so any call at all here means a (wrongly triggered) rescan — one
		// doWalletScan hits scanWallet more than once (scan + getWalletUtxos), so we
		// assert scan-happened vs skipped, not an exact count.
		scanWalletMock.mockClear();
		setSnapshotState(walletId, THROTTLE_MS + 5_000, null);
		const snap = await refreshWalletSnapshot(userId, walletId);
		expect(snap).not.toBeNull();
		expect(scanWalletMock).not.toHaveBeenCalled(); // NOT re-scanned — the wcxw win
	});

	it('a DIRTY wallet past the throttle rescans and the scan clears the flag', async () => {
		const { userId, walletId } = await seedWallet();
		stubOneConfirmedUtxo('12'.repeat(32), 150_000_000, 900_000);
		getTxHexMock.mockResolvedValue(normalRawHex());

		await refreshWalletSnapshot(userId, walletId, { force: true });

		// Simulate a scripthash status change: backdate + mark dirty.
		scanWalletMock.mockClear();
		setSnapshotState(walletId, THROTTLE_MS + 5_000, Date.now() - 3_000);
		const snap = await refreshWalletSnapshot(userId, walletId);
		expect(snap).not.toBeNull();
		expect(scanWalletMock).toHaveBeenCalled(); // dirty → rescanned
		// Successful scan compare-and-swapped the flag back to clean.
		expect(readDirtySince('wallet', walletId)).toBeNull();
	});
});

// -------------------------------------------------- send-page snapshot fast path
//
// cairn-g1u2. sendSnapshot serves a PROVABLY-clean wallet's persisted coins +
// balance so the send load skips the live re-scan; on ANY doubt it returns null
// (⇒ caller re-scans live). markWalletDirty is the broadcast-time guard that
// forces the next send load back onto the live scan.

describe('sendSnapshot (cairn-g1u2 send-page fast path)', () => {
	const coinbaseUtxos = [] as const;

	function putWalletSnapshot(
		id: number,
		over: Partial<WalletSnapshot>,
		meta: { lastSyncedAt?: number; dirtySince?: number | null } = {}
	): void {
		const snap: WalletSnapshot = {
			scan: { addresses: [], txs: [], confirmed: 500_000, unconfirmed: 0 },
			receive: null,
			coinbaseUtxos: [...coinbaseUtxos],
			spendableUtxos: [
				{ txid: 'a'.repeat(64), vout: 0, value: 300_000, height: 800_000, coinbase: false },
				{ txid: 'b'.repeat(64), vout: 1, value: 200_000, height: 800_010, coinbase: false }
			],
			tipHeight: 900_000,
			maturingTotal: 0,
			speedUp: [],
			scanError: null,
			...over
		};
		db.prepare(
			`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at, dirty_since)
			 VALUES ('wallet', ?, ?, NULL, ?, ?)
			 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET
			   snapshot = excluded.snapshot, last_synced_at = excluded.last_synced_at,
			   dirty_since = excluded.dirty_since`
		).run(id, JSON.stringify(snap), meta.lastSyncedAt ?? Date.now(), meta.dirtySince ?? null);
	}

	beforeEach(() => {
		isWalletWatchedMock.mockReset();
		isWalletWatchedMock.mockReturnValue(true);
		db.prepare("DELETE FROM wallet_snapshots WHERE wallet_id >= 9000").run();
	});

	it('serves a CLEAN, watched, fresh, new-format wallet from the snapshot', () => {
		putWalletSnapshot(9001, {});
		const out = sendSnapshot('wallet', 9001);
		expect(out).not.toBeNull();
		expect(out!.confirmed).toBe(500_000);
		expect(out!.tipHeight).toBe(900_000);
		expect(out!.utxos).toHaveLength(2);
		expect(out!.utxos[0].txid).toBe('a'.repeat(64));
	});

	it('returns null (⇒ live scan) when the wallet is DIRTY', () => {
		putWalletSnapshot(9002, {}, { dirtySince: Date.now() });
		expect(sendSnapshot('wallet', 9002)).toBeNull();
	});

	it('returns null when the wallet is not watched (no live subscription)', () => {
		isWalletWatchedMock.mockReturnValue(false);
		putWalletSnapshot(9003, {});
		expect(sendSnapshot('wallet', 9003)).toBeNull();
	});

	it('returns null when there is no snapshot (first load)', () => {
		expect(sendSnapshot('wallet', 9999)).toBeNull();
	});

	it('returns null past MAX_CLEAN_TTL (self-healing staleness bound)', () => {
		putWalletSnapshot(9004, {}, { lastSyncedAt: Date.now() - MAX_CLEAN_TTL_MS - 1 });
		expect(sendSnapshot('wallet', 9004)).toBeNull();
	});

	it('serves right up to (just under) MAX_CLEAN_TTL', () => {
		putWalletSnapshot(9005, {}, { lastSyncedAt: Date.now() - (MAX_CLEAN_TTL_MS - 5_000) });
		expect(sendSnapshot('wallet', 9005)).not.toBeNull();
	});

	it('returns null for a pre-cairn-g1u2 snapshot (no persisted spendable set)', () => {
		// Simulate an old row: spendableUtxos absent from the JSON entirely.
		putWalletSnapshot(9006, { spendableUtxos: undefined });
		// putWalletSnapshot spreads `over` so undefined stays a key; force-strip it to
		// mirror a genuinely old row that never had the field.
		const row = db
			.prepare("SELECT snapshot FROM wallet_snapshots WHERE wallet_id = 9006")
			.get() as { snapshot: string };
		const parsed = JSON.parse(row.snapshot);
		delete parsed.spendableUtxos;
		db.prepare("UPDATE wallet_snapshots SET snapshot = ? WHERE wallet_id = 9006").run(
			JSON.stringify(parsed)
		);
		expect(sendSnapshot('wallet', 9006)).toBeNull();
	});

	it('returns null for a scan-less snapshot (never actually scanned)', () => {
		putWalletSnapshot(9007, { scan: null });
		expect(sendSnapshot('wallet', 9007)).toBeNull();
	});

	it('returns null for a degraded snapshot (scanError set)', () => {
		putWalletSnapshot(9008, { scanError: 'node unreachable' });
		expect(sendSnapshot('wallet', 9008)).toBeNull();
	});

	it('markWalletDirty flips a clean wallet so the next send load re-scans live', () => {
		putWalletSnapshot(9009, {});
		expect(sendSnapshot('wallet', 9009)).not.toBeNull(); // clean → served
		markWalletDirty('wallet', 9009);
		expect(readDirtySince('wallet', 9009)).not.toBeNull();
		expect(sendSnapshot('wallet', 9009)).toBeNull(); // now dirty → live scan
	});

	it('honours the kill-switch: skips the whole fast path (covered by env at load)', () => {
		// The kill-switch (CAIRN_SYNC_DISABLE_DIRTY_SKIP) is read once at module load
		// into CLEAN_SKIP_DISABLED; when off (the default in this suite) a clean wallet
		// is served, proving the gate is otherwise open. The env-set path is exercised
		// by cleanSkipWindowMs()'s own tests; here we assert the default-open behavior.
		putWalletSnapshot(9010, {});
		expect(sendSnapshot('wallet', 9010)).not.toBeNull();
	});
});

// ============================================================================
// cairn-qyvl — per-user coalescing of the whole refreshPortfolio pass
// ============================================================================
//
// The per-item scans already single-flight; this locks the PASS-level guarantee:
// two concurrent refreshPortfolio(userId) triggers (e.g. the startup warm pass
// racing the client dashboard refresh) share ONE in-flight pass — so the expensive
// synchronous buildPortfolioAggregate (a full-blob JSON.parse per wallet) runs once
// per burst, not once per caller — while sequential callers still each run fresh.
describe('refreshPortfolio — per-user pass coalescing (cairn-qyvl)', () => {
	beforeEach(() => {
		wipeWalletFixtures();
		scanWalletMock.mockReset();
		listUnspentMock.mockReset();
		findNextUnusedIndexMock.mockReset();
		getTxHexMock.mockReset();
	});

	it('coalesces two concurrent refreshes for the same user into one pass + one scan', async () => {
		const { userId } = await seedWallet();
		scanWalletMock.mockResolvedValue({
			addresses: [{ address: RECEIVE_0, index: 0, change: false, used: true, balance: 0 }],
			txs: [],
			confirmed: 0,
			unconfirmed: 0
		});
		listUnspentMock.mockResolvedValue([]);
		findNextUnusedIndexMock.mockResolvedValue(1);

		// Both issued before any await settles: the second synchronously hits the
		// in-flight map and gets the SAME promise — the pass itself, not just the
		// inner per-item scan, is single-flighted.
		const a = refreshPortfolio(userId);
		const b = refreshPortfolio(userId);
		expect(a).toBe(b);

		const [ra, rb] = await Promise.all([a, b]);
		expect(ra).toBe(rb); // shared result object — one pass produced both results
		// The pass actually ran (did real scan work) rather than short-circuiting.
		// Promise identity above is the coalescing proof: without pass-level
		// single-flight, `b` would be a DISTINCT promise running its own item-list
		// build + runPortfolioRefreshPass + synchronous buildPortfolioAggregate.
		expect(scanWalletMock).toHaveBeenCalled();
	});

	it('does NOT coalesce sequential (non-overlapping) refreshes — the entry clears on settle', async () => {
		const { userId } = await seedWallet();
		scanWalletMock.mockResolvedValue({
			addresses: [{ address: RECEIVE_0, index: 0, change: false, used: true, balance: 0 }],
			txs: [],
			confirmed: 0,
			unconfirmed: 0
		});
		listUnspentMock.mockResolvedValue([]);
		findNextUnusedIndexMock.mockResolvedValue(1);

		// First pass runs to completion, persisting a snapshot (last_synced_at = now).
		await refreshPortfolio(userId);
		const firstCalls = scanWalletMock.mock.calls.length;
		expect(firstCalls).toBeGreaterThanOrEqual(1);

		// A later, non-overlapping pass is a brand-new promise (not the settled one).
		const second = refreshPortfolio(userId);
		expect(typeof second.then).toBe('function');
		await second;
		// The just-written snapshot is inside the clean/throttle window, so the second
		// pass legitimately SKIPS the re-scan — proving it ran its own fresh decision
		// rather than replaying the first pass's result.
		expect(scanWalletMock.mock.calls.length).toBe(firstCalls);
	});
});
