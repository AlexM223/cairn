// GET /api/sync — first-sync progress for the Heartwood first-sync screen
// (cairn-koy4.11). Polled ~1/s while the screen is open; everything behind it
// is in-memory or TTL-cached, so polling is cheap. Read-only.

import { json, requireUser } from '$lib/server/api';
import { ensureFirstSyncRunning, getSyncStatus } from '$lib/server/syncStatus';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireUser(event);
	// Polling keeps the build alive even if the boot-time starter was missed
	// (e.g. the process restarted mid-count).
	ensureFirstSyncRunning();
	return json(await getSyncStatus());
};
