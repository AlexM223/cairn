// Telegram (Bot API) notification channel — docs/NOTIFICATION-PLAN.md §2.3.
//
// One bot for the whole instance (admin supplies the @BotFather token); each
// user supplies their own numeric chat id. Sends via plain HTTPS + JSON to
// api.telegram.org — no SDK dependency, just the platform `fetch`.
//
// Config storage:
//   • per-user → notification_channel_config, channel='telegram',
//                config = { "chatId": string }  (see TelegramChannelConfig)
//   • instance → settings key: telegram_bot_token
//
// Error mapping (ChannelSendResult.retryable):
//   • 401 (bad bot token) / 403 (user hasn't started the bot / blocked it) → retryable:false
//   • 429 (rate limited) → retryable:true (the queue can honour retry_after)
//   • 5xx / network error → retryable:true

import { db } from '../db';
import { childLogger } from '../logger';
import { getSetting, readSecretSetting } from '../settings';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';
import { absoluteNotificationLink } from '../notifyLinks';

const log = childLogger('notify:telegram');

const API_BASE = 'https://api.telegram.org';

/** Per-user config JSON stored in notification_channel_config.config. */
interface TelegramChannelConfig {
	/** Numeric Telegram chat id the bot will message. Stored as a string. */
	chatId?: string;
}

/** Escape the three characters Telegram's HTML parse_mode is sensitive to. */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The user's saved chat id (or null). */
function readChatId(userId: number): string | null {
	try {
		const row = db
			.prepare(
				`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'telegram'`
			)
			.get(userId) as { config: string } | undefined;
		if (!row) return null;
		const cfg = JSON.parse(row.config) as TelegramChannelConfig;
		const chatId = cfg.chatId?.trim();
		return chatId ? chatId : null;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read telegram channel config');
		return null;
	}
}

/** Render a payload into Telegram HTML: bold title, plain body, link appended. */
function renderMessage(payload: NotificationPayload): string {
	let text = `<b>${escapeHtml(payload.title)}</b>`;
	if (payload.body) text += `\n${escapeHtml(payload.body)}`;
	// Telegram only auto-links full URLs, so send the absolute form; a relative
	// path renders as inert text (cairn-5gpv.1). Omitted when CAIRN_ORIGIN is unset.
	const link = absoluteNotificationLink(payload.link);
	if (link) text += `\n${escapeHtml(link)}`;
	return text;
}

interface TelegramResponse {
	ok: boolean;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

/** POST sendMessage and map the outcome to a ChannelSendResult. */
async function callSendMessage(
	token: string,
	chatId: string,
	text: string
): Promise<ChannelSendResult> {
	let res: Response;
	try {
		res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: 'HTML',
				disable_web_page_preview: true
			})
		});
	} catch (err) {
		// Network-level failure (DNS, connection reset, timeout) — transient.
		log.warn({ err, chatId }, 'telegram request failed at network level');
		return { ok: false, error: (err as Error).message, retryable: true };
	}

	let bodyJson: TelegramResponse | null = null;
	try {
		bodyJson = (await res.json()) as TelegramResponse;
	} catch {
		bodyJson = null;
	}

	if (res.ok && bodyJson?.ok) return { ok: true };

	const code = bodyJson?.error_code ?? res.status;
	const description = bodyJson?.description ?? `HTTP ${res.status}`;

	if (code === 401 || code === 403) {
		return { ok: false, error: description, retryable: false };
	}
	if (code === 429) {
		const retryAfter = bodyJson?.parameters?.retry_after;
		const suffix = retryAfter ? ` (retry after ${retryAfter}s)` : '';
		return { ok: false, error: `Rate limited${suffix}`, retryable: true };
	}
	// 5xx and anything else transient-looking.
	log.warn({ code, description, chatId }, 'telegram send failed');
	return { ok: false, error: description, retryable: true };
}

/** Read the bot token + user's chat id, or return a terminal config error. */
function preflight(userId: number): { token: string; chatId: string } | ChannelSendResult {
	const token = readSecretSetting('telegram_bot_token');
	if (!token) {
		return { ok: false, error: 'Telegram is not configured on this instance.', retryable: false };
	}
	const chatId = readChatId(userId);
	if (!chatId) {
		return { ok: false, error: 'No Telegram chat id configured.', retryable: false };
	}
	return { token, chatId };
}

const telegramChannel: NotificationChannelPlugin = {
	id: 'telegram',
	label: 'Telegram',

	/** Configured when the instance has a bot token AND this user has a chat id. */
	isConfigured(userId: number): boolean {
		return readSecretSetting('telegram_bot_token') !== null && readChatId(userId) !== null;
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		const pre = preflight(userId);
		if ('ok' in pre) return pre;
		return callSendMessage(pre.token, pre.chatId, renderMessage(payload));
	},

	async test(userId: number): Promise<ChannelSendResult> {
		const pre = preflight(userId);
		if ('ok' in pre) return pre;
		const result = await callSendMessage(
			pre.token,
			pre.chatId,
			'✅ Heartwood is connected to Telegram.'
		);
		// The single most common real-world test failure: the user hasn't pressed
		// Start on the bot yet, so Telegram returns 403. Give a friendly nudge.
		if (!result.ok && result.retryable === false) {
			return {
				...result,
				error: 'Message your bot first (press Start in Telegram), then try again.'
			};
		}
		return result;
	}
};

export default telegramChannel;
