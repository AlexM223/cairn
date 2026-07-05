import { json } from '$lib/server/api';
import { db } from '$lib/server/db';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('health');

/**
 * GET /api/health → { status: "ok" } | 503 { status: "degraded" }
 *
 * Unauthenticated on purpose: container orchestrators and reverse proxies
 * can't log in. Discloses nothing beyond liveness — no chain state, versions,
 * or counts.
 */
export const GET: RequestHandler = async () => {
	try {
		db.prepare('SELECT 1').get();
		return json({ status: 'ok' });
	} catch (e) {
		log.warn({ err: e }, 'health check failed');
		return json({ status: 'degraded' }, { status: 503 });
	}
};
