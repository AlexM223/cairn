import { json, readJson, requireTeamMode } from '$lib/server/api';
import {
	updateMultisigShare,
	revokeMultisigShare,
	listCollaborators,
	ShareError,
	type ShareRole
} from '$lib/server/multisigShares';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PATCH /api/wallets/multisig/:id/shares/:shareId — change a collaborator's role
 * and/or reassign their keys: { role?, keyIds? }.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	const shareId = parseId(event.params.shareId);
	if (id === null || shareId === null) return json({ error: 'Not found' }, { status: 404 });
	const body = await readJson<{ role?: unknown; keyIds?: unknown }>(event);
	const changes: { role?: ShareRole; keyIds?: number[] } = {};
	if (body.role != null) changes.role = String(body.role) as ShareRole;
	if (Array.isArray(body.keyIds)) changes.keyIds = body.keyIds.map(Number).filter(Number.isInteger);
	try {
		updateMultisigShare(user.id, shareId, changes);
		return json({ collaborators: listCollaborators(user.id, id) });
	} catch (e) {
		if (e instanceof ShareError) {
			const status = e.code === 'not_found' || e.code === 'not_owner' ? 404 : 400;
			return json({ error: status === 404 ? 'Not found' : e.message, code: e.code }, { status });
		}
		throw e;
	}
};

/** DELETE /api/wallets/multisig/:id/shares/:shareId — revoke a share (owner only). */
export const DELETE: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	const shareId = parseId(event.params.shareId);
	if (id === null || shareId === null || !revokeMultisigShare(user.id, shareId)) {
		return json({ error: 'Not found' }, { status: 404 });
	}
	return json({ collaborators: listCollaborators(user.id, id) });
};
