// Edge-case gaps for the Bitcoin Core JSON-RPC client NOT already covered by
// client.test.ts (which owns: envelope/auth shape, cookie-file 401 retry, -5/
// -28 JSON-RPC error codes, .cause transport-error unwrapping, ping() never
// throwing). This file adds: HTTP 403 (rpcallowip-style rejection), a
// malformed/invalid RPC URL, the AbortController request-timeout path, and
// empty/non-JSON response bodies (both 2xx and non-2xx). Same stubGlobal
// fetch approach as client.test.ts — no real sockets.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const readFileMock = vi.fn(async (..._args: unknown[]) => 'cookieuser:cookiepass\n');
vi.mock('node:fs/promises', () => ({ readFile: (...args: unknown[]) => readFileMock(...args) }));

import { CoreRpcClient, CoreRpcError } from './client';

const RPC_URL = 'http://127.0.0.1:8332';

function jsonResponse(status: number, body: unknown) {
	return {
		status,
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
	};
}

function stubFetch(
	responder: (url: string, init: RequestInit) => ReturnType<typeof jsonResponse> | Promise<never>
) {
	const fn = vi.fn(async (url: unknown, init: unknown) =>
		responder(String(url), (init ?? {}) as RequestInit)
	);
	vi.stubGlobal('fetch', fn);
	return fn;
}

beforeEach(() => {
	readFileMock.mockClear();
	readFileMock.mockResolvedValue('cookieuser:cookiepass\n');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---- HTTP 403 (rpcallowip-style IP rejection) ---------------------------------------

describe('HTTP 403 handling', () => {
	it('surfaces a plain HTTP-status error (not a CoreRpcError) for a 403 rejection', async () => {
		stubFetch(() => jsonResponse(403, 'Forbidden by rpcallowip'));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const err = await client.getBlockCount().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(CoreRpcError);
		expect(err.message).toContain('HTTP 403');
		expect(err.message).toContain('Forbidden by rpcallowip');
	});

	it('does not attempt a cookie re-read/retry on 403 (that path is 401-only)', async () => {
		const fetchFn = stubFetch(() => jsonResponse(403, 'Forbidden'));
		const client = new CoreRpcClient({ url: RPC_URL, cookiePath: '/data/.cookie' });

		await client.getBlockCount().catch(() => {});

		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});

// ---- malformed / invalid URL ----------------------------------------------------------

describe('malformed/invalid RPC URL', () => {
	it('wraps a fetch-time "Invalid URL" TypeError into a diagnosable transport error', async () => {
		// Real fetch throws a TypeError synchronously-in-the-promise for a garbage
		// URL; simulate that shape without touching the network.
		stubFetch(() => {
			throw new TypeError('Failed to parse URL from not-a-real-url');
		});
		const client = new CoreRpcClient({ url: 'not-a-real-url', user: 'u', pass: 'p' });

		const err = await client.getBlockCount().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain('request failed');
		expect(err.message).toContain('Failed to parse URL');
	});

	it('trims trailing slashes from the configured URL before use (construction does not throw)', () => {
		expect(() => new CoreRpcClient({ url: 'http://127.0.0.1:8332///', user: 'u', pass: 'p' })).not.toThrow();
	});

	it('an empty-string URL still constructs without throwing (fails lazily on first call instead)', async () => {
		stubFetch(() => {
			throw new TypeError('Failed to parse URL from ');
		});
		const client = new CoreRpcClient({ url: '', user: 'u', pass: 'p' });
		await expect(client.getBlockCount()).rejects.toThrow(/request failed/);
	});
});

// ---- request timeout via AbortController ----------------------------------------------

describe('request timeout (AbortController)', () => {
	it('aborts and surfaces a diagnosable error once the configured timeout elapses', async () => {
		vi.useFakeTimers();
		stubFetch((_url, init) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					const err = new DOMException('This operation was aborted', 'AbortError');
					reject(err);
				});
			}) as Promise<never>;
		});
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p', timeoutMs: 500 });

		const pending = client.getBlockCount().then(
			() => null,
			(e) => e
		);
		await vi.advanceTimersByTimeAsync(600);
		const err = await pending;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain('request failed');
		expect(err.message.toLowerCase()).toContain('abort');
	});

	it('does not fire the abort (and resolves normally) when the response lands before the timeout', async () => {
		vi.useFakeTimers();
		stubFetch(() => jsonResponse(200, { result: 42, error: null }));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p', timeoutMs: 5_000 });

		const pending = client.getBlockCount();
		await vi.advanceTimersByTimeAsync(10);
		await expect(pending).resolves.toBe(42);
	});
});

// ---- HTTP 500 with a JSON-RPC error body (distinct from a bare-status 500) ------------

describe('HTTP 500 / non-2xx with a JSON-RPC error envelope', () => {
	it('prefers the structured JSON-RPC error over the bare HTTP status on a 500', async () => {
		stubFetch(() =>
			jsonResponse(500, { result: null, error: { code: -1, message: 'Generic internal error' } })
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const err = await client.getBlockCount().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(CoreRpcError);
		expect(err.code).toBe(-1);
		expect(err.message).toContain('Generic internal error');
	});
});

// ---- empty / non-JSON response bodies -------------------------------------------------

describe('empty / non-JSON response bodies', () => {
	it('a 200 with an empty body throws "unparseable response", not a silent success', async () => {
		stubFetch(() => jsonResponse(200, ''));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		await expect(client.getBlockCount()).rejects.toThrow(/unparseable response/);
	});

	it('a 200 with non-JSON garbage throws "unparseable response"', async () => {
		stubFetch(() => jsonResponse(200, '<html>not json</html>'));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		await expect(client.getBlockCount()).rejects.toThrow(/unparseable response/);
	});

	it('a non-2xx status with non-JSON garbage throws the bare-HTTP-status error, not "unparseable"', async () => {
		stubFetch(() => jsonResponse(502, 'Bad Gateway'));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const err = await client.getBlockCount().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(CoreRpcError);
		expect(err.message).toContain('HTTP 502');
		expect(err.message).toContain('Bad Gateway');
	});

	it('a 200 whose body is valid JSON but not the JSON-RPC shape (no result/error keys) still resolves — result is undefined', async () => {
		stubFetch(() => jsonResponse(200, { unexpected: 'shape' }));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		// parsed.error is undefined (not present) so the error branch is skipped;
		// status is 2xx so it resolves with `result` (also undefined) rather than
		// throwing "unparseable" — pinning this actual (if surprising) behavior.
		await expect(client.getBlockCount()).resolves.toBeUndefined();
	});
});
