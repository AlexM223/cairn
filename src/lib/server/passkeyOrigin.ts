// SAFE mitigation for desktop passkey sign-in failures (auth-desktop
// investigation). WebAuthn's expectedOrigin is pinned to CAIRN_ORIGIN (see
// getRp() in webauthn.ts), so a ceremony started from any OTHER origin is
// guaranteed to fail server-side verification — scheme/port mismatches
// included (e.g. the proxy's http://host:3217 vs the raw https://host:5588
// listener). Rather than let a user attempt — and always lose — a ceremony
// that can never verify, every passkey entry point (login, recovery
// registration, settings "add a passkey") checks this first and hides
// itself, naming the origin where it DOES work instead.
//
// Deliberately mirrors — rather than imports — getRp()'s one-line origin
// derivation so this stays a pure, side-effect-free read that any page load
// can call. It intentionally does not touch the real verification path in
// webauthn.ts; the actual expectedOrigin fix (accepting the request's own
// origin, or an array of allowed origins) is a separate, riskier change.

import { env } from '$env/dynamic/private';

/** The origin a WebAuthn ceremony must run on to verify, for a request that itself arrived on `requestOrigin`. */
export function expectedPasskeyOrigin(requestOrigin: string): string {
	return env.CAIRN_ORIGIN ?? requestOrigin;
}

/** True when a passkey ceremony started on `requestOrigin` can actually verify. */
export function passkeyAvailableOn(requestOrigin: string): boolean {
	return expectedPasskeyOrigin(requestOrigin) === requestOrigin;
}
