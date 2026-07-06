// Integration test for the email channel that exercises the REAL network path:
// a real nodemailer transporter talking real SMTP wire protocol to a tiny local
// TCP stub server (no mocking of nodemailer, unlike email.test.ts). This is the
// closest we get to "did this actually work" without a live mail relay or
// external service (Ethereal, Mailhog, etc.) — the stub speaks just enough
// SMTP (EHLO/MAIL FROM/RCPT TO/DATA) to accept a message and hand back the raw
// envelope + body for assertions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import emailChannel from './email';
import type { NotificationPayload } from '../notifyTypes';

interface CapturedMessage {
	from: string;
	to: string[];
	data: string;
}

/** Undo quoted-printable encoding: join soft line breaks ("=\r\n") and decode
 *  "=XX" hex escapes. nodemailer switches to this encoding for long lines, so
 *  tests must decode it to assert on the logical body content. */
function decodeQuotedPrintable(text: string): string {
	return text
		.replace(/=\r\n/g, '')
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseHeaders(raw: string): { headers: Record<string, string>; body: string } {
	const sep = raw.indexOf('\r\n\r\n');
	const headerBlock = sep === -1 ? raw : raw.slice(0, sep);
	let body = sep === -1 ? '' : raw.slice(sep + 4);
	const headers: Record<string, string> = {};
	for (const line of headerBlock.split('\r\n')) {
		const m = line.match(/^([^:]+):\s*(.*)$/);
		if (m) headers[m[1].toLowerCase()] = m[2];
	}
	if (headers['content-transfer-encoding'] === 'quoted-printable') {
		body = decodeQuotedPrintable(body);
	}
	return { headers, body };
}

/** A minimal SMTP server: just enough of RFC 5321 for nodemailer to complete a
 *  send (EHLO, MAIL FROM, RCPT TO, DATA with dot-stuffing, QUIT). Captures every
 *  accepted message for the test to inspect. */
function startFakeSmtpServer(): Promise<{
	port: number;
	messages: CapturedMessage[];
	close: () => Promise<void>;
}> {
	const messages: CapturedMessage[] = [];

	const server = net.createServer((socket) => {
		let buffer = '';
		let inData = false;
		let dataLines: string[] = [];
		let mailFrom = '';
		let rcptTo: string[] = [];

		socket.write('220 localhost ESMTP fake\r\n');

		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			let idx: number;
			while ((idx = buffer.indexOf('\r\n')) !== -1) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				if (inData) {
					if (line === '.') {
						inData = false;
						messages.push({ from: mailFrom, to: [...rcptTo], data: dataLines.join('\r\n') });
						dataLines = [];
						mailFrom = '';
						rcptTo = [];
						socket.write('250 OK: queued\r\n');
					} else {
						// Transparency: a leading dot is doubled by the sender; undo it.
						dataLines.push(line.startsWith('.') ? line.slice(1) : line);
					}
					continue;
				}

				const upper = line.toUpperCase();
				if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
					socket.write('250-localhost greets you\r\n250 8BITMIME\r\n');
				} else if (upper.startsWith('MAIL FROM')) {
					const m = line.match(/MAIL FROM:\s*<([^>]*)>/i);
					mailFrom = m ? m[1] : '';
					socket.write('250 OK\r\n');
				} else if (upper.startsWith('RCPT TO')) {
					const m = line.match(/RCPT TO:\s*<([^>]*)>/i);
					if (m) rcptTo.push(m[1]);
					socket.write('250 OK\r\n');
				} else if (upper === 'DATA') {
					inData = true;
					socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
				} else if (upper === 'QUIT') {
					socket.write('221 Bye\r\n');
					socket.end();
				} else {
					socket.write('250 OK\r\n');
				}
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (!addr || typeof addr === 'string') return reject(new Error('no port'));
			resolve({
				port: addr.port,
				messages,
				close: () => new Promise((res) => server.close(() => res()))
			});
		});
	});
}

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM user_pgp_keys; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;
let smtp: Awaited<ReturnType<typeof startFakeSmtpServer>>;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	const user = registerUser({
		email: 'realuser@example.com',
		password: 'correct horse battery',
		displayName: 'realuser'
	});
	userId = user.id;

	smtp = await startFakeSmtpServer();
	setSetting('smtp_host', '127.0.0.1');
	setSetting('smtp_port', String(smtp.port));
	setSetting('smtp_from', 'cairn@example.com');
	setSetting('smtp_tls', 'none');
});

