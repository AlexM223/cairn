import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import {
	getWallet,
	getWalletDetail,
	deleteWallet,
	getLabels,
	nextReceiveAddress,
	peekReceiveAddress
} from '$lib/server/wallets';
import {
	listTransactions,
	getWalletUtxos,
	detectWalletUnconfirmedInflows
} from '$lib/server/transactions';
import { getChain } from '$lib/server/chain';
import { getAddressLabels } from '$lib/server/addressLabels';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#F0EBE5', light: '#00000000' }
};

function walletId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = walletId(params.id);
	const row = getWallet(locals.user!.id, id);
	if (!row) error(404, 'Wallet not found');

	const base = {
		wallet: {
			id: row.id,
			name: row.name,
			scriptType: row.script_type,
			deviceType: row.device_type ?? null,
			xpub: row.xpub,
			createdAt: row.created_at
		},
		imported: url.searchParams.get('imported') === '1',
		// Tx labels are local bookkeeping — one cheap SQLite read, no network.
		labels: getLabels(locals.user!.id, id) ?? {},
		// Address labels (cairn-nbsx) — annotate why an address exists; local read.
		addressLabels: getAddressLabels('wallet', id),
		// Saved transactions in the draft → awaiting-signature → broadcast
		// lifecycle. Cheap local SQLite read, newest first.
		transactions: listTransactions(locals.user!.id, id) ?? []
	};

	try {
		const detail = await getWalletDetail(locals.user!.id, id);
		if (!detail) error(404, 'Wallet not found');
		const receive = await peekReceiveAddress(row);
		const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

		// Mining rewards (coinbase UTXOs) get their own "cooling off" section. A
		// normal wallet has none, so this is empty for almost everyone. Tolerate a
		// scanner/chain hiccup here without failing the whole page — the balance
		// and receive cards above are what matter most.
		let coinbaseUtxos: { txid: string; vout: number; value: number; height: number }[] = [];
		let tipHeight = 0;
		try {
			const [utxos, tip] = await Promise.all([
				getWalletUtxos(row.xpub),
				getChain().getTip()
			]);
			tipHeight = tip.height;
			coinbaseUtxos = utxos
				.filter((u) => u.coinbase)
				.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
		} catch {
			coinbaseUtxos = [];
			tipHeight = 0;
		}

		// Which unconfirmed transactions can be sped up, and how (RBF vs CPFP) —
		// feeds the "Speed up" button (cairn-u9ob.4). Tolerate a chain hiccup: the
		// button simply doesn't appear rather than failing the page.
		let speedUp: Awaited<ReturnType<typeof detectWalletUnconfirmedInflows>> = [];
		try {
			speedUp = (await detectWalletUnconfirmedInflows(locals.user!.id, id)) ?? [];
		} catch {
			speedUp = [];
		}

		return {
			...base,
			scan: {
				addresses: detail.scan.addresses,
				txs: detail.scan.txs,
				confirmed: detail.scan.confirmed,
				unconfirmed: detail.scan.unconfirmed
			},
			receive: { ...receive, qr },
			coinbaseUtxos,
			tipHeight,
			speedUp: speedUp ?? [],
			scanError: null as string | null
		};
	} catch (e) {
		// Only swallow scan failures — let 404s and friends bubble.
		if (e instanceof Error && e.cause === 'unreachable') {
			return { ...base, scan: null, receive: null, scanError: e.message };
		}
		throw e;
	}
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async ({ params, locals, request }) => {
		const id = walletId(params.id);
		const form = await request.formData();
		const currentRaw = form.get('current');
		const current = currentRaw == null ? NaN : Number(currentRaw);

		let next: { address: string; path: string; index: number } | null;
		try {
			next = await nextReceiveAddress(
				locals.user!.id,
				id,
				Number.isInteger(current) ? current : undefined
			);
		} catch (e) {
			return fail(502, {
				receiveError:
					e instanceof Error ? e.message : 'Could not reach the Electrum server.'
			});
		}
		if (!next) error(404, 'Wallet not found');

		const qr = await QRCode.toDataURL(next.address, QR_OPTS);
		return { receive: { ...next, qr } };
	},

	delete: async ({ params, locals }) => {
		const id = walletId(params.id);
		if (!deleteWallet(locals.user!.id, id)) error(404, 'Wallet not found');
		redirect(303, '/wallets');
	}
};
