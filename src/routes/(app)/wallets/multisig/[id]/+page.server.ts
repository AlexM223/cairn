import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import {
	getMultisig,
	getViewableMultisig,
	deleteMultisig,
	toMultisigConfig
} from '$lib/server/wallets/multisig';
import { AuthError } from '$lib/server/auth';
import {
	multisigAccessRole,
	redactMultisigKeysForViewer,
	listCollaborators
} from '$lib/server/multisigShares';
import { listContacts } from '$lib/server/contacts';
import { getInstanceSettings } from '$lib/server/settings';
import { invalidateMultisigCache, nextMultisigReceiveAddress } from '$lib/server/multisigScan';
import { multisigToDescriptor } from '$lib/server/bitcoin/multisig';
import { listMultisigTransactionSummaries } from '$lib/server/multisigTransactions';
import { isBackedUp } from '$lib/server/backups';
import { getAddressLabels } from '$lib/server/addressLabels';
import { readMultisigSnapshot, EMPTY_MULTISIG_SNAPSHOT } from '$lib/server/walletSync';
import { requireUser } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';
import type { Actions, PageServerLoad } from './$types';

const log = childLogger('wallet');

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

export const load: PageServerLoad = ({ params, locals, url, depends }) => {
	const id = multisigId(params.id);
	// Cache-first (cairn-2zxt SWR): the scan-derived fields come from a persisted
	// snapshot read synchronously below — no Electrum in load(), so navigation
	// never blocks. The +page.svelte fires the /refresh endpoint on mount + on each
	// new block and re-invalidates this tag to pick up the fresh snapshot. Retires
	// the streamed full-scan-per-navigation (cairn-vknb.2).
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
				// Safe to include: redactMultisigKeysForViewer never redacts xpub or
				// fingerprint for any role (multisigShares.ts) -- only path is scoped
				// to the viewers own key. Feeds the Keys section supporting
				// audit display (copy/expand) and the key-check UI.
				xpub: k.xpub,
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

	// The scan-derived fields come from the persisted snapshot (read synchronously,
	// no Electrum). `savedTxs` is NOT part of the snapshot — it's a cheap, viewer-
	// scoped local read (the viewer-safe projection, no PSBT/recipients) folded in
	// fresh here (cairn-o1dp.1). Empty-but-shaped until the first refresh lands.
	const cached = readMultisigSnapshot(id);
	const snapshot = cached?.snapshot ?? EMPTY_MULTISIG_SNAPSHOT;
	const scan = {
		...snapshot,
		savedTxs: listMultisigTransactionSummaries(locals.user!.id, id) ?? []
	};

	return {
		...base,
		// Already resolved (not a promise) — the shell and the scan-derived cards
		// both paint instantly. `lastSyncedAt` feeds the SyncIndicator.
		scan,
		lastSyncedAt: cached?.lastSyncedAt ?? null
	};
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async (event) => {
		requireUser(event);
		const { params, locals, request } = event;
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
				receiveError: sanitizeChainError(e, log, { multisigId: id }, 'multisig receive-address action failed')
			});
		}
	},

	delete: async (event) => {
		requireUser(event);
		const { params, locals } = event;
		const id = multisigId(params.id);
		const multisig = getMultisig(locals.user!.id, id);
		if (!multisig) error(404, 'Multisig not found');
		try {
			if (!deleteMultisig(locals.user!.id, id)) error(404, 'Multisig not found');
		} catch (e) {
			if (e instanceof AuthError) return fail(409, { deleteError: e.message });
			throw e;
		}
		invalidateMultisigCache(multisig);
		redirect(303, '/wallets');
	}
};
