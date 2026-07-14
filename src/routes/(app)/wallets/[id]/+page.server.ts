import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { getWallet, deleteWallet, getLabels, nextReceiveAddress } from '$lib/server/wallets';
import { AuthError } from '$lib/server/auth';
import { listTransactions } from '$lib/server/transactions';
import { getAddressLabels } from '$lib/server/addressLabels';
import { isBackedUp } from '$lib/server/backups';
import { readWalletSnapshot, EMPTY_WALLET_SNAPSHOT } from '$lib/server/walletSync';
import { listReplacedInbound } from '$lib/server/addressWatcher';
import { requireUser } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#E4D8CC', light: '#00000000' }
};

function walletId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');
	return id;
}

export const load: PageServerLoad = ({ params, locals, url, depends }) => {
	const id = walletId(params.id);
	const userId = locals.user!.id;
	const row = getWallet(userId, id);
	if (!row) error(404, 'Wallet not found');

	// Cache-first (cairn-2zxt SWR): load() reads a persisted snapshot SYNCHRONOUSLY
	// — zero Electrum, so navigation never blocks. The +page.svelte fires the
	// /refresh endpoint on mount (and on each new block) and, when it resolves,
	// re-invalidates this tag; load() re-runs (cheap — just this SQLite read) and
	// picks up the fresh snapshot. The old streamed full-scan-per-navigation
	// (cairn-vknb.1) is retired.
	depends(`cairn:wallet:${id}`);
	const cached = readWalletSnapshot(id);

	return {
		wallet: {
			id: row.id,
			name: row.name,
			scriptType: row.script_type,
			deviceType: row.device_type ?? null,
			xpub: row.xpub,
			createdAt: row.created_at
		},
		imported: url.searchParams.get('imported') === '1',
		// Server-tracked backup status (wallet_backups) — the single source of
		// truth the wizard's download step and the persistent banner both use.
		backedUp: isBackedUp('wallet', id),
		// Tx labels are local bookkeeping — one cheap SQLite read, no network.
		labels: getLabels(userId, id) ?? {},
		// Address labels (cairn-nbsx) — annotate why an address exists; local read.
		addressLabels: getAddressLabels(userId, 'wallet', id),
		// Saved transactions in the draft → awaiting-signature → broadcast
		// lifecycle. Cheap local SQLite read, newest first.
		transactions: listTransactions(userId, id) ?? [],
		// The scan-derived fields (balance, addresses, txs, receive peek + QR,
		// coinbase UTXOs, tip, speed-up verdicts) from the persisted snapshot —
		// already resolved (not a promise). Empty-but-shaped until the first
		// background refresh lands.
		chainData: cached?.snapshot ?? EMPTY_WALLET_SNAPSHOT,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		// Inbound payments that were double-spent / RBF'd away before confirming
		// (cairn-a2p1). The live scan naturally drops them from the balance + tx
		// list, so we surface them here as amber "cancelled" rows to reconcile the
		// vanished amount for the user.
		cancelledTxs: listReplacedInbound('wallet', id)
	};
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async (event) => {
		requireUser(event);
		const { params, locals, request } = event;
		const id = walletId(params.id);
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

			const qr = await QRCode.toDataURL(next.address, QR_OPTS);
			return { receive: { ...next, qr } };
		} catch (e) {
			// The 404 above is a SvelteKit HttpError, not a connectivity failure --
			// let it propagate to the error boundary instead of being reported as a
			// degraded 502 form response.
			if (isHttpError(e)) throw e;
			return fail(502, {
				receiveError:
					e instanceof Error ? e.message : 'Could not reach the Electrum server.'
			});
		}
	},

	delete: async (event) => {
		requireUser(event);
		const { params, locals } = event;
		const id = walletId(params.id);
		try {
			if (!deleteWallet(locals.user!.id, id)) error(404, 'Wallet not found');
		} catch (e) {
			if (e instanceof AuthError) return fail(409, { deleteError: e.message });
			throw e;
		}
		redirect(303, '/wallets');
	}
};
