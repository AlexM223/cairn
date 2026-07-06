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

import { db } from '../db';
import { childLogger } from '../logger';
import {
	checkTargetUrl,
	isBlockedAddress,
	isBlockedIPv4,
	safeFetch,
	type SafeResponse
} from './ssrf';
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
	// Serialize ONCE and sign those exact bytes, so the HMAC matches what we send.
	const rawBody = JSON.stringify(body);
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.secret) {
		const signature = createHmac('sha256', config.secret).update(rawBody, 'utf8').digest('hex');
		headers['X-Cairn-Signature'] = `sha256=${signature}`;
	}

	// safeFetch runs the SSRF gate and pins the socket to a validated IP (no
	// rebinding window). An SSRF/bad-scheme/unresolvable rejection throws with
	// `.ssrf` and is never fixed by retrying; any other throw is transport-level.
	let response: SafeResponse;
	try {
		response = await safeFetch(config.url, {
			method: 'POST',
			headers,
			body: rawBody,
			timeoutMs: REQUEST_TIMEOUT_MS
		});
	} catch (e) {
		if ((e as { ssrf?: boolean }).ssrf) {
			log.warn({ reason: (e as Error).message }, 'webhook target rejected');
			return { ok: false, error: (e as Error).message, retryable: false };
		}
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
