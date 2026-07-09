// Shared SSRF guard for notification channels that POST to a user-supplied URL
// (webhook, ntfy, …). Any server-side fetch to a user-controlled host is an SSRF
// surface: without a guard a user could aim Cairn at cloud metadata endpoints,
// LAN admin panels, or localhost. This module centralizes the policy so every
// outbound channel goes through the identical gate (cairn-iiuh).
//
// POLICY
//   • scheme MUST match the caller's scheme mode: http:/https: (the default, used
//     by webhook + ntfy), or ws:/wss: (Nostr relays — see checkRelayUrl). A bare
//     host with no URL (per-user SMTP relay) goes through checkTargetHost, which
//     skips the scheme check entirely.
//   • the hostname is resolved to IPs, and EVERY resolved address is checked
//     against the blocked ranges below; a literal IP host is checked directly.
//   • the admin escape hatch `webhook_allow_private_targets === 'true'` (instance
//     setting, off by default) disables the range check for self-hosters who
//     legitimately POST to another service on their own LAN. It NEVER disables
//     the scheme check.
//
// WEBSOCKET (ws:/wss:) TARGETS — cairn-zn7z
//   safeFetch's pinned-socket TOCTOU defense is HTTP-only. Nostr publishes over a
//   WebSocket opened by nostr-tools' SimplePool, which uses the global WebSocket
//   and re-resolves DNS itself at connect — there is no hook to pin the socket to
//   a pre-validated IP. So for ws targets we validate the resolved IPs up front
//   (checkRelayUrl) and reject blocked ones BEFORE connecting; this closes the
//   fixed-private-IP and "resolves-to-a-private-range" cases. A determined
//   DNS-rebinding attacker who flips their record between our check and the
//   WebSocket's own re-resolution is NOT fully defeated for ws (documented
//   limitation — pinning would require replacing nostr-tools' transport).
//
// DNS-REBINDING (TOCTOU) — cairn-335b (closed)
//   checkTargetUrl resolves every A/AAAA record and rejects if ANY is blocked,
//   which defeats the simple "one public + one private record" split. On its own
//   that still left a time-of-check/time-of-use gap: the platform `fetch`
//   re-resolves DNS at connect, so an attacker who flips their record between the
//   check and the connect could slip a private IP through. safeFetch now closes
//   that gap by PINNING the connection: it hands off to a node:http(s) transport
//   that dials the exact validated IP directly (never re-resolving the hostname),
//   while still presenting the original Host header and TLS servername so
//   virtual-hosting and certificate validation keep working. DNS is consulted
//   once, inside checkTargetUrl, and never again — there is no rebinding window.

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { getSetting } from '../settings';

/**
 * Is `ip` (a numeric IPv4 or IPv6 literal) inside a blocked private/loopback/
 * link-local range? IPv4-mapped IPv6 is unwrapped first — in BOTH the dotted
 * (`::ffff:127.0.0.1`) and compressed-hex (`::ffff:7f00:1`) spellings (cairn-7bsc).
 */
export function isBlockedAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return isBlockedIPv4(ip);
	if (family === 6) {
		const lower = ip.toLowerCase();
		// IPv4-mapped IPv6 (::ffff:0:0/96) — unwrap and re-check as IPv4. Covers the
		// dotted-quad form and the compressed-hex form a naive regex would miss.
		const mapped = mappedIPv4(lower);
		if (mapped) return isBlockedIPv4(mapped);
		if (lower === '::1' || lower === '::') return true; // loopback / unspecified
		// fc00::/7 (unique-local: fc.. and fd..) and fe80::/10 (link-local).
		if (/^f[cd]/.test(lower)) return true;
		if (/^fe[89ab]/.test(lower)) return true;
		return false;
	}
	// Not a recognizable IP literal — treat as blocked (fail closed).
	return true;
}

/**
 * If `lower` (a lowercased IPv6 literal) is IPv4-mapped (::ffff:a.b.c.d), return
 * the embedded IPv4 in dotted-quad form; otherwise null. Handles both the dotted
 * tail (`::ffff:127.0.0.1`) and the fully-hex tail (`::ffff:7f00:1`).
 */
