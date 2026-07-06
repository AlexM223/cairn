// GET /api/account/export — download everything Cairn stores about the caller
// as a JSON file (cairn-5u2i.3). Strictly self-service: the bundle is scoped to
// locals.user.id at the query level inside buildAccountExport, carries no
// secret material (no password/recovery hashes, no session tokens, channel
// secrets redacted to presence booleans), and never includes other users' data.

import { requireUser } from '$lib/server/api';
import { buildAccountExport } from '$lib/server/accountData';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const data = buildAccountExport(user.id);
	const date = new Date().toISOString().slice(0, 10);
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="cairn-my-data-${date}.json"`,
			'cache-control': 'no-store'
		}
	});
};
