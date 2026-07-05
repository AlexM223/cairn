// DELETE /api/auth/passkeys/:id       — remove a passkey (never the last one)
// PATCH  /api/auth/passkeys/:id {name} — rename a passkey

import { json, requireUser, readJson } from '$lib/server/api';
import { deleteCredential, renameCredential, listCredentials, AuthError } from '$lib/server/auth';
import type { RequestHandler } from './$types';

function credentialId(event: { params: { id: string } }): number | null {
	const id = Number(event.params.id);
	return Number.isInteger(id) && id > 0 ? id : null;
}

export const DELETE: RequestHandler = (event) => {
	const user = requireUser(event);
	const id = credentialId(event);
	if (id === null) return json({ error: 'Bad passkey id.' }, { status: 400 });

	try {
		if (!deleteCredential(user.id, id)) return json({ error: 'Passkey not found.' }, { status: 404 });
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	return json({ passkeys: listCredentials(user.id) });
};

export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = credentialId(event);
	if (id === null) return json({ error: 'Bad passkey id.' }, { status: 400 });

	const body = await readJson<{ name?: string }>(event);
	if (!renameCredential(user.id, id, String(body.name ?? '')))
		return json({ error: 'Passkey not found.' }, { status: 404 });
	return json({ passkeys: listCredentials(user.id) });
};
