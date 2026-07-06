import { json, requireUser } from '$lib/server/api';
import { classifySearch } from '$lib/server/search';
import type { RequestHandler } from './$types';

/** GET /api/search?q= → SearchResult */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const q = event.url.searchParams.get('q') ?? '';
	return json(await classifySearch(q));
};
