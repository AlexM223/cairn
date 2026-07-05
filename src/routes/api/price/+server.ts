import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import type { RequestHandler } from './$types';

// Optional fiat estimate for the portfolio hero. Privacy-first: the dashboard
// only calls this endpoint when the user explicitly turns fiat ON (off by
// default), so no third-party price service is contacted otherwise. Cached
// in-process for a few minutes to avoid hammering the source.

const CACHE_MS = 5 * 60 * 1000;
const SOURCE = 'https://mempool.space/api/v1/prices';
let cache: { at: number; usd: number | null } | null = null;

async function fetchUsd(): Promise<number | null> {
	try {
		const res = await fetch(SOURCE, { signal: AbortSignal.timeout(6000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { USD?: number };
		return typeof body.USD === 'number' && body.USD > 0 ? body.USD : null;
	} catch {
		return null;
	}
}

/** GET /api/price — current BTC→USD spot, or { usd: null } when unavailable. */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const now = Date.now();
	if (!cache || now - cache.at > CACHE_MS) {
		cache = { at: now, usd: await fetchUsd() };
	}
	return json({ usd: cache.usd });
};
