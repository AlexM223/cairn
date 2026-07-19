import { fail } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getUserMiningView } from '$lib/server/mining/readModels';
import {
	ensureMiningPrefs,
	setPayoutWallet,
	setUserMiningEnabled,
	regenerateMiningId
} from '$lib/server/mining/prefs';
import { childLogger } from '$lib/server/logger';
import type { Actions, PageServerLoad } from './$types';

const log = childLogger('mining-ui');

function errMessage(e: unknown): string {
	return e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';
}

/**
 * Per-user mining dashboard (cairn-vn43.7/.9/.24). Every field this page reads
 * is already scoped to the viewing user by getUserMiningView — this route
 * never queries mining tables directly, so there is no way for it to leak
 * another user's workers/shares/blocks.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireFeature(event, 'mining');

	try {
		const view = await getUserMiningView(user.id);
		return { view, loadError: null as string | null };
	} catch (e) {
		// getUserMiningView can fail (DB hiccup, or worker A's read model still
		// mid-flight) — never blank-page the user. Degrade to an inert dashboard
		// with an honest banner rather than misreporting this as "operator
		// hasn't started the pool" (engine-stopped) or any other real state.
		log.warn(
			{ userId: user.id, err: e instanceof Error ? e.message : String(e) },
			'getUserMiningView failed'
		);
		return {
			view: {
				engine: {
					status: 'stopped' as const,
					stratumPort: 0,
					bind: '',
					shareDifficulty: 0,
					asicPort: null
				},
				connection: null,
				payout: null,
				workers: [],
				totals: {
					hashrateNow: 0,
					hashrate24h: 0,
					bestShareEver: 0,
					acceptedShares: 0,
					staleShares: 0
				},
				earnings: { blocksFound: [], totalMaturedSats: 0, totalPendingSats: 0 },
				odds: null,
				networkDifficulty: null,
				wallets: []
			},
			loadError: 'Mining data is temporarily unavailable. Try refreshing the page.'
		};
	}
};

export const actions: Actions = {
	enable: async (event) => {
		const user = requireFeature(event, 'mining');
		try {
			ensureMiningPrefs(user.id);
			setUserMiningEnabled(user.id, true);
		} catch (e) {
			return fail(400, { enableError: errMessage(e) });
		}
		return { enabled: true };
	},

	disable: async (event) => {
		const user = requireFeature(event, 'mining');
		try {
			setUserMiningEnabled(user.id, false);
		} catch (e) {
			return fail(400, { disableError: errMessage(e) });
		}
		return { disabled: true };
	},

	/**
	 * Change the payout wallet. The client only ever offers this user's own
	 * eligible wallets (view.wallets), but setPayoutWallet re-validates
	 * ownership server-side so a tampered walletId still fails closed rather
	 * than silently repointing rewards at someone else's wallet.
	 */
	selectWallet: async (event) => {
		const user = requireFeature(event, 'mining');
		const form = await event.request.formData();
		const raw = String(form.get('walletId') ?? '').trim();
		const walletId = Number(raw);
		if (!raw || !Number.isInteger(walletId)) {
			return fail(400, { walletError: 'Choose a wallet.' });
		}
		try {
			setPayoutWallet(user.id, walletId);
		} catch (e) {
			return fail(400, { walletError: errMessage(e) });
		}
		return { walletSaved: true };
	},

	regenerateId: async (event) => {
		const user = requireFeature(event, 'mining');
		try {
			regenerateMiningId(user.id);
		} catch (e) {
			return fail(400, { regenerateError: errMessage(e) });
		}
		return { regenerated: true };
	}
};
