// Tests for the test-before-save SMTP endpoint (cairn-l512.4). Exercises the real
// send path against a tiny local SMTP stub (same approach as email.smtp-integration
// .test.ts) and asserts the route NEVER persists anything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { encryptSecret } from '$lib/server/secretKey';
import { POST } from './+server';

/** Minimal SMTP sink: accepts EHLO/MAIL/RCPT/DATA/QUIT, records nothing we assert
 *  on here beyond "it accepted a message". No auth required. */
function startFakeSmtp(): Promise<{ port: number; close: () => Promise<void>; count: () => number }> {
	let count = 0;
	const server = net.createServer((socket) => {
		let buffer = '';
		let inData = false;
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
						count++;
						socket.write('250 OK: queued\r\n');
					}
					continue;
				}
				const upper = line.toUpperCase();
				if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
					socket.write('250-localhost greets you\r\n250 8BITMIME\r\n');
				} else if (upper === 'DATA') {
					inData = true;
					socket.write('354 Start mail input\r\n');
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
				count: () => count,
				close: () => new Promise((res) => server.close(() => res()))
			});
		});
	});
}

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	// The fake SMTP sink listens on 127.0.0.1, which the SSRF guard (cairn-ruxo)
	// blocks by default. Enable the admin escape hatch so these end-to-end send
	// tests can reach it — the guard itself is exercised with the hatch OFF in the
	// dedicated "SSRF guard" block below.
	setSetting('webhook_allow_private_targets', 'true');
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;
	smtp = await startFakeSmtp();
});

afterEach(async () => {
	await smtp.close();
});

function event(body: unknown): Parameters<typeof POST>[0] {
	return {
		locals: { user: { id: userId, email: 'user@example.com', isAdmin: false } },
		params: {},
		request: new Request('http://localhost/api/notifications/channels/email/test-smtp', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0];
}

async function post(body: unknown) {
	const res = await POST(event(body));
	return { status: res.status, body: await res.json() };
}

function hasConfigRow(): boolean {
	const row = db
		.prepare(`SELECT 1 FROM notification_channel_config WHERE user_id = ? AND channel = 'email'`)
		.get(userId);
	return !!row;
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		host: '127.0.0.1',
		port: smtp.port,
		user: '',
		pass: '',
		from: 'me@example.com',
		tls: 'none',
		...overrides
	};
}

describe('POST test-smtp', () => {
	it('sends with valid ad-hoc credentials and persists NOTHING', async () => {
		const { body } = await post(candidate({ pass: 'anything' }));
		expect(body.ok).toBe(true);
		expect(smtp.count()).toBe(1);
		expect(hasConfigRow()).toBe(false); // never wrote config
	});

	it('returns ok:false for an unreachable host (not a 500)', async () => {
		await smtp.close(); // nothing listening now
		const { body } = await post(candidate({ port: smtp.port }));
		expect(body.ok).toBe(false);
		expect(body.error).toBeTruthy();
		expect(hasConfigRow()).toBe(false);
	});

	it('re-tests with the stored password when pass is blank', async () => {
		// Save an email config with an encrypted personal-SMTP password.
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', ?)`
		).run(
			userId,
			JSON.stringify({
				smtp: {
					host: 'old.example',
					port: 25,
					user: 'me',
					from: 'me@example.com',
					tls: 'none',
					passEnc: encryptSecret('stored-password')
				}
			})
		);
		// Blank pass in the request → should reuse the stored one (no auth error here
		// since the stub accepts anything; the point is it doesn't fail resolving).
		const { body } = await post(candidate({ user: 'me', pass: '' }));
		expect(body.ok).toBe(true);
		// The stored config is unchanged (route never persists).
		const stored = JSON.parse(
			(
				db
					.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'email'`)
					.get(userId) as { config: string }
			).config
		);
		expect(stored.smtp.host).toBe('old.example'); // untouched
	});

	it('blank pass with no stored password tests as a no-auth relay', async () => {
		const { body } = await post(candidate({ user: '', pass: '' }));
		expect(body.ok).toBe(true);
		expect(hasConfigRow()).toBe(false);
	});

	it('rejects invalid fields with 400', async () => {
		expect((await post(candidate({ host: '' }))).status).toBe(400);
		expect((await post(candidate({ from: 'bad' }))).status).toBe(400);
		expect((await post(candidate({ tls: 'nope' }))).status).toBe(400);
		expect((await post(candidate({ port: 0 }))).status).toBe(400);
	});
});

describe('POST test-smtp — SSRF guard (cairn-ruxo)', () => {
	it('rejects a loopback host with 400 and never opens a connection', async () => {
		// Hatch OFF for this block — a blind LAN/loopback port scan must be refused.
		setSetting('webhook_allow_private_targets', 'false');
		const { status, body } = await post(candidate({ host: '127.0.0.1', port: smtp.port }));
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/rejected|blocked|private|loopback/i);
		// The fake SMTP sink saw nothing — we bailed before dialling.
		expect(smtp.count()).toBe(0);
		expect(hasConfigRow()).toBe(false);
	});

	it('rejects a CGNAT (100.64.0.0/10) host literal with 400 (cairn-pihb)', async () => {
		setSetting('webhook_allow_private_targets', 'false');
		const { status, body } = await post(candidate({ host: '100.100.100.100' }));
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
	});
});
