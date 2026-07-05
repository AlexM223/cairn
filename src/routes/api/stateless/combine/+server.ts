import { json, requireUser, readJson } from '$lib/server/api';
import { combineStatelessPsbts, statelessErrorInfo } from '$lib/server/stateless';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('stateless');

/**
 * POST /api/stateless/combine { source, base, incoming }
 * Merge one signer's output (`incoming` — base64/hex/text, anything a signer
 * hands back) into the client-held `base` PSBT. Returns the combined PSBT
 * plus fresh quorum progress. Same guards as the persistent attach path
 * (same-transaction check, multisig-key membership, idempotent re-submission);
 * the client holds ALL state between calls — nothing is stored.
 */
export const POST: RequestHandler = async (event) => {
	requireUser(event);
	const body = await readJson<{ source?: unknown; base?: unknown; incoming?: unknown }>(event);
	try {
		return json(
			combineStatelessPsbts(
				String(body.source ?? ''),
				String(body.base ?? ''),
				String(body.incoming ?? '')
			)
		);
	} catch (e) {
		const { status, message, code } = statelessErrorInfo(e);
		if (status >= 500) {
			log.error({ err: e, code }, 'stateless combine failed');
		}
		return json({ error: message, code }, { status });
	}
};
