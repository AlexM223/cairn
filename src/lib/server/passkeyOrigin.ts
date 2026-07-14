// Allowed-origin set for WebAuthn (passkey) ceremonies, shared by the
// verification path (webauthn.ts) and the UI gate (login / recover / settings
// pages that hide the passkey entry point on an origin where it can't work).
//
// Background (cairn-ib7w): on Umbrel, CAIRN_ORIGIN is pinned to the plain-HTTP
// app_proxy origin (http://<device>:3211) so the session cookie stays
// non-Secure there (cairn-wrph/9njl). But a browser will only run a passkey
// ceremony in a SECURE context, and the only secure surface Umbrel exposes is
// the self-signed HTTPS listener (https://<device>:4488, cairn-wgr8) — the same
// listener hardware-wallet signing needs. A single pinned CAIRN_ORIGIN made
// @simplewebauthn's expectedOrigin reject that listener's real origin, so
// passkeys could never verify there. The fix is to accept a SET of origins:
// the configured origin PLUS the HTTPS listener variant of the same host.
//
// The set is derived purely from server configuration (never from an
// attacker-controllable request header when an origin is configured), so it is
// safe to hand straight to @simplewebauthn as expectedOrigin.

import { env } from '$env/dynamic/private';
import { httpsExternalPort } from './httpsPort';

/**
 * Every origin a WebAuthn ceremony for this instance is allowed to run on:
 *
 *   1. The configured CAIRN_ORIGIN (reverse-proxy / Umbrel app_proxy origin),
 *      or — when CAIRN_ORIGIN is unset — the request's own origin, preserving
 *      the "self-hosted just works on whatever host you serve it from" default.
 *   2. PLUS the self-signed HTTPS listener origin (cairn-wgr8) when one is
 *      published: the SAME host, https, on the host-visible external port. This
 *      is the secure-context listener Umbrel needs for hardware-wallet signing
 *      and the only surface where a browser will actually perform a ceremony.
 *
 * rpID is deliberately NOT varied here — it is the bare host, identical across
 * both listeners (adapter-node derives it from the Host header on the direct
 * HTTPS connection), so a credential registered on one verifies on the other.
 * Only the origin (scheme + host + port) differs, which is exactly what this
 * allowlist reconciles. The default HTTPS port (443) is emitted without an
 * explicit `:443` so it matches the origin string a browser actually sends.
 */
export function allowedPasskeyOrigins(requestOrigin: string): string[] {
	const base = env.CAIRN_ORIGIN?.trim() || requestOrigin;
	const origins = new Set<string>([base]);

	const httpsPort = httpsExternalPort();
	if (httpsPort) {
		try {
			// Same device host the credential is bound to — from the configured
			// origin when set, else the request's own host.
			const host = new URL(base).hostname;
			origins.add(httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`);
		} catch {
			// Malformed base origin — skip the derived HTTPS variant rather than
			// emit a broken one. The base entry still stands.
		}
	}
	return [...origins];
}

/** True when a passkey ceremony started on `requestOrigin` can actually verify server-side. */
export function passkeyAvailableOn(requestOrigin: string): boolean {
	return allowedPasskeyOrigins(requestOrigin).includes(requestOrigin);
}

/**
 * The secure origin to point a user at when their current origin can't run a
 * passkey ceremony — the HTTPS listener variant when one exists (the only
 * secure-context surface on plain-HTTP Umbrel), else the configured/base origin.
 */
export function expectedPasskeyOrigin(requestOrigin: string): string {
	const origins = allowedPasskeyOrigins(requestOrigin);
	// Prefer an https origin — the secure-context one the hint should send
	// users to; falling back to the first (base) entry otherwise.
	return origins.find((o) => o.startsWith('https://')) ?? origins[0];
}
