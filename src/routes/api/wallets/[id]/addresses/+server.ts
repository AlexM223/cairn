import { json, requireUser } from '$lib/server/api';
import { getWalletDetail } from '$lib/server/wallets';
import type { RequestHandler } from './$types';

/** GET /api/wallets/:id/addresses — derived addresses with usage and balances. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Wallet not found' }, { status: 404 });
	}

	try {
		const detail = await getWalletDetail(user.id, id);
		if (!detail) return json({ error: 'Wallet not found' }, { status: 404 });
		return json({ addresses: detail.scan.addresses });
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Wallet scan failed' },
			{ status: 502 }
		);
	}
};
