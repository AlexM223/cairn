// GET/PUT the signed-in user's per-channel CONNECTION config
// (notification_channel_config). This is the "how do I reach you on this
// channel" config (email address, Telegram chat id, ntfy topic, ...), distinct
// from the routing rules in /api/notifications/preferences.
//
// Config is stored as a per-channel JSON blob (shapes documented in §2 of
// docs/NOTIFICATION-PLAN.md). Anything sensitive (ntfy accessToken, webhook
// secret) is REDACTED on GET the same way the Core RPC password is — the client
// gets a hasAccessToken / hasSecret boolean and an empty string for the field;
// an empty submit means "keep the stored value" so an untouched field can't
// wipe it.

import { json, readJson, requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { childLogger } from '$lib/server/logger';
import { getSetting } from '$lib/server/settings';
import { encryptSecret } from '$lib/server/secretKey';
import type { NotificationChannelId } from '$lib/server/notifyTypes';
import type { RequestHandler } from './$types';

const log = childLogger('notify:channel-cfg-api');

// Channels that carry user-side connection config. in-app has none (always on).
type ConfigurableChannel = Exclude<NotificationChannelId, 'inapp'>;
const CONFIGURABLE = new Set<string>(['email', 'telegram', 'ntfy', 'nostr', 'webhook']);

function isConfigurable(c: string): c is ConfigurableChannel {
	return CONFIGURABLE.has(c);
}

interface ConfigRow {
	config: string;
	verified_at: string | null;
}

function readStoredConfig(userId: number, channel: string): Record<string, unknown> {
	const row = db
		.prepare('SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = ?')
		.get(userId, channel) as Pick<ConfigRow, 'config'> | undefined;
	if (!row) return {};
	try {
		const v = JSON.parse(row.config);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Redact a stored config for the client. Secrets become presence booleans; the
 * field itself is blanked so the form never round-trips a secret to the browser.
 */
function redactForClient(channel: ConfigurableChannel, cfg: Record<string, unknown>) {
	switch (channel) {
		case 'ntfy': {
			const { accessToken, ...rest } = cfg;
			return { ...rest, hasAccessToken: !!accessToken };
		}
		case 'webhook': {
			const { secret, ...rest } = cfg;
			return { ...rest, hasSecret: !!secret };
		}
		case 'email': {
			// Personal SMTP: strip the encrypted password envelope, expose presence
			// only — same pattern as ntfy/webhook above.
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

/**
 * GET /api/notifications/channels/:channel — the caller's redacted config for
 * this channel, its verified_at timestamp, plus the instance-wide default the
 * UI should pre-fill (email address default, ntfy default server, Nostr default
 * relays) so a fresh account reads as "here's what you can turn on".
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const channel = event.params.channel;
	if (!isConfigurable(channel)) {
		return json({ error: `Unknown channel: ${channel}` }, { status: 404 });
	}

	const row = db
		.prepare('SELECT config, verified_at FROM notification_channel_config WHERE user_id = ? AND channel = ?')
		.get(user.id, channel) as ConfigRow | undefined;

	const stored = row ? safeParse(row.config) : {};
	const config = redactForClient(channel, stored);

	// Instance defaults the UI shows as placeholders / pre-fills.
	const defaults: Record<string, unknown> = {};
	if (channel === 'email') defaults.address = user.email;
	if (channel === 'ntfy') defaults.server = getSetting('ntfy_default_server') ?? '';
	if (channel === 'nostr') {
		const raw = getSetting('nostr_default_relays');
		defaults.relays = raw ? safeParseArray(raw) : [];
	}

	return json({
		config,
		verifiedAt: row?.verified_at ?? null,
		configured: !!row,
		defaults
	});
};

/**
 * PUT /api/notifications/channels/:channel — save the caller's connection config
 * for this channel. Body is the per-channel shape from §2; secret fields left
 * blank/absent keep the stored value. Basic per-channel validation only — the
 * plugin's own send() does the authoritative checks.
 */
export const PUT: RequestHandler = async (event) => {
	const user = requireUser(event);
	const channel = event.params.channel;
	if (!isConfigurable(channel)) {
		return json({ error: `Unknown channel: ${channel}` }, { status: 404 });
	}

	const body = await readJson<Record<string, unknown>>(event);
	const prev = readStoredConfig(user.id, channel);

	let config: Record<string, unknown>;
	try {
		config = buildConfig(channel, body, prev);
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'Invalid config.' }, { status: 400 });
	}

	try {
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config, updated_at)
			 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			 ON CONFLICT(user_id, channel)
			 DO UPDATE SET config = excluded.config,
			               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
		).run(user.id, channel, JSON.stringify(config));
	} catch (e) {
		log.error({ err: e, userId: user.id, channel }, 'failed to save channel config');
		return json({ error: 'Could not save this channel.' }, { status: 500 });
	}

	return json({ config: redactForClient(channel as ConfigurableChannel, config), configured: true });
};

/** DELETE /api/notifications/channels/:channel — disconnect this channel. */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const channel = event.params.channel;
	if (!isConfigurable(channel)) {
		return json({ error: `Unknown channel: ${channel}` }, { status: 404 });
	}
	db.prepare('DELETE FROM notification_channel_config WHERE user_id = ? AND channel = ?').run(
		user.id,
		channel
	);
	return json({ configured: false });
};

function safeParse(raw: string): Record<string, unknown> {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function safeParseArray(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

const HTTP_RE = /^https?:\/\//i;

/**
 * Validate + assemble the stored JSON for one channel. `prev` supplies the
 * kept-when-blank value for secret fields. Throws with a user-facing message on
 * invalid input.
 */
function buildConfig(
	channel: ConfigurableChannel,
	body: Record<string, unknown>,
	prev: Record<string, unknown>
): Record<string, unknown> {
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
	switch (channel) {
		case 'email': {
			const address = str(body.address);
			if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
				throw new Error('Enter a valid email address.');

			const cfg: Record<string, unknown> = {};
			if (address) cfg.address = address;

			// Personal SMTP (additive, optional). Precedence:
			//   clearSmtp:true      → drop personal SMTP (keep address)
			//   body.smtp present   → validate + save it (encrypting the password)
			//   body.smtp absent    → leave any previously-saved SMTP untouched
			const prevSmtp =
				prev.smtp && typeof prev.smtp === 'object'
					? (prev.smtp as Record<string, unknown>)
					: undefined;
			if (body.clearSmtp === true) {
				// personal SMTP removed; cfg.smtp intentionally left unset
			} else if (body.smtp && typeof body.smtp === 'object') {
				cfg.smtp = buildEmailSmtp(body.smtp as Record<string, unknown>, prevSmtp);
			} else if (prevSmtp) {
				cfg.smtp = prevSmtp;
			}

			if (!cfg.address && !cfg.smtp)
				throw new Error('Enter an email address or set up your own SMTP.');
			return cfg;
		}
		case 'telegram': {
			const chatId = str(body.chatId);
			if (!chatId) throw new Error('Enter your Telegram chat ID.');
			return { chatId };
		}
		case 'ntfy': {
			const topic = str(body.topic);
			if (!topic) throw new Error('Enter an ntfy topic.');
			const server = str(body.server);
			if (server && !HTTP_RE.test(server)) throw new Error('ntfy server must start with http:// or https://.');
			// accessToken: blank means keep the stored one.
			const accessToken = body.accessToken == null || str(body.accessToken) === ''
				? prev.accessToken
				: str(body.accessToken);
			const cfg: Record<string, unknown> = { topic };
			if (server) cfg.server = server;
			if (accessToken) cfg.accessToken = accessToken;
			return cfg;
		}
		case 'nostr': {
			const recipientPubkey = str(body.recipientPubkey);
			if (!recipientPubkey) throw new Error('Enter your Nostr public key (npub or hex).');
			const relays = Array.isArray(body.relays)
				? body.relays.map(String).map((r) => r.trim()).filter(Boolean)
				: [];
			const cfg: Record<string, unknown> = { recipientPubkey };
			if (relays.length) cfg.relays = relays;
			return cfg;
		}
		case 'webhook': {
			const url = str(body.url);
			if (!url) throw new Error('Enter a webhook URL.');
			if (!HTTP_RE.test(url)) throw new Error('Webhook URL must start with http:// or https://.');
			// secret: blank means keep the stored one.
			const secret = body.secret == null || str(body.secret) === '' ? prev.secret : str(body.secret);
			const cfg: Record<string, unknown> = { url };
			if (secret) cfg.secret = secret;
			return cfg;
		}
		default:
			// Unreachable — channel is validated by isConfigurable before we get here.
			throw new Error('Unknown channel.');
	}
}

const SMTP_TLS_MODES = new Set(['starttls', 'tls', 'none']);

/**
 * Validate + assemble a personal SMTP sub-config for storage. Mirrors the
 * instance-wide validation in /api/admin/notifications. The password is
 * encrypted (via secretKey.ts) before it ever hits the config JSON; a blank
 * password keeps the previously-stored encrypted envelope (blank-means-keep,
 * same convention as ntfy/webhook secrets). Throws on invalid input.
 */
function buildEmailSmtp(
	smtp: Record<string, unknown>,
	prevSmtp: Record<string, unknown> | undefined
): Record<string, unknown> {
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

	const host = str(smtp.host);
	if (!host) throw new Error('Enter your SMTP server host.');

	const from = str(smtp.from);
	if (!from) throw new Error('Enter the From address for your SMTP server.');
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))
		throw new Error('The SMTP From address must be a valid email.');

	const tls = str(smtp.tls);
	if (!SMTP_TLS_MODES.has(tls)) throw new Error('Choose a valid SMTP encryption mode.');

	const port = Number(smtp.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('SMTP port must be between 1 and 65535.');

	const user = str(smtp.user) || null;

	// pass: blank/absent → keep the previously-stored encrypted password; a
	// non-blank value is encrypted here so plaintext never reaches storage.
	const rawPass = smtp.pass == null ? '' : str(smtp.pass);
	const passEnc = rawPass === '' ? (prevSmtp?.passEnc ?? null) : encryptSecret(rawPass);

	return { host, port, user, from, tls, passEnc };
}
