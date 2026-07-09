import { json, requireUser } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import { refreshWalletSnapshot, readWalletSnapshot } from '$lib/server/walletSync';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet-sync');

/**
 * POST /api/wallets/:id/refresh — the background half of stale-while-revalidate.
 * Kicks a live Electrum re-scan (single-flighted + throttled server-side),
 * rewrites the persisted snapshot, and returns it. When a fresh scan just ran
 * within the throttle window the current cached snapshot is returned unchanged.
 *
 * On a scan failure the LAST GOOD snapshot is left intact and a 502 is returned
 * with its (now-stale) last_synced_at, so the client keeps showing cached data
 * rather than erroring the page. Read access (owning the wallet) is enough —
 * refreshing never mutates funds.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0 || !getWallet(user.id, id)) {
		return json({ error: 'Wallet not found' }, { status: 404 });
	}

	try {
		const snapshot = await refreshWalletSnapshot(user.id, id);
		if (!snapshot) return json({ error: 'Wallet not found' }, { status: 404 });
		const stored = readWalletSnapshot(id);
		return json({ snapshot, lastSyncedAt: stored?.lastSyncedAt ?? null });
	} catch (e) {
		log.warn({ err: e, walletId: id }, 'wallet snapshot refresh failed (serving cached)');
		const stored = readWalletSnapshot(id);
		return json(
			{
				error: e instanceof Error ? e.message : 'Could not refresh the wallet',
				lastSyncedAt: stored?.lastSyncedAt ?? null
			},
			{ status: 502 }
		);
	}
};
