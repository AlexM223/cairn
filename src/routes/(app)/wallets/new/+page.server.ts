import { fail, redirect } from '@sveltejs/kit';
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

	/** Step 4: create the wallet and hand off to the detail page. */
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const xpub = String(form.get('xpub') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();

		let id: number;
		try {
			id = createWallet(locals.user!.id, { name, xpub }).id;
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not import that wallet.'
			});
		}
		redirect(303, `/wallets/${id}?imported=1`);
	}
};
