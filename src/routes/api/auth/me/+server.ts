import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	return json({ user: requireUser(event) });
};
