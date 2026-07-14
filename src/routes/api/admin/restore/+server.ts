// POST /api/admin/restore { passphrase, backup } → decrypt + additively restore.
// Admin-only. Accounts whose email already exists are skipped; imported accounts
// arrive credential-less and are reclaimed by adding a passkey at signup.

import { json, requireAdmin, readJson } from '$lib/server/api';
import { decryptBackup, restoreBackup, BackupError } from '$lib/server/backup';
import { notify } from '$lib/server/notifications';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('backup');

export const POST: RequestHandler = async (event) => {
	const user = requireAdmin(event);
	const body = await readJson<{ passphrase?: string; backup?: string }>(event);
	const passphrase = String(body.passphrase ?? '');
	const backupText = String(body.backup ?? '');

	if (!backupText.trim()) return json({ error: 'Attach a backup file.' }, { status: 400 });
	if (!passphrase) return json({ error: 'Enter the backup passphrase.' }, { status: 400 });

	try {
		const data = await decryptBackup(backupText, passphrase);
		const summary = await restoreBackup(data);
		log.warn({ userId: user.id, summary }, 'instance restore applied');

		// Fan a restore out to every admin (cairn-cpb5): a restore is a high-impact,
		// social-engineerable action, so it must be visible — and call out when the
		// backup tried to import admin rows (all forced to non-admin on the way in),
		// or tried to carry security-posture settings (cairn-0dg4 — withheld by
		// restoreBackup's allowlist, see backup.ts).
		const adminNote =
			summary.adminDowngraded > 0
				? ` ${summary.adminDowngraded} account(s) marked admin in the backup were imported as normal accounts — re-promote them yourself if that was intended.`
				: '';
		const settingsNote =
			summary.settingsSkipped.length > 0
				? ` ${summary.settingsSkipped.length} setting(s) in the backup were NOT restored (security/posture keys: ${summary.settingsSkipped.join(', ')}) — set them yourself in Admin → Settings if intended.`
				: '';
		notify({
			type: 'admin_restore',
			userId: null,
			level: summary.adminDowngraded > 0 || summary.settingsSkipped.length > 0 ? 'warn' : 'info',
			title: 'Instance backup restored',
			body: `${user.email} restored a backup: ${summary.usersAdded} account(s) added, ${summary.usersSkipped} skipped.${adminNote}${settingsNote}`,
			detail: {
				byUserId: user.id,
				usersAdded: summary.usersAdded,
				usersSkipped: summary.usersSkipped,
				adminDowngraded: summary.adminDowngraded,
				sharesRestored: summary.shares,
				settingsSkipped: summary.settingsSkipped
			},
			link: '/admin/users'
		});

		return json({ summary });
	} catch (e) {
		if (e instanceof BackupError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e }, 'restore endpoint failed');
		return json({ error: 'Restore failed.' }, { status: 500 });
	}
};
