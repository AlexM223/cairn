import { error } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { getChain } from '$lib/server/chain';
import { isValidAddress } from '$lib/server/bitcoin/xpub';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { AddressInfo, AddressTx } from '$lib/types';

export const load: PageServerLoad = async ({ params }) => {
	const address = params.address.trim();
	if (!isValidAddress(address)) error(404, 'Not a valid Bitcoin address');

	const chain = getChain();
	let info: AddressInfo;
	try {
		info = await chain.getAddressInfo(address);
	} catch (e) {
		if (isNotFoundError(e)) error(404, 'Address not found');
		error(502, chainErrorMessage(e));
	}

	let txs: AddressTx[] = [];
	let txError: string | null = null;
	try {
		txs = await chain.getAddressTxs(address);
	} catch (e) {
		txError = chainErrorMessage(e);
	}

	// QR of the address itself (not a bitcoin: URI) — what wallets expect to
	// scan when someone wants to send here. Cosmetic, so failure is silent.
	let qr: string | null = null;
	try {
		qr = await QRCode.toDataURL(address, {
			margin: 1,
			width: 200,
			color: { dark: '#F0EBE5', light: '#00000000' }
		});
	} catch {
		qr = null;
	}

	return { info, txs, txError, qr };
};
