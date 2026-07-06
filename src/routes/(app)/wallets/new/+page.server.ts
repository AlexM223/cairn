import { fail } from '@sveltejs/kit';
import { parseXpub } from '$lib/server/bitcoin/xpub';
import { derivePreviewAddresses } from '$lib/server/bitcoin/walletScan';
import { createWallet, friendlyXpubError } from '$lib/server/wallets';
import { getReferralBuyUrls } from '$lib/server/referrals';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return {
		// Resolved buy-a-device links for the method picker. null when the
		// referral_links flag is off — the wizard then renders no referral UI at
		// all (the client keys purely off URL presence).
		referralBuyUrls: getReferralBuyUrls(locals.flags)
	};
};

export const actions: Actions = {
	/** Step 2 → 3: validate the pasted key and derive the first 5 receive addresses. */
	preview: async ({ request }) => {
		const form = await request.formData();
		const xpub = String(form.get('xpub') ?? '').trim();
		try {
			const parsed = parseXpub(xpub);
			return {
				preview: derivePreviewAddresses(xpub, 5),
				scriptType: parsed.scriptType,
				xpub
			};
		} catch (e) {
			return fail(400, { error: friendlyXpubError(e) });
		}
	},

	/**
	 * Create the wallet, then hand the id back so the wizard can require a config
	 * backup download before finishing (cairn-dcp) — no redirect here.
	 */
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const xpub = String(form.get('xpub') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		// Empty string = the user skipped it; createWallet normalizes to null.
		const deviceType = String(form.get('deviceType') ?? '').trim();

		let id: number;
		try {
			id = createWallet(locals.user!.id, { name, xpub, deviceType }).id;
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not import that wallet.'
			});
		}
		return { created: true, id };
	}
};
