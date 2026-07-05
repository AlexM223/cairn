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
import { getSetting } from '../settings';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const log = childLogger('notify:email');

/** Per-user config JSON stored in notification_channel_config.config. */
interface EmailChannelConfig {
	/** Destination address; defaults to the user's account email if absent. */
	address?: string;
}

interface SmtpConfig {
	host: string;
	port: number;
	user: string | null;
	pass: string | null;
	from: string;
	tls: 'starttls' | 'tls' | 'none';
}

/** Assemble the instance-wide SMTP config from raw settings keys. Returns null
 *  when the minimum (a host and a From: address) isn't configured. */
function readSmtpConfig(): SmtpConfig | null {
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
		pass: getSetting('smtp_pass'),
		from,
		tls
	};
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

/** Build a transporter and send one mail, mapping the result. */
async function sendMail(
	smtp: SmtpConfig,
	to: string,
	subject: string,
	text: string
): Promise<ChannelSendResult> {
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
		await transporter.sendMail({ from: smtp.from, to, subject, text });
		return { ok: true };
	} catch (err) {
		const { message, retryable } = classifyError(err);
		log.warn({ err, to, retryable }, 'email send failed');
		return { ok: false, error: message, retryable };
	} finally {
		transporter.close();
	}
}

/** Compose + (optionally) encrypt + send. Shared by send() and test(). */
async function deliver(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const smtp = readSmtpConfig();
	if (!smtp) {
		return {
			ok: false,
			error: 'SMTP is not configured on this instance.',
			retryable: false
		};
	}

	const to = resolveAddress(userId);
	if (!to) {
		return { ok: false, error: 'No destination email address configured.', retryable: false };
	}

	let subject = payload.title;
	let body = payload.body;
	if (payload.link) body += `\n\n${payload.link}`;

	const pgpKey = readPgpPublicKey(userId);
	if (pgpKey) {
		try {
			body = await encryptBody(body, pgpKey);
			// Never leak the event in the subject when we bothered to encrypt.
			subject = 'Cairn notification';
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
	}

	return sendMail(smtp, to, subject, body);
}

const emailChannel: NotificationChannelPlugin = {
	id: 'email',
	label: 'Email',

	/** Configured when the instance has SMTP set up AND we can resolve a
	 *  destination address for this user (explicit override or account email). */
	isConfigured(userId: number): boolean {
		return readSmtpConfig() !== null && resolveAddress(userId) !== null;
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		return deliver(userId, payload);
	},

	async test(userId: number): Promise<ChannelSendResult> {
		return deliver(userId, {
			type: 'admin_server_health',
			userId,
			level: 'info',
			title: 'Test notification from Cairn',
			body: 'This is a test notification. If you received it, email notifications are working.'
		});
	}
};

export default emailChannel;
