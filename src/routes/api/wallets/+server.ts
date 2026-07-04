import { json, requireUser, readJson } from '$lib/server/api';
import { listWallets, createWallet } from '$lib/server/wallets';
import type { RequestHandler } from './$types';

/** GET /api/wallets — all of the user's wallets with (cached) live balances. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { wallets, errors } = await listWallets(user.id);
	return json({ wallets, errors });
};

/** POST /api/wallets { name?, xpub } — import a watch-only wallet. */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ name?: string; xpub?: string }>(event);
	try {
		const wallet = createWallet(user.id, { name: body.name, xpub: body.xpub });
		return json({ wallet }, { status: 201 });
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Could not import that wallet.' },
			{ status: 400 }
		);
	}
};
