// POST/DELETE the signed-in user's PGP public key for the email channel's
// optional body encryption (§4.2). This key encrypts JUST notification email
// bodies — it has nothing to do with the user's Bitcoin keys, which never leave
// their hardware wallet. Stored in user_pgp_keys with a fingerprint computed at
// upload time so the user can cross-check it against their own keyring.

import { json, readJson, requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { childLogger } from '$lib/server/logger';
import * as openpgp from 'openpgp';
import type { RequestHandler } from './$types';

const log = childLogger('notify:pgp-api');

interface PgpKeyRow {
	fingerprint: string;
	created_at: string;
}

/** GET /api/notifications/pgp — the stored key's fingerprint, or null. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const row = db
		.prepare('SELECT fingerprint, created_at FROM user_pgp_keys WHERE user_id = ?')
		.get(user.id) as PgpKeyRow | undefined;
	return json({ key: row ? { fingerprint: row.fingerprint, createdAt: row.created_at } : null });
};

/**
 * POST /api/notifications/pgp — store/replace the user's armored public key.
 * Body: { publicKey: string }. Validates it parses as a PUBLIC key (rejects a
 * private key paste — a common, dangerous mistake), computes the fingerprint,
 * upserts. Returns { fingerprint, userIds }.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ publicKey?: unknown }>(event);
	const armored = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';

	if (!armored) {
		return json({ error: 'Paste an ASCII-armored public key.' }, { status: 400 });
	}
	if (armored.includes('PRIVATE KEY')) {
		// Never accept a private key — this feature only ever needs the public half.
		return json(
			{
				error:
					'That looks like a PRIVATE key. Only paste your PUBLIC key here — Cairn never needs your private key.'
			},
			{ status: 400 }
		);
	}

	let fingerprint: string;
	let userIds: string[] = [];
	try {
		const key = await openpgp.readKey({ armoredKey: armored });
		if (key.isPrivate()) {
			return json(
				{ error: 'That is a private key. Paste only your public key.' },
				{ status: 400 }
			);
		}
		fingerprint = key.getFingerprint();
		try {
			userIds = key.getUserIDs();
		} catch {
			userIds = [];
		}
	} catch (e) {
		log.warn({ err: e, userId: user.id }, 'PGP key failed to parse');
		return json(
			{ error: 'Could not read that as a PGP public key. Check you pasted the whole armored block.' },
			{ status: 400 }
		);
	}

	try {
		db.prepare(
			`INSERT INTO user_pgp_keys (user_id, public_key, fingerprint)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id)
			 DO UPDATE SET public_key = excluded.public_key,
			               fingerprint = excluded.fingerprint,
			               created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
		).run(user.id, armored, fingerprint);
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'failed to store PGP key');
		return json({ error: 'Could not save that key.' }, { status: 500 });
	}

	return json({ key: { fingerprint, userIds } });
};

/** DELETE /api/notifications/pgp — remove the stored key. */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	db.prepare('DELETE FROM user_pgp_keys WHERE user_id = ?').run(user.id);
	return json({ key: null });
};
