import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { listInvites, createInvites, revokeInvite } from '$lib/server/admin';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ invites: listInvites() });
};

/** POST { count?, label?, maxUses?, expiresDays? } */
export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await readJson<{
		count?: number;
		label?: string;
		maxUses?: number;
		expiresDays?: number;
	}>(event);

	const created = createInvites({
		createdBy: admin.id,
		count: body.count ?? 1,
		label: body.label,
		maxUses: body.maxUses,
		expiresDays: body.expiresDays ?? null
	});
	return json({ invites: created }, { status: 201 });
};

/** DELETE { id } — revoke an invite. */
export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<{ id?: number }>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });
	revokeInvite(body.id);
	return json({ ok: true });
};