function mappedIPv4(lower: string): string | null {
	// Fast path: dotted tail.
	const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) return dotted[1];

	const groups = expandIPv6(lower);
	if (!groups) return null;
	// IPv4-mapped = first five hextets zero and the sixth 0xffff.
	if (groups[0] || groups[1] || groups[2] || groups[3] || groups[4]) return null;
	if (groups[5] !== 0xffff) return null;
	const hi = groups[6];
	const lo = groups[7];
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Expand an IPv6 literal (handling `::` and an optional dotted IPv4 tail) into
 *  its 8 numeric hextets, or null if it isn't a valid IPv6 address. */
function expandIPv6(lower: string): number[] | null {
	if (isIP(lower) !== 6) return null;
	let str = lower;

	// A trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) becomes two hextets.
	const v4 = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const o = v4[1].split('.').map(Number);
		if (o.some((n) => n < 0 || n > 255)) return null;
		const hextets = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
		str = str.slice(0, v4.index) + hextets;
	}

	const [head, tail, extra] = str.split('::');
	if (extra !== undefined) return null; // more than one "::"
	const headParts = head ? head.split(':') : [];
	const tailParts = tail ? tail.split(':') : [];
	const fill = 8 - headParts.length - tailParts.length;
	if (str.includes('::')) {
		if (fill < 0) return null;
	} else if (headParts.length !== 8) {
		return null;
	}
	const parts =
		str.includes('::')
			? [...headParts, ...Array(fill).fill('0'), ...tailParts]
			: headParts;
	const groups = parts.map((p) => (p === '' ? 0 : parseInt(p, 16)));
	if (groups.length !== 8 || groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
	return groups;
}

export function isBlockedIPv4(ip: string): boolean {
	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return true; // malformed — fail closed
	}
	const [a, b] = parts;
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 10) return true; // 10.0.0.0/8 private
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale) (cairn-pihb)
	if (a === 0) return true; // 0.0.0.0/8 "this host"
	return false;
}

/** Whether the admin has opted into private/LAN notification targets. */
export function allowPrivateTargets(): boolean {
	return getSetting('webhook_allow_private_targets') === 'true';
}

/** Result of the SSRF gate: an allowed URL plus the validated IPs to pin to, or
 *  a rejection reason. */
export type UrlCheck =
	| { ok: true; url: URL; addresses: { address: string; family: number }[] }
	| { ok: false; error: string };

/** Result of a bare-host SSRF check (no URL/scheme), e.g. a raw SMTP relay host. */
export type HostCheck =
	| { ok: true; addresses: { address: string; family: number }[] }
	| { ok: false; error: string };

/** Which URL schemes a checkTargetUrl call accepts. */
export type SchemeMode = 'http' | 'ws';

const ALLOWED_SCHEMES: Record<SchemeMode, ReadonlySet<string>> = {
	http: new Set(['http:', 'https:']),
	ws: new Set(['ws:', 'wss:'])
};

/**
 * Validate a bare HOST (no scheme) against the SSRF range policy: a literal IP is
 * checked directly, a hostname is resolved to every address and rejected if ANY
 * is blocked. This is the shared core of checkTargetUrl and the entry point for
 * targets that have no URL wrapper (per-user SMTP relay host — cairn-ruxo). The
 * admin escape hatch (allowPrivateTargets) applies here exactly as it does for
 * URLs. Returns the resolved+validated addresses so a caller may pin to them.
 */
export async function checkTargetHost(host: string): Promise<HostCheck> {
	// A literal IP host is checked directly (no DNS). URL wraps IPv6 in brackets.
	const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (isIP(literal)) {
		if (!allowPrivateTargets() && isBlockedAddress(literal)) {
			return { ok: false, error: `Blocked private/loopback address: ${literal}` };
		}
		return { ok: true, addresses: [{ address: literal, family: isIP(literal) }] };
	}

	// Hostname — resolve to every address once and reject if ANY is blocked.
	let addresses: { address: string; family: number }[];
	try {
		addresses = await dnsLookup(host, { all: true });
	} catch {
		return { ok: false, error: `Could not resolve host: ${host}` };
	}
	if (addresses.length === 0) {
		return { ok: false, error: `Could not resolve host: ${host}` };
	}
	if (!allowPrivateTargets()) {
		for (const { address } of addresses) {
			if (isBlockedAddress(address)) {
				return {
					ok: false,
					error: `Blocked private/loopback address: ${address} (resolved from ${host})`
				};
			}
		}
	}
	return { ok: true, addresses };
}

/**
 * Validate a target URL against the SSRF policy. Rejects any scheme outside the
 * caller's `scheme` mode (default 'http' = http:/https:; 'ws' = ws:/wss:); rejects
 * resolution to a blocked IP range unless the admin escape hatch is on. Returns
 * the resolved+validated addresses so http callers can pin to them.
 */
