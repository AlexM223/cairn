import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { getMultisig, deleteMultisig, toMultisigConfig } from '$lib/server/wallets/multisig';
import {
	getMultisigDetail,
	getMultisigUtxos,
	invalidateMultisigCache,
	nextMultisigReceiveAddress,
	peekMultisigReceiveAddress
} from '$lib/server/multisigScan';
import { multisigToDescriptor } from '$lib/server/bitcoin/multisig';
import { isBackedUp } from '$lib/server/backups';
import { getChain } from '$lib/server/chain';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#F0EBE5', light: '#00000000' }
};

function multisigId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Multisig not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = multisigId(params.id);
	const multisig = getMultisig(locals.user!.id, id);
	if (!multisig) error(404, 'Multisig not found');

	const base = {
		multisig: {
			id: multisig.id,
			name: multisig.name,
			threshold: multisig.threshold,
			scriptType: multisig.scriptType,
			createdAt: multisig.createdAt,
			source: multisig.source,
			keys: multisig.keys.map((k) => ({
				id: k.id,
				name: k.name,
				category: k.category,
				deviceType: k.deviceType,
				fingerprint: k.fingerprint,
				path: k.path,
				lastVerifiedAt: k.lastVerifiedAt ?? null
			}))
		},
		created: url.searchParams.get('created') === '1',
		// Server-tracked backup status (wallet_backups) — authoritative, matching
		// the wizard's download step and the persistent banner.
		backedUp: isBackedUp('multisig', id),
		descriptor: multisigToDescriptor(toMultisigConfig(multisig))
	};

	try {
		const detail = await getMultisigDetail(multisig);
		const receive = await peekMultisigReceiveAddress(multisig);
		const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

		// Mining rewards (coinbase UTXOs) get their own "cooling off" section —
		// empty for almost every multisig. The scan above already ran, so
		// getMultisigUtxos hits the cache; guard the chain tip separately so a tip
		// hiccup just hides the section rather than failing the page.
		let coinbaseUtxos: { txid: string; vout: number; value: number; height: number }[] = [];
		let tipHeight = 0;
		try {
			const [utxos, tip] = await Promise.all([
				getMultisigUtxos(multisig),
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

		return {
			...base,
			detail: {
				balance: detail.balance,
				addresses: detail.addresses,
				history: detail.history,
				utxoCount: detail.utxos.length
			},
			receive: { ...receive, qr },
			coinbaseUtxos,
			tipHeight,
			scanError: null as string | null
		};
	} catch (e) {
		// Only swallow scan failures — the multisig shell still renders.
		return {
			...base,
			detail: null,
			receive: null,
			scanError: e instanceof Error ? e.message : 'Multisig scan failed'
		};
	}
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async ({ params, locals, request }) => {
		const id = multisigId(params.id);
		const multisig = getMultisig(locals.user!.id, id);
		if (!multisig) error(404, 'Multisig not found');

		const form = await request.formData();
		const currentRaw = form.get('current');
		const current = currentRaw == null ? NaN : Number(currentRaw);

		try {
			const next = await nextMultisigReceiveAddress(
				multisig,
				Number.isInteger(current) ? current : undefined
			);
			const qr = await QRCode.toDataURL(next.address, QR_OPTS);
			return { receive: { ...next, qr } };
		} catch (e) {
			return fail(502, {
				receiveError:
					e instanceof Error ? e.message : 'Could not reach the Electrum server.'
			});
		}
	},

	delete: async ({ params, locals }) => {
		const id = multisigId(params.id);
		const multisig = getMultisig(locals.user!.id, id);
		if (!multisig || !deleteMultisig(locals.user!.id, id)) error(404, 'Multisig not found');
		invalidateMultisigCache(multisig);
		redirect(303, '/wallets');
	}
};
