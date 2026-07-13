import { json, requireFeature } from '$lib/server/api';
import { classifySearch } from '$lib/server/search';
import { clientIpFor, searchRetryAfter, noteSearchRequest, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import type { RequestHandler } from './$types';

/**
 * GET /api/search?q= → SearchResult
 *
 * Gated on the `explorer` feature flag (cairn-he4e) — this endpoint is the
 * actual enforcement boundary for the whole explorer UI (see
 * src/routes/(app)/explorer/+layout.server.ts), so a disabled/never-enabled
 * flag must 403 here too, not just hide the nav.
 *
 * Rate limited per-user and per-IP (cairn-hwta) — classifySearch() can fan
 * out to real chain RPC (getTip/getTx/getBlock), so an unbounded loop of
 * queries could exhaust the shared Electrum/Core connection pool.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireFeature(event, 'explorer');

	const ip = clientIpFor(event);
	const wait = searchRetryAfter(ip, user.id);
	if (wait !== null) {
		return json({ error: tooManyAttemptsMessage(wait), code: 'rate_limited' }, { status: 429 });
	}
	noteSearchRequest(ip, user.id);

	const q = event.url.searchParams.get('q') ?? '';
	return json(await classifySearch(q));
};
