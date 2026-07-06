import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import { FEATURE_FLAGS_BY_KEY } from './featureFlags/registry';
import { isFeatureEnabled } from './featureFlags/resolve';
import { childLogger } from './logger';

const flagLog = childLogger('feature-flags');

/** Guard for /api routes: 401 JSON error when not signed in. */
export function requireUser(event: RequestEvent): SessionUser {
	if (!event.locals.user) error(401, 'Authentication required');
	return event.locals.user;
}

/** Guard for /api/admin routes: 403 when not an admin. */
export function requireAdmin(event: RequestEvent): SessionUser {
	const user = requireUser(event);
	if (!user.isAdmin) error(403, 'Admin access required');
	return user;
}

/**
 * Guard for any route/action that performs a feature-gated action. This is the
 * ACTUAL enforcement boundary — the UI hiding a button (§5) is a courtesy; the
 * 403 here is what makes a disabled flag real against a stale client bundle or
 * a direct API call. Prefers the per-request resolved flags (event.locals.flags)
 * and falls back to a fresh DB read for contexts where they weren't populated.
 * Throws 403 with the flag's user-facing message when the resolved value is off.
 */
export function requireFeature(event: RequestEvent, key: string): SessionUser {
	const user = requireUser(event);
	const enabled = event.locals.flags?.[key] ?? isFeatureEnabled(key, user.id);
	if (!enabled) {
		const def = FEATURE_FLAGS_BY_KEY.get(key);
		if (!def) throw new Error(`requireFeature: unknown feature flag: ${key}`);
		// Surface blocked attempts in /admin/logs so an operator can see who ran
		// into a disabled feature (and spot an over-restrictive flag). warn level,
		// no secrets — just the user id, flag key, and the request path.
		flagLog.warn(
			{ userId: user.id, flag: key, method: event.request?.method, path: event.url?.pathname },
			`feature blocked: ${key} for user ${user.id}`
		);
		error(403, def.userMessage);
	}
	return user;
}

/** Read a JSON body, returning 400 on malformed input. */
export async function readJson<T = Record<string, unknown>>(event: RequestEvent): Promise<T> {
	try {
		return (await event.request.json()) as T;
	} catch {
		error(400, 'Invalid JSON body');
	}
}

/**
 * Like readJson, but treats an *empty* body as `{}` (some POSTs legitimately
 * carry no body, e.g. broadcasting an already-saved draft with no fresh PSBT).
 * A non-empty but malformed body still returns 400 — it must not be silently
 * swallowed on irreversible actions like broadcast (cairn-1yw7).
 */
export async function readOptionalJson<T = Record<string, unknown>>(event: RequestEvent): Promise<T> {
	const raw = (await event.request.text()).trim();
	if (!raw) return {} as T;
	try {
		return JSON.parse(raw) as T;
	} catch {
		error(400, 'Invalid JSON body');
	}
}

export { json };
