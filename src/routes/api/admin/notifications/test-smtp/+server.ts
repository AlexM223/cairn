// POST /api/admin/notifications/test-smtp — send a real test email to the
// admin's own account address using the instance SMTP config, and report the
// ChannelSendResult inline (§5.1). Reuses the email channel plugin's test()
// (same code path as a real send) so a green result means the relay truly works.
//
// Save the SMTP form FIRST, then test — the plugin reads the stored settings,
// not the in-flight form. The Admin UI enforces that ordering.

import { json, requireAdmin } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { CHANNELS } from '$lib/server/notifications';
import type { ChannelSendResult } from '$lib/server/notifyTypes';
import type { RequestHandler } from './$types';

const log = childLogger('notify:admin-smtp-test');

export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);

	let result: ChannelSendResult;
	try {
		result = await CHANNELS.email.test(admin.id);
	} catch (e) {
		// Log the real error for the operator, but return a generic message rather
		// than forwarding raw driver/connection text to the client (cairn-6y98).
		log.error({ err: e, userId: admin.id }, 'SMTP test threw');
		result = { ok: false, error: 'The test failed unexpectedly.' };
	}
	return json(result);
};
