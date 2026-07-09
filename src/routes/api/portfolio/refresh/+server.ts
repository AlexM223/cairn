import { json, requireUser } from '$lib/server/api';
import { refreshPortfolio } from '$lib/server/walletSync';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet-sync');

/**
 * POST /api/portfolio/refresh — the coalesced background half of stale-while-
 * revalidate for the WALLETS LIST.
 *
 * One server-driven pass refreshes every wallet + multisig the caller can see,
 * most-stale-first, capped at SCAN_CONCURRENCY concurrent Electrum scans. This
 * replaces the list page firing a POST /refresh per wallet/multisig — N of them
 * hit the browser's own per-origin connection cap AND monopolized the
 * 2-connection Electrum pool, starving interactive requests (building a send,
 * opening a tx). Each per-item scan is still single-flighted + throttled, so a
 * detail page refreshing the same wallet coalesces with this pass.
 *
 * Read access (being logged in) is enough — refreshing never mutates funds.
 * Deliberately never 5xx: a fully-unreachable backend returns 200 with a summary
 * whose `failed`/`aborted` fields say so, and the client keeps serving its
 * cached list (and can decide to surface a "couldn't reach the server" retry).
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	try {
		return json(await refreshPortfolio(user.id));
	} catch (e) {
		log.warn({ err: e, userId: user.id }, 'portfolio refresh pass failed (serving cached)');
		return json({ refreshed: 0, skipped: 0, failed: 0, aborted: true });
	}
};
