import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';

// Mock DNS so the SSRF gate (checkTargetUrl in ./ssrf) is deterministic and
// never does a real lookup for the example hostnames used below.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args)
}));

import ntfyChannel from './ntfy';
import { _transport } from './ssrf';
import type { NotificationPayload } from '../notifyTypes';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;
// The pinned-socket transport is mocked — args are [url: URL, pinned, init].
let sendMock: MockInstance<typeof _transport.pinnedRequest>;

const PAYLOAD: NotificationPayload = {
	type: 'tx_large',
	userId: null,
	level: 'error',
	title: 'Large payment',
	body: '1.5 BTC moved',
	link: 'https://example.com/x'
};

function textResponse(status: number, text = ''): { ok: boolean; status: number; text: () => Promise<string> } {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => text
	};
}

function configureUser(cfg: Record<string, unknown>): void {
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config)
		 VALUES (?, 'ntfy', ?)
		 ON CONFLICT(user_id, channel) DO UPDATE SET config = excluded.config`
	).run(userId, JSON.stringify(cfg));
}

beforeEach(() => {
	wipe();
	vi.clearAllMocks();
	// Default DNS: a public address so hostname targets pass the SSRF gate.
	lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	sendMock = vi.spyOn(_transport, 'pinnedRequest').mockResolvedValue(textResponse(200));
	setSetting('registration_mode', 'open');
	userId = registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'user'
	}).id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isConfigured', () => {
	it('is false with no topic', () => {
		expect(ntfyChannel.isConfigured(userId)).toBe(false);
	});

	it('is false with a topic but no server and no instance default', () => {
		configureUser({ topic: 'mytopic' });
		expect(ntfyChannel.isConfigured(userId)).toBe(false);
	});

	it('is true when the topic + instance default server are present', () => {
		setSetting('ntfy_default_server', 'https://ntfy.sh');
		configureUser({ topic: 'mytopic' });
		expect(ntfyChannel.isConfigured(userId)).toBe(true);
	});

	it('is true with a per-user server override even without the instance default', () => {
		configureUser({ server: 'https://push.example.com', topic: 'mytopic' });
		expect(ntfyChannel.isConfigured(userId)).toBe(true);
	});
});

describe('send', () => {
	it('returns a non-retryable error when not configured', async () => {
		const res = await ntfyChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('publishes JSON with mapped priority, click link and bearer token', async () => {
		configureUser({
			server: 'https://push.example.com/',
			topic: 'mytopic',
			accessToken: 'tk_abc'
		});
		sendMock.mockResolvedValueOnce(textResponse(200, ''));
		const res = await ntfyChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);

		const [url, , init] = sendMock.mock.calls[0];
		// Trailing slash normalized off the server; the request targets its root.
		expect(url.origin).toBe('https://push.example.com');
		expect(url.pathname).toBe('/');
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer tk_abc');
		const body = JSON.parse(init.body as string) as {
			topic: string;
			title: string;
			message: string;
			priority: number;
			click: string;
		};
		expect(body.topic).toBe('mytopic');
		expect(body.title).toBe('Large payment');
		expect(body.message).toBe('1.5 BTC moved');
		expect(body.priority).toBe(5); // error → 5
		expect(body.click).toBe('https://example.com/x');
	});

	it('maps warn → priority 4 and info → 3', async () => {
		setSetting('ntfy_default_server', 'https://ntfy.sh');
		configureUser({ topic: 't' });
		sendMock.mockResolvedValue(textResponse(200));

		await ntfyChannel.send(userId, { ...PAYLOAD, level: 'warn' });
		let body = JSON.parse((sendMock.mock.calls[0][2] as RequestInit).body as string);
		expect(body.priority).toBe(4);

		await ntfyChannel.send(userId, { ...PAYLOAD, level: 'info' });
		body = JSON.parse((sendMock.mock.calls[1][2] as RequestInit).body as string);
		expect(body.priority).toBe(3);
	});

	it('treats 403 (topic ACL / bad token) as non-retryable', async () => {
		configureUser({ server: 'https://push.example.com', topic: 't' });
		sendMock.mockResolvedValueOnce(textResponse(403, 'forbidden'));
		const res = await ntfyChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});

	it('treats a 5xx as retryable', async () => {
		configureUser({ server: 'https://push.example.com', topic: 't' });
		sendMock.mockResolvedValueOnce(textResponse(503, 'unavailable'));
		const res = await ntfyChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});

	it('treats a network error as retryable', async () => {
		configureUser({ server: 'https://push.example.com', topic: 't' });
		sendMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const res = await ntfyChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});

describe('test()', () => {
	it('publishes a canned test message', async () => {
		setSetting('ntfy_default_server', 'https://ntfy.sh');
		configureUser({ topic: 't' });
		sendMock.mockResolvedValueOnce(textResponse(200));
		const res = await ntfyChannel.test(userId);
		expect(res.ok).toBe(true);
		const body = JSON.parse((sendMock.mock.calls[0][2] as RequestInit).body as string);
		expect(body.title).toContain('test notification');
	});
});
