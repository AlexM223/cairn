import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import { FEATURE_FLAGS_BY_KEY } from './featureFlags/registry';
import { isFeatureEnabled } from './featureFlags/resolve';
import { getInstanceSettings } from './settings';
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

/**
 * Guard for the multi-user MANAGEMENT surfaces only — admin users/invites,
 * contacts, and multisig-share creation/editing — gated on instanceMode ===
 * 'team' (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2). A 404, not a 403:
 * solo mode hides these outright rather than showing a "disabled by your
 * administrator" message, since nothing disabled them — the instance is just
 * narrower. Never gates the READ path a cosigner/viewer already uses to
 * access a wallet already shared with them (that's a separate check, e.g.
 * getViewableMultisig) — an owner toggling back to solo must not silently
 * revoke access they already granted (cairn-7t0z.5).
 */
export function assertTeamMode(): void {
	if (getInstanceSettings().instanceMode !== 'team') error(404, 'Not found');
}

/** Same as {@link assertTeamMode}, for /api routes: also requires sign-in. */
export function requireTeamMode(event: RequestEvent): SessionUser {
	const user = requireUser(event);
	assertTeamMode();
	return user;
}

/**
 * Shared body-size cap for JSON endpoints. There is no adapter/hook-level
 * max-body-size in this repo, so every JSON route otherwise buffers and
 * JSON.parses an arbitrarily large pasted/uploaded blob (a memory/CPU self-DoS
 * surface — cairn-973j). 1 MB is far above any legitimate PSBT/descriptor/config
 * payload. Applied centrally here rather than per-route.
 */
const MAX_JSON_BODY_BYTES = 1_000_000;

/** Read the request body as text, rejecting anything over the shared cap. */
async function readCappedBody(event: RequestEvent): Promise<string> {
	const declared = Number(event.request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
		error(413, 'Request body too large');
	}
	const raw = await event.request.text();
	if (raw.length > MAX_JSON_BODY_BYTES) {
		error(413, 'Request body too large');
	}
	return raw;
}

/** Read a JSON body, returning 400 on malformed input. */
export async function readJson<T = Record<string, unknown>>(event: RequestEvent): Promise<T> {
	const raw = await readCappedBody(event);
	try {
		return JSON.parse(raw) as T;
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
	const raw = (await readCappedBody(event)).trim();
	if (!raw) return {} as T;
	try {
		return JSON.parse(raw) as T;
	} catch {
		error(400, 'Invalid JSON body');
	}
}

export { json };
