import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /admin/feature-flags is deleted (docs/UX-SIMPLIFICATION-SPEC.md §3 / §9): the
// 25-row toggle grid is gone. The flag ENGINE is untouched (registry, resolve,
// requireFeature, the feature_flags / user_feature_flags tables) — only the
// grid UI dies. The two flags an operator legitimately decides (mining,
// explorer) are now plain labeled toggles in Settings; the other 23 are
// code-only defaults, still API/DB-settable. This stub redirects old links to
// the Mining toggle's new home.
export const load: PageServerLoad = async () => {
	redirect(307, '/settings#mining');
};
