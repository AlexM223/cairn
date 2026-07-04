import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
		redirect(302, `/login${next}`);
	}
	return { user: locals.user };
};
