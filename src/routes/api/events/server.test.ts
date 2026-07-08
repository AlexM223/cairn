// cairn-ldvt — the SSE heartbeat setInterval callback calls getChain()
// unguarded. getChain() lazily rebuilds the ChainService when
// reconfigureChain() nulled the singleton, and that construction can throw —
// synchronously, inside a raw setInterval callback with no local handler. An
// uncaught throw there would escape to the process-level crash guard and take
// the whole process down, killing every connected user's stream. The fix
// wraps the heartbeat body in try/catch: on any throw, log a warning and end
// just THIS stream so the browser's EventSource reconnects to a fresh
// handler. These tests simulate that failure and assert it stays contained.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// childLogger('events') is called at module load time (top of +server.ts), so
// the mock must be installed before the route is imported (vi.mock hoists).
// Mirrors the logMock pattern used in
// src/routes/api/wallets/[id]/transactions/[txId]/broadcast/server.test.ts.
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
	return log as {
		warn: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
		fatal: ReturnType<typeof vi.fn>;
		child: () => unknown;
	};
});

vi.mock('$lib/server/logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log',
	REDACT_OPTIONS: {}
}));

const chainMocks = vi.hoisted(() => ({
	getChain: vi.fn()
}));

vi.mock('$lib/server/chain', () => ({
	getChain: chainMocks.getChain
}));

import { GET } from './+server';

type Ev = Parameters<typeof GET>[0];

/** A minimal stand-in for ChainService.electrum: just enough for the route. */
function makeElectrum() {
	return {
		headersSubscribe: vi.fn(async () => ({ height: 100, hex: '00'.repeat(80) })),
		on: vi.fn(),
		off: vi.fn()
	};
}

/** Minimal RequestEvent for the GET handler — signed-in user, no other locals needed. */
function makeEvent(): Ev {
	const url = 'http://localhost/api/events';
	return {
		locals: { user: { id: 1, email: 'user@example.com', displayName: 'User', isAdmin: false } },
		params: {},
		url: new URL(url),
		request: new Request(url)
	} as unknown as Ev;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('GET /api/events heartbeat resilience (cairn-ldvt)', () => {
	it('ends the stream cleanly, without an unhandled throw, when getChain() throws mid-heartbeat', async () => {
		const electrum = makeElectrum();
		// First call (pinning the client at the top of the handler) succeeds;
		// every later call — i.e. the heartbeat's — simulates reconfigureChain()
		// having nulled the singleton and reconstruction failing.
		chainMocks.getChain.mockReturnValueOnce({ electrum }).mockImplementation(() => {
			throw new Error('electrum construction failed (simulated)');
		});

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();

		// Let start()'s async setup (headersSubscribe, then registering the
		// header listener and the heartbeat interval) settle before advancing.
		await vi.advanceTimersByTimeAsync(0);
		// Drain the initial tip frame sent during start() so it doesn't mask the
		// stream-closed read below.
		await reader.read();

		// Advance past the heartbeat interval. If the fix's try/catch were
		// missing, getChain() throwing here would escape the timer callback and
		// this await would reject (fake-timers surfaces an uncaught callback
		// exception the same way a real setInterval would crash the process) —
		// which would fail this test.
		await vi.advanceTimersByTimeAsync(25_000);

		// The stream ended cleanly (controller.close() ran via endStream()).
		const { done } = await reader.read();
		expect(done).toBe(true);

		// Logged, not swallowed silently.
		expect(logMock.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			'sse heartbeat failed'
		);
		// cleanup() ran: the 'header' listener was removed.
		expect(electrum.off).toHaveBeenCalledWith('header', expect.any(Function));
	});

	it('still ends the stream cleanly (no throw) when getChain() merely reports a swapped client', async () => {
		const electrum = makeElectrum();
		const swapped = makeElectrum();
		chainMocks.getChain
			.mockReturnValueOnce({ electrum })
			.mockReturnValue({ electrum: swapped });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // drain the initial tip frame

		await vi.advanceTimersByTimeAsync(25_000);

		const { done } = await reader.read();
		expect(done).toBe(true);
		expect(logMock.warn).not.toHaveBeenCalled();
		expect(electrum.off).toHaveBeenCalledWith('header', expect.any(Function));
	});

	it('sends a heartbeat ping and stays open on the normal (non-throwing) path', async () => {
		const electrum = makeElectrum();
		chainMocks.getChain.mockReturnValue({ electrum });

		const res = await GET(makeEvent());
		const reader = res.body!.getReader();
		await vi.advanceTimersByTimeAsync(0);
		await reader.read(); // drain the initial tip frame

		await vi.advanceTimersByTimeAsync(25_000);

		const { done, value } = await reader.read();
		expect(done).toBe(false);
		expect(new TextDecoder().decode(value)).toBe(': ping\n\n');
		expect(logMock.warn).not.toHaveBeenCalled();
	});

	it('regression guard: an uncaught throw in a setInterval callback DOES surface as a rejection', async () => {
		// Sanity check for the "advance past the heartbeat" awaits above: proves
		// fake-timers actually propagates an uncaught callback exception, so a
		// clean (non-rejecting) advance in those tests is a meaningful assertion
		// of the try/catch fix — not a tautology. A bare setInterval with no
		// try/catch is exactly the pre-fix shape of the bug.
		let calls = 0;
		const bad = setInterval(() => {
			calls++;
			throw new Error('boom');
		}, 25_000);
		await expect(vi.advanceTimersByTimeAsync(25_000)).rejects.toThrow('boom');
		expect(calls).toBe(1);
		clearInterval(bad);
	});
});
