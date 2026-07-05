import { readLogEntries } from '$lib/server/logStore';
import type { PageServerLoad } from './$types';

// Admin gate is enforced by (app)/admin/+layout.server.ts. First paint ships
// the last 1000 lines; the page filters client-side and can auto-refresh.
export const load: PageServerLoad = () => {
	return readLogEntries({ limit: 1000 });
};
