import { json, readJson, requireUser } from '$lib/server/api';
import { compareMultisigKey, getMultisig, markKeyVerified } from '$lib/server/wallets/multisig';
import type { RequestHandler } from './$types';

/**
 * POST /api/wallets/multisig/:id/keys/:keyId/verified — record a key health check
 * (Casa-style periodic verification; see markKeyVerified in multisigs.ts).
 *
 * Body, one of:
 *   { "method": "device", "xpub": "...", "fingerprint": "..." }
 *     A live hardware re-read. The SERVER compares the reading against the
 *     stored row (canonicalizing SLIP-132 xpub aliases), so a check is only
 *     ever recorded for a key that actually matched:
 *       match    → 200 { verified: true, keyId, lastVerifiedAt }
 *       mismatch → 200 { verified: false, fingerprintMatch, xpubMatch,
 *                        expectedFingerprint, deviceFingerprint }
 *   { "method": "manual" }
 *     A guided manual verification the user explicitly confirmed (ColdCard /
 *     QR / file keys, which Cairn cannot re-read directly).
 *       → 200 { verified: true, keyId, lastVerifiedAt }
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const keyId = Number(event.params.keyId);
	const multisig = Number.isInteger(id) && id > 0 ? getMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });
	const key = Number.isInteger(keyId) ? multisig.keys.find((k) => k.id === keyId) : undefined;
	if (!key) return json({ error: 'Key not found' }, { status: 404 });

	const body = await readJson<{ method?: unknown; xpub?: unknown; fingerprint?: unknown }>(event);

	if (body.method === 'device') {
		if (typeof body.xpub !== 'string' || typeof body.fingerprint !== 'string') {
			return json(
				{ error: 'A device check needs the xpub and fingerprint the device reported.' },
				{ status: 400 }
			);
		}
		const cmp = compareMultisigKey(key, { xpub: body.xpub, fingerprint: body.fingerprint });
		if (!cmp.fingerprintMatch || !cmp.xpubMatch) {
			return json({
				verified: false,
				fingerprintMatch: cmp.fingerprintMatch,
				xpubMatch: cmp.xpubMatch,
				expectedFingerprint: key.fingerprint.toLowerCase(),
				deviceFingerprint: body.fingerprint.trim().toLowerCase()
			});
		}
	} else if (body.method !== 'manual') {
		return json({ error: 'method must be "device" or "manual".' }, { status: 400 });
	}

	const updated = markKeyVerified(user.id, id, keyId);
	if (!updated) return json({ error: 'Key not found' }, { status: 404 });
	return json({ verified: true, keyId: updated.id, lastVerifiedAt: updated.lastVerifiedAt });
};
