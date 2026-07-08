// POST /api/admin/backup { passphrase } → encrypted instance backup download.
// Admin-only. The file contains config only (accounts minus credentials,
// wallet/multisig configs, settings, labels, address book) — no secrets.

import { json, requireAdmin, readJson } from '$lib/server/api';
import { buildBackup, encryptBackup } from '$lib/server/backup';
import { setSetting } from '$lib/server/settings';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('backup');

export const POST: RequestHandler = async (event) => {
	const user = requireAdmin(event);
	const body = await readJson<{ passphrase?: string }>(event);
	const passphrase = String(body.passphrase ?? '');
	if (passphrase.length < 8) {
		return json({ error: 'Choose a passphrase of at least 8 characters.' }, { status: 400 });
	}

	const exportedAt = new Date().toISOString();
	const encrypted = await encryptBackup(buildBackup(exportedAt), passphrase);
	// Record when the last successful instance backup was taken. Shared
	// groundwork: the notification plan's backup_missing/backup_stale events read
	// this same key — build it once here, consume it there.
	setSetting('last_instance_backup_at', exportedAt);
	log.info({ userId: user.id }, 'instance backup downloaded');

	return new Response(encrypted, {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="cairn-backup-${exportedAt.slice(0, 10)}.json"`,
			'cache-control': 'no-store'
		}
	});
};
