import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import {
	getMultisig,
	getViewableMultisig,
	deleteMultisig,
	toMultisigConfig
} from '$lib/server/wallets/multisig';
import {
	multisigAccessRole,
	redactMultisigKeysForViewer,
	listCollaborators
} from '$lib/server/multisigShares';
import { listContacts } from '$lib/server/contacts';
import { getInstanceSettings } from '$lib/server/settings';
import {
	getMultisigDetail,
	getMultisigUtxos,
	invalidateMultisigCache,
	nextMultisigReceiveAddress,
	peekMultisigReceiveAddress
} from '$lib/server/multisigScan';
import { multisigToDescriptor } from '$lib/server/bitcoin/multisig';
import {
	listMultisigTransactionSummaries,
	detectMultisigUnconfirmedInflows
} from '$lib/server/multisigTransactions';
import { isBackedUp } from '$lib/server/backups';
import { getChain } from '$lib/server/chain';
import { getAddressLabels } from '$lib/server/addressLabels';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#E4D8CC', light: '#00000000' }
};

function multisigId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Multisig not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = multisigId(params.id);
	// Owner OR any accepted share (viewer/cosigner) — read-only surface. A non-
	// participant gets the same 404 as a missing wallet.
	const multisig = getViewableMultisig(locals.user!.id, id);
	if (!multisig) error(404, 'Multisig not found');
	const role = multisigAccessRole(locals.user!.id, id);
	// Non-owner viewers see their own key's path but not other cosigners' (plan §6).
	const visibleKeys = redactMultisigKeysForViewer(multisig.keys, locals.user!.id, multisig.userId);

	// The share-MANAGEMENT surface (Collaborators) is owner-only AND gated on team
	// mode — the same gate the /shares API enforces (requireTeamMode). In solo mode
	// nothing is "disabled", the instance is just narrower, so we hide the section
	// entirely rather than showing a dead form. Read access a cosigner/viewer
	// already has is never touched by this (cairn-7t0z.5).
	const canManageShares = role === 'owner' && getInstanceSettings().instanceMode === 'team';

	const base = {
		// The caller's role drives which owner-only controls (share, delete,
		// broadcast) the page renders — the server gates them regardless.
		role,
		multisig: {
			id: multisig.id,
			name: multisig.name,
			threshold: multisig.threshold,
			scriptType: multisig.scriptType,
			createdAt: multisig.createdAt,
			source: multisig.source,
			keys: visibleKeys.map((k) => ({
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
		// The descriptor embeds every key's origin path. Owners and cosigners need
		// it (cosigners register the full quorum on their device to sign); a pure
		// viewer never signs, so they don't get it (plan §6).
		descriptor: role === 'viewer' ? null : multisigToDescriptor(toMultisigConfig(multisig)),
		// Address labels (cairn-nbsx) — shared annotations for this vault; local read.
		addressLabels: getAddressLabels(locals.user!.id, 'multisig', id),
		// Sharing surface (owner + team mode only). Both lists are cheap local reads
		// and independent of the Electrum scan, so they live on `base` and stay
		// present even when the scan below fails. Empty for everyone else.
		canManageShares,
		collaborators: canManageShares ? listCollaborators(locals.user!.id, id) : [],
		// Only accepted contacts (friends) can receive a share; the picker needs
		// just the id/name/email to build the option list.
		shareableContacts: canManageShares
			? listContacts(locals.user!.id).friends.map((c) => ({
					userId: c.userId,
					displayName: c.displayName,
					email: c.email
				}))
			: []
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

		// Which unconfirmed txs can be sped up, and how (RBF vs CPFP) — feeds the
		// "Speed up" button (cairn-u9ob.4). Tolerate a chain hiccup. The saved-tx
		// list lets the RBF path find the row to bump.
		let speedUp: Awaited<ReturnType<typeof detectMultisigUnconfirmedInflows>> = [];
		try {
			speedUp = (await detectMultisigUnconfirmedInflows(locals.user!.id, id)) ?? [];
		} catch {
			speedUp = [];
		}
		// Already the viewer-safe projection (no PSBT/recipients) — the summary
		// list stays viewer-reachable while the full-shape functions are
		// cosigner-gated (cairn-o1dp.1).
		const savedTxs = listMultisigTransactionSummaries(locals.user!.id, id) ?? [];

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
			speedUp: speedUp ?? [],
			savedTxs,
			scanError: null as string | null
		};
	} catch (e) {
		// Only swallow scan failures — the multisig shell still renders. Keep the
		// same fields the success branch returns (empty) so `data.speedUp`/
		// `data.savedTxs` aren't typed as possibly-undefined at the call sites.
		return {
			...base,
			detail: null,
			receive: null,
			coinbaseUtxos: [] as { txid: string; vout: number; value: number; height: number }[],
			tipHeight: 0,
			speedUp: [] as Awaited<ReturnType<typeof detectMultisigUnconfirmedInflows>>,
			savedTxs: [] as { id: number; txid: string | null; status: string; feeRate: number }[],
			scanError: e instanceof Error ? e.message : 'Multisig scan failed'
		};
	}
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async ({ params, locals, request }) => {
		const id = multisigId(params.id);
		// Any participant can fetch a deposit address for a shared wallet.
		const multisig = getViewableMultisig(locals.user!.id, id);
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
