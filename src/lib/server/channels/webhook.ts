// Webhook channel — generic HTTP POST to a user-supplied URL.
// See docs/NOTIFICATION-PLAN.md §2.6 (Unit 7).
//
// WHAT THIS DOES
//   Delivers a notification as a JSON POST to a URL the user configured. This is
//   the escape hatch for arbitrary integrations (a personal script, a Discord/
//   Slack relay, a home-automation hook, …).
//
// REQUEST FORMAT
//   POST <url>
//   Content-Type: application/json
//   Body (exact field order not significant; shape is stable):
//     {
//       "type":      "tx_received",             // NotificationEventType (or "test")
//       "level":     "info",                    // info | success | warn | error
//       "title":     "Payment received",
//       "body":      "0.015 BTC received to Savings",
//       "detail":    { "amountSats": 1500000 }, // structured, NON-SECRET (may be null)
//       "link":      "/wallets/3",              // relative deep-link (may be null)
//       "timestamp": "2026-07-05T12:00:00.000Z" // ISO-8601, when the POST was built
//     }
//
// SIGNATURE (HMAC) — how a receiver verifies the POST really came from Cairn
//   If the user set a `secret`, we add a header:
//     X-Cairn-Signature: sha256=<hex>
//   where <hex> is the lowercase hex HMAC-SHA-256 of the RAW request body BYTES
//   (the exact UTF-8 bytes we send — sign the serialized string, do not
//   re-serialize on the receiving end before comparing), keyed by `secret`:
//     node:crypto.createHmac('sha256', secret).update(rawBodyBytes).digest('hex')
//   This is the same construction GitHub and Stripe use. To verify, the receiver
//   recomputes the HMAC over the raw body it received and compares in constant
//   time against the header value (after the `sha256=` prefix).
//
// SSRF GUARD (this unit's responsibility — see review note in §2.6)
//   `url` is fully user-supplied and this code runs server-side, so a naive
//   fetch would let a user aim Cairn at internal services (cloud metadata
//   endpoints, LAN admin panels, localhost). We validate at send time:
//     • scheme MUST be http: or https: — everything else is rejected.
//     • the hostname is resolved to IPs, and EVERY resolved address is checked
//       against the blocked ranges below. A literal IP in the URL is checked
//       directly (no DNS needed).
//   Blocked ranges (rejected unless the admin opted in):
//     IPv4  127.0.0.0/8      loopback
//           10.0.0.0/8       private
//           172.16.0.0/12    private
//           192.168.0.0/16   private
//           169.254.0.0/16   link-local (incl. cloud metadata 169.254.169.254)
//           0.0.0.0/8        "this host"
//     IPv6  ::1              loopback
//           ::               unspecified
//           fc00::/7         unique-local
//           fe80::/10        link-local
//           ::ffff:a.b.c.d   IPv4-mapped — unwrapped and re-checked as IPv4
//   The admin escape hatch `webhook_allow_private_targets === 'true'` (instance
//   setting, off by default) disables the range check for self-hosters who
//   legitimately POST to another service on their own LAN. It never disables the
//   scheme check. An SSRF rejection is retryable:false — no amount of retrying
//   fixes a URL pointed at 127.0.0.1.

import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { db } from '../db';
import { childLogger } from '../logger';
import { getSetting } from '../settings';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const log = childLogger('notify:webhook');

/** Abort a webhook POST that hasn't responded in this long (transient failure). */
const REQUEST_TIMEOUT_MS = 10_000;

interface WebhookUserConfig {
	url: string;
	secret?: string;
}

/** The exact JSON body shape we POST (documented in the file header). */
interface WebhookBody {
	type: string;
	level: string;
	title: string;
	body: string;
	detail: Record<string, unknown> | null;
	link: string | null;
	timestamp: string;
}

/** Read + parse a user's saved webhook config row. Returns null if absent/invalid. */
function readUserConfig(userId: number): WebhookUserConfig | null {
	let raw: string | undefined;
	try {
		const row = db
			.prepare(
				`SELECT config FROM notification_channel_config
				  WHERE user_id = ? AND channel = 'webhook'`
			)
			.get(userId) as { config: string } | undefined;
		raw = row?.config;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read webhook channel config');
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<WebhookUserConfig>;
		if (!parsed || typeof parsed.url !== 'string' || parsed.url.trim().length === 0) return null;
		const secret =
			typeof parsed.secret === 'string' && parsed.secret.length > 0 ? parsed.secret : undefined;
		return { url: parsed.url.trim(), secret };
	} catch (e) {
		log.error({ err: e, userId }, 'webhook channel config is not valid JSON');
		return null;
	}
}

/**
 * Is `ip` (a numeric IPv4 or IPv6 literal) inside a blocked private/loopback/
 * link-local range? IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped first.
 */
function isBlockedAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return isBlockedIPv4(ip);
	if (family === 6) {
		const lower = ip.toLowerCase();
		// IPv4-mapped IPv6 — unwrap and re-check as IPv4.
		const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isBlockedIPv4(mapped[1]);
		if (lower === '::1' || lower === '::') return true; // loopback / unspecified
		// fc00::/7 (unique-local: fc.. and fd..) and fe80::/10 (link-local).
		if (/^f[cd]/.test(lower)) return true;
		if (/^fe[89ab]/.test(lower)) return true;
		return false;
	}
	// Not a recognizable IP literal — treat as blocked (fail closed).
	return true;
}

