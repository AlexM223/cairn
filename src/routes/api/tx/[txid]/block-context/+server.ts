import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';

/**
 * GET /api/tx/[txid]/block-context → BlockContext (docs/TX-BLOCK-CONTEXT-DESIGN.md §3).
 *
 * Always 200: getTxBlockContext never throws — it degrades to `richness:'none'` on a
 * total backend failure, which the client renders as the honest "connecting" state.
 * A malformed txid is the only 404. Standalone (in addition to the streamed
 * +page.server.ts bundle) so the wallet detail page and manual QA can reuse it.
 */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const txid = event.params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) {
		return json({ error: 'Transaction not found' }, { status: 404 });
	}

	const ctx = await getChain().getTxBlockContext(txid);
	return json(ctx);
};
