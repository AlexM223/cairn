// Tests for the generic per-channel connection-config route, focused on the
// personal-SMTP additions to the 'email' case (cairn-l512.3): encryption at
// rest, blank-means-keep, clearSmtp, and redaction. Other channels are exercised
// only enough to confirm this change didn't disturb them.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { decryptSecret } from '$lib/server/secretKey';
import { GET, PUT, DELETE } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;
});

function event(channel: string, body?: unknown, method = 'PUT'): Parameters<typeof PUT>[0] {
	return {
		locals: { user: { id: userId, email: 'user@example.com', isAdmin: false } },
		params: { channel },
		request: new Request('http://localhost/api/notifications/channels/' + channel, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

async function put(channel: string, body: unknown) {
	const res = await PUT(event(channel, body));
	return { status: res.status, body: await res.json() };
}

function rawStoredConfig(): string {
	const row = db
		.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = 'email'`)
		.get(userId) as { config: string } | undefined;
	return row?.config ?? '';
}

const VALID_SMTP = {
	host: 'smtp.myhost.example',
	port: 2525,
	user: 'me@myhost.example',
	from: 'me@myhost.example',
	tls: 'starttls',
	pass: 'super-secret-pw'
};

describe('email channel config — personal SMTP', () => {
	it('persists SMTP with the password ENCRYPTED (plaintext never stored)', async () => {
		const { status, body } = await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		expect(status).toBe(200);

		const raw = rawStoredConfig();
		expect(raw).not.toContain('super-secret-pw'); // plaintext must not appear anywhere
		const stored = JSON.parse(raw);
		expect(stored.smtp.passEnc).toBeTruthy();
		expect(stored.smtp.passEnc).not.toBe('super-secret-pw');
		expect(decryptSecret(stored.smtp.passEnc)).toBe('super-secret-pw'); // decrypts back
		expect(stored.smtp.host).toBe('smtp.myhost.example');
		expect(stored.smtp.port).toBe(2525);
		expect(stored.address).toBe('to@example.com');

		// Response is redacted — no passEnc, presence flag instead.
		expect(body.config.smtp.passEnc).toBeUndefined();
		expect(body.config.smtp.hasPass).toBe(true);
	});

	it('keeps the stored password when pass is blank on a later save', async () => {
		await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		const firstEnc = JSON.parse(rawStoredConfig()).smtp.passEnc;

		// Re-save with a blank password (user didn't retype it).
		await put('email', {
			address: 'to@example.com',
			smtp: { ...VALID_SMTP, pass: '', port: 2526 }
		});
		const stored = JSON.parse(rawStoredConfig());
		expect(stored.smtp.passEnc).toBe(firstEnc); // unchanged
		expect(stored.smtp.port).toBe(2526); // other fields still update
	});

	it('GET never returns passEnc, only hasPass', async () => {
		await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		const res = await GET(event('email', undefined, 'GET'));
		const data = await res.json();
		expect(data.config.smtp.passEnc).toBeUndefined();
		expect(data.config.smtp.hasPass).toBe(true);
		expect(data.config.smtp.host).toBe('smtp.myhost.example');
	});

	it('clearSmtp:true removes only the smtp sub-object, leaving address intact', async () => {
		await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		await put('email', { address: 'to@example.com', clearSmtp: true });
		const stored = JSON.parse(rawStoredConfig());
		expect(stored.smtp).toBeUndefined();
		expect(stored.address).toBe('to@example.com');
	});

	it('leaves previously-saved SMTP untouched when a request omits smtp', async () => {
		await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		// Update only the address; no smtp key in the body.
		await put('email', { address: 'changed@example.com' });
		const stored = JSON.parse(rawStoredConfig());
		expect(stored.address).toBe('changed@example.com');
		expect(stored.smtp?.host).toBe('smtp.myhost.example'); // still there
		expect(decryptSecret(stored.smtp.passEnc)).toBe('super-secret-pw');
	});

	it('rejects invalid SMTP fields', async () => {
		expect((await put('email', { smtp: { ...VALID_SMTP, host: '' } })).status).toBe(400);
		expect((await put('email', { smtp: { ...VALID_SMTP, from: 'not-an-email' } })).status).toBe(400);
		expect((await put('email', { smtp: { ...VALID_SMTP, tls: 'bogus' } })).status).toBe(400);
		expect((await put('email', { smtp: { ...VALID_SMTP, port: 70000 } })).status).toBe(400);
	});

	it('allows saving personal SMTP with no destination address (defaults apply)', async () => {
		const { status } = await put('email', { smtp: VALID_SMTP });
		expect(status).toBe(200);
		const stored = JSON.parse(rawStoredConfig());
		expect(stored.address).toBeUndefined();
		expect(stored.smtp.host).toBe('smtp.myhost.example');
	});

	it('still saves an address-only config (no SMTP) as before', async () => {
		const { status } = await put('email', { address: 'to@example.com' });
		expect(status).toBe(200);
		const stored = JSON.parse(rawStoredConfig());
		expect(stored.address).toBe('to@example.com');
		expect(stored.smtp).toBeUndefined();
	});
});

function rawStoredConfigFor(channel: string): string {
	const row = db
		.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = ?`)
		.get(userId, channel) as { config: string } | undefined;
	return row?.config ?? '';
}

describe('ntfy channel config — encrypted access token (cairn-e9mz.1)', () => {
	it('stores the access token ENCRYPTED (plaintext never stored) and redacts it', async () => {
		const { status, body } = await put('ntfy', { topic: 'my-topic', accessToken: 'tk_123' });
		expect(status).toBe(200);
		expect(body.config.accessToken).toBeUndefined();
		expect(body.config.accessTokenEnc).toBeUndefined();
		expect(body.config.hasAccessToken).toBe(true);

		const raw = rawStoredConfigFor('ntfy');
		expect(raw).not.toContain('tk_123');
		const stored = JSON.parse(raw);
		expect(stored.accessToken).toBeUndefined();
		expect(decryptSecret(stored.accessTokenEnc)).toBe('tk_123');
	});

	it('keeps the stored encrypted token when accessToken is blank on a later save', async () => {
		await put('ntfy', { topic: 'my-topic', accessToken: 'tk_123' });
		const firstEnc = JSON.parse(rawStoredConfigFor('ntfy')).accessTokenEnc;

		await put('ntfy', { topic: 'renamed-topic', accessToken: '' });
		const stored = JSON.parse(rawStoredConfigFor('ntfy'));
		expect(stored.accessTokenEnc).toBe(firstEnc); // unchanged
		expect(stored.topic).toBe('renamed-topic');
	});

	it('upgrades a legacy plaintext accessToken to the envelope on re-save', async () => {
		// A row written before encryption shipped: plaintext accessToken key.
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'ntfy', ?)`
		).run(userId, JSON.stringify({ topic: 'my-topic', accessToken: 'tk_legacy' }));

		// Re-save without retyping the token — blank means keep.
		await put('ntfy', { topic: 'my-topic', accessToken: '' });
		const raw = rawStoredConfigFor('ntfy');
		expect(raw).not.toContain('tk_legacy');
		expect(decryptSecret(JSON.parse(raw).accessTokenEnc)).toBe('tk_legacy');
	});
});

describe('webhook channel config — encrypted signing secret (cairn-e9mz.2)', () => {
	const SECRET = 'a-sixteen-char-plus-secret';

	it('stores the secret ENCRYPTED (plaintext never stored) and redacts it', async () => {
		const { status, body } = await put('webhook', { url: 'https://example.com/hook', secret: SECRET });
		expect(status).toBe(200);
		expect(body.config.secret).toBeUndefined();
		expect(body.config.secretEnc).toBeUndefined();
		expect(body.config.hasSecret).toBe(true);

		const raw = rawStoredConfigFor('webhook');
		expect(raw).not.toContain(SECRET);
		const stored = JSON.parse(raw);
		expect(stored.secret).toBeUndefined();
		expect(decryptSecret(stored.secretEnc)).toBe(SECRET);
	});

	it('still rejects a too-short secret (validated on the raw value)', async () => {
		const { status } = await put('webhook', { url: 'https://example.com/hook', secret: 'short' });
		expect(status).toBe(400);
	});

	it('keeps the stored encrypted secret when secret is blank on a later save', async () => {
		await put('webhook', { url: 'https://example.com/hook', secret: SECRET });
		const firstEnc = JSON.parse(rawStoredConfigFor('webhook')).secretEnc;

		await put('webhook', { url: 'https://example.com/hook2', secret: '' });
		const stored = JSON.parse(rawStoredConfigFor('webhook'));
		expect(stored.secretEnc).toBe(firstEnc); // unchanged
		expect(stored.url).toBe('https://example.com/hook2');
	});

	it('upgrades a legacy plaintext secret to the envelope on re-save', async () => {
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'webhook', ?)`
		).run(userId, JSON.stringify({ url: 'https://example.com/hook', secret: 'legacy-secret' }));

		await put('webhook', { url: 'https://example.com/hook', secret: '' });
		const raw = rawStoredConfigFor('webhook');
		expect(raw).not.toContain('legacy-secret');
		expect(decryptSecret(JSON.parse(raw).secretEnc)).toBe('legacy-secret');
	});
});

describe('other channels unaffected', () => {

	it('DELETE clears the channel config row', async () => {
		await put('email', { address: 'to@example.com', smtp: VALID_SMTP });
		const res = await DELETE(event('email', undefined, 'DELETE'));
		expect((await res.json()).configured).toBe(false);
		expect(rawStoredConfig()).toBe('');
	});
});
