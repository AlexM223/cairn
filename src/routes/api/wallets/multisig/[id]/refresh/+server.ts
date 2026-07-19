import { json, requireUser } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import { refreshMultisigSnapshot, readMultisigSnapshot } from '$lib/server/walletSync';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet-sync');

/**
 * POST /api/wallets/multisig/:id/refresh — the background half of stale-while-
 * revalidate for a multisig. Any participant (owner / viewer / cosigner) may
 * trigger it — getViewableMultisig is the same read gate the receive + detail
 * routes use, and the snapshot is identical for all of them. Single-flighted +
 * throttled server-side; a scan failure leaves the last good snapshot intact and
 * returns 502 so the client keeps showing cached data.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0 || !getViewableMultisig(user.id, id)) {
		return json({ error: 'Multisig not found' }, { status: 404 });
	}

	try {
		// cairn-0tvez: force the rescan rather than trusting the throttle/clean-skip
		// gate. This endpoint is the client's explicit "go get fresh data" signal
		// (mount + new-block nudge) — without force, a snapshot marked CLEAN (no
		// scripthash-status change ever observed, e.g. because the watcher hadn't
		// subscribed this multisig's addresses yet) could sit unrefreshed for up to
		// MAX_CLEAN_TTL_MS (30 min) even though the client is actively asking for a
		// refresh right now. Single-flighted still — a concurrent trigger for the
		// same id coalesces onto one real scan.
		const snapshot = await refreshMultisigSnapshot(user.id, id, { force: true });
		if (!snapshot) return json({ error: 'Multisig not found' }, { status: 404 });
		const stored = readMultisigSnapshot(id);
		return json({ snapshot, lastSyncedAt: stored?.lastSyncedAt ?? null });
	} catch (e) {
		log.warn({ err: e, multisigId: id }, 'multisig snapshot refresh failed (serving cached)');
		const stored = readMultisigSnapshot(id);
		return json(
			{
				error: e instanceof Error ? e.message : 'Could not refresh the multisig',
				lastSyncedAt: stored?.lastSyncedAt ?? null
			},
			{ status: 502 }
		);
	}
};
