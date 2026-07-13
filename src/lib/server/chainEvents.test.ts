// cairn-ylam: chainEvents.ts had zero test coverage of its own — chain.test.ts
// mocks it entirely (`vi.mock('../chainEvents', ...)`) so nothing exercises the
// real listener bodies. This file drives a fake Electrum event emitter through
// connect/disconnect/header sequences and asserts the three things the module
// promises: invalidateTipCache() fires only on a strictly-higher block header,
// connect/disconnect are deduped to real state CHANGES (not every flap/replay),
// and the admin outage alert is debounced behind a 60s grace timer that a
// reconnect within the window cancels.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ElectrumHeader } from './electrum/client';
import type { ElectrumPool } from './electrum/pool';

const recordActivityMock = vi.fn();
const invalidateTipCacheMock = vi.fn();
const notifyMock = vi.fn();

vi.mock('./activity', () => ({ recordActivity: (...a: unknown[]) => recordActivityMock(...a) }));
vi.mock('./chain/cache', () => ({ invalidateTipCache: (...a: unknown[]) => invalidateTipCacheMock(...a) }));
vi.mock('./notifications', () => ({ notify: (...a: unknown[]) => notifyMock(...a) }));

import { wireChainEvents, resetConnectionState } from './chainEvents';

class FakePool extends EventEmitter {
	server = 'fixture.example:50002';
}

function makePool(): FakePool {
	return new FakePool();
}

// Headers only ever go up in production; tests that care about dedup/ordering
// pull from a monotonically increasing counter so no test can accidentally
// collide with a height an earlier test already "observed" via the module's
// singleton lastBlockHeight (chainEvents has no reset hook for it — by design,
// mirroring real chain behaviour where heights never go backwards).
let nextHeight = 1000;
function freshHeight(): number {
	nextHeight += 10;
	return nextHeight;
}

function header(height: number): ElectrumHeader {
	return { height, hex: '00'.repeat(80) } as ElectrumHeader;
}

beforeEach(() => {
	vi.clearAllMocks();
	resetConnectionState();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('connect / disconnect: dedup to real state changes', () => {
	it('records network_up on the first connect', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('connect');

		expect(recordActivityMock).toHaveBeenCalledTimes(1);
		expect(recordActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'network_up', level: 'success' })
		);
	});

	it('does not re-record network_up on a repeat connect while already connected (reconnect replay)', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('connect');
		recordActivityMock.mockClear();

		pool.emit('connect'); // e.g. a resubscribe replay firing 'connect' again
		expect(recordActivityMock).not.toHaveBeenCalled();
	});

	it('records network_down on the first disconnect, and does not repeat on a second disconnect while already down', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('connect');
		recordActivityMock.mockClear();

		pool.emit('disconnect');
		expect(recordActivityMock).toHaveBeenCalledTimes(1);
		expect(recordActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'network_down', level: 'warn' })
		);

		recordActivityMock.mockClear();
		pool.emit('disconnect');
		expect(recordActivityMock).not.toHaveBeenCalled();
	});

	it('records network_up again after a genuine disconnect -> reconnect cycle', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('connect');
		pool.emit('disconnect');
		recordActivityMock.mockClear();

		pool.emit('connect');
		expect(recordActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'network_up' })
		);
	});
});

