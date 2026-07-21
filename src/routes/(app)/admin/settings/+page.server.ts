import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /admin/settings is deleted (docs/UX-SIMPLIFICATION-SPEC.md §5 / §9): its
// entire contents — Node connection, Registration, Team features, User
// agreement, Factory reset — moved wholesale into the one Settings page
// (spec §4). This stub keeps old bookmarks and notification/health deep links
// alive with a 307 to the Node-connection anchor of the new page.
//
// The old in-page anchors map as #registration → #instance, #node-connection →
// #node-connection, #factory-reset → #factory-reset — but a URL fragment is
// never sent to the server (browsers keep it client-side), so the incoming
// anchor can't be read here to preserve it. We land on #node-connection, the
// most common target; the surviving anchors are still reachable on the page.
export const load: PageServerLoad = async () => {
	redirect(307, '/settings#node-connection');
};
