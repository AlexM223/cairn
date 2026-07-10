import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { readPortfolioSnapshot } from '$lib/server/portfolioSnapshot';
import type { RequestHandler } from './$types';

/**
 * Full portfolio across the user's single-sig and multisig wallets — total
 * balance, allocation, cross-wallet recent activity, the balance-over-time
 * series, and per-wallet sparklines.
 *
 * Stale-while-revalidate (cairn — dashboard SWR): this is now a SYNCHRONOUS read
 * of the persisted per-user aggregate (portfolioSnapshot.ts) and NEVER scans.
 * The aggregate is (re)built by the coalesced background refresh pass
 * (walletSync.refreshPortfolio) from the per-wallet snapshots it already
 * produced — so a dashboard visit no longer blocks the hero balance on live
 * Electrum round-trips. The client fetches this instantly on mount, fires POST
 * /api/portfolio/refresh in the background, then refetches to pick up the fresh
 * aggregate — exactly the pattern the wallets list uses.
 *
 * `portfolio` is null until the first refresh has persisted an aggregate (the
 * page then shows its first-sync state); `lastSyncedAt` drives the freshness
 * indicator.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const snap = readPortfolioSnapshot(user.id);
	// No aggregate yet (never synced, or the user has no wallets) → null; the page
	// distinguishes onboarding from first-sync via its own hasWallets signal.
	if (!snap || snap.detail.walletCount === 0) {
		return json({ portfolio: null, lastSyncedAt: snap?.lastSyncedAt ?? null });
	}
	return json({ portfolio: snap.detail, lastSyncedAt: snap.lastSyncedAt });
};
