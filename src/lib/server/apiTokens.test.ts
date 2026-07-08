import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { requireUser, requireAdmin } from './api';
import {
	createApiToken,
	listApiTokens,
	revokeApiToken,
	getApiTokenUser,
	bearerRetryAfter,
	noteBearerFailure,
	noteBearerSuccess,
	ApiTokenError,
	TOKEN_PREFIX,
	MAX_TOKENS_PER_USER
} from './apiTokens';

function wipe(): void {
	db.exec('DELETE FROM api_tokens; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

let userId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'owner@example.com',
			password: 'correct horse battery',
			displayName: 'Owner'
		})
	).id;
});

describe('createApiToken', () => {
	it('returns a prefixed token and stores only its hash', () => {
		const created = createApiToken(userId, 'my script');
		expect(created.token.startsWith(TOKEN_PREFIX)).toBe(true);
		expect(created.expiresAt).toBeNull();

		// The raw token must appear nowhere in the database.
		const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(created.id) as Record<
			string,
			unknown
		>;
		expect(row.token_hash).not.toBe(created.token);
		expect(String(row.token_hash)).toHaveLength(64); // sha256 hex
		expect(JSON.stringify(row)).not.toContain(created.token);
	});

	it('rejects an empty name', () => {
		expect(() => createApiToken(userId, '   ')).toThrow(ApiTokenError);
	});

	it('rejects a bad expiry', () => {
		expect(() => createApiToken(userId, 'x', 0)).toThrow(ApiTokenError);
		expect(() => createApiToken(userId, 'x', 1.5)).toThrow(ApiTokenError);
	});

	it('caps the number of tokens per user', () => {
		for (let i = 0; i < MAX_TOKENS_PER_USER; i++) createApiToken(userId, `t${i}`);
		expect(() => createApiToken(userId, 'one too many')).toThrow(ApiTokenError);
	});
});

describe('getApiTokenUser', () => {
	it('resolves a valid token to its user and bumps last_used_at', () => {
		const { token, id } = createApiToken(userId, 'ci');
		const user = getApiTokenUser(token);
		expect(user).not.toBeNull();
		expect(user!.id).toBe(userId);
		expect(user!.email).toBe('owner@example.com');
		expect(user!.isAdmin).toBe(true); // first registered user is the admin

		const row = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(id) as {
			last_used_at: string | null;
		};
		expect(row.last_used_at).not.toBeNull();
	});

	it('returns null for unknown, unprefixed, or empty tokens', () => {
		expect(getApiTokenUser('')).toBeNull();
		expect(getApiTokenUser('not-a-cairn-token')).toBeNull();
		expect(getApiTokenUser(TOKEN_PREFIX + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
	});

	it('rejects an expired token and deletes its row', () => {
		const { token, id } = createApiToken(userId, 'short-lived', 1);
		db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			id
		);
		expect(getApiTokenUser(token)).toBeNull();
		expect(db.prepare('SELECT 1 FROM api_tokens WHERE id = ?').get(id)).toBeUndefined();
	});

	it('rejects tokens of a disabled account', () => {
		const { token } = createApiToken(userId, 'soon disabled');
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
		expect(getApiTokenUser(token)).toBeNull();
	});

	it('rejects a revoked token immediately', () => {
		const { token, id } = createApiToken(userId, 'revoked');
		expect(getApiTokenUser(token)).not.toBeNull();
		expect(revokeApiToken(userId, id)).toBe(true);
		expect(getApiTokenUser(token)).toBeNull();
	});
});

describe('listApiTokens / revokeApiToken', () => {
	it('lists metadata only, newest first', () => {
		createApiToken(userId, 'first');
		createApiToken(userId, 'second');
		const tokens = listApiTokens(userId);
		expect(tokens.map((t) => t.name)).toEqual(['second', 'first']);
		for (const t of tokens) {
			expect(t).not.toHaveProperty('token');
			expect(t).not.toHaveProperty('token_hash');
		}
	});

	it('cannot revoke another user\'s token', async () => {
		const other = (
			await registerUser({
				email: 'other@example.com',
				password: 'correct horse battery',
				displayName: 'Other'
			})
		).id;
		const { id } = createApiToken(userId, 'mine');
		expect(revokeApiToken(other, id)).toBe(false);
		expect(listApiTokens(userId)).toHaveLength(1);
	});
});

describe('requireUser Bearer integration', () => {
	function bearerEvent(authorization: string | null, ip = '192.0.2.1'): RequestEvent {
		return {
			locals: { user: null, flags: {} },
			request: new Request('http://cairn.test/api/whatever', {
				headers: authorization ? { authorization } : {}
			}),
			getClientAddress: () => ip
		} as unknown as RequestEvent;
	}

	function statusOf(fn: () => void): number | undefined {
		try {
			fn();
		} catch (e) {
			return (e as { status?: number }).status;
		}
		return undefined;
	}

	it('resolves a Bearer token to the same user context as the cookie path', () => {
		const { token } = createApiToken(userId, 'integration');
		const event = bearerEvent(`Bearer ${token}`);
		const user = requireUser(event);
		expect(user.id).toBe(userId);
		// Locals populated like the hooks cookie path — downstream guards agree.
		expect(event.locals.user?.id).toBe(userId);
		expect(event.locals.flags).toBeTruthy();
		// The first user is the admin, so the admin guard passes on the same event.
		expect(requireAdmin(event).id).toBe(userId);
	});

	it('401s a revoked token immediately', () => {
		const { token, id } = createApiToken(userId, 'to revoke');
		expect(statusOf(() => requireUser(bearerEvent(`Bearer ${token}`)))).toBeUndefined();
		revokeApiToken(userId, id);
		expect(statusOf(() => requireUser(bearerEvent(`Bearer ${token}`)))).toBe(401);
	});

	it('401s garbage tokens and 429s an IP that keeps guessing', () => {
		const ip = '198.51.100.7';
		for (let i = 0; i < 20; i++) {
			expect(statusOf(() => requireUser(bearerEvent(`Bearer ${TOKEN_PREFIX}nope${i}`, ip)))).toBe(401);
		}
		expect(statusOf(() => requireUser(bearerEvent(`Bearer ${TOKEN_PREFIX}nope-final`, ip)))).toBe(429);
	});

	it('401s with the generic message when no credential of any kind is sent', () => {
		expect(statusOf(() => requireUser(bearerEvent(null)))).toBe(401);
	});
});

describe('bearer failure throttling', () => {
	it('throttles an IP after repeated failures and clears on success', () => {
		const ip = `10.0.0.${Math.floor(Math.random() * 250)}`;
		expect(bearerRetryAfter(ip)).toBeNull();
		for (let i = 0; i < 20; i++) noteBearerFailure(ip);
		expect(bearerRetryAfter(ip)).toBeGreaterThan(0);
		noteBearerSuccess(ip);
		expect(bearerRetryAfter(ip)).toBeNull();
	});
});
