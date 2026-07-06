// GET/PUT the signed-in user's quiet-hours settings (cairn-5gpv.4). During the
// window, routine (info/success) external-channel notifications are deferred to
// the window's end by the queue worker; warn/error security alerts still deliver
// when the urgent override is on. In-app delivery is never affected.

import { json, readJson, requireUser } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { getQuietHours, setQuietHours } from '$lib/server/quietHours';
import type { RequestHandler } from './$types';

const log = childLogger('notify:quiet-api');

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	return json({ quietHours: getQuietHours(user.id) });
};

export const PUT: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<Record<string, unknown>>(event);
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
	try {
		const saved = setQuietHours(user.id, {
			enabled: body.enabled === true,
			start: str(body.start) ?? null,
			end: str(body.end) ?? null,
			tz: str(body.tz) ?? null,
			urgentOverride: body.urgentOverride !== false
		});
		return json({ quietHours: saved });
	} catch (e) {
		// Validation errors carry a user-facing message; anything else is a 500.
		if (e instanceof Error && e.message) {
			return json({ error: e.message }, { status: 400 });
		}
		log.error({ err: e, userId: user.id }, 'failed to save quiet hours');
		return json({ error: 'Could not save quiet hours.' }, { status: 500 });
	}
};
