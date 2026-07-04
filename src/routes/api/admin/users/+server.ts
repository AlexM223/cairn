import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { listUsers, setUserAdmin, setUserDisabled, deleteUser } from '$lib/server/admin';
import { AuthError } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ users: listUsers() });
};

/** POST { id, disabled?, isAdmin? } — update a user's flags. */
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<{ id?: number; disabled?: boolean; isAdmin?: boolean }>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });

	try {
		if (typeof body.disabled === 'boolean') setUserDisabled(body.id, body.disabled);
		if (typeof body.isAdmin === 'boolean') setUserAdmin(body.id, body.isAdmin);
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	return json({ users: listUsers() });
};

/** DELETE { id } */
export const DELETE: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await readJson<{ id?: number }>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });
	if (body.id === admin.id)
		return json({ error: 'You cannot delete your own account.' }, { status: 400 });

	try {
		deleteUser(body.id);
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	return json({ ok: true });
};
