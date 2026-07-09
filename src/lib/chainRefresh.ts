// Client-side trigger for the SWR chain pages (dashboard + explorer family).
//
// On mount, and on every new-block event, a page calls this to kick a background
// refresh of the persisted chain snapshot, then invalidate('cairn:chain') so its
// server load() re-runs (a cheap SQLite read now) and picks up the fresh data.
// A plain .ts helper on purpose — the reactive $state (syncing / syncFailed)
// lives in each component; only the fetch+invalidate is shared here.

import { invalidate } from '$app/navigation';

/**
 * POST the chain-refresh endpoint, then re-run the chain load on success.
 * Resolves true when the snapshot was refreshed (or served fresh) and the load
 * reinvalidated; false when the backend couldn't be reached — the caller keeps
 * showing cached data and its stale timestamp either way. Never throws.
 *
 * @param force bypass the server-side freshness throttle (used on new-block
 *              events, where the data has genuinely changed).
 */
export async function triggerChainRefresh(force = false): Promise<boolean> {
	try {
		const res = await fetch('/api/chain/refresh', {
			method: 'POST',
			headers: force ? { 'content-type': 'application/json' } : undefined,
			body: force ? JSON.stringify({ force: true }) : undefined
		});
		if (!res.ok) return false;
		await invalidate('cairn:chain');
		return true;
	} catch {
		return false;
	}
}
