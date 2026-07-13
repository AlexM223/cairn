/**
 * Fill-when-absent x-forwarded-proto helper (cairn-wrph, cairn-9njl).
 *
 * Root cause this exists to fix: adapter-node's `get_origin()` treats a
 * request as https whenever NEITHER `ORIGIN` NOR `PROTOCOL_HEADER` is
 * configured (see build/handler.js). server.mjs's bare-node deployments
 * (no reverse proxy, no ORIGIN set) hit that default on the PLAIN HTTP
 * listener too, so every login request "looks" https to
 * src/lib/server/auth.ts's cookieSecure(), which stamps the session cookie
 * `Secure`. Browsers silently drop a `Secure` cookie set over a plain-HTTP
 * response, so the cookie never sticks and the user is bounced back to the
 * login page with an apparently-successful 200.
 *
 * The fix (paired with server.mjs setting `PROTOCOL_HEADER=x-forwarded-proto`
 * for unconfigured deployments): stamp each listener's own protocol onto the
 * request BEFORE it reaches the SvelteKit handler, but only when the header
 * isn't already present. That "only when absent" rule is load-bearing for
 * the reverse-proxy topology (e.g. Umbrel's app_proxy, or any TLS-terminating
 * proxy in front of the HTTP port): those deployments set their own
 * `X-Forwarded-Proto` and it must be honored, not clobbered by this
 * listener's default.
 *
 * Deliberately standalone (imported by server.mjs, which runs OUTSIDE the
 * SvelteKit build — see the header comment in scripts/tls-cert.mjs for why):
 * no imports from src/, pure function over a plain header bag so it's
 * trivially unit-testable without spinning up http.Server instances.
 *
 * Trust-model note (sec-sign-off, see cairn-wrph bead comments): on the HTTP
 * listener this means an inbound `x-forwarded-proto: https` header from an
 * untrusted client is honored as-is (cookieSecure would then stamp Secure on
 * a plain-HTTP response, which the browser just drops — self-inflicted, not
 * an escalation). Deployments that terminate TLS in front of the HTTP port
 * and DON'T set X-Forwarded-Proto get a loud regression (Secure cookie over
 * what SvelteKit sees as http) rather than a silent one — accepted trade-off,
 * documented in the Dockerfile.
 */

/**
 * Mutates `headers` in place, setting `x-forwarded-proto` to `proto` only if
 * it is not already present. Never touches any other header.
 *
 * @param {Record<string, string | string[] | undefined>} headers - Node's
 *   `req.headers` (or any header bag with the same shape).
 * @param {'http' | 'https'} proto - This listener's own protocol.
 * @returns {Record<string, string | string[] | undefined>} the same headers
 *   object, for convenience.
 */
export function fillForwardedProto(headers, proto) {
	if (headers['x-forwarded-proto'] === undefined) {
		headers['x-forwarded-proto'] = proto;
	}
	return headers;
}
