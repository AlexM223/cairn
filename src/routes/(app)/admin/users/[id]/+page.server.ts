// Admin → Users → one user. The per-user feature-flag override grid was removed
// (docs/UX-SIMPLIFICATION-SPEC.md §3.1 / §10): the flag ENGINE is untouched —
// the `user_feature_flags` table and resolve.ts's per-user branch stay, so any
// pre-existing override rows are still honored — only the tri-state toggle UI is
// gone. This route survives because it's a notification/health deep-link target
// (`/admin/users/[id]`); it now shows the user's identity header only.
//
// Under /admin, so the admin layout's isAdmin gate protects the page. Also gated
// on assertTeamMode() (cairn-7xlf): this is part of the same Users/Invites
// multi-user MANAGEMENT surface as the list page, which already 404s in solo
// mode — the detail route must match.

import { error } from '@sveltejs/kit';
import { assertTeamMode } from '$lib/server/api';
import { getUser } from '$lib/server/admin';
import type { PageServerLoad } from './$types';

function parseUserId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'User not found');
	return id;
}

export const load: PageServerLoad = async ({ params }) => {
	assertTeamMode();
	const userId = parseUserId(params.id);
	const user = getUser(userId);
	if (!user) error(404, 'User not found');
	return { subject: user };
};
