// POST /api/admin/restore { passphrase, backup } → decrypt + additively restore.
// Admin-only. Accounts whose email already exists are skipped; imported accounts
// arrive credential-less and are reclaimed by adding a passkey at signup.

import { json, requireAdmin, readJson } from '$lib/server/api';
import { decryptBackup, restoreBackup, BackupError } from '$lib/server/backup';
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
		const data = decryptBackup(backupText, passphrase);
		const summary = restoreBackup(data);
		log.warn({ userId: user.id, summary }, 'instance restore applied');
		return json({ summary });
	} catch (e) {
		if (e instanceof BackupError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e }, 'restore endpoint failed');
		return json({ error: 'Restore failed.' }, { status: 500 });
	}
};
