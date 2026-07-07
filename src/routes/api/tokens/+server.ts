// Personal access tokens (cairn-ivae.1).
//   GET  /api/tokens         → the caller's tokens (metadata only, no secrets)
//   POST /api/tokens         → create one; the token VALUE appears only in this
//                              response — it is stored hash-only and can never
//                              be retrieved again.
// Revocation lives at DELETE /api/tokens/[id]. The browser UI for all of this
// is /settings/tokens; these endpoints exist so token management itself is
// scriptable too.

import { json, requireUser, readJson } from '$lib/server/api';
import { createApiToken, listApiTokens, ApiTokenError } from '$lib/server/apiTokens';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	return json({ tokens: listApiTokens(user.id) });
};

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ name?: string; expiresDays?: number | null }>(event);
	try {
		const created = createApiToken(user.id, String(body.name ?? ''), body.expiresDays ?? null);
		return json(created, { status: 201 });
	} catch (e) {
		if (e instanceof ApiTokenError) return json({ error: e.message }, { status: 400 });
		throw e;
	}
};
