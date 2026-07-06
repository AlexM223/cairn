// Single source of truth for redacting notification config before it reaches a
// client (cairn-ofna). The notification system stores two kinds of secret-bearing
// config:
//
//   • per-user, per-channel CONNECTION config (notification_channel_config) —
//     ntfy accessToken, webhook secret, personal-SMTP password. Redacted by
//     redactChannelConfig().
//   • instance-wide notification settings (the shared `settings` table) — SMTP
//     relay password, Telegram bot token. Redacted by
//     getPublicInstanceNotificationSettings().
//
// Before this module these were four independent hand-rolled redactors (the
// settings page loader, the channel API route, the admin API route, and the
// admin page loader), with nothing in the type system forcing a NEW secret field
// to be added to all of them. This module is the getPublicChannelConfig() the
// db.ts schema comment always promised — mirroring settings.ts's
// getPublicInstanceSettings()/hasCoreRpcPass pattern. Add a new secret field HERE
// and every call site inherits the redaction.

import { getSetting } from './settings';
import type { NotificationChannelId } from './notifyTypes';

/** Channels that carry per-user connection config (everything but in-app). */
export type ConfigurableChannel = Exclude<NotificationChannelId, 'inapp'>;

/**
 * Redact one channel's stored connection config for the browser: every secret
 * field becomes a presence boolean and the secret itself is dropped, so a form
 * can round-trip the config without ever receiving the secret (a blank submit
 * then means "keep the stored value"). Non-secret channels pass through
 * unchanged.
 */
export function redactChannelConfig(
	channel: ConfigurableChannel,
	cfg: Record<string, unknown>
): Record<string, unknown> {
	switch (channel) {
		case 'ntfy': {
			// accessTokenEnc is the encrypted-at-rest form; accessToken only appears
			// on legacy rows the startup migration hasn't rewritten yet.
			const { accessToken, accessTokenEnc, ...rest } = cfg;
			return { ...rest, hasAccessToken: !!(accessTokenEnc || accessToken) };
		}
		case 'webhook': {
			// secretEnc is the encrypted-at-rest form; secret only appears on legacy
			// rows the startup migration hasn't rewritten yet.
			const { secret, secretEnc, ...rest } = cfg;
			return { ...rest, hasSecret: !!(secretEnc || secret) };
		}
		case 'email': {
			// Personal SMTP: strip the encrypted password envelope, expose presence
			// only — same shape the settings form expects (smtp.hasPass).
			const { smtp, ...rest } = cfg;
			if (smtp && typeof smtp === 'object') {
				const { passEnc, ...smtpRest } = smtp as Record<string, unknown>;
				return { ...rest, smtp: { ...smtpRest, hasPass: !!passEnc } };
			}
			return cfg;
		}
		default:
			return cfg;
	}
}

/** The redacted instance-wide notification settings the shape both the admin API
 *  and the admin page loader return. */
export interface PublicInstanceNotificationSettings {
	smtpHost: string;
	smtpPort: string;
	smtpUser: string;
	smtpFrom: string;
	smtpTls: 'starttls' | 'tls' | 'none';
	hasSmtpPass: boolean;
	/** Always '' — the token is never serialized, only its presence flag is. */
	telegramBotToken: '';
	hasTelegramBotToken: boolean;
	ntfyDefaultServer: string;
	nostrDefaultRelays: string[];
	webhookAllowPrivateTargets: boolean;
}

function parseRelays(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

/**
 * Assemble the instance-wide notification settings safe to send to the client:
 * the SMTP relay password and Telegram bot token are replaced by presence flags
 * (hasSmtpPass / hasTelegramBotToken), mirroring getPublicInstanceSettings()'s
 * hasCoreRpcPass. The only place instance notification secrets are redacted.
 */
export function getPublicInstanceNotificationSettings(): PublicInstanceNotificationSettings {
	const tlsRaw = getSetting('smtp_tls') ?? 'starttls';
	const tls: 'starttls' | 'tls' | 'none' =
		tlsRaw === 'tls' || tlsRaw === 'none' ? tlsRaw : 'starttls';
	return {
		smtpHost: getSetting('smtp_host') ?? '',
		smtpPort: getSetting('smtp_port') ?? '587',
		smtpUser: getSetting('smtp_user') ?? '',
		smtpFrom: getSetting('smtp_from') ?? '',
		smtpTls: tls,
		hasSmtpPass: !!getSetting('smtp_pass'),
		telegramBotToken: '',
		hasTelegramBotToken: !!getSetting('telegram_bot_token'),
		ntfyDefaultServer: getSetting('ntfy_default_server') ?? '',
		nostrDefaultRelays: parseRelays(getSetting('nostr_default_relays')),
		webhookAllowPrivateTargets: getSetting('webhook_allow_private_targets') === 'true'
	};
}
