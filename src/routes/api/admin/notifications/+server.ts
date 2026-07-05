// Admin instance-wide notification config (§5): SMTP relay, Telegram bot token,
// ntfy default server, Nostr default relays, and the webhook SSRF escape-hatch
// toggle. All persisted to the shared `settings` table via setSetting, following
// the exact naming convention in §1.2. Secrets (smtp_pass, telegram_bot_token)
// are never echoed back — GET exposes hasSmtpPass / hasTelegramBotToken booleans
// the same way admin/settings redacts the Core RPC password.

import { json, readJson, requireAdmin } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { getSetting, setSetting } from '$lib/server/settings';
import type { RequestHandler } from './$types';

const log = childLogger('notify:admin-api');

/** Assemble the redacted instance notification settings for the client. */
function publicNotificationSettings() {
	const relaysRaw = getSetting('nostr_default_relays');
	let relays: string[] = [];
	if (relaysRaw) {
		try {
			const v = JSON.parse(relaysRaw);
			if (Array.isArray(v)) relays = v.map(String);
		} catch {
			relays = [];
		}
	}
	return {
		smtpHost: getSetting('smtp_host') ?? '',
		smtpPort: getSetting('smtp_port') ?? '587',
		smtpUser: getSetting('smtp_user') ?? '',
		smtpFrom: getSetting('smtp_from') ?? '',
		smtpTls: (getSetting('smtp_tls') ?? 'starttls') as 'starttls' | 'tls' | 'none',
		hasSmtpPass: !!getSetting('smtp_pass'),
		telegramBotToken: '', // never sent to the client
		hasTelegramBotToken: !!getSetting('telegram_bot_token'),
		ntfyDefaultServer: getSetting('ntfy_default_server') ?? '',
		nostrDefaultRelays: relays,
		webhookAllowPrivateTargets: getSetting('webhook_allow_private_targets') === 'true'
	};
}

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ settings: publicNotificationSettings() });
};

const TLS_MODES = new Set(['starttls', 'tls', 'none']);

/**
 * POST /api/admin/notifications — save instance notification settings. Only the
 * keys present in the body are touched. Blank secret fields are ignored (keep
 * the stored value); an explicit clearSmtpPass / clearTelegramBotToken flag wipes.
 */
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<Record<string, unknown>>(event);
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

	try {
		if ('smtpHost' in body) setSetting('smtp_host', str(body.smtpHost));
		if ('smtpPort' in body) {
			const port = Number(body.smtpPort);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				return json({ error: 'SMTP port must be between 1 and 65535.' }, { status: 400 });
			}
			setSetting('smtp_port', String(port));
		}
		if ('smtpUser' in body) setSetting('smtp_user', str(body.smtpUser));
		if ('smtpFrom' in body) {
			const from = str(body.smtpFrom);
			if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
				return json({ error: 'From address must be a valid email.' }, { status: 400 });
			}
			setSetting('smtp_from', from);
		}
		if ('smtpTls' in body) {
			const mode = str(body.smtpTls);
			if (!TLS_MODES.has(mode)) return json({ error: 'Invalid TLS mode.' }, { status: 400 });
			setSetting('smtp_tls', mode);
		}
		// Secrets: blank = keep; explicit clear flag = wipe.
		if (body.clearSmtpPass === true) setSetting('smtp_pass', '');
		else if (str(body.smtpPass) !== '') setSetting('smtp_pass', str(body.smtpPass));

		if (body.clearTelegramBotToken === true) setSetting('telegram_bot_token', '');
		else if (str(body.telegramBotToken) !== '') setSetting('telegram_bot_token', str(body.telegramBotToken));

		if ('ntfyDefaultServer' in body) {
			const server = str(body.ntfyDefaultServer);
			if (server && !/^https?:\/\//i.test(server)) {
				return json({ error: 'ntfy server must start with http:// or https://.' }, { status: 400 });
			}
			setSetting('ntfy_default_server', server.replace(/\/+$/, ''));
		}
		if ('nostrDefaultRelays' in body) {
			const relays = Array.isArray(body.nostrDefaultRelays)
				? body.nostrDefaultRelays.map(String).map((r) => r.trim()).filter(Boolean)
				: [];
			for (const r of relays) {
				if (!/^wss?:\/\//i.test(r)) {
					return json({ error: `Relay "${r}" must start with wss:// or ws://.` }, { status: 400 });
				}
			}
			setSetting('nostr_default_relays', JSON.stringify(relays));
		}
		if ('webhookAllowPrivateTargets' in body) {
			setSetting('webhook_allow_private_targets', body.webhookAllowPrivateTargets === true ? 'true' : 'false');
		}
	} catch (e) {
		log.error({ err: e }, 'failed to save admin notification settings');
		return json({ error: 'Could not save settings.' }, { status: 500 });
	}

	return json({ settings: publicNotificationSettings() });
};