afterEach(async () => {
	await smtp.close();
});

describe('email channel — real SMTP wire protocol against a local stub server', () => {
	it('delivers a tx_received notification with correct envelope, headers, subject, and body', async () => {
		const payload: NotificationPayload = {
			type: 'tx_received',
			userId: null,
			level: 'info',
			title: 'Payment received',
			body: '0.015 BTC received to Savings',
			link: '/wallets/3'
		};

		const res = await emailChannel.send(userId, payload);
		expect(res.ok).toBe(true);
		expect(smtp.messages).toHaveLength(1);

		const msg = smtp.messages[0];
		expect(msg.from).toBe('cairn@example.com');
		expect(msg.to).toEqual(['realuser@example.com']);

		const { headers, body } = parseHeaders(msg.data);
		expect(headers.from).toBe('cairn@example.com');
		expect(headers.to).toBe('realuser@example.com');
		expect(headers.subject).toBe('Payment received');
		expect(body).toContain('0.015 BTC received to Savings');
		expect(body).toContain('/wallets/3');
	});

	it('delivers to an explicit per-user address override, not the account email', async () => {
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', ?)`
		).run(userId, JSON.stringify({ address: 'alt-destination@example.com' }));

		await emailChannel.send(userId, {
			type: 'security_failed_login',
			userId,
			level: 'warn',
			title: 'Failed login attempts',
			body: '5 failed login attempts on your account.'
		});

		const msg = smtp.messages[0];
		expect(msg.to).toEqual(['alt-destination@example.com']);
		const { headers } = parseHeaders(msg.data);
		expect(headers.to).toBe('alt-destination@example.com');
	});

	it('delivers a real PGP-encrypted message that decrypts back to the original body', async () => {
		const openpgp = await import('openpgp');
		const { privateKey, publicKey } = await openpgp.generateKey({
			type: 'ecc',
			curve: 'curve25519' as never,
			userIDs: [{ name: 'Real User', email: 'realuser@example.com' }],
			format: 'armored'
		});
		db.prepare(
			'INSERT INTO user_pgp_keys (user_id, public_key, fingerprint) VALUES (?, ?, ?)'
		).run(userId, publicKey, 'deadbeef');

		const originalBody = '1.5 BTC received to Cold Storage';
		await emailChannel.send(userId, {
			type: 'tx_large',
			userId,
			level: 'warn',
			title: 'Large payment',
			body: originalBody
		});

		const msg = smtp.messages[0];
		const { headers, body } = parseHeaders(msg.data);
		// Subject must NOT leak the event; body must NOT contain plaintext on the wire.
		expect(headers.subject).toBe('Cairn notification');
		expect(body).not.toContain(originalBody);
		expect(body).toContain('BEGIN PGP MESSAGE');

		// Prove it's not just opaque-looking text — it actually decrypts. The
		// generated key has no passphrase, so the private key is already usable.
		const privKey = await openpgp.readPrivateKey({ armoredKey: privateKey });
		const message = await openpgp.readMessage({ armoredMessage: body });
		const { data: decrypted } = await openpgp.decrypt({ message, decryptionKeys: privKey });
		expect(decrypted).toBe(originalBody);
	});

	it("sends the test() canned message through the identical real send path", async () => {
		const res = await emailChannel.test(userId);
		expect(res.ok).toBe(true);
		const msg = smtp.messages[0];
		const { headers, body } = parseHeaders(msg.data);
		expect(headers.subject).toContain('Test notification');
		expect(body).toContain('email notifications are working');
	});
});
