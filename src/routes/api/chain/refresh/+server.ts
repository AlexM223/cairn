import { json, requireUser, readOptionalJson } from '$lib/server/api';
import { refreshChainSnapshot } from '$lib/server/chainSync';
import { chainErrorMessage } from '$lib/server/search';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('chain');

/**
 * POST /api/chain/refresh — the "revalidate" trigger for the SWR chain pages.
 * Refreshes the persisted global chain snapshot (single-flight + throttled in
 * chainSync.ts) and returns it. Read-only chain data, so it just needs a signed-
 * in session (no special role). `{ force: true }` bypasses the freshness
 * throttle — the client sends it on a new-block event, where the data really has
 * changed. A backend outage with no prior snapshot returns 502; the client keeps
 * showing whatever it already had.
 */
export const POST: RequestHandler = async (event) => {
	requireUser(event);
	const body = await readOptionalJson<{ force?: boolean }>(event);
	try {
		const snap = await refreshChainSnapshot({ force: body.force === true });
		return json({ lastSyncedAt: snap.lastSyncedAt, data: snap.data });
	} catch (e) {
		log.warn({ err: e }, 'chain refresh failed');
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
