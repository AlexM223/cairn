import { json, requireAdmin } from '$lib/server/api';
import { rotateSenderSecretKey } from '$lib/server/channels/nostr';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('notify:nostr');

/**
 * POST /api/admin/nostr-identity/rotate — regenerate the instance Nostr signing
 * identity. The old secret key is a permanent identity key; rotation is the
 * response to a suspected DB/key leak (cairn-o6y5). Admin-only. Prior DMs were
 * addressed to each recipient's own pubkey and are unaffected; only the sender
 * pubkey future DMs come from changes.
 */
export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const rotated = rotateSenderSecretKey();
	if (!rotated) {
		return json({ error: 'Could not rotate the Nostr identity — check the server logs.' }, { status: 500 });
	}
	log.warn({ adminId: admin.id, pubkey: rotated.pubkey }, 'admin rotated the instance Nostr identity');
	return json({ ok: true, pubkey: rotated.pubkey });
};
