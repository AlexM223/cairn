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

type SavedTxSummary = NonNullable<ReturnType<typeof listMultisigTransactionSummaries>>[number];
type SpeedUpInflow = NonNullable<Awaited<ReturnType<typeof detectMultisigUnconfirmedInflows>>>[number];

export interface MultisigScan {
	detail: {
		balance: Awaited<ReturnType<typeof getMultisigDetail>>['balance'];
		addresses: Awaited<ReturnType<typeof getMultisigDetail>>['addresses'];
		history: Awaited<ReturnType<typeof getMultisigDetail>>['history'];
		utxoCount: number;
	} | null;
	receive:
		| (Awaited<ReturnType<typeof peekMultisigReceiveAddress>> & { qr: string })
		| null;
	coinbaseUtxos: { txid: string; vout: number; value: number; height: number }[];
	tipHeight: number;
	speedUp: SpeedUpInflow[];
	savedTxs: SavedTxSummary[];
	scanError: string | null;
}

/**
 * The Electrum-dependent slice of the page. Streamed (returned as an unawaited
 * promise) so the multisig shell paints instantly while the full gap-limit scan
 * + tip + unconfirmed-inflow detection resolve in the background (cairn-vknb.2),
 * mirroring the dashboard's `loadChainSnapshot`. Never rejects — a scan failure
 * resolves to an empty-but-shaped snapshot the page renders as a banner, so the
 * "scan unreachable → degrade to zero/empty, never 500" contract is preserved.
 */
async function loadMultisigScan(
	multisig: Parameters<typeof getMultisigDetail>[0],
	userId: number,
	id: number
): Promise<MultisigScan> {
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
			const [utxos, tip] = await Promise.all([getMultisigUtxos(multisig), getChain().getTip()]);
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
		let speedUp: SpeedUpInflow[] = [];
		try {
			speedUp = (await detectMultisigUnconfirmedInflows(userId, id)) ?? [];
		} catch {
			speedUp = [];
		}
		// Already the viewer-safe projection (no PSBT/recipients) — the summary
		// list stays viewer-reachable while the full-shape functions are
		// cosigner-gated (cairn-o1dp.1).
		const savedTxs = listMultisigTransactionSummaries(userId, id) ?? [];

		return {
			detail: {
				balance: detail.balance,
				addresses: detail.addresses,
				history: detail.history,
				utxoCount: detail.utxos.length
			},
			receive: { ...receive, qr },
			coinbaseUtxos,
			tipHeight,
			speedUp,
			savedTxs,
			scanError: null
		};
	} catch (e) {
		// Only swallow scan failures — the multisig shell still renders. Keep the
		// same fields the success branch returns (empty) so `scan.speedUp`/
		// `scan.savedTxs` aren't typed as possibly-undefined at the call sites.
		return {
			detail: null,
			receive: null,
			coinbaseUtxos: [],
			tipHeight: 0,
			speedUp: [],
			savedTxs: [],
			scanError: e instanceof Error ? e.message : 'Multisig scan failed'
		};
	}
}

export const load: PageServerLoad = async ({ params, locals, url, depends }) => {
	const id = multisigId(params.id);
	// A new block invalidates only this tag (wired to onNewBlock on the client),
	// so the chain-derived fields (tip, coinbase maturity, speed-up eligibility)
	// refresh live without a manual reload — mirroring `depends('cairn:chain')`
	// on the dashboard. The scan itself is 60s-cached server-side, so this stays
	// cheap on repeat.
	depends(`cairn:multisig:${id}`);
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

	return {
		...base,
		// Streamed, not awaited (SvelteKit 2 leaves top-level promises alone): the
		// multisig shell (name, keys, collaborators, descriptor, backup status)
		// paints immediately from the cheap `base` fields above while the full
		// gap-limit scan + tip + speed-up detection resolve in the background
		// (cairn-vknb.2). loadMultisigScan never rejects — a scan failure resolves
		// to an empty-but-shaped snapshot the page renders as a banner.
		scan: loadMultisigScan(multisig, locals.user!.id, id)
	};
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
