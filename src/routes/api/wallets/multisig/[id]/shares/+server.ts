import { json, readJson, requireTeamMode } from '$lib/server/api';
import { listCollaborators, shareMultisig, ShareError, type ShareRole } from '$lib/server/multisigShares';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/wallets/multisig/:id/shares — collaborators on this wallet (owner
 * only). This is the sharing MANAGEMENT surface — gated on instanceMode. A
 * cosigner/viewer's own read access to the wallet itself goes through
 * getViewableMultisig instead, which is never gated by instanceMode
 * (cairn-7t0z.5) — so turning solo mode back on never revokes access already
 * granted, it only hides the owner's management UI/API.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	if (id === null) return json({ error: 'Wallet not found' }, { status: 404 });
	try {
		return json({ collaborators: listCollaborators(user.id, id) });
	} catch (e) {
		// listCollaborators throws not_owner (a 404-equivalent — never leak existence).
		if (e instanceof ShareError) return json({ error: 'Wallet not found' }, { status: 404 });
		throw e;
	}
};

/**
 * POST /api/wallets/multisig/:id/shares — share with a contact:
 * { contactUserId, role: 'viewer'|'cosigner', keyIds?: number[] }.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	if (id === null) return json({ error: 'Wallet not found' }, { status: 404 });
	const body = await readJson<{ contactUserId?: unknown; role?: unknown; keyIds?: unknown }>(event);
	const contactUserId = Number(body.contactUserId);
	const role = String(body.role ?? 'viewer') as ShareRole;
	const keyIds = Array.isArray(body.keyIds) ? body.keyIds.map(Number).filter(Number.isInteger) : [];
	if (!Number.isInteger(contactUserId) || contactUserId <= 0) {
		return json({ error: 'Pick a contact to share with.' }, { status: 400 });
	}
	try {
		shareMultisig(user.id, id, contactUserId, role, keyIds);
		return json({ collaborators: listCollaborators(user.id, id) });
	} catch (e) {
		if (e instanceof ShareError) {
			// not_owner reads as a 404 (no existence leak); everything else is a 400.
			const status = e.code === 'not_owner' ? 404 : 400;
			return json({ error: status === 404 ? 'Wallet not found' : e.message, code: e.code }, { status });
		}
		throw e;
	}
};
