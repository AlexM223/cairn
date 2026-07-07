// Email (SMTP + optional PGP) notification channel — docs/NOTIFICATION-PLAN.md §2.2.
//
// One SMTP relay for the whole instance (admin config in the `settings` table);
// each user picks the destination address (defaults to their account email) and
// may upload a PGP public key. When a key is on file the message BODY is
// PGP-encrypted (openpgp.js, inline ASCII-armored) and the subject is kept
// generic ("Cairn notification") so a snooping mail server learns nothing.
//
// Config storage:
//   • per-user  → notification_channel_config, channel='email',
//                 config = { "address": string }  (see EmailChannelConfig)
//   • per-user  → user_pgp_keys row (optional) enables body encryption
//   • instance  → settings keys: smtp_host, smtp_port (default 587), smtp_user,
//                 smtp_pass, smtp_from, smtp_tls ('starttls' | 'tls' | 'none')
//
// Error mapping (ChannelSendResult.retryable):
//   • bad host / auth failure / missing SMTP config  → retryable:false (admin must fix)
//   • connection timeout / transient 4xx-5xx         → retryable:true  (queue retries)
//
// Local dev tip: point smtp_host=localhost, smtp_port=1025, smtp_tls='none' at a
// Mailhog/maildev container to exercise the real send path without a live relay.
// (Not a project dependency — just a documented convenience.)

import nodemailer from 'nodemailer';
import * as openpgp from 'openpgp';
import { db } from '../db';
import { childLogger } from '../logger';
import { getSetting, readSecretSetting } from '../settings';
import { decryptSecret } from '../secretKey';
import { absoluteNotificationLink } from '../notifyLinks';
import { renderEmail, renderText } from './emailTemplate';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationLevel,
	NotificationPayload
} from '../notifyTypes';

const log = childLogger('notify:email');

/** Shown when neither personal nor instance SMTP is configured — distinguishes
 *  the two escape routes a user has (bring your own, or ask the admin). */
const NO_SMTP_MESSAGE =
	'No SMTP configured — set up your own in Settings › Notifications, or ask your admin to configure instance email.';

/** Personal SMTP relay saved by a user, stored (encrypted pass) alongside the
 *  destination address in notification_channel_config.config. */
export interface PersonalSmtp {
	host: string;
	port: number;
	user: string | null;
	from: string;
	tls: 'starttls' | 'tls' | 'none';
	/** Encrypted envelope from secretKey.ts — NEVER plaintext. Null = no-auth relay. */
	passEnc: string | null;
}

/** Per-user config JSON stored in notification_channel_config.config. Old rows
 *  hold only `address`; `smtp` is additive — absent means "fall back to the
 *  instance relay", i.e. exactly today's behaviour. */
interface EmailChannelConfig {
	/** Destination address; defaults to the user's account email if absent. */
	address?: string;
	/** Personal SMTP relay. Absent = use the instance-wide relay. */
	smtp?: PersonalSmtp;
}

export interface SmtpConfig {
	host: string;
	port: number;
	user: string | null;
	pass: string | null;
	from: string;
	tls: 'starttls' | 'tls' | 'none';
}

/** Assemble the instance-wide SMTP config from raw settings keys. Returns null
 *  when the minimum (a host and a From: address) isn't configured. */
function readInstanceSmtpConfig(): SmtpConfig | null {
	const host = getSetting('smtp_host');
	if (!host) return null;
	const from = getSetting('smtp_from') ?? getSetting('smtp_user');
	if (!from) return null;

	const portRaw = getSetting('smtp_port');
	const port = portRaw ? parseInt(portRaw, 10) : 587;
	const tlsRaw = getSetting('smtp_tls');
	const tls: SmtpConfig['tls'] =
		tlsRaw === 'tls' || tlsRaw === 'none' || tlsRaw === 'starttls' ? tlsRaw : 'starttls';

	return {
		host,
		port: Number.isFinite(port) && port > 0 ? port : 587,
		user: getSetting('smtp_user'),
		pass: readSecretSetting('smtp_pass'),
		from,
		tls
	};
}

/**
 * Resolve the SMTP relay to use for THIS recipient, per docs/PER-USER-SMTP-PLAN.md
 * §1: the user's own saved relay first (decrypting its password), else the
 * instance-wide relay, else null. May THROW if the user's stored password can't
 * be decrypted (corrupt envelope / wrong key) — callers translate that into a
 * clear non-retryable error rather than letting it crash a queue tick.
 */
function readSmtpConfig(userId: number): SmtpConfig | null {
	const cfg = readChannelConfig(userId);
	const personal = cfg?.smtp;
	if (personal?.host && personal.from) {
		return {
			host: personal.host,
			port: personal.port,
			user: personal.user,
			pass: personal.passEnc ? decryptSecret(personal.passEnc) : null,
			from: personal.from,
			tls: personal.tls
		};
	}
	return readInstanceSmtpConfig();
}

