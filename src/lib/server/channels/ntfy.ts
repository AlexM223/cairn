// ntfy (self-hosted push) notification channel — docs/NOTIFICATION-PLAN.md §2.4.
//
// ntfy is inherently decentralized: a "topic" is just a URL path segment with no
// registration step, and the server can be ntfy.sh or the operator's own box.
// Sends via a plain JSON HTTP POST — no SDK, just the platform `fetch`.
//
// Config storage:
//   • per-user → notification_channel_config, channel='ntfy',
//                config = { "server"?: string, "topic": string, "accessToken"?: string }
//                (see NtfyChannelConfig). `server` defaults to the instance
//                setting `ntfy_default_server` when the user leaves it blank.
//   • instance → settings key: ntfy_default_server (a UI-convenience default only)
//
// Priority mapping (payload.level → ntfy 1..5):
//   error → 5 (max), warn → 4, info/success → 3 (default)
//
// Error mapping (ChannelSendResult.retryable):
//   • 401 / 403 (bad access token or topic ACL) → retryable:false
//   • anything else (incl. the user's own ntfy box briefly down) → retryable:true

import { db } from '../db';
import { childLogger } from '../logger';
import { getSetting } from '../settings';
import { safeFetch, type SafeResponse } from './ssrf';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationLevel,
	NotificationPayload
} from '../notifyTypes';
import { absoluteNotificationLink } from '../notifyLinks';

const log = childLogger('notify:ntfy');

/** Per-user config JSON stored in notification_channel_config.config. */
interface NtfyChannelConfig {
	/** ntfy server base URL; falls back to `ntfy_default_server` when blank. */
	server?: string;
	/** Topic (URL path segment) to publish to. Required. */
	topic?: string;
	/** Optional bearer token for an access-controlled topic. */
	accessToken?: string;
}

interface ResolvedNtfyConfig {
	server: string;
	topic: string;
	accessToken?: string;
}

/** ntfy priority (1..5) for a notification level. */
function priorityForLevel(level: NotificationLevel): number {
	if (level === 'error') return 5;
	if (level === 'warn') return 4;
	return 3;
}

/** Assemble the effective ntfy config: per-user row + instance default server. */
function resolveConfig(userId: number): ResolvedNtfyConfig | null {
	let cfg: NtfyChannelConfig;
	try {
		const row = db
			.prepare(
				`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'ntfy'`
			)
			.get(userId) as { config: string } | undefined;
		if (!row) return null;
		cfg = JSON.parse(row.config) as NtfyChannelConfig;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read ntfy channel config');
		return null;
	}

	const topic = cfg.topic?.trim();
	if (!topic) return null;

	const server = (cfg.server?.trim() || getSetting('ntfy_default_server') || '').trim();
	if (!server) return null;

	const accessToken = cfg.accessToken?.trim();
	return { server, topic, accessToken: accessToken || undefined };
}

/** Strip a trailing slash so `${server}` + JSON body posts to the root cleanly. */
function normalizeServer(server: string): string {
	return server.replace(/\/+$/, '');
}

/** POST the JSON publish body and map the outcome. */
async function publish(
	cfg: ResolvedNtfyConfig,
	payload: NotificationPayload
): Promise<ChannelSendResult> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (cfg.accessToken) headers.authorization = `Bearer ${cfg.accessToken}`;

	const body: Record<string, unknown> = {
		topic: cfg.topic,
		title: payload.title,
		message: payload.body,
		priority: priorityForLevel(payload.level)
	};
	// ntfy's `click` action opens a browser and expects an ABSOLUTE URL; a
	// relative path is undefined behavior (cairn-5gpv.1). Omitted when unset.
	const link = absoluteNotificationLink(payload.link);
	if (link) body.click = link;

	// safeFetch enforces the SSRF policy on the user-supplied `server` URL and
	// pins the socket to a validated IP (cairn-iiuh, cairn-335b): a user could
	// otherwise aim ntfy at cloud metadata / LAN / localhost. An SSRF rejection
	// throws with `.ssrf` and is not retryable.
	let res: SafeResponse;
	try {
		res = await safeFetch(normalizeServer(cfg.server), {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		});
	} catch (err) {
		if ((err as { ssrf?: boolean }).ssrf) {
			log.warn({ reason: (err as Error).message, topic: cfg.topic }, 'ntfy target rejected by SSRF guard');
			return { ok: false, error: (err as Error).message, retryable: false };
		}
		// Network-level failure — the user's own ntfy box being briefly down is
		// exactly the transient case retries exist for.
		log.warn({ err, topic: cfg.topic }, 'ntfy request failed at network level');
		return { ok: false, error: (err as Error).message, retryable: true };
	}

	if (res.ok) return { ok: true };

	let detail = `HTTP ${res.status}`;
	try {
		const text = await res.text();
		if (text) detail = text.slice(0, 500);
	} catch {
		// Body already consumed or unavailable — the status line is enough.
	}

	if (res.status === 401 || res.status === 403) {
		return { ok: false, error: detail, retryable: false };
	}
	log.warn({ status: res.status, topic: cfg.topic }, 'ntfy publish failed');
	return { ok: false, error: detail, retryable: true };
}

const ntfyChannel: NotificationChannelPlugin = {
	id: 'ntfy',
	label: 'ntfy',

	/** Configured when we can resolve a server + topic for this user. */
	isConfigured(userId: number): boolean {
		return resolveConfig(userId) !== null;
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		const cfg = resolveConfig(userId);
		if (!cfg) return { ok: false, error: 'ntfy is not configured.', retryable: false };
		return publish(cfg, payload);
	},

	async test(userId: number): Promise<ChannelSendResult> {
		const cfg = resolveConfig(userId);
		if (!cfg) return { ok: false, error: 'ntfy is not configured.', retryable: false };
		return publish(cfg, {
			type: 'admin_server_health',
			userId,
			level: 'info',
			title: 'Cairn test notification',
			body: 'This is a test notification from Cairn. ntfy is connected.'
		});
	}
};

export default ntfyChannel;
