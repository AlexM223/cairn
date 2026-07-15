import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
	// The layout's load() redirects to /login when locals.user is null, but
	// SvelteKit runs layout and page loads concurrently unless the page
	// explicitly depends on the layout — without this, an anonymous/expired
	// request can hit the locals.user!.id assertion below before the layout's
	// redirect takes effect, 500ing instead of redirecting (cairn-ydxi).
	await parent();

	// Either flavor counts — a multisig-only user still has a portfolio.
	const hasWallets =
		((
			db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM wallets WHERE user_id = ?) +
						(SELECT COUNT(*) FROM multisigs WHERE user_id = ?) AS n`
				)
				.get(locals.user!.id, locals.user!.id) as { n: number }
		).n) > 0;

	return {
		hasWallets
	};
};
