// Shared "hand out the next unused receive address" form-action body
// (cairn-gt05.2): the wallet-detail page's Receive tab and the canonical
// /wallets/[id]/receive subpage both mount the same ReceivePanel, whose Rotate
// form posts to a ?/receive action on whichever page hosts it. This helper is
// that action's single implementation so the two routes cannot drift.
import { error, fail, isHttpError } from '@sveltejs/kit';
import QRCode from 'qrcode';
import type { RequestEvent } from '@sveltejs/kit';
import { nextReceiveAddress } from '$lib/server/wallets';
import { requireUser } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';

const log = childLogger('wallet');

// Opaque parchment behind evergreen ink (cairn-7d3q4) — see the matching
// QR_OPTS comment in $lib/server/walletSync.ts for why this must stay in sync.
export const RECEIVE_QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#1f2623', light: '#f3efe7' }
} as const;

export function parseWalletId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');
	return id;
}

/** The ?/receive action body — returns { receive } or fail(502, { receiveError }). */
export async function rotateReceiveAction(event: RequestEvent<{ id: string }>) {
	requireUser(event);
	const { params, locals, request } = event;
	const id = parseWalletId(params.id);
	const form = await request.formData();
	const currentRaw = form.get('current');
	const current = currentRaw == null ? NaN : Number(currentRaw);

	try {
		const next = await nextReceiveAddress(
			locals.user!.id,
			id,
			Number.isInteger(current) ? current : undefined
		);
		if (!next) error(404, 'Wallet not found');

		const qr = await QRCode.toDataURL(next.address, RECEIVE_QR_OPTS);
		return { receive: { ...next, qr } };
	} catch (e) {
		// The 404 above is a SvelteKit HttpError, not a connectivity failure —
		// let it propagate to the error boundary instead of being reported as a
		// degraded 502 form response.
		if (isHttpError(e)) throw e;
		return fail(502, {
			receiveError: sanitizeChainError(e, log, { walletId: id }, 'receive-address action failed')
		});
	}
}
