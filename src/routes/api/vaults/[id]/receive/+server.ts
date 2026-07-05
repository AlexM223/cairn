import { json, requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { nextVaultReceiveAddress } from '$lib/server/vaultScan';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('vault');

/**
 * GET /api/vaults/:id/receive[?after=N] — the next unused receive address,
 * advancing the receive cursor past it. `after` requests an address strictly
 * beyond the one already on display (fresh address per click), clamped to the
 * gap-limit window so discovery never misses funds.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const vault = Number.isInteger(id) && id > 0 ? getVault(user.id, id) : null;
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	const afterRaw = event.url.searchParams.get('after');
	const after = afterRaw === null ? NaN : Number(afterRaw);

	try {
		const next = await nextVaultReceiveAddress(
			vault,
			Number.isInteger(after) ? after : undefined
		);
		return json(next);
	} catch (e) {
		log.error({ err: e, vaultId: Number(event.params.id) }, 'vault receive-address failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not derive a receive address' },
			{ status: 502 }
		);
	}
};
