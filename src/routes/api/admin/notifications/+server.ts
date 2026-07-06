// Admin instance-wide notification config (§5): SMTP relay, Telegram bot token,
// ntfy default server, Nostr default relays, and the webhook SSRF escape-hatch
// toggle. All persisted to the shared `settings` table via setSetting, following
// the exact naming convention in §1.2. Secrets (smtp_pass, telegram_bot_token)
// are never echoed back — GET exposes hasSmtpPass / hasTelegramBotToken booleans
// the same way admin/settings redacts the Core RPC password.

import { json, readJson, requireAdmin } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { getSetting, setSetting, setSecretSetting } from '$lib/server/settings';
import { getPublicInstanceNotificationSettings } from '$lib/server/notifyConfig';
import { notify } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

const log = childLogger('notify:admin-api');

// Instance-settings redaction is shared with the admin page loader via
// notifyConfig.ts (cairn-ofna) — one place to add a new secret field.
const publicNotificationSettings = getPublicInstanceNotificationSettings;

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
	const admin = requireAdmin(event);
	const body = await readJson<Record<string, unknown>>(event);
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

	// Snapshot the security-relevant SSRF escape-hatch before the save so we can
	// alert other admins if it flips (cairn-5gpv.8). Turning
	// webhook_allow_private_targets ON lets webhooks reach private/internal network
	// targets — a change other admins on a multi-admin instance should be pushed,
	// not left to discover in /admin/logs.
	const prevAllowPrivate = getSetting('webhook_allow_private_targets') === 'true';

	// Cross-field guard (cairn-es32): refuse smtp_tls='none' when SMTP credentials
	// are (or remain) configured — nodemailer would send AUTH and the message body
	// in cleartext. Compute the EFFECTIVE values this save would leave in place
	// (present-in-body wins; secrets: clear flag > provided > stored) and reject
	// the unsafe combination before persisting anything.
	const effectiveTls = 'smtpTls' in body ? str(body.smtpTls) : (getSetting('smtp_tls') ?? 'starttls');
	const effectiveUser = 'smtpUser' in body ? str(body.smtpUser) : (getSetting('smtp_user') ?? '');
	const effectivePass =
		body.clearSmtpPass === true
			? ''
			: str(body.smtpPass) !== ''
				? str(body.smtpPass)
				: (getSetting('smtp_pass') ?? '');
	if (effectiveTls === 'none' && (effectiveUser !== '' || effectivePass !== '')) {
		return json(
			{
				error:
					'Refusing TLS mode "none" while SMTP credentials are set — that would send your username, password, and message content in cleartext. Use STARTTLS or TLS, or clear the SMTP username/password first.'
			},
			{ status: 400 }
		);
	}

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
		// Secrets: blank = keep; explicit clear flag = wipe. New values are stored
		// encrypted at rest (cairn-e9mz.3); '' clears via the same helper.
		if (body.clearSmtpPass === true) setSecretSetting('smtp_pass', '');
		else if (str(body.smtpPass) !== '') setSecretSetting('smtp_pass', str(body.smtpPass));

		if (body.clearTelegramBotToken === true) setSecretSetting('telegram_bot_token', '');
		else if (str(body.telegramBotToken) !== '')
			setSecretSetting('telegram_bot_token', str(body.telegramBotToken));

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

	// Broadcast a security-relevant settings change to every admin (cairn-5gpv.8):
	// only when the webhook SSRF allow-list actually FLIPPED (not on every save, to
	// avoid nagging an admin editing their own SMTP fields). Best-effort.
	if ('webhookAllowPrivateTargets' in body) {
		const nowAllowPrivate = body.webhookAllowPrivateTargets === true;
		if (nowAllowPrivate !== prevAllowPrivate) {
			const actor = admin.displayName || admin.email || 'An admin';
			notify({
				type: 'admin_settings_changed',
				userId: null,
				level: 'warn',
				title: 'Webhook network policy changed',
				body: nowAllowPrivate
					? `${actor} allowed webhooks to reach private/internal network targets. This relaxes SSRF protection for all users.`
					: `${actor} restored the block on webhooks reaching private/internal network targets.`,
				detail: { setting: 'webhook_allow_private_targets', value: nowAllowPrivate },
				link: '/admin/notifications'
			});
		}
	}

	return json({ settings: publicNotificationSettings() });
};
