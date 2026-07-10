// Unit tests for the Bitcoin Core JSON-RPC client. The HTTP layer is stubbed by
// replacing global fetch (same approach chain.test.ts uses for EsploraApi), so
// these pin down: request shape (envelope + Basic-auth header), result parsing,
// JSON-RPC error → CoreRpcError with its code, HTTP 401 → cookie file re-read +
// retry, the unwrapped-cause transport-error message, and ping() never throwing.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Cookie-file auth reads from disk via node:fs/promises — mock it so the 401
// re-read path is observable and no real file is touched.
const readFileMock = vi.fn(async (..._args: unknown[]) => 'cookieuser:cookiepass\n');
vi.mock('node:fs/promises', () => ({ readFile: (...args: unknown[]) => readFileMock(...args) }));

import { CoreRpcClient, CoreRpcError } from './client';

const RPC_URL = 'http://127.0.0.1:8332';

/** A fetch Response stand-in carrying a status and a JSON (or raw string) body. */
function jsonResponse(status: number, body: unknown) {
	return {
		status,
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
	};
}

/** Capture calls and drive fetch from a queue of responses (or a single one). */
function stubFetch(
	responder: (url: string, init: RequestInit) => ReturnType<typeof jsonResponse>
): ReturnType<typeof vi.fn> {
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
});

// ---- successful call --------------------------------------------------------------

describe('call() success path', () => {
	it('parses the JSON-RPC result and sends the right envelope + auth header', async () => {
		const fetchFn = stubFetch(() =>
			jsonResponse(200, { result: { blocks: 868_000, chain: 'main' }, error: null, id: 1 })
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'rpcuser', pass: 'rpcpass' });

		const info = await client.getBlockchainInfo();
		expect(info).toEqual({ blocks: 868_000, chain: 'main' });

		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(RPC_URL);
		expect(init.method).toBe('POST');
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({ jsonrpc: '1.0', method: 'getblockchaininfo', params: [] });
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe(
			'Basic ' + Buffer.from('rpcuser:rpcpass').toString('base64')
		);
	});

	it('passes wrapper params through in order', async () => {
		const fetchFn = stubFetch(() => jsonResponse(200, { result: 'abcd', error: null }));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		await client.getBlockHash(700_000);
		const body = JSON.parse(String((fetchFn.mock.calls[0][1] as RequestInit).body));
		expect(body).toMatchObject({ method: 'getblockhash', params: [700_000] });
	});

	it('returns null from gettxout for a spent/nonexistent output', async () => {
		stubFetch(() => jsonResponse(200, { result: null, error: null }));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });
		await expect(client.getTxOut('a'.repeat(64), 0)).resolves.toBeNull();
	});
});

// ---- JSON-RPC error ---------------------------------------------------------------

describe('JSON-RPC error handling', () => {
	it('throws CoreRpcError carrying the numeric code (-5 not found)', async () => {
		stubFetch(() =>
			jsonResponse(500, { result: null, error: { code: -5, message: 'No such transaction' } })
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const err = await client.getRawTransaction('b'.repeat(64)).then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(CoreRpcError);
		expect(err.code).toBe(-5);
		expect(err.method).toBe('getrawtransaction');
		expect(err.message).toContain('No such transaction');
	});

	it('surfaces the -28 warming-up code', async () => {
		stubFetch(() =>
			jsonResponse(503, { result: null, error: { code: -28, message: 'Loading block index…' } })
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });
		await expect(client.getBlockCount()).rejects.toMatchObject({ code: -28 });
	});
});

// ---- 401 → cookie re-read ---------------------------------------------------------

describe('cookie-file auth and 401 re-read', () => {
	it('re-reads the cookie file once on a 401 and retries the request', async () => {
		let call = 0;
		const fetchFn = stubFetch((_url, init) => {
			call += 1;
			// Assert the request actually carried the cookie-derived Basic header.
			const headers = init.headers as Record<string, string>;
			expect(headers.authorization).toBe(
				'Basic ' + Buffer.from('cookieuser:cookiepass').toString('base64')
			);
			return call === 1
				? jsonResponse(401, 'Unauthorized')
				: jsonResponse(200, { result: 12, error: null });
		});
		const client = new CoreRpcClient({ url: RPC_URL, cookiePath: '/data/.cookie' });

		await expect(client.getBlockCount()).resolves.toBe(12);
		// Two HTTP attempts (original + retry), and the cookie file read twice:
		// once for the initial auth header, once after the 401 dropped the cache.
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(readFileMock).toHaveBeenCalledTimes(2);
		expect(readFileMock).toHaveBeenCalledWith('/data/.cookie', 'utf8');
	});

	it('throws a clear 401 error when the retry still fails auth', async () => {
		stubFetch(() => jsonResponse(401, 'Unauthorized'));
		const client = new CoreRpcClient({ url: RPC_URL, cookiePath: '/data/.cookie' });
		await expect(client.getBlockCount()).rejects.toThrow(/401 Unauthorized/);
	});

	it('caches cookie creds across successful calls (no re-read without a 401)', async () => {
		stubFetch(() => jsonResponse(200, { result: 1, error: null }));
		const client = new CoreRpcClient({ url: RPC_URL, cookiePath: '/data/.cookie' });

		await client.getBlockCount();
		await client.getBlockCount();
		// Read once, then served from the in-memory cache.
		expect(readFileMock).toHaveBeenCalledTimes(1);
	});
});

// ---- transport error unwrapping ---------------------------------------------------

describe('transport error diagnostics', () => {
	it('includes the unwrapped .cause chain, not a bare "fetch failed"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				// Shape of a real undici DNS failure: opaque outer TypeError, real
				// reason one .cause deep with a code.
				const cause = Object.assign(new Error('getaddrinfo ENOTFOUND bitcoind.local'), {
					code: 'ENOTFOUND'
				});
				throw new TypeError('fetch failed', { cause });
			})
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const err = await client.getBlockCount().then(
			() => null,
			(e) => e
		);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain('getaddrinfo ENOTFOUND bitcoind.local');
		expect(err.message).toContain('ENOTFOUND');
		expect(err.message).not.toBe('fetch failed');
	});
});

// ---- ping() never throws ----------------------------------------------------------

describe('ping()', () => {
	it('reports ok with the block height on success', async () => {
		stubFetch(() => jsonResponse(200, { result: { blocks: 868_123, chain: 'main' }, error: null }));
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });
		await expect(client.ping()).resolves.toEqual({ ok: true, blocks: 868_123 });
	});

	it('resolves (never throws) with an error string when the node is unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed', {
					cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8332'), {
						code: 'ECONNREFUSED'
					})
				});
			})
		);
		const client = new CoreRpcClient({ url: RPC_URL, user: 'u', pass: 'p' });

		const res = await client.ping();
		expect(res.ok).toBe(false);
		expect(res.error).toContain('ECONNREFUSED');
	});
});
