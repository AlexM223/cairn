import { json, requireUser } from '$lib/server/api';
import { getWallet, nextReceiveAddress } from '$lib/server/wallets';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/** POST /api/wallets/:id/receive — next unused receive address (advances cursor). */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0 || !getWallet(user.id, id)) {
		return json({ error: 'Wallet not found' }, { status: 404 });
	}

	try {
		const next = await nextReceiveAddress(user.id, id);
		if (!next) return json({ error: 'Wallet not found' }, { status: 404 });
		return json(next);
	} catch (e) {
		log.error({ err: e, walletId: id }, 'wallet receive-address failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not derive a receive address' },
			{ status: 502 }
		);
	}
};
