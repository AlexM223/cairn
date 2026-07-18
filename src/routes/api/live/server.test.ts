// GET /api/live handler tests (docs/LIVE-UPDATES-DESIGN.md §8), mirroring the
// /api/events server.test.ts style: connect primes the current block tip and the
// session user's unread count, the heartbeat pings and detects a swapped client,
// and cleanup on abort removes the connection from liveHub and is idempotent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const chainMocks = vi.hoisted(() => ({ getChain: vi.fn() }));
vi.mock('$lib/server/chain', () => ({ getChain: chainMocks.getChain }));

// The connect-time unread prime; stub so the handler never touches SQLite.
const activityMock = vi.hoisted(() => ({ unreadUserFeedCount: vi.fn(() => 4) }));
vi.mock('$lib/server/activity', () => activityMock);

import { GET } from './+server';
import { connectionCount } from '$lib/server/liveHub';

type Ev = Parameters<typeof GET>[0];

function makeElectrum() {
	return {
		headersSubscribe: vi.fn(async () => ({ height: 100, hex: '00'.repeat(80) })),
		on: vi.fn(),
		off: vi.fn()
	};
}

function makeEvent(topics?: string): Ev {
	const url = topics ? `http://localhost/api/live?topics=${topics}` : 'http://localhost/api/live';
	return {
		locals: { user: { id: 1, email: 'user@example.com', displayName: 'User', isAdmin: false } },
		params: {},
		url: new URL(url),
		request: new Request(url)
	} as unknown as Ev;
}

const decode = (v: Uint8Array | undefined) => new TextDecoder().decode(v);

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('GET /api/live', () => {
	it('primes the current block tip and the unread count on connect, then registers', async () => {
		const electrum = makeElectrum();
		chainMocks.getChain.mockReturnValue({ electrum });

		const before = connectionCount();
		const res = await GET(makeEvent());
		const reader = res.body!.getReader();

		await vi.advanceTimersByTimeAsync(0);

		// First frame: current tip height.
		const first = await reader.read();
		expect(decode(first.value)).toBe(`event: block\ndata: ${JSON.stringify({ height: 100 })}\n\n`);

		// Second frame: primed unread count for the session user.
		const second = await reader.read();
		expect(decode(second.value)).toBe(
			`event: notification\ndata: ${JSON.stringify({ unread: 4 })}\n\n`
		);
		expect(activityMock.unreadUserFeedCount).toHaveBeenCalledWith(1);

		// The connection is now registered with the hub.
		expect(connectionCount()).toBe(before + 1);

		await reader.cancel();
	});

	it('does NOT attach its own electrum header listener (fan-out is process-level)', async () => {
		const electrum = makeElectrum();
		chainMocks.getChain.mockReturnValue({ electrum });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);

		expect(electrum.on).not.toHaveBeenCalled();

		await reader.cancel();
	});

	it('sends a heartbeat ping and stays open on the normal path', async () => {
		const electrum = makeElectrum();
		chainMocks.getChain.mockReturnValue({ electrum });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // block prime
		await reader.read(); // notification prime

		await vi.advanceTimersByTimeAsync(25_000);

		const { done, value } = await reader.read();
		expect(done).toBe(false);
		expect(decode(value)).toBe(': ping\n\n');

		await reader.cancel();
	});

	it('ends the stream cleanly when the heartbeat detects a swapped client (reconfigureChain)', async () => {
		const electrum = makeElectrum();
		const swapped = makeElectrum();
		chainMocks.getChain.mockReturnValueOnce({ electrum }).mockReturnValue({ electrum: swapped });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // block prime
		await reader.read(); // notification prime

		await vi.advanceTimersByTimeAsync(25_000);

		const { done } = await reader.read();
		expect(done).toBe(true);
		expect(logMock.warn).not.toHaveBeenCalled();
	});

	it('removes the connection from the hub on abort, idempotently', async () => {
		const electrum = makeElectrum();
		chainMocks.getChain.mockReturnValue({ electrum });

		const req = makeEvent();
		const before = connectionCount();
		const res = await GET(req);
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		expect(connectionCount()).toBe(before + 1);

		// Simulate the platform surfacing a disconnect via the abort signal.
		(req.request.signal as unknown as EventTarget).dispatchEvent(new Event('abort'));
		expect(connectionCount()).toBe(before);

		// Cancelling the reader afterwards (second cleanup path) must be safe.
		await expect(reader.cancel()).resolves.toBeUndefined();
		expect(connectionCount()).toBe(before);
	});

	// --- Electrum-down resilience (cairn-yc87) -------------------------------

	it('keeps the stream OPEN when tip prime fails: nudges health degraded, still primes notification, still registers', async () => {
		const electrum = makeElectrum();
		electrum.headersSubscribe.mockRejectedValue(new Error('connect timed out'));
		chainMocks.getChain.mockReturnValue({ electrum });

		const before = connectionCount();
		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);

		// First frame: a degraded `health` nudge (NOT an error frame, NOT a close).
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(decode(first.value)).toBe(
			`event: health\ndata: ${JSON.stringify({ electrum: 'down', tipHeight: 0, tipAgeMs: null })}\n\n`
		);

		// Second frame: the unread prime still flows — it's Electrum-independent.
		const second = await reader.read();
		expect(decode(second.value)).toBe(
			`event: notification\ndata: ${JSON.stringify({ unread: 4 })}\n\n`
		);

		// The connection is registered with the hub despite the failed prime, so
		// hub-fanned frames (block/health/notification/mempool/...) reach it once
		// Electrum recovers.
		expect(connectionCount()).toBe(before + 1);

		await reader.cancel();
	});

	it('does NOT end the stream on tip prime failure — heartbeat still pings', async () => {
		const electrum = makeElectrum();
		electrum.headersSubscribe.mockRejectedValue(new Error('ECONNREFUSED'));
		chainMocks.getChain.mockReturnValue({ electrum });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // health degraded nudge
		await reader.read(); // notification prime

		// Advance to the heartbeat. Background tip-retries in this window fail
		// silently (no frame), so the next readable frame is the ping — proving
		// the connection is still open, not reconnect-looping.
		await vi.advanceTimersByTimeAsync(25_000);
		const { done, value } = await reader.read();
		expect(done).toBe(false);
		expect(decode(value)).toBe(': ping\n\n');

		await reader.cancel();
	});

	it('background retry recovers: emits the tip block frame and a health-up nudge once Electrum comes back', async () => {
		const electrum = makeElectrum();
		// Fail the connect-time prime, then succeed on the first background retry.
		electrum.headersSubscribe
			.mockRejectedValueOnce(new Error('connect timed out'))
			.mockResolvedValue({ height: 200, hex: '00'.repeat(80) });
		chainMocks.getChain.mockReturnValue({ electrum });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // health degraded nudge
		await reader.read(); // notification prime

		// First retry fires at TIP_RETRY_MIN_MS (5s) and succeeds.
		await vi.advanceTimersByTimeAsync(5_000);

		const block = await reader.read();
		expect(decode(block.value)).toBe(`event: block\ndata: ${JSON.stringify({ height: 200 })}\n\n`);

		const recovered = await reader.read();
		expect(decode(recovered.value)).toBe(
			`event: health\ndata: ${JSON.stringify({ electrum: 'up', tipHeight: 0, tipAgeMs: null })}\n\n`
		);

		await reader.cancel();
	});
});