/** Whether SOME relay (personal or instance) is available for this user, without
 *  decrypting anything — used by isConfigured() to grey out the toggle. */
function smtpIsAvailable(userId: number): boolean {
	const cfg = readChannelConfig(userId);
	if (cfg?.smtp?.host && cfg.smtp.from) return true;
	return readInstanceSmtpConfig() !== null;
}

/** The user's saved email config row (or null). */
function readChannelConfig(userId: number): EmailChannelConfig | null {
	try {
		const row = db
			.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'email'`)
			.get(userId) as { config: string } | undefined;
		if (!row) return null;
		return JSON.parse(row.config) as EmailChannelConfig;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read email channel config');
		return null;
	}
}

/** The account email for a user, used as the default destination. */
function accountEmail(userId: number): string | null {
	try {
		const row = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as
			| { email: string }
			| undefined;
		return row?.email ?? null;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read account email');
		return null;
	}
}

/** Effective destination address: explicit override, else the account email. */
function resolveAddress(userId: number): string | null {
	const cfg = readChannelConfig(userId);
	const address = cfg?.address?.trim();
	if (address) return address;
	return accountEmail(userId);
}

/** The user's PGP public key block, if they've uploaded one. */
function readPgpPublicKey(userId: number): string | null {
	try {
		const row = db
			.prepare('SELECT public_key FROM user_pgp_keys WHERE user_id = ?')
			.get(userId) as { public_key: string } | undefined;
		return row?.public_key ?? null;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read PGP key');
		return null;
	}
}

/** PGP-encrypt a plaintext body to the given armored public key. */
async function encryptBody(plaintext: string, armoredPublicKey: string): Promise<string> {
	const publicKey = await openpgp.readKey({ armoredKey: armoredPublicKey });
	const message = await openpgp.createMessage({ text: plaintext });
	const encrypted = await openpgp.encrypt({ message, encryptionKeys: publicKey });
	return encrypted as string;
}

/** nodemailer's `secure` flag: true only for implicit TLS (port 465 style). */
function isSecure(tls: SmtpConfig['tls']): boolean {
	return tls === 'tls';
}

/** Classify a nodemailer/SMTP error into retryable vs. terminal. Auth failures
 *  and DNS/host problems are config bugs the admin must fix (not retryable);
 *  timeouts, connection resets and 5xx are transient (retryable). */
function classifyError(err: unknown): { message: string; retryable: boolean } {
	const e = err as { code?: string; responseCode?: number; message?: string } | undefined;
	const message = e?.message ?? String(err);
	const code = e?.code ?? '';
	const responseCode = e?.responseCode;

	// Authentication / host resolution / TLS — the admin's SMTP config is wrong.
	const terminalCodes = new Set(['EAUTH', 'ENOTFOUND', 'EDNS', 'ECONNREFUSED', 'EENVELOPE']);
	if (terminalCodes.has(code)) return { message, retryable: false };
	// 5xx are permanent per SMTP, but relays sometimes return transient 5xx; the
	// plan classes 4xx-that-look-transient AND 5xx as retryable, so honour that.
	if (typeof responseCode === 'number' && responseCode >= 400) {
		return { message, retryable: true };
	}
	// Timeouts / connection resets — transient.
	return { message, retryable: true };
}

/** Map a notification level to email priority headers. warn/error become
 *  high-importance so an urgent alert is visually flagged in the inbox; routine
 *  info/success carry no header (normal). Mirrors ntfy's priorityForLevel
 *  (cairn-5gpv.4). */
function priorityHeaders(level: NotificationLevel): Record<string, string> | undefined {
	if (level === 'warn' || level === 'error') {
		return { Importance: 'high', 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High' };
	}
	return undefined;
}

interface MailParts {
	to: string;
	subject: string;
	/** Plain-text alternative (always present). */
	text: string;
	/** HTML alternative — omitted on the PGP-encrypted path. */
	html?: string;
	/** Extra headers (e.g. Importance for warn/error). */
	headers?: Record<string, string>;
}

/** Build a transporter and send one mail, mapping the result. */
async function sendMail(smtp: SmtpConfig, parts: MailParts): Promise<ChannelSendResult> {
	const transporter = nodemailer.createTransport({
		host: smtp.host,
		port: smtp.port,
		secure: isSecure(smtp.tls),
		// STARTTLS is opportunistic by default on non-secure ports; force it when
		// the admin explicitly chose 'starttls', and forbid upgrade for 'none'.
		requireTLS: smtp.tls === 'starttls',
		ignoreTLS: smtp.tls === 'none',
		auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined
	});
	try {
		await transporter.sendMail({
			from: smtp.from,
			to: parts.to,
			subject: parts.subject,
			text: parts.text,
			...(parts.html ? { html: parts.html } : {}),
			...(parts.headers ? { headers: parts.headers } : {})
		});
		return { ok: true };
	} catch (err) {
		const { message, retryable } = classifyError(err);
		log.warn({ err, to: parts.to, retryable }, 'email send failed');
		return { ok: false, error: message, retryable };
	} finally {
		transporter.close();
	}
}

/** Compose + (optionally) encrypt + send with an EXPLICIT relay. The single
 *  send/error-classification path shared by real sends, the test button, and the
 *  test-before-save endpoint (via sendTestWithConfig) — so a green test result
 *  genuinely exercises what a real notification would do. */
async function deliverWith(
	userId: number,
	payload: NotificationPayload,
	smtp: SmtpConfig
): Promise<ChannelSendResult> {
	const to = resolveAddress(userId);
	if (!to) {
		return { ok: false, error: 'No destination email address configured.', retryable: false };
	}

	// Deep links must be absolute in an email — a bare "/wallets/3" isn't clickable
	// in any mail client (cairn-5gpv.1). Omitted when CAIRN_ORIGIN is unset.
	const link = absoluteNotificationLink(payload.link);
	const headers = priorityHeaders(payload.level);

	const pgpKey = readPgpPublicKey(userId);
	if (pgpKey) {
		// Encrypted path stays plain-text only: encrypting HTML adds armored-payload
		// complexity for no benefit (cairn-5gpv.2). Encrypt only the body (+ link) —
		// the title already rode in as context nowhere the mail server can read, and
		// the subject is forced generic below; keeping the body title-free preserves
		// the pre-existing encrypted-body contract (title '' → renderText emits body).
		let text: string;
		try {
			text = await encryptBody(
				renderText({ title: '', body: payload.body, link, level: payload.level }),
				pgpKey
			);
		} catch (err) {
			// A bad/unreadable key is a config problem the user must fix — do not
			// silently fall back to plaintext (that would defeat the point).
			log.warn({ err, userId }, 'PGP encryption failed');
			return {
				ok: false,
				error: 'Could not encrypt with your PGP key. Check the uploaded public key.',
				retryable: false
			};
		}
		// Never leak the event in the subject when we bothered to encrypt.
		return sendMail(smtp, { to, subject: 'Heartwood notification', text, headers });
	}

	// Cleartext path: full branded HTML alternative + a plain-text fallback
	// (cairn-5gpv.2).
	const { html, text } = renderEmail({
		title: payload.title,
		body: payload.body,
		link,
		level: payload.level
	});
	return sendMail(smtp, { to, subject: payload.title, text, html, headers });
}

/** Resolve this recipient's relay, mapping the two "can't send" cases (a corrupt
 *  saved password, or nothing configured at all) to a clear non-retryable
 *  ChannelSendResult so a decryption error never throws out of a queue tick. */
function resolveSmtp(userId: number): { smtp: SmtpConfig } | { error: ChannelSendResult } {
	let smtp: SmtpConfig | null;
	try {
		smtp = readSmtpConfig(userId);
	} catch (err) {
		log.warn({ err, userId }, 'failed to decrypt saved SMTP password');
		return {
			error: {
				ok: false,
				error: 'Your saved email password could not be read. Re-enter it in Settings › Notifications.',
				retryable: false
			}
		};
	}
	if (!smtp) return { error: { ok: false, error: NO_SMTP_MESSAGE, retryable: false } };
	return { smtp };
}

/** The canned "does email work?" payload, shared by test() and the test-smtp route. */
function testPayload(userId: number): NotificationPayload {
	return {
		type: 'admin_server_health',
		userId,
		level: 'info',
		title: 'Test notification from Heartwood',
		body: 'This is a test notification. If you received it, email notifications are working.'
	};
}

/** Compose + encrypt + send. Shared by send() and test(): resolves the recipient's
 *  relay (personal → instance) then delegates to deliverWith. */
async function deliver(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const resolved = resolveSmtp(userId);
	if ('error' in resolved) return resolved.error;
	return deliverWith(userId, payload, resolved.smtp);
}

/**
 * Send the canned test message through an EXPLICIT candidate relay, bypassing
 * stored config entirely. The test-before-save endpoint (§4) uses this to verify
 * form values the user hasn't saved yet; test() uses it with the resolved stored
 * relay. Same send/error path either way (deliverWith → sendMail → classifyError).
 */
export async function sendTestWithConfig(
	userId: number,
	smtp: SmtpConfig
): Promise<ChannelSendResult> {
	return deliverWith(userId, testPayload(userId), smtp);
}

const emailChannel: NotificationChannelPlugin = {
	id: 'email',
	label: 'Email',

	/** Configured when SOME relay (the user's own or the instance's) is available
	 *  AND we can resolve a destination address (explicit override or account
	 *  email). Deliberately does not decrypt the saved password (pure DB read). */
	isConfigured(userId: number): boolean {
		return smtpIsAvailable(userId) && resolveAddress(userId) !== null;
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		return deliver(userId, payload);
	},

	async test(userId: number): Promise<ChannelSendResult> {
		const resolved = resolveSmtp(userId);
		if ('error' in resolved) return resolved.error;
		return sendTestWithConfig(userId, resolved.smtp);
	}
};

export default emailChannel;
