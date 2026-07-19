// The canonical Receive subpage (cairn-gt05.2, spec §2.4): a Tier-2 surface
// both Home's and the wallet-detail page's Receive buttons route to. Renders
// the same ReceivePanel the detail page's Receive tab embeds; the address
// comes from the persisted snapshot (SWR — zero Electrum on navigation), and
// the Rotate form posts to the shared ?/receive action.
import { error } from '@sveltejs/kit';
import { getWallet } from '$lib/server/wallets';
import { readWalletSnapshot } from '$lib/server/walletSync';
import { parseWalletId, rotateReceiveAction } from '$lib/server/receiveRotate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, depends }) => {
	const id = parseWalletId(params.id);
	const row = getWallet(locals.user!.id, id);
	if (!row) error(404, 'Wallet not found');

	depends(`cairn:wallet:${id}`);
	const cached = readWalletSnapshot(id);
	const snapshot = cached?.snapshot ?? null;
	const scan = snapshot?.scan ?? null;

	return {
		wallet: { id: row.id, name: row.name },
		receive: snapshot?.receive ?? null,
		// Mechanism-fact confidence line for a never-funded wallet (gt05.6).
		neverFunded:
			scan !== null && scan.confirmed === 0 && scan.unconfirmed === 0 && scan.txs.length === 0
	};
};

export const actions: Actions = {
	receive: rotateReceiveAction
};
