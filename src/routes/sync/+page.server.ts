// /sync — the first-sync screen (design 1a, cairn-koy4.11). Top-level route,
// OUTSIDE the (app) layout on purpose: the (app) layout's first-sync gate
// redirects here, so living under it would loop — same shape as /disclosure
// and /setup-admin. The page brings its own full-screen Grove shell (no rail).

import { redirect } from '@sveltejs/kit';
import { ensureFirstSyncRunning, getSyncStatus } from '$lib/server/syncStatus';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	// Visiting the screen (re)arms the build if it isn't running yet.
	ensureFirstSyncRunning();
	return { status: await getSyncStatus() };
};
