import { getSetting } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

// Admin-only (gated by the admin +layout.server.ts). Surfaces the last
// successful instance-backup timestamp so the page can nudge when it's stale or
// never been done.
export const load: PageServerLoad = async () => {
	return { lastInstanceBackupAt: getSetting('last_instance_backup_at') };
};