export async function checkTargetUrl(
	rawUrl: string,
	opts: { scheme?: SchemeMode } = {}
): Promise<UrlCheck> {
	const scheme = opts.scheme ?? 'http';
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, error: 'Invalid URL' };
	}

	if (!ALLOWED_SCHEMES[scheme].has(url.protocol)) {
		return { ok: false, error: `Unsupported URL scheme: ${url.protocol}` };
	}

	const hostCheck = await checkTargetHost(url.hostname);
	if (!hostCheck.ok) return hostCheck;
	return { ok: true, url, addresses: hostCheck.addresses };
}

/**
 * SSRF gate for a Nostr relay URL (ws:/wss:). Same range policy as checkTargetUrl,
 * but with the WebSocket scheme set and WITHOUT the pinned-socket TOCTOU defense
 * (see the WEBSOCKET note in the module header — nostr-tools opens its own socket
 * and re-resolves DNS). Callers must reject a non-ok result before connecting.
 */
export function checkRelayUrl(rawUrl: string): Promise<UrlCheck> {
	return checkTargetUrl(rawUrl, { scheme: 'ws' });
}

/** Minimal Response-like shape returned by safeFetch — the global fetch Response
 *  satisfies it structurally, so channels can treat both interchangeably. */
export interface SafeResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface SafeFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
}

/**
 * A single already-validated address to pin a connection to. Every address
 * checkTargetUrl returns has passed the range policy.
 */
type PinnedAddress = { address: string; family: number };

/**
 * Low-level pinned HTTP(S) request. Dials the ALREADY-VALIDATED IP directly
 * (`host: pinned.address`) so the hostname is never re-resolved at connect time —
 * this is what closes the DNS-rebinding TOCTOU. The original Host header and (for
 * https) the TLS `servername` are set to the real hostname, so virtual-hosting
 * and certificate identity validation are unaffected. Redirects are NOT followed
 * (there is no redirect handling here), so a 3xx cannot bounce past the gate.
 *
 * Kept on an overridable object (`_transport`) so tests can substitute a fake
 * transport instead of opening real sockets.
 */
function pinnedRequest(
	url: URL,
	pinned: PinnedAddress,
	init: SafeFetchInit
): Promise<SafeResponse> {
	const isHttps = url.protocol === 'https:';
	const requestFn = isHttps ? httpsRequest : httpRequest;
	const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	// url.host carries the port when non-default — the correct Host header value.
	headers.Host = url.host;

	return new Promise<SafeResponse>((resolve, reject) => {
		const req = requestFn(
			{
				host: pinned.address,
				port,
				method: init.method ?? 'GET',
				path: `${url.pathname}${url.search}`,
				headers,
				// SNI + the default cert-identity check both key off servername, so
				// TLS is verified against the real hostname, not the pinned IP.
				servername: isHttps ? url.hostname : undefined,
				timeout: init.timeoutMs ?? 10_000
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const status = res.statusCode ?? 0;
					const bodyText = Buffer.concat(chunks).toString('utf8');
					resolve({
						ok: status >= 200 && status < 300,
						status,
						text: async () => bodyText
					});
				});
				res.on('error', reject);
			}
		);
		req.on('timeout', () => req.destroy(new Error('Request timed out')));
		req.on('error', reject);
		if (init.body != null) req.write(init.body);
		req.end();
	});
}

/** Overridable transport seam (tests substitute a fake to avoid real sockets). */
export const _transport = { pinnedRequest };

/**
 * SSRF-safe fetch: runs the URL through checkTargetUrl (scheme + resolved-IP
 * policy) BEFORE issuing the request, then pins the connection to a validated IP
 * so DNS can't be rebound between check and connect (cairn-335b). Never follows
 * redirects. An SSRF/bad-scheme/unresolvable rejection throws an Error with
 * `.ssrf === true` (callers map that to non-retryable); a transport failure
 * throws a plain Error (retryable).
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeResponse> {
	const check = await checkTargetUrl(rawUrl);
	if (!check.ok) {
		const err = new Error(check.error) as Error & { ssrf: true };
		err.ssrf = true;
		throw err;
	}

	// Pin to the first validated address. Every returned address already passed
	// the range check, and dialing it by IP means DNS is never consulted again.
	return _transport.pinnedRequest(check.url, check.addresses[0], init);
}
