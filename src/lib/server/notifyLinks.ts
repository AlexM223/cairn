// Deep-link resolution for notifications (cairn-5gpv.1).
//
// A NotificationPayload.link is a BARE RELATIVE app path ("/wallets/3") — it
// resolves fine inside the app (an <a href> under the app's own origin), but
// external channels (email, Telegram, ntfy, Nostr) ship it into a context with
// no implicit origin, where "/wallets/3" is inert text or undefined behavior.
//
// This helper joins that relative path against the instance's public origin
// (env.CAIRN_ORIGIN — the same config WebAuthn uses for reverse-proxy setups).
// notify() runs mostly OUTSIDE a request context (background watchers, the queue
// worker), so there is no event.url to fall back to: CAIRN_ORIGIN is the sole
// source of truth. When it is unset we omit the link entirely rather than send a
// broken one, and log a one-time hint for self-hosters who want working links.

import { env } from '$env/dynamic/private';
import { childLogger } from './logger';

const log = childLogger('notify:links');

let warnedMissingOrigin = false;

/**
 * Resolve a payload's relative deep-link to an absolute URL against
 * CAIRN_ORIGIN, for use in external notification channels. Returns null when
 * there is no link, when CAIRN_ORIGIN is unset (a broken link is worse than
 * none — logged once as an admin hint), or when the join fails.
 */
export function absoluteNotificationLink(link: string | null | undefined): string | null {
	if (!link) return null;

	// An already-absolute link needs no origin — pass it straight through.
	try {
		return new URL(link).href;
	} catch {
		// Relative path — resolve against CAIRN_ORIGIN below.
	}

	const origin = env.CAIRN_ORIGIN?.trim();
	if (!origin) {
		if (!warnedMissingOrigin) {
			warnedMissingOrigin = true;
			log.warn(
				'CAIRN_ORIGIN is not set — external notifications will omit deep links. ' +
					'Set CAIRN_ORIGIN to this instance’s public URL (e.g. https://cairn.example.com) to include working links.'
			);
		}
		return null;
	}

	try {
		// An already-absolute link passes through; a relative one resolves against
		// the origin. new URL also validates the result is a real URL.
		return new URL(link, origin).href;
	} catch {
		log.warn({ link, origin }, 'could not resolve notification deep link');
		return null;
	}
}
