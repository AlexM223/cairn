import { json, requireUser, readJson } from '$lib/server/api';
import { broadcastStatelessPsbt, statelessErrorInfo } from '$lib/server/stateless';
import type { RequestHandler } from './$types';

/**
 * POST /api/stateless/broadcast { source, psbt }
 * Quorum-check the client-held PSBT against the pasted config (refused below
 * M with an "X of M signatures collected" message), finalize it, and
 * broadcast via the chain source. Returns { txid }.
 *
 * No atomic broadcast claim exists here — there is no row to claim. Double
 * submitting the same finalized transaction is rejected by the network itself
 * (already-known duplicate), and a transaction cannot double-spend itself:
 * acceptable for an explicitly stateless tool (see $lib/server/stateless.ts).
 */
export const POST: RequestHandler = async (event) => {
	requireUser(event);
	const body = await readJson<{ source?: unknown; psbt?: unknown }>(event);
	try {
		return json(await broadcastStatelessPsbt(String(body.source ?? ''), String(body.psbt ?? '')));
	} catch (e) {
		const { status, message, code } = statelessErrorInfo(e);
		return json({ error: message, code }, { status });
	}
};
