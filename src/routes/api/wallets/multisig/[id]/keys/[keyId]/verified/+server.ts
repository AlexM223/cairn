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
 *     ever recorded for a key that actually matched. A stored '00000000'
 *     placeholder fingerprint (bare-xpub add, no origin ever captured) never
 *     disagreed with anything real, so it doesn't fail the check on its own —
 *     matchedWithoutFingerprint flags that case (cairn-9p6z):
 *       match    → 200 { verified: true, keyId, lastVerifiedAt, matchedWithoutFingerprint }
 *       mismatch → 200 { verified: false, fingerprintMatch, xpubMatch,
 *                        expectedFingerprint, deviceFingerprint }
 *   { "method": "paste", "xpub": "...", "fingerprint": "..." }
 *     A re-entered/re-imported xpub — the air-gapped / ColdCard / no-device
 *     (and plain-HTTP, where WebHID/Web Serial are withheld) fallback to a
 *     live re-read. Same shape, same compare — the endpoint doesn't check
 *     the source of a reading, only the values — so it shares every response
 *     shape with "device" above.
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

	let matchedWithoutFingerprint = false;
	if (body.method === 'device' || body.method === 'paste') {
		if (typeof body.xpub !== 'string' || typeof body.fingerprint !== 'string') {
			return json(
				{ error: 'A key check needs the xpub and fingerprint to compare — both are required.' },
				{ status: 400 }
			);
		}
		const cmp = compareMultisigKey(key, { xpub: body.xpub, fingerprint: body.fingerprint });
		// A stored '00000000' placeholder fingerprint (bare-xpub add, no
		// [fingerprint/path] origin) never disagreed with anything real — the
		// xpub match alone decides the check in that case (cairn-9p6z).
		if (!cmp.xpubMatch || !(cmp.fingerprintMatch || cmp.matchedWithoutFingerprint)) {
			return json({
				verified: false,
				fingerprintMatch: cmp.fingerprintMatch,
				xpubMatch: cmp.xpubMatch,
				expectedFingerprint: key.fingerprint.toLowerCase(),
				deviceFingerprint: body.fingerprint.trim().toLowerCase()
			});
		}
		matchedWithoutFingerprint = cmp.matchedWithoutFingerprint;
	} else if (body.method !== 'manual') {
		return json({ error: 'method must be "device", "paste", or "manual".' }, { status: 400 });
	}

	const updated = markKeyVerified(user.id, id, keyId);
	if (!updated) return json({ error: 'Key not found' }, { status: 404 });
	return json({
		verified: true,
		keyId: updated.id,
		lastVerifiedAt: updated.lastVerifiedAt,
		matchedWithoutFingerprint
	});
};
