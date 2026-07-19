import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { listInvites, createInvites, revokeInvite } from '$lib/server/admin';
import { AuthError } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ invites: listInvites() });
};

/** POST { count?, label?, maxUses?, expiresDays?, welcomeMessage? } */
export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await readJson<{
		count?: number;
		label?: string;
		maxUses?: number;
		expiresDays?: number;
		welcomeMessage?: string;
	}>(event);

	try {
		const created = createInvites({
			createdBy: admin.id,
			count: body.count ?? 1,
			label: body.label,
			maxUses: body.maxUses,
			expiresDays: body.expiresDays ?? null,
			welcomeMessage: body.welcomeMessage
		});
		return json({ invites: created }, { status: 201 });
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
};

/** DELETE { id } — revoke an invite. */
export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<{ id?: number }>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });
	revokeInvite(body.id);
	return json({ ok: true });
};
