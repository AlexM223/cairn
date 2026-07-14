import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';

// Optional fiat estimate for the portfolio hero. Privacy-first: the dashboard
// only calls this endpoint when the user explicitly turns fiat ON (off by
// default), so no price service is contacted otherwise. Neither Electrum nor
// Bitcoin Core RPC exposes a spot price, so the price is sourced from the single
// permitted public source (mempool.space /v1/prices) — the one remaining
// external call in the chain layer (cairn-zoz8.18). Caching lives in the chain
// layer. See ChainService.getBtcUsdPrice.

/** GET /api/price — current BTC→USD spot, or { usd: null } when unavailable. */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	return json({ usd: await getChain().getBtcUsdPrice() });
};
