// Startup pre-warming of the per-wallet/per-multisig scan caches.
//
// The portfolio aggregator (portfolio.ts) has no cache of its own — it re-scans
// every wallet via the per-wallet/per-multisig 60s in-memory caches in
// walletScan.ts / multisigScan.ts. On a cold server those caches are empty, so
// the first portfolio load pays a full serialized scan of every wallet over the
// single shared Electrum connection (~4.29s for 245 wallets in the load test,
// Scenario 7). Warming those caches shortly after boot turns that first request
// warm. See cairn-fd56. (Cross-restart instant-but-stale reads via SQLite
// persistence are tracked separately in cairn-er1k.)

import { db } from './db';
import { childLogger } from './logger';
import { scanWallet } from './bitcoin/walletScan';
import { scanMultisig } from './multisigScan';
import { listMultisigs } from './wallets/multisig';

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
			await scanWallet(xpub);
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
				await scanMultisig(m);
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

	const timer = setTimeout(() => {
		void warmPortfolioCache().catch((e) => log.error({ err: e }, 'portfolio warm pass failed'));
	}, WARM_DELAY_MS);
	timer.unref?.();
}
