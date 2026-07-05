import { json, requireUser, readJson } from '$lib/server/api';
import { scanStatelessSource, statelessErrorInfo } from '$lib/server/stateless';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('stateless');

/**
 * POST /api/stateless/scan { source }
 * Parse a pasted multisig config (output descriptor or Caravan/Unchained JSON),
 * scan it over Electrum, and return balance + coins + a receive-address
 * preview + the 0/0 test address. Nothing is stored — this is the entry point
 * of the stateless (Caravan-parity) flow. Auth required: stateless means "no
 * multisig row", not "no login".
 */
export const POST: RequestHandler = async (event) => {
	requireUser(event);
	const body = await readJson<{ source?: unknown }>(event);
	try {
		return json(await scanStatelessSource(String(body.source ?? '')));
	} catch (e) {
		const { status, message, code } = statelessErrorInfo(e);
		if (status >= 500) {
			log.error({ err: e, code }, 'stateless scan failed');
		}
		return json({ error: message, code }, { status });
	}
};
