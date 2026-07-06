// Shared SSRF guard for notification channels that POST to a user-supplied URL
// (webhook, ntfy, …). Any server-side fetch to a user-controlled host is an SSRF
// surface: without a guard a user could aim Cairn at cloud metadata endpoints,
// LAN admin panels, or localhost. This module centralizes the policy so every
// outbound channel goes through the identical gate (cairn-iiuh).
//
// POLICY
//   • scheme MUST be http: or https:.
//   • the hostname is resolved to IPs, and EVERY resolved address is checked
//     against the blocked ranges below; a literal IP host is checked directly.
//   • the admin escape hatch `webhook_allow_private_targets === 'true'` (instance
//     setting, off by default) disables the range check for self-hosters who
//     legitimately POST to another service on their own LAN. It NEVER disables
//     the scheme check.
//
// NOTE ON DNS-REBINDING (TOCTOU) — cairn-335b (still open)
//   checkTargetUrl resolves every A/AAAA record and rejects if ANY is blocked,
//   which defeats the simple "one public + one private record" split. It does NOT
//   fully close the time-of-check/time-of-use gap: the platform `fetch` re-resolves
//   DNS at connect, so an attacker who flips their record between validation and
//   fetch can still slip through. Fully closing it requires pinning the socket to
//   the validated IP (a node:http transport), tracked separately in cairn-335b.

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

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

/**
 * Validate a target URL against the SSRF policy. Rejects non-http(s) schemes
 * always; rejects resolution to a blocked IP range unless the admin escape hatch
 * is on. Returns the resolved+validated addresses so callers can pin to them.
 */
export async function checkTargetUrl(rawUrl: string): Promise<UrlCheck> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, error: 'Invalid URL' };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: `Unsupported URL scheme: ${url.protocol}` };
	}

	const host = url.hostname;
	// A literal IP host is checked directly (no DNS). URL wraps IPv6 in brackets.
	const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (isIP(literal)) {
		if (!allowPrivateTargets() && isBlockedAddress(literal)) {
			return { ok: false, error: `Blocked private/loopback address: ${literal}` };
		}
		return { ok: true, url, addresses: [{ address: literal, family: isIP(literal) }] };
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
	return { ok: true, url, addresses };
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
 * SSRF-safe fetch: runs the URL through checkTargetUrl (scheme + resolved-IP
 * policy) BEFORE issuing the request, and never follows redirects so a 3xx can't
 * bounce past the gate. An SSRF/bad-scheme/unresolvable rejection throws an Error
 * with `.ssrf === true` (callers map that to non-retryable); a transport failure
 * throws a plain Error (retryable).
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeResponse> {
	const check = await checkTargetUrl(rawUrl);
	if (!check.ok) {
		const err = new Error(check.error) as Error & { ssrf: true };
		err.ssrf = true;
		throw err;
	}

	// Fetch the caller's original URL string (same target checkTargetUrl just
	// validated) so we don't surprise callers with URL normalization.
	return fetch(rawUrl, {
		method: init.method ?? 'GET',
		headers: init.headers,
		body: init.body,
		signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
		redirect: 'manual' // a 3xx must not bounce us past the SSRF check
	});
}
