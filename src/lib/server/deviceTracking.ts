// New-device login detection (cairn-5gpv.6). The sessions table records the
// user-agent/IP at creation; this module keeps a small per-user set of known
// device fingerprints and fires security_new_device the first time a session is
// created from an unrecognized one. Deliberately NOT fired for a user's very
// first device — that's the expected signup/first-login, with no prior owner to
// warn — mirroring how webauthn.ts skips the first passkey.
//
// The fingerprint is a coarse hash of the user-agent string: enough to catch "you
// signed in from a new browser/phone" without any real device attestation. It's a
// heuristic nudge, not a security boundary.

import { createHash } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { notify } from './notifications';
import { childLogger } from './logger';

const log = childLogger('notify:device');

export interface SessionContext {
	/** The request's User-Agent header, or null when unavailable. */
	userAgent: string | null;
	/** The client IP (event.getClientAddress()), or null. Stored for context; not
	 *  part of the fingerprint (IPs churn too much to be a stable device signal). */
	ip: string | null;
}

/** Build a SessionContext from a request event — the user-agent header and client
 *  IP. getClientAddress() can throw depending on the adapter, so it's guarded. */
export function sessionContextFrom(event: RequestEvent): SessionContext {
	let ip: string | null = null;
	try {
		ip = event.getClientAddress();
	} catch {
		ip = null;
	}
	return { userAgent: event.request.headers.get('user-agent'), ip };
}

/** Coarse device fingerprint: a hash of the user-agent string. */
function fingerprint(userAgent: string): string {
	return createHash('sha256').update(userAgent).digest('hex').slice(0, 32);
}

/** Best-effort human label for a user-agent (browser + OS family), for the alert
 *  body. Falls back to a trimmed raw UA when nothing recognizable is found. */
export function describeUserAgent(ua: string): string {
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /OPR\/|Opera/.test(ua)
			? 'Opera'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Chrome\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: null;
	const os = /Windows/.test(ua)
		? 'Windows'
		: /iPhone|iPad|iOS/.test(ua)
			? 'iOS'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X|Macintosh/.test(ua)
					? 'macOS'
					: /Linux/.test(ua)
						? 'Linux'
						: null;
	if (browser && os) return `${browser} on ${os}`;
	if (browser) return browser;
	if (os) return os;
	return ua.length > 60 ? `${ua.slice(0, 60)}…` : ua;
}

/**
 * Record the device behind a just-created session and, when it's an unrecognized
 * fingerprint for a user who already has at least one known device, fire
 * security_new_device. No-op (and no alert) when the user-agent is missing — an
 * empty UA can't be fingerprinted, and internal createSession calls that don't
 * pass request context simply aren't tracked. Best-effort: never throws, so it
 * can never break the login it rides along with.
 */
export function recordDeviceAndMaybeNotify(userId: number, ctx: SessionContext): void {
	const ua = ctx.userAgent?.trim();
	if (!ua) return; // can't fingerprint; skip silently
	const fp = fingerprint(ua);

	try {
		const existing = db
			.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND fingerprint = ?')
			.get(userId, fp);
		if (existing) {
			db.prepare(
				`UPDATE known_devices SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				  WHERE user_id = ? AND fingerprint = ?`
			).run(userId, fp);
			return;
		}

		// New fingerprint. Only an alert-worthy "new device" if the user already had
		// a known device — the first one is the expected signup/first login.
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?')
			.get(userId) as { n: number };

		db.prepare(
			`INSERT INTO known_devices (user_id, fingerprint, user_agent) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, fingerprint) DO NOTHING`
		).run(userId, fp, ua);

		if (n > 0) {
			notify({
				type: 'security_new_device',
				userId,
				level: 'warn',
				title: 'New device signed in',
				body: `Your account was just signed in from a device we haven’t seen before (${describeUserAgent(
					ua
				)}). If this wasn’t you, change your password and review your account.`,
				detail: { device: describeUserAgent(ua), ip: ctx.ip },
				link: '/settings'
			});
		}
	} catch (e) {
		log.error({ err: e, userId }, 'device tracking failed');
	}
}
