// POST /api/notifications/channels/email/test-smtp — send a real test email
// through CANDIDATE SMTP fields the user has typed but NOT yet saved
// (docs/PER-USER-SMTP-PLAN.md §4).
//
// Why this exists separately from the generic .../[channel]/test route: that one
// calls plugin.test(userId), which reads the ALREADY-SAVED config. Here we want
// to verify form values before saving, so a typo'd password never gets persisted
// as "verified" and the user gets feedback before committing.
//
// This route NEVER writes to notification_channel_config — saving is the separate
// explicit PUT action. It only builds a transporter from the candidate fields and
// sends the canned test payload, reusing the email channel's shared
// sendTestWithConfig() so the send + error-classification path is identical to a
// real notification (no duplicated transporter logic here).

import { json, readJson, requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { childLogger } from '$lib/server/logger';
import { decryptSecret } from '$lib/server/secretKey';
import { sendTestWithConfig, type SmtpConfig } from '$lib/server/channels/email';
import type { ChannelSendResult } from '$lib/server/notifyTypes';
import type { RequestHandler } from './$types';

const log = childLogger('notify:email-smtp-test');

const TLS_MODES = new Set<SmtpConfig['tls']>(['starttls', 'tls', 'none']);

/** The user's saved personal-SMTP encrypted password, if any (for blank-pass re-test). */
function storedPassEnc(userId: number): string | null {
	try {
		const row = db
			.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'email'`)
			.get(userId) as { config: string } | undefined;
		if (!row) return null;
		const cfg = JSON.parse(row.config) as { smtp?: { passEnc?: string | null } };
		return cfg.smtp?.passEnc ?? null;
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<Record<string, unknown>>(event);
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

	// --- Validate the candidate fields (mirrors buildConfig('email') / admin) ---
	const host = str(body.host);
	if (!host) return json({ ok: false, error: 'Enter your SMTP server host.' }, { status: 400 });

	const from = str(body.from);
	if (!from) return json({ ok: false, error: 'Enter the From address.' }, { status: 400 });
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))
		return json({ ok: false, error: 'The From address must be a valid email.' }, { status: 400 });

	const tls = str(body.tls) as SmtpConfig['tls'];
	if (!TLS_MODES.has(tls))
		return json({ ok: false, error: 'Choose a valid encryption mode.' }, { status: 400 });

	const port = Number(body.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		return json({ ok: false, error: 'SMTP port must be between 1 and 65535.' }, { status: 400 });

	const smtpUser = str(body.user) || null;

	// --- Resolve the password to test with -----------------------------------
	// Blank/absent pass → reuse the already-saved encrypted password (so re-testing
	// after a first successful save doesn't require retyping it). If none is stored
	// either, test as a no-auth relay rather than failing with a confusing auth error.
	let pass: string | null;
	const rawPass = body.pass == null ? '' : str(body.pass);
	if (rawPass !== '') {
		pass = rawPass;
	} else {
		const enc = storedPassEnc(user.id);
		if (enc) {
			try {
				pass = decryptSecret(enc);
			} catch (err) {
				log.warn({ err, userId: user.id }, 'failed to decrypt stored SMTP password for test');
				return json(
					{
						ok: false,
						error: 'Your saved password could not be read. Re-enter it to test.',
						retryable: false
					},
					{ status: 200 }
				);
			}
		} else {
			pass = null; // no-auth relay
		}
	}

	const candidate: SmtpConfig = { host, port, user: smtpUser, pass, from, tls };

	let result: ChannelSendResult;
	try {
		result = await sendTestWithConfig(user.id, candidate);
	} catch (err) {
		log.error({ err, userId: user.id }, 'SMTP test threw');
		result = { ok: false, error: err instanceof Error ? err.message : 'The test failed unexpectedly.' };
	}
	return json(result);
};
