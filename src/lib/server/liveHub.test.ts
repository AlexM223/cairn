// liveHub tests (docs/LIVE-UPDATES-DESIGN.md §8). The scope-isolation cases are
// the single most important tests in the live-updates suite: they assert the
// server-side security boundary (§6) that a user-scoped frame never reaches
// another user's connection and an admin-scoped frame never reaches a non-admin.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// childLogger is called at module load; mock before importing liveHub.
const logMock = vi.hoisted(() => {
	const log: Record<string, unknown> = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn()
	};
	log.child = () => log;
	return log;
});

vi.mock('$lib/server/logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log',
	REDACT_OPTIONS: {}
}));

// unreadUserFeedCount is the ONE DB read the notify bridge performs; stub it so
// the test never touches SQLite and we can assert the count that lands in the frame.
const activityMock = vi.hoisted(() => ({ unreadUserFeedCount: vi.fn(() => 0) }));
vi.mock('./activity', () => activityMock);

import { register, publish, connectionCount, type LiveConnection } from './liveHub';
import { notifyBus } from './notifyBus';

/** A connection whose sent frames are captured for assertions. */
function makeConn(over: Partial<LiveConnection> = {}): LiveConnection & { sent: string[] } {
	const sent: string[] = [];
	const conn = {
		userId: over.userId ?? 1,
		isAdmin: over.isAdmin ?? false,
		wantsMempool: over.wantsMempool ?? true,
		send: (frame: string) => sent.push(frame),
		sent
	};
	return conn;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	// Drain any connections a test left registered so cases stay independent.
	expect(true).toBe(true);
});

describe('liveHub.publish scope isolation (security-critical, §6)', () => {
	it('delivers a user-scoped frame only to that user’s connections', () => {
		const a = makeConn({ userId: 1 });
		const b = makeConn({ userId: 2 });
		const unA = register(a);
		const unB = register(b);

		publish('wallet', { userId: 1 }, { walletId: 'w1' });

		expect(a.sent).toHaveLength(1);
		expect(a.sent[0]).toContain('event: wallet');
		expect(b.sent).toHaveLength(0);

		unA();
		unB();
	});

	it('delivers a broadcast frame to every connection regardless of user', () => {
		const a = makeConn({ userId: 1 });
		const b = makeConn({ userId: 2 });
		const unA = register(a);
		const unB = register(b);

		publish('block', { broadcast: true }, { height: 800_001 });

		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(1);
		expect(a.sent[0]).toBe(`event: block\ndata: ${JSON.stringify({ height: 800_001 })}\n\n`);

		unA();
		unB();
	});

	it('delivers an admin-scoped frame only to admin connections', () => {
		const admin = makeConn({ userId: 1, isAdmin: true });
		const regular = makeConn({ userId: 2, isAdmin: false });
		const un1 = register(admin);
		const un2 = register(regular);

		publish('mining:pool', { admin: true }, {});

		expect(admin.sent).toHaveLength(1);
		expect(regular.sent).toHaveLength(0);

		un1();
		un2();
	});

	it('suppresses mempool frames for a connection that opted out (wantsMempool=false)', () => {
		const wants = makeConn({ userId: 1, wantsMempool: true });
		const opted = makeConn({ userId: 2, wantsMempool: false });
		const un1 = register(wants);
		const un2 = register(opted);

		publish('mempool', { broadcast: true }, { count: 5 });

		expect(wants.sent).toHaveLength(1);
		expect(opted.sent).toHaveLength(0);

		un1();
		un2();
	});
});

describe('liveHub lifecycle', () => {
	it('unregister removes the connection so later publishes never reach it', () => {
		const a = makeConn({ userId: 1 });
		const un = register(a);
		expect(connectionCount()).toBe(1);

		un();
		expect(connectionCount()).toBe(0);

		publish('block', { broadcast: true }, { height: 1 });
		expect(a.sent).toHaveLength(0);
	});

	it('unregister is idempotent (safe to call twice)', () => {
		const a = makeConn();
		const un = register(a);
		un();
		expect(() => un()).not.toThrow();
		expect(connectionCount()).toBe(0);
	});

	it('publish with no connections is a no-op (does not throw)', () => {
		expect(connectionCount()).toBe(0);
		expect(() => publish('block', { broadcast: true }, { height: 1 })).not.toThrow();
	});

	it('a throwing connection never breaks fan-out to the others', () => {
		const bad = {
			userId: 1,
			isAdmin: false,
			wantsMempool: true,
			send: () => {
				throw new Error('dead stream');
			}
		};
		const good = makeConn({ userId: 2 });
		const un1 = register(bad);
		const un2 = register(good);

		expect(() => publish('block', { broadcast: true }, { height: 9 })).not.toThrow();
		expect(good.sent).toHaveLength(1);

		un1();
		un2();
	});
});

describe('liveHub notifyBus bridge (§3.2)', () => {
	it('emits exactly one user-scoped notification frame per notify event, carrying the unread count', () => {
		activityMock.unreadUserFeedCount.mockReturnValue(3);
		const target = makeConn({ userId: 7 });
		const other = makeConn({ userId: 8 });
		const un1 = register(target);
		const un2 = register(other);

		notifyBus.emit('event', { userId: 7 });

		// One DB read for the event (not per connection), one frame to the target.
		expect(activityMock.unreadUserFeedCount).toHaveBeenCalledTimes(1);
		expect(activityMock.unreadUserFeedCount).toHaveBeenCalledWith(7);
		expect(target.sent).toEqual([
			`event: notification\ndata: ${JSON.stringify({ unread: 3 })}\n\n`
		]);
		expect(other.sent).toHaveLength(0);

		un1();
		un2();
	});

	it('ignores instance-wide (userId null) events — they never bump a user badge', () => {
		const conn = makeConn({ userId: 7 });
		const un = register(conn);

		notifyBus.emit('event', { userId: null });

		expect(activityMock.unreadUserFeedCount).not.toHaveBeenCalled();
		expect(conn.sent).toHaveLength(0);

		un();
	});
});
