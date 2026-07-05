import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { getVault, deleteVault, toVaultConfig } from '$lib/server/vaults';
import {
	getVaultDetail,
	invalidateVaultCache,
	nextVaultReceiveAddress,
	peekVaultReceiveAddress
} from '$lib/server/vaultScan';
import { vaultToDescriptor } from '$lib/server/bitcoin/multisig';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#F0EBE5', light: '#00000000' }
};

function vaultId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Vault not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = vaultId(params.id);
	const vault = getVault(locals.user!.id, id);
	if (!vault) error(404, 'Vault not found');

	const base = {
		vault: {
			id: vault.id,
			name: vault.name,
			threshold: vault.threshold,
			scriptType: vault.scriptType,
			createdAt: vault.createdAt,
			keys: vault.keys.map((k) => ({
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
		descriptor: vaultToDescriptor(toVaultConfig(vault))
	};

	try {
		const detail = await getVaultDetail(vault);
		const receive = await peekVaultReceiveAddress(vault);
		const qr = await QRCode.toDataURL(receive.address, QR_OPTS);
		return {
			...base,
			detail: {
				balance: detail.balance,
				addresses: detail.addresses,
				history: detail.history,
				utxoCount: detail.utxos.length
			},
			receive: { ...receive, qr },
			scanError: null as string | null
		};
	} catch (e) {
		// Only swallow scan failures — the vault shell still renders.
		return {
			...base,
			detail: null,
			receive: null,
			scanError: e instanceof Error ? e.message : 'Vault scan failed'
		};
	}
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async ({ params, locals, request }) => {
		const id = vaultId(params.id);
		const vault = getVault(locals.user!.id, id);
		if (!vault) error(404, 'Vault not found');

		const form = await request.formData();
		const currentRaw = form.get('current');
		const current = currentRaw == null ? NaN : Number(currentRaw);

		try {
			const next = await nextVaultReceiveAddress(
				vault,
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
		const id = vaultId(params.id);
		const vault = getVault(locals.user!.id, id);
		if (!vault || !deleteVault(locals.user!.id, id)) error(404, 'Vault not found');
		invalidateVaultCache(vault);
		redirect(303, '/vaults');
	}
};
