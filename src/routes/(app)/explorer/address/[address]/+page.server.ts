import { error } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { getChain } from '$lib/server/chain';
import { isExplorerAddress } from '$lib/server/bitcoin/xpub';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import { addressOwnership } from '../../ownership.server';
import type { PageServerLoad } from './$types';
import type { AddressInfo, AddressTx } from '$lib/types';

interface AddressInfoResult {
	info: AddressInfo | null;
	/** The backend explicitly reports no record of this (syntactically valid) address. */
	notFound: boolean;
	/** The backend was unreachable or errored (distinct from a genuine 404). */
	error: string | null;
}

/** getAddressInfo is an Electrum round-trip (cairn-2zxt.3) — streamed so
 *  the page chrome, address, and QR paint instantly instead of blocking SSR.
 *  Never rejects: a missing address resolves to `notFound`, any other failure to
 *  `error`, so a slow/unreachable backend degrades to a graceful in-page state
 *  instead of a route-level 404/502 that would block paint. */
async function loadAddressInfo(address: string): Promise<AddressInfoResult> {
	try {
		return { info: await getChain().getAddressInfo(address), notFound: false, error: null };
	} catch (e) {
		if (isNotFoundError(e)) return { info: null, notFound: true, error: null };
		return { info: null, notFound: false, error: chainErrorMessage(e) };
	}
}

/** getAddressTxs is a separate round-trip, streamed independently so the address
 *  summary can paint before its (potentially long) history resolves. Never
 *  rejects: a failure resolves to an empty list + error. */
async function loadAddressTxs(address: string): Promise<{ txs: AddressTx[]; error: string | null }> {
	try {
		return { txs: await getChain().getAddressTxs(address), error: null };
	} catch (e) {
		return { txs: [], error: chainErrorMessage(e) };
	}
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const address = params.address.trim();
	// Syntactic validation stays a synchronous 404 — pure routing decision, no
	// chain round-trip.
	if (!isExplorerAddress(address)) error(404, 'Not a valid Bitcoin address');

	// QR of the address itself (not a bitcoin: URI) — what wallets expect to scan.
	// It's a local CPU render of the address we already have (no chain round-trip),
	// so it can resolve inline without gating paint. Cosmetic: failure degrades to
	// no QR.
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

	return {
		address,
		qr,
		// "This is your wallet" badge — a synchronous, chain-free, viewer-scoped
		// local lookup (see ownership.server.ts), so it paints with the SSR shell.
		// null when the address isn't one of the viewing user's own wallets.
		ownership: addressOwnership(locals.user?.id, address),
		// Streamed, not awaited (cairn-2zxt.3): the two chain round-trips.
		infoResult: loadAddressInfo(address),
		txsResult: loadAddressTxs(address)
	};
};
