// Startup pre-warming of the per-wallet/per-multisig scan caches.
//
// The portfolio aggregator (portfolio.ts) has no cache of its own — it re-scans
// every wallet via the per-wallet/per-multisig 60s in-memory caches in
// walletScan.ts / multisigScan.ts. On a cold server those caches are empty, so
// the first portfolio load pays a full serialized scan of every wallet over the
// single shared Electrum connection (~4.29s for 245 wallets in the load test,
// Scenario 7). Warming those caches shortly after boot turns that first request
// warm. See cairn-fd56. Cross-restart instant-but-stale reads are handled by
// seeding these caches from the persisted wallet_scan_cache table at startup
// (seedScanCachesFromDb below / scanCachePersist.ts — cairn-er1k).

import { db } from './db';
import { childLogger } from './logger';
import type { WalletScanResult } from './bitcoin/walletScan';
import { scanWallet, primeWalletScanCache } from './bitcoin/walletScan';
import type { MultisigScanResult } from './multisigScan';
import { scanMultisig, primeMultisigScanCache } from './multisigScan';
import { listMultisigs } from './wallets/multisig';
import { loadPersistedScans } from './scanCachePersist';

const log = childLogger('portfolio-warm');

/** Defer past the address watcher's own initial pass (10s) so warming doesn't
 *  compete with the Electrum client's initial connect/subscribe/baseline. */
const WARM_DELAY_MS = 20_000;

let started = false;

/** Yield to the event loop so a queued HTTP request can interleave between scans. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Seed the in-memory scan caches from the persisted `wallet_scan_cache` table so
 * requests in the window between boot and the warm pass get an instant (if
 * slightly stale) result instead of paying a cold serialized re-scan. Synchronous
 * and cheap (local SQLite reads); runs at startup, BEFORE the network warm pass.
 *
 * The seeded entries are given a normal TTL so early requests are served, then
 * replaced with live data by the force-refreshing warm pass moments later.
 * Best-effort: any failure is logged and skipped — persistence is a pure
 * optimization, never a correctness dependency.
 *
 * Staleness UX note (cairn-er1k item 5): a seeded read is at most as stale as the
 * last pre-restart scan and is refreshed within ~WARM_DELAY_MS. The existing live
 * cache already serves up-to-60s-old balances with no indicator, and per Cairn's
 * UX philosophy (calm, no exposed internals, no signal the user can act on) we
 * deliberately do NOT add an "Updating…" badge for the brief post-restart window
 * — it would flicker on every restart for a difference the user cannot influence.
 */
export function seedScanCachesFromDb(): void {
	let wallets = 0;
	let multisigs = 0;
	try {
		for (const row of loadPersistedScans<WalletScanResult>('wallet')) {
			primeWalletScanCache(row.key, row.result);
			wallets++;
		}
	} catch (e) {
		log.debug({ err: e }, 'seed: wallet scan cache failed (skipped)');
	}
	try {
		for (const row of loadPersistedScans<MultisigScanResult>('multisig')) {
			primeMultisigScanCache(row.key, row.result);
			multisigs++;
		}
	} catch (e) {
		log.debug({ err: e }, 'seed: multisig scan cache failed (skipped)');
	}
	if (wallets || multisigs) log.info({ wallets, multisigs }, 'scan caches seeded from persisted rows');
}

/**
 * Populate the scan caches for every wallet and multisig across all users.
 *
 * Best-effort: a failure for one wallet is logged and skipped so a single bad
 * xpub or a chain hiccup never aborts the whole pass. Scans run serially with a
 * yield between them — the underlying scans share one Electrum connection, so
 * flooding them concurrently would neither be faster nor kind to in-flight user
 * requests. scanWallet/scanMultisig populate their own 60s in-memory caches, so
 * this simply front-runs the first real request.
 */
export async function warmPortfolioCache(): Promise<void> {
	let wallets = 0;
	let multisigs = 0;

	// scanWallet is keyed by xpub and user-independent, so a DISTINCT sweep warms
	// each unique wallet once even if several accounts imported the same xpub.
	const xpubs = (db.prepare('SELECT DISTINCT xpub FROM wallets').all() as { xpub: string }[]).map(
		(r) => r.xpub
	);
	for (const xpub of xpubs) {
		try {
			// Force-refresh: replace any persisted seed with a live scan.
			await scanWallet(xpub, { forceRefresh: true });
			wallets++;
		} catch (e) {
			log.debug({ err: e }, 'warm: wallet scan failed (skipped)');
		}
		await yieldToEventLoop();
	}

	// Multisigs need a full MultisigRow (keys included) to scan; listMultisigs
	// builds them per user, so enumerate users and warm each one's multisigs.
	const userIds = (db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id);
	for (const userId of userIds) {
		let rows;
		try {
			rows = listMultisigs(userId);
		} catch (e) {
			log.debug({ err: e, userId }, 'warm: listing multisigs failed (skipped)');
			continue;
		}
		for (const m of rows) {
			try {
				await scanMultisig(m, { forceRefresh: true });
				multisigs++;
			} catch (e) {
				log.debug({ err: e, multisigId: m.id }, 'warm: multisig scan failed (skipped)');
			}
			await yieldToEventLoop();
		}
	}

	log.info({ wallets, multisigs }, 'portfolio scan cache pre-warmed');
}

/**
 * Kick off a single deferred warm pass after startup. Idempotent and unref'd —
 * it never holds the process open and never throws into the caller.
 */
export function startPortfolioWarm(): void {
	if (started) return;
	started = true;

	// Seed the in-memory caches from persisted rows immediately (synchronous,
	// local) so requests before the deferred network warm pass get instant data.
	try {
		seedScanCachesFromDb();
	} catch (e) {
		log.error({ err: e }, 'seeding scan caches from persisted rows failed');
	}

	const timer = setTimeout(() => {
		void warmPortfolioCache().catch((e) => log.error({ err: e }, 'portfolio warm pass failed'));
	}, WARM_DELAY_MS);
	timer.unref?.();
}
