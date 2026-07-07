import { fail } from '@sveltejs/kit';
import { getSetting } from '$lib/server/settings';
import {
	getScheduledBackupConfig,
	saveScheduledBackupConfig,
	BackupError
} from '$lib/server/backup';
import type { Actions, PageServerLoad } from './$types';

// Admin-only (gated by the admin +layout.server.ts). Surfaces the last
// successful instance-backup timestamp so the page can nudge when it's stale or
// never been done, plus the scheduled-backup config (cairn-ivae.3).
export const load: PageServerLoad = async () => {
	return {
		lastInstanceBackupAt: getSetting('last_instance_backup_at'),
		schedule: getScheduledBackupConfig()
	};
};

export const actions: Actions = {
	saveSchedule: async ({ request, locals }) => {
		// The admin layout already gates this route; unattended writing to an
		// operator path deserves the explicit second check anyway.
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });

		const form = await request.formData();
		const passphrase = String(form.get('passphrase') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		// Blank = keep the stored passphrase (it is never echoed back); a typed
		// one must be confirmed, same as the manual-download flow.
		if (passphrase !== '' && passphrase !== confirm) {
			return fail(400, { error: 'The passphrases do not match.' });
		}

		try {
			saveScheduledBackupConfig({
				enabled: form.get('enabled') === 'on',
				interval: String(form.get('interval') ?? 'daily'),
				path: String(form.get('path') ?? ''),
				passphrase
			});
		} catch (e) {
			if (e instanceof BackupError) return fail(400, { error: e.message });
			throw e;
		}
		return { scheduleSaved: true };
	}
};
