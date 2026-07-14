// cairn-ib7w: WebAuthn expectedOrigin must accept BOTH the configured
// CAIRN_ORIGIN (Umbrel's plain-HTTP app_proxy origin) AND the self-signed
// HTTPS listener origin (the only secure-context surface, where a browser will
// actually run the ceremony). This is the acceptance matrix for the shared
// origin allowlist that both the verification path (webauthn.ts) and the UI
// gate (login / recover / settings) consume.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	allowedPasskeyOrigins,
	passkeyAvailableOn,
	expectedPasskeyOrigin
} from './passkeyOrigin';

// $env/dynamic/private reads process.env at call time, so tests set/clear it directly.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of ['CAIRN_ORIGIN', 'CAIRN_HTTPS_EXTERNAL_PORT', 'CAIRN_HTTPS_PORT', 'CAIRN_RP_ID']) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

// The canonical Umbrel deployment: CAIRN_ORIGIN pinned to the plain-HTTP
// app_proxy origin, HTTPS listener published on host port 4488.
const UMBREL_HTTP = 'http://umbrel.local:3211';
const UMBREL_HTTPS = 'https://umbrel.local:4488';

describe('allowedPasskeyOrigins — Umbrel http-proxy + https-listener (cairn-ib7w)', () => {
	beforeEach(() => {
		process.env.CAIRN_ORIGIN = UMBREL_HTTP;
		process.env.CAIRN_HTTPS_EXTERNAL_PORT = '4488';
	});

	it('includes BOTH the configured http proxy origin and the https listener variant of the same host', () => {
		const origins = allowedPasskeyOrigins(UMBREL_HTTPS);
		expect(origins).toContain(UMBREL_HTTP);
		expect(origins).toContain(UMBREL_HTTPS);
		expect(origins).toHaveLength(2);
	});

	it('accepts a ceremony performed on the HTTPS listener (the real bug: this used to be rejected)', () => {
		expect(passkeyAvailableOn(UMBREL_HTTPS)).toBe(true);
	});

	it('still accepts the configured http proxy origin itself', () => {
		expect(passkeyAvailableOn(UMBREL_HTTP)).toBe(true);
	});

	it('rejects an unrelated / attacker origin — no wildcard, exact allowlist only', () => {
		expect(passkeyAvailableOn('https://evil.example.com')).toBe(false);
		expect(passkeyAvailableOn('https://umbrel.local.evil.com:4488')).toBe(false);
		// Right host, wrong (unpublished) port is not admitted either.
		expect(passkeyAvailableOn('https://umbrel.local:9999')).toBe(false);
		expect(allowedPasskeyOrigins(UMBREL_HTTPS)).not.toContain('https://evil.example.com');
	});

	it('the https listener variant is built from the CONFIGURED host, not the request origin (a spoofed Host cannot inject an allowed origin)', () => {
		// Even if a request claims a foreign origin, the derived https entry stays
		// pinned to the configured umbrel.local host.
		const origins = allowedPasskeyOrigins('https://attacker.example.net:4488');
		expect(origins).toContain(UMBREL_HTTPS);
		expect(origins).not.toContain('https://attacker.example.net:4488');
	});

	it('expectedPasskeyOrigin points users at the SECURE https listener, never the insecure http origin', () => {
		// A user on some non-verifying origin should be sent to the https surface.
		expect(expectedPasskeyOrigin('https://umbrel.local:9999')).toBe(UMBREL_HTTPS);
	});
});

describe('allowedPasskeyOrigins — rpID/origin consistency across both listeners', () => {
	beforeEach(() => {
		process.env.CAIRN_ORIGIN = UMBREL_HTTP;
		process.env.CAIRN_HTTPS_EXTERNAL_PORT = '4488';
	});

	it('the same allowlist is produced regardless of which listener served the request', () => {
		// A registration begun on the http proxy and an authentication begun on the
		// https listener resolve to the identical set — so a credential registered
		// on one verifies on the other (rpID is the shared bare host umbrel.local).
		expect(allowedPasskeyOrigins(UMBREL_HTTP)).toEqual(allowedPasskeyOrigins(UMBREL_HTTPS));
	});
});

describe('allowedPasskeyOrigins — non-Umbrel deployments are unchanged', () => {
	it('with no CAIRN_ORIGIN and no HTTPS listener, the sole allowed origin is the request origin itself (self-hosted default — each request is self-consistent)', () => {
		// When nothing is configured the allowlist is exactly the request's own
		// origin — the unchanged pre-existing behaviour. Phishing rejection in this
		// mode comes from rpID + the browser's same-origin enforcement, not from a
		// server-side origin allowlist (which only narrows once CAIRN_ORIGIN is set,
		// as the Umbrel cases above verify).
		expect(allowedPasskeyOrigins('https://wallet.example.org:8443')).toEqual([
			'https://wallet.example.org:8443'
		]);
		expect(passkeyAvailableOn('https://wallet.example.org:8443')).toBe(true);
		// A different request origin simply produces its own single-element list.
		expect(allowedPasskeyOrigins('https://other.example.net')).toEqual(['https://other.example.net']);
	});

	it('a plain reverse-proxy (CAIRN_ORIGIN set, no HTTPS listener) allows exactly the configured origin', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com';
		const origins = allowedPasskeyOrigins('http://127.0.0.1:3000');
		expect(origins).toEqual(['https://cairn.example.com']);
		// The internal request origin the proxy forwards from is NOT auto-allowed.
		expect(passkeyAvailableOn('http://127.0.0.1:3000')).toBe(false);
	});

	it('a whitespace-only CAIRN_ORIGIN behaves as unset (falls back to the request origin)', () => {
		process.env.CAIRN_ORIGIN = '   ';
		expect(allowedPasskeyOrigins('https://host.example:9000')).toEqual(['https://host.example:9000']);
	});
});

describe('allowedPasskeyOrigins — HTTPS default-port and malformed handling', () => {
	it('a 443 external port is emitted without an explicit :443 (matches the browser-sent origin string)', () => {
		process.env.CAIRN_ORIGIN = 'http://host.example:80';
		process.env.CAIRN_HTTPS_EXTERNAL_PORT = '443';
		expect(allowedPasskeyOrigins('https://host.example')).toContain('https://host.example');
		expect(allowedPasskeyOrigins('https://host.example')).not.toContain('https://host.example:443');
	});

	it('a malformed base origin does not throw and does not emit a broken https variant', () => {
		process.env.CAIRN_ORIGIN = 'not a url';
		process.env.CAIRN_HTTPS_EXTERNAL_PORT = '4488';
		const origins = allowedPasskeyOrigins('https://real.example:4488');
		// Base entry (the malformed configured value) is preserved verbatim; no
		// second, broken https entry is synthesized from it.
		expect(origins).toEqual(['not a url']);
	});
});