function isBlockedIPv4(ip: string): boolean {
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

/** Result of the SSRF gate: either an allowed parsed URL, or a rejection reason. */
type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Validate a webhook target URL against the SSRF policy. Rejects non-http(s)
 * schemes always; rejects resolution to a blocked IP range unless the admin
 * escape hatch is on. Performs DNS resolution (async) for hostnames.
 */
async function checkTargetUrl(rawUrl: string): Promise<UrlCheck> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, error: 'Invalid URL' };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: `Unsupported URL scheme: ${url.protocol}` };
	}

	const allowPrivate = getSetting('webhook_allow_private_targets') === 'true';
	if (allowPrivate) return { ok: true, url };

	const host = url.hostname;

	// A literal IP host is checked directly (no DNS). URL wraps IPv6 in brackets.
	const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (isIP(literal)) {
		if (isBlockedAddress(literal)) {
			return { ok: false, error: `Blocked private/loopback address: ${literal}` };
		}
		return { ok: true, url };
	}

	// Hostname — resolve to every address and reject if ANY is blocked. Checking
	// all results (not just the first) avoids a DNS-rebinding-style bypass where
	// one A record is public and another is internal.
	let addresses: { address: string }[];
	try {
		addresses = await lookup(host, { all: true });
	} catch (e) {
		log.warn({ err: e, host }, 'DNS resolution failed for webhook target');
		return { ok: false, error: `Could not resolve host: ${host}` };
	}
	if (addresses.length === 0) {
		return { ok: false, error: `Could not resolve host: ${host}` };
	}
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) {
			return {
				ok: false,
				error: `Blocked private/loopback address: ${address} (resolved from ${host})`
			};
		}
	}
	return { ok: true, url };
}

/** Build the exact JSON body we POST for a given payload/type. */
function buildBody(payload: NotificationPayload, typeOverride?: string): WebhookBody {
	return {
		type: typeOverride ?? payload.type,
		level: payload.level,
		title: payload.title,
		body: payload.body,
		detail: payload.detail ?? null,
		link: payload.link ?? null,
		timestamp: new Date().toISOString()
	};
}

/**
 * POST a body to a validated URL, signing it if a secret is present. Shared by
 * send() and test() so both go through the identical SSRF gate + signing path.
 */
async function postWebhook(
	config: WebhookUserConfig,
	body: WebhookBody
): Promise<ChannelSendResult> {
	const check = await checkTargetUrl(config.url);
	if (!check.ok) {
		// SSRF / bad-scheme / unresolvable — none of these are fixed by retrying.
		log.warn({ reason: check.error }, 'webhook target rejected');
		return { ok: false, error: check.error, retryable: false };
	}

	// Serialize ONCE and sign those exact bytes, so the HMAC matches what we send.
	const rawBody = JSON.stringify(body);
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.secret) {
		const signature = createHmac('sha256', config.secret).update(rawBody, 'utf8').digest('hex');
		headers['X-Cairn-Signature'] = `sha256=${signature}`;
	}

	let response: Response;
	try {
		response = await fetch(check.url.toString(), {
			method: 'POST',
			headers,
			body: rawBody,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: 'manual' // don't let a 3xx bounce us past the SSRF check
		});
	} catch (e) {
		// Network error / timeout — transient, worth a retry.
		log.warn({ err: e }, 'webhook POST failed at the transport level');
		return { ok: false, error: `Request failed: ${(e as Error).message}`, retryable: true };
	}

	if (response.status >= 200 && response.status < 300) {
		return { ok: true };
	}
	// Any non-2xx → retryable (webhook receivers are often flaky scripts). The
	// queue caps total attempts, so this can't loop forever.
	log.warn({ status: response.status }, 'webhook POST returned non-2xx');
	return { ok: false, error: `HTTP ${response.status}`, retryable: true };
}

const webhookChannel: NotificationChannelPlugin = {
	id: 'webhook',
	label: 'Webhook',

	isConfigured(userId: number): boolean {
		const config = readUserConfig(userId);
		if (!config) return false;
		// Cheap sync validity check only — the full SSRF/DNS gate runs at send time.
		try {
			const proto = new URL(config.url).protocol;
			return proto === 'http:' || proto === 'https:';
		} catch {
			return false;
		}
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		const config = readUserConfig(userId);
		if (!config) {
			return { ok: false, error: 'Webhook channel not configured', retryable: false };
		}
		return postWebhook(config, buildBody(payload));
	},

	async test(userId: number): Promise<ChannelSendResult> {
		const config = readUserConfig(userId);
		if (!config) {
			return { ok: false, error: 'Webhook channel not configured', retryable: false };
		}
		const testPayload: NotificationPayload = {
			type: 'tx_received', // overridden to 'test' in the body below
			userId,
			level: 'info',
			title: 'Cairn test notification',
			body: 'If you received this, your webhook is working.',
			detail: { test: true }
		};
		const result = await postWebhook(config, buildBody(testPayload, 'test'));
		// test() reports the HTTP status verbatim so the user can debug their
		// own endpoint. On a non-2xx, `error` already carries "HTTP <status>".
		return result;
	}
};

/** Exposed for tests only — never import these from application code. */
export const _internals = {
	readUserConfig,
	checkTargetUrl,
	isBlockedAddress,
	isBlockedIPv4,
	buildBody,
	REQUEST_TIMEOUT_MS
};

export default webhookChannel;
