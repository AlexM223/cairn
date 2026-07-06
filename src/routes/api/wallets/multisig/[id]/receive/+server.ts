import { json, requireUser } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import { nextMultisigReceiveAddress } from '$lib/server/multisigScan';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/receive[?after=N] — the next unused receive address,
 * advancing the receive cursor past it. `after` requests an address strictly
 * beyond the one already on display (fresh address per click), clamped to the
 * gap-limit window so discovery never misses funds.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	// Any participant can fetch a deposit address for a shared wallet.
	const multisig = Number.isInteger(id) && id > 0 ? getViewableMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	const afterRaw = event.url.searchParams.get('after');
	const after = afterRaw === null ? NaN : Number(afterRaw);

	try {
		const next = await nextMultisigReceiveAddress(
			multisig,
			Number.isInteger(after) ? after : undefined
		);
		return json(next);
	} catch (e) {
		log.error({ err: e, multisigId: Number(event.params.id) }, 'wallet receive-address failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not derive a receive address' },
			{ status: 502 }
		);
	}
};
