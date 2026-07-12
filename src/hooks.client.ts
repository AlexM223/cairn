import type { HandleClientError } from '@sveltejs/kit';

/**
 * Client-side counterpart to hooks.server.ts's handleError (Wave 5 item 7 /
 * log-request.md §3, "SvelteKit handleError hooks (server + client)").
 *
 * Before this file existed there was no src/hooks.client.ts at all, so an
 * uncaught client-side error — a hydration failure, a `load` throw, a render
 * error during navigation — fell back to SvelteKit's own default
 * handleError, which just `console.error`s the raw error and shows the
 * generic error page. On Umbrel (logs-only deployment, no debugger attached)
 * that failure is invisible to the operator by construction: it lives only
 * in the end user's own browser console, with no id an operator could ever
 * ask the user to quote back.
 *
 * Scoping note (see the audit): this does NOT address the CSRF-class
 * invisible-failure the rest of the sprint targets. A cross-origin form
 * submission's 403 is a *resolved* network response that `use:enhance`'s
 * `applyAction` handles, not a thrown exception — it never reaches this
 * hook. That class is covered server-side (server.mjs's access log +
 * hooks.server.ts's gate logging). This hook only covers genuine
 * client-side exceptions during navigation/render.
 *
 * Deliberately minimal — the SAFE half of item 7. It logs one structured
 * line to the browser console with a short, stable `errorId` prefix (the
 * same shape as the server's handleError / `app.d.ts`'s `App.Error`) so a
 * user can copy that id into a support request, or a self-hosting operator
 * looking over someone's shoulder can quote it. It does NOT add a
 * `POST /api/client-error` beacon: the audit explicitly recommends deferring
 * that (it would be a new, effectively-unauthenticated endpoint and needs
 * rate-limiting + a request-body cap + safeguards against becoming a
 * log-spam vector, none of which exist yet — out of scope for this wave).
 *
 * Rollback: delete this file. SvelteKit falls back to its built-in default
 * client handleError with no other code changes required.
 */
export const handleError: HandleClientError = ({ error, event, status, message }) => {
	const errorId = randomErrorId();
	// This IS the log sink for a client-side error — there is no server to
	// forward it to (see the file doc comment on the deferred beacon).
	console.error(`[cairn:${errorId}]`, message || 'Client error', {
		status,
		route: event.route.id,
		error
	});
	return { message: 'Something went wrong', errorId };
};

/** Browser-side counterpart to hooks.server.ts's `randomBytes(4).toString('hex')` —
 *  same shape (4 bytes, lowercase hex), via the Web Crypto API since node:crypto
 *  isn't available in the browser. */
function randomErrorId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
