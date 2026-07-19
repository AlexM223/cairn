// /wallets/[id]/settings — Tier-2 subpage (cairn-gt05.2, spec §2.2): rename,
// "Download backup file" (was "Export config"), the full address list (was the
// "Addresses · N" tab), and — at the bottom, demoted and confirmation-gated —
// remove-this-wallet. Destructive actions live on their own gated URL, never
// in the detail page's scroll flow.
import { error, fail, redirect } from '@sveltejs/kit';
import { getWallet, deleteWallet, renameWallet } from '$lib/server/wallets';
import { AuthError } from '$lib/server/auth';
import { getAddressLabels } from '$lib/server/addressLabels';
import { isBackedUp } from '$lib/server/backups';
import { readWalletSnapshot } from '$lib/server/walletSync';
import { requireUser } from '$lib/server/api';
import { parseWalletId } from '$lib/server/receiveRotate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, depends }) => {
	const id = parseWalletId(params.id);
	const userId = locals.user!.id;
	const row = getWallet(userId, id);
	if (!row) error(404, 'Wallet not found');

	depends(`cairn:wallet:${id}`);
	const cached = readWalletSnapshot(id);

	return {
		wallet: {
			id: row.id,
			name: row.name,
			scriptType: row.script_type,
			xpub: row.xpub
		},
		backedUp: isBackedUp('wallet', id),
		addressLabels: getAddressLabels(userId, 'wallet', id),
		// The scanned address list from the persisted snapshot (SWR — no network
		// on navigation). Empty until the wallet's first background refresh.
		addresses: cached?.snapshot?.scan?.addresses ?? []
	};
};

export const actions: Actions = {
	/** Rename — trivial + reversible (friction ladder: zero dialogs). */
	rename: async (event) => {
		requireUser(event);
		const id = parseWalletId(event.params.id);
		const form = await event.request.formData();
		const name = String(form.get('name') ?? '');
		if (!renameWallet(event.locals.user!.id, id, name)) {
			return fail(400, { renameError: 'Enter a name for this wallet.' });
		}
		return { renamed: true };
	},

	/** Remove from tracking — medium stakes, so the action itself is gated:
	 *  the UI's confirm step posts confirmed=yes; a bare POST does nothing. */
	delete: async (event) => {
		requireUser(event);
		const id = parseWalletId(event.params.id);
		const form = await event.request.formData();
		if (form.get('confirmed') !== 'yes') {
			return fail(400, { deleteError: 'Confirm the removal first.' });
		}
		try {
			if (!deleteWallet(event.locals.user!.id, id)) error(404, 'Wallet not found');
		} catch (e) {
			if (e instanceof AuthError) return fail(409, { deleteError: e.message });
			throw e;
		}
		redirect(303, '/wallets');
	}
};
