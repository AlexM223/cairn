import { fail } from '@sveltejs/kit';
import { parseXpub } from '$lib/server/bitcoin/xpub';
import { derivePreviewAddresses } from '$lib/server/bitcoin/walletScan';
import { createWallet, friendlyXpubError } from '$lib/server/wallets';
import type { Actions } from './$types';

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
