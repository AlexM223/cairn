import type { ActionResult } from '@sveltejs/kit';

// Shared classification for the app's hand-rolled fetch+deserialize form-action
// callers (the ones that can't use a static `use:enhance` because they submit
// programmatically mid-wizard). Reference incident: a cross-site 403 from
// SvelteKit's own CSRF/origin check was swallowed client-side and reported as
// "Network hiccup — check your connection", and a session-expiry `redirect`
// result was swallowed entirely and reported as "That key could not be read."
// Both are the same invisible/mislabeled-failure class this helper exists to
// close off — every outcome below is either genuinely handled or turned into a
// visible, honestly-labeled message.

export type SafeActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** A real `fetch()` failure — offline, DNS, TLS, aborted. We never got a response. */
export const NETWORK_ERROR_MESSAGE = 'Network hiccup — check your connection and try again.';

/**
 * We got a response, but it isn't a form-action result at all — most commonly
 * SvelteKit's own cross-site/CSRF check (a 403 that predates the action ever
 * running), occasionally something in front of the app (a reverse proxy's own
 * error/login page). Deliberately does NOT say "check your connection" — that
 * misdiagnosis is the exact bug this helper fixes.
 */
export const REJECTED_MESSAGE =
	"That request was blocked before it reached Heartwood — usually a mismatched address or an expired sign-in, not your key or your connection. Reload the page and try again.";

/**
 * The two framework functions this helper needs from `$app/forms`, injected
 * rather than imported directly. This project's vitest config does not load
 * the SvelteKit vite plugin (only a couple of manual aliases — see
 * vitest.config.ts), so a top-level `import ... from '$app/forms'` here would
 * break this module's own unit test. Same pattern as `secureRedirect.ts`
 * taking `win` as a parameter instead of touching browser globals directly.
 */
export interface SafeActionEnv {
	deserialize: (raw: string) => ActionResult;
	applyAction: (result: ActionResult) => Promise<void>;
}

/**
 * POST a SvelteKit form action (`?/name`) the way the framework's own
 * `use:enhance` does — including the `accept: application/json` header our
 * bespoke callers previously omitted, which is what lets the CSRF/origin
 * check hand back parseable JSON instead of a plain-text body — and turn
 * every possible outcome into a shape callers can render directly:
 *
 *   - `{ok:true, data}` on success.
 *   - `{ok:false, error}` on a real failure — `fail()`'s message, a thrown
 *     `error()`'s message, or `fallback` when neither is present.
 *   - a `redirect` result is FOLLOWED via `applyAction` instead of falling
 *     through to a generic error (the auth-expiry fix — this used to render
 *     as a false "bad key"/"couldn't add that" instead of sending the user
 *     back to sign in).
 *   - a real network failure and "the server answered but not with a form
 *     action result" (framework 403, a proxy's own page) are told apart —
 *     only the former gets the "check your connection" copy.
 *
 * Callers keep owning their own `$state` fields; this only replaces the
 * fetch+deserialize+classify boilerplate.
 */
export async function safeAction<T = unknown>(
	env: SafeActionEnv,
	action: string,
	body: FormData,
	fallback: string
): Promise<SafeActionResult<T>> {
	let res: Response;
	try {
		res = await fetch(`?/${action}`, {
			method: 'POST',
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
			body
		});
	} catch {
		return { ok: false, error: NETWORK_ERROR_MESSAGE };
	}

	let result: ActionResult;
	try {
		result = env.deserialize(await res.text());
	} catch {
		// Not JSON at all — the framework's plain-text CSRF response (when the
		// header above isn't honored for some reason) or a non-SvelteKit body
		// (proxy error/login page) in front of the app.
		return { ok: false, error: unrecognizedResponseError(res, fallback) };
	}

	switch (result.type) {
		case 'success':
			return { ok: true, data: (result.data ?? {}) as T };
		case 'failure':
			return {
				ok: false,
				error: (result.data as { error?: string } | undefined)?.error ?? fallback
			};
		case 'redirect':
			// e.g. the session expired mid-wizard and the server wants the user
			// back at /login — follow it instead of showing a stale-looking
			// "could not be read" / "couldn't add that" error.
			await env.applyAction(result);
			return { ok: false, error: '' };
		case 'error':
			return {
				ok: false,
				error: (result.error as { message?: string } | undefined)?.message ?? fallback
			};
		default:
			// Valid JSON, but not one of the four ActionResult shapes above —
			// SvelteKit's CSRF/origin check returns a bare `{message}` with no
			// `type` field even when it does respond with JSON (confirmed
			// against @sveltejs/kit's respond.js). Same "server said no,
			// not a network problem" classification as the non-JSON case.
			return { ok: false, error: unrecognizedResponseError(res, fallback) };
	}
}

function unrecognizedResponseError(res: Response, fallback: string): string {
	return res.status === 403 ? REJECTED_MESSAGE : fallback;
}
