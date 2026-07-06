import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { createHmac } from 'node:crypto';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';

// Mock DNS so hostname-based SSRF checks are deterministic (no real lookups).
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args)
}));

import webhookChannel, { _internals } from './webhook';
import { _transport } from './ssrf';

/** A SafeResponse-shaped result for the pinned transport mock. */
function resp(status: number, body = ''): { ok: boolean; status: number; text: () => Promise<string> } {
	return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const PASSWORD = 'correct horse battery staple';
function makeUser(email: string): number {
	setSetting('registration_mode', 'open');
	return registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] }).id;
}

function saveConfig(userId: number, config: Record<string, unknown>): void {
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config)
		 VALUES (?, 'webhook', ?)`
	).run(userId, JSON.stringify(config));
}

const payload = {
	type: 'tx_received' as const,
	userId: 1,
	level: 'info' as const,
	title: 'Payment received',
	body: '0.015 BTC received to Savings',
	detail: { amountSats: 1500000, walletId: 3 },
	link: '/wallets/3'
};

// The pinned-socket transport is mocked so no real sockets open. Its call args
// are [url: URL, pinned: {address,family}, init] — the request the SSRF gate
// approved and pinned to a validated IP.
let sendMock: MockInstance<typeof _transport.pinnedRequest>;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	// Default DNS: a public address, so hostname targets pass the SSRF gate.
	lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	sendMock = vi.spyOn(_transport, 'pinnedRequest').mockResolvedValue(resp(200, 'ok'));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('config + isConfigured', () => {
	it('is not configured with no row', () => {
		const u = makeUser('a@example.com');
		expect(webhookChannel.isConfigured(u)).toBe(false);
	});

	it('is configured with a valid http(s) url', () => {
		const u = makeUser('b@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });
		expect(webhookChannel.isConfigured(u)).toBe(true);
	});

	it('is not configured with a non-http scheme', () => {
		const u = makeUser('c@example.com');
		saveConfig(u, { url: 'ftp://example.com/hook' });
		expect(webhookChannel.isConfigured(u)).toBe(false);
	});

	it('is not configured with malformed JSON / missing url', () => {
		const u = makeUser('d@example.com');
		saveConfig(u, { secret: 'x' });
		expect(webhookChannel.isConfigured(u)).toBe(false);
	});
});

describe('send() — success + signing', () => {
	it('POSTs the documented JSON body and reports ok on 2xx', async () => {
		const u = makeUser('e@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(true);
		expect(sendMock).toHaveBeenCalledTimes(1);

		const [url, pinned, init] = sendMock.mock.calls[0];
		expect(url.href).toBe('https://example.com/hook');
		// Pinned to the validated IP the SSRF gate resolved, not the hostname.
		expect(pinned.address).toBe('93.184.216.34');
		expect(init.method).toBe('POST');
		expect(init.headers!['Content-Type']).toBe('application/json');
		// No secret → no signature header.
		expect(init.headers!['X-Cairn-Signature']).toBeUndefined();

		const body = JSON.parse(init.body!);
		expect(body).toMatchObject({
			type: 'tx_received',
			level: 'info',
			title: 'Payment received',
			body: '0.015 BTC received to Savings',
			detail: { amountSats: 1500000, walletId: 3 },
			link: '/wallets/3'
		});
		expect(typeof body.timestamp).toBe('string');
	});

	it('signs the raw body bytes with X-Cairn-Signature when a secret is set', async () => {
		const u = makeUser('f@example.com');
		const secret = 'shhhh';
		saveConfig(u, { url: 'https://example.com/hook', secret });

		await webhookChannel.send(u, payload);
		const init = sendMock.mock.calls[0][2];
		const sig = init.headers!['X-Cairn-Signature'] as string;
		expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

		// Recompute over the EXACT bytes we sent — must match.
		const expected = 'sha256=' + createHmac('sha256', secret).update(init.body!, 'utf8').digest('hex');
		expect(sig).toBe(expected);
	});
});

describe('send() — failure classification', () => {
	it('non-2xx → retryable', async () => {
		const u = makeUser('g@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });
		sendMock.mockResolvedValue(resp(500, 'boom'));

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
		expect(res.error).toContain('500');
	});

	it('network error / timeout → retryable', async () => {
		const u = makeUser('h@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });
		sendMock.mockRejectedValue(new Error('ETIMEDOUT'));

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});

	it('not configured → non-retryable', async () => {
		const u = makeUser('i@example.com');
		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});
});

describe('SSRF guard', () => {
	it('rejects a loopback 127.0.0.1 URL as non-retryable and never fetches', async () => {
		const u = makeUser('j@example.com');
		saveConfig(u, { url: 'http://127.0.0.1:8080/hook' });

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toMatch(/private|loopback|blocked/i);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('rejects a non-http(s) scheme as non-retryable', async () => {
		const u = makeUser('k@example.com');
		saveConfig(u, { url: 'file:///etc/passwd' });
		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toMatch(/scheme/i);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('rejects a hostname that RESOLVES to a private range', async () => {
		const u = makeUser('l@example.com');
		saveConfig(u, { url: 'https://internal.example/hook' });
		lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('rejects if ANY resolved address is private (mixed A records)', async () => {
		const u = makeUser('m@example.com');
		saveConfig(u, { url: 'https://rebind.example/hook' });
		lookupMock.mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '169.254.169.254', family: 4 } // cloud metadata
		]);
		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('allows private targets when the admin escape hatch is on', async () => {
		const u = makeUser('n@example.com');
		saveConfig(u, { url: 'http://127.0.0.1:8080/hook' });
		setSetting('webhook_allow_private_targets', 'true');

		const res = await webhookChannel.send(u, payload);
		expect(res.ok).toBe(true);
		expect(sendMock).toHaveBeenCalledTimes(1);
	});
});

describe('isBlockedAddress ranges', () => {
	it('blocks the documented private/loopback/link-local ranges', () => {
		for (const ip of [
			'127.0.0.1',
			'127.255.255.255',
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.169.254',
			'0.0.0.0',
			'::1',
			'::',
			'fc00::1',
			'fd12::1',
			'fe80::1',
			'::ffff:127.0.0.1',
			'::ffff:10.0.0.1',
			// Compressed-hex IPv4-mapped forms — a naive dotted-quad regex misses
			// these, letting ::ffff:7f00:1 (127.0.0.1) through (cairn-7bsc).
			'::ffff:7f00:1', // 127.0.0.1
			'::ffff:0a00:1', // 10.0.0.1
			'::ffff:a9fe:a9fe' // 169.254.169.254 cloud metadata
		]) {
			expect(_internals.isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
		}
	});

	it('allows public addresses', () => {
		for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
			expect(_internals.isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
		}
	});
});

describe('test()', () => {
	it('POSTs type:test and reports HTTP status verbatim on failure', async () => {
		const u = makeUser('o@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });
		sendMock.mockResolvedValue(resp(418, 'nope'));

		const res = await webhookChannel.test(u);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('418');

		const body = JSON.parse(sendMock.mock.calls[0][2].body!);
		expect(body.type).toBe('test');
	});

	it('reports ok on a 2xx', async () => {
		const u = makeUser('p@example.com');
		saveConfig(u, { url: 'https://example.com/hook' });
		const res = await webhookChannel.test(u);
		expect(res.ok).toBe(true);
	});
});
