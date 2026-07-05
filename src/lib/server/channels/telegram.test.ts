import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import telegramChannel from './telegram';
import type { NotificationPayload } from '../notifyTypes';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;
const fetchMock = vi.fn<typeof fetch>();

const PAYLOAD: NotificationPayload = {
	type: 'tx_received',
	userId: null,
	level: 'info',
	title: 'Payment <received>',
	body: 'A & B',
	link: 'https://example.com/x'
};

/** Build a Response-like object with a JSON body and status. */
function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as unknown as Response;
}

function configure(): void {
	setSetting('telegram_bot_token', 'BOT:token');
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'telegram', ?)`
	).run(userId, JSON.stringify({ chatId: '12345' }));
}

beforeEach(() => {
	wipe();
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchMock);
	setSetting('registration_mode', 'open');
	userId = registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'user'
	}).id;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isConfigured', () => {
	it('is false without a bot token or chat id', () => {
		expect(telegramChannel.isConfigured(userId)).toBe(false);
		setSetting('telegram_bot_token', 'BOT:token');
		expect(telegramChannel.isConfigured(userId)).toBe(false); // still no chat id
	});

	it('is true with both a bot token and a chat id', () => {
		configure();
		expect(telegramChannel.isConfigured(userId)).toBe(true);
	});
});

describe('send', () => {
	it('returns a non-retryable error when not configured', async () => {
		const res = await telegramChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('posts HTML-escaped text to the sendMessage endpoint on success', async () => {
		configure();
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const res = await telegramChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.telegram.org/botBOT:token/sendMessage');
		const sent = JSON.parse(init.body as string) as {
			chat_id: string;
			text: string;
			parse_mode: string;
			disable_web_page_preview: boolean;
		};
		expect(sent.chat_id).toBe('12345');
		expect(sent.parse_mode).toBe('HTML');
		expect(sent.disable_web_page_preview).toBe(true);
		// Title bolded and escaped; body ampersand escaped.
		expect(sent.text).toContain('<b>Payment &lt;received&gt;</b>');
		expect(sent.text).toContain('A &amp; B');
	});

	it('treats 403 (blocked / never started) as non-retryable', async () => {
		configure();
		fetchMock.mockResolvedValueOnce(
			jsonResponse(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' })
		);
		const res = await telegramChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});

	it('treats 429 (rate limited) as retryable', async () => {
		configure();
		fetchMock.mockResolvedValueOnce(
			jsonResponse(429, { ok: false, error_code: 429, parameters: { retry_after: 7 } })
		);
		const res = await telegramChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
		expect(res.error).toContain('7');
	});

	it('treats a network error as retryable', async () => {
		configure();
		fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
		const res = await telegramChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});

describe('test()', () => {
	it('rewrites a 403 into a friendly "message your bot first" hint', async () => {
		configure();
		fetchMock.mockResolvedValueOnce(
			jsonResponse(403, { ok: false, error_code: 403, description: 'Forbidden' })
		);
		const res = await telegramChannel.test(userId);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toMatch(/message your bot first/i);
	});

	it('reports success for a good test send', async () => {
		configure();
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const res = await telegramChannel.test(userId);
		expect(res.ok).toBe(true);
	});
});
