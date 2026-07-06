import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getPortfolioDetail } from '$lib/server/portfolio';
import type { RequestHandler } from './$types';

/**
 * Full portfolio across the user's single-sig and multisig wallets — total
 * balance, allocation, cross-wallet recent activity, the balance-over-time
 * series, and per-wallet sparklines. Lives on its own endpoint so new-block
 * refreshes of the dashboard's chain data don't force a wallet rescan; the
 * client fetches this independently, once per visit.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const detail = await getPortfolioDetail(user.id);
	// No wallets → no portfolio (the dashboard shows an onboarding prompt).
	if (detail.walletCount === 0) return json({ portfolio: null });
	return json({ portfolio: detail });
};
