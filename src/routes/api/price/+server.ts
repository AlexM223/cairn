import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';

// Optional fiat estimate for the portfolio hero. Privacy-first: the dashboard
// only calls this endpoint when the user explicitly turns fiat ON (off by
// default), so no price service is contacted otherwise. The price is sourced
// through the admin's configured Esplora backend — a self-hosted mempool
// instance serves its own /v1/prices — and only a plain esplora backend (which
// has no price endpoint) falls back to the public mempool.space. Caching lives
// in the chain layer. See ChainService.getBtcUsdPrice.

/** GET /api/price — current BTC→USD spot, or { usd: null } when unavailable. */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	return json({ usd: await getChain().getBtcUsdPrice() });
};
