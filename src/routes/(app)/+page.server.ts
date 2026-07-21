import { db } from '$lib/server/db';
import { getSetting, setSetting } from '$lib/server/settings';
import { requireAdmin } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

const FIRST_RUN_CARD_DISMISSED_KEY = 'first_run_card_dismissed';

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
		hasWallets,
		// First-run "Set up your Heartwood" card (UX Simplification Wave 3,
		// cairn-6c91u.3, docs/UX-SIMPLIFICATION-SPEC.md §7): admin-only,
		// dismissible. Persisted the same way as the Umbrel assisted-connect
		// card's dismiss (settings.ts's dismissCoreDetection action) — one
		// instance-wide settings row, not a per-user preference. Non-admins
		// never see the card, so this is always reported dismissed for them —
		// no reason to leak the real value into a payload that never renders it.
		firstRunCardDismissed: locals.user!.isAdmin
			? getSetting(FIRST_RUN_CARD_DISMISSED_KEY) === '1'
			: true
	};
};

export const actions: Actions = {
	dismissFirstRunCard: async (event) => {
		requireAdmin(event);
		setSetting(FIRST_RUN_CARD_DISMISSED_KEY, '1');
		return { dismissed: true };
	}
};