describe('outage alert: debounced behind the grace timer', () => {
	it('does not alert an admin before the grace window elapses', () => {
		vi.useFakeTimers();
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('disconnect');

		vi.advanceTimersByTime(59_000);
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('fires exactly one admin_server_health alert once the connection is still down past the grace window', () => {
		vi.useFakeTimers();
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('disconnect');

		vi.advanceTimersByTime(60_000);
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'admin_server_health',
				userId: null,
				level: 'error',
				title: 'Bitcoin node connection down'
			})
		);

		// Latched: further time passing while still down must not re-alert.
		vi.advanceTimersByTime(120_000);
		expect(notifyMock).toHaveBeenCalledTimes(1);
	});

	it('a reconnect WITHIN the grace window cancels the pending alert entirely', () => {
		vi.useFakeTimers();
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('disconnect');

		vi.advanceTimersByTime(30_000);
		pool.emit('connect'); // reconnect before the 60s grace window elapses

		vi.advanceTimersByTime(120_000);
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('sends a "connection restored" notification on the reconnect that follows a fired alert, and re-arms for the next outage', () => {
		vi.useFakeTimers();
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('disconnect');
		vi.advanceTimersByTime(60_000); // outage alert fires, healthAlerted latches true
		notifyMock.mockClear();

		pool.emit('connect');
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'admin_server_health',
				level: 'success',
				title: 'Bitcoin node connection restored'
			})
		);

		// Latch cleared: a SECOND outage that also runs out the grace window must
		// alert again, not be silently suppressed by the earlier latch.
		notifyMock.mockClear();
		pool.emit('disconnect');
		vi.advanceTimersByTime(60_000);
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
	});

	it('resetConnectionState cancels a pending alert and clears the latch (client-swap path)', () => {
		vi.useFakeTimers();
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		pool.emit('disconnect');
		vi.advanceTimersByTime(60_000); // alert fires, latches
		notifyMock.mockClear();

		resetConnectionState(); // reconfigureChain tearing down the old client
		vi.advanceTimersByTime(120_000);
		expect(notifyMock).not.toHaveBeenCalled(); // no delayed/duplicate alert

		// The next client's first connect is treated as fresh (not suppressed by
		// stale "already connected" state) and does NOT claim a "restored" alert
		// (the latch was cleared, not fired-and-recovered).
		const freshPool = makePool();
		wireChainEvents(freshPool as unknown as ElectrumPool);
		freshPool.emit('connect');
		expect(notifyMock).not.toHaveBeenCalled();
		expect(recordActivityMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'network_up' }));
	});
});

describe('header: invalidateTipCache + new_block only on a strictly-higher height', () => {
	it('invalidates the tip cache and records new_block on the first sight of a height', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		const h = freshHeight();

		pool.emit('header', header(h));

		expect(invalidateTipCacheMock).toHaveBeenCalledTimes(1);
		expect(recordActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'new_block', detail: { height: h } })
		);
	});

	it('does NOT re-fire for the same height replayed (reconnect resubscription re-emitting the current tip)', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		const h = freshHeight();
		pool.emit('header', header(h));
		invalidateTipCacheMock.mockClear();
		recordActivityMock.mockClear();

		pool.emit('header', header(h));
		expect(invalidateTipCacheMock).not.toHaveBeenCalled();
		expect(recordActivityMock).not.toHaveBeenCalled();
	});

	it('does NOT fire for a height lower than one already observed (an out-of-order / stale replay)', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		const high = freshHeight();
		pool.emit('header', header(high));
		invalidateTipCacheMock.mockClear();
		recordActivityMock.mockClear();

		pool.emit('header', header(high - 5));
		expect(invalidateTipCacheMock).not.toHaveBeenCalled();
		expect(recordActivityMock).not.toHaveBeenCalled();
	});

	it('fires again for a genuinely higher height, preserving ordering across a run of blocks', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);
		const base = freshHeight();
		pool.emit('header', header(base));
		invalidateTipCacheMock.mockClear();
		recordActivityMock.mockClear();

		pool.emit('header', header(base + 1));
		expect(invalidateTipCacheMock).toHaveBeenCalledTimes(1);
		expect(recordActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'new_block', detail: { height: base + 1 } })
		);
	});

	it('ignores a malformed header (missing/non-numeric height) without throwing or firing anything', () => {
		const pool = makePool();
		wireChainEvents(pool as unknown as ElectrumPool);

		expect(() => pool.emit('header', null)).not.toThrow();
		expect(() => pool.emit('header', {})).not.toThrow();
		expect(() => pool.emit('header', { height: 'not-a-number' })).not.toThrow();

		expect(invalidateTipCacheMock).not.toHaveBeenCalled();
		expect(recordActivityMock).not.toHaveBeenCalled();
	});
});
