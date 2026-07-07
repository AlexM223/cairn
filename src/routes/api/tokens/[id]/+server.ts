// DELETE /api/tokens/[id] — revoke one of the caller's own personal access
// tokens (cairn-ivae.1). Scoped to the requesting user inside revokeApiToken,
// so a guessed foreign id is a plain 404.

import { json, requireUser } from '$lib/server/api';
import { revokeApiToken } from '$lib/server/apiTokens';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id)) return json({ error: 'Bad token id.' }, { status: 400 });
	if (!revokeApiToken(user.id, id)) return json({ error: 'Token not found.' }, { status: 404 });
	return json({ revoked: true });
};
