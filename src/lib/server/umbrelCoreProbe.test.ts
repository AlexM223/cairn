// Umbrel Bitcoin Core RPC detect-and-surface probe (Wave B, Unit B1 —
// docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md). Zero coverage existed for this
// module before this file. Mirrors the mocking/idioms of umbrelProbe.test.ts
// (Wave A, Electrum sibling): global fetch is stubbed (no real sockets), and
// each test restores CAIRN_PLATFORM afterwards.
//
// Covers the properties the module header calls out as its safety contract:
//  1. Detection fires on HTTP 401/403/200, and on 503 carrying Core's -28
//     warming-up fingerprint (but NOT a generic unrelated 503).
//  2. NOT detected — silently, no throw — on connection-refused / timeout /
//     DNS failure (any transport error).
//  3. Gating: only runs when CAIRN_PLATFORM === 'umbrel'; skips when
//     coreRpcConfigured() is already true; skips once `core_rpc_detected` is
//     set to ANY value, including 'dismissed'.
//  4. On detection, writes ONLY core_rpc_detected='umbrel' — no
//     core_rpc_url/user/pass, no connection_mode.
//  5. Never throws, even when the probe body itself would blow up on a
//     garbage response.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { db } from './db';
import { getSetting, setSetting } from './settings';

function stubFetch(impl: (...args: unknown[]) => unknown) {
	const fn = vi.fn(impl);
	vi.stubGlobal('fetch', fn);
	return fn;
}

const { probeAndDetectUmbrelCore, UMBREL_CORE_RPC_URL } = await import('./umbrelCoreProbe');

let savedPlatform: string | undefined;

beforeEach(() => {
	db.exec("DELETE FROM settings; DELETE FROM instance_secrets;");
	savedPlatform = process.env.CAIRN_PLATFORM;
	delete process.env.CAIRN_PLATFORM;
});

afterEach(() => {
	if (savedPlatform === undefined) delete process.env.CAIRN_PLATFORM;
	else process.env.CAIRN_PLATFORM = savedPlatform;
	vi.unstubAllGlobals();
});

// ---- platform / config / marker gating --------------------------------------------

describe('probeAndDetectUmbrelCore — gating', () => {
	it('never probes when CAIRN_PLATFORM is unset', async () => {
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));
		const applied = await probeAndDetectUmbrelCore();
		expect(applied).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('never probes when CAIRN_PLATFORM is set to something other than "umbrel"', async () => {
		process.env.CAIRN_PLATFORM = 'docker';
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));
		const applied = await probeAndDetectUmbrelCore();
		expect(applied).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('skips the probe when coreRpcConfigured() is already true', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('skips (no re-probe) once core_rpc_detected is already set to "umbrel"', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('core_rpc_detected', 'umbrel');
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('skips (no re-probe) once core_rpc_detected is set to "dismissed"', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('core_rpc_detected', 'dismissed');
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();
		// Idempotence: the dismissed marker is never overwritten back to 'umbrel'.
		expect(getSetting('core_rpc_detected')).toBe('dismissed');
	});
});

// ---- detection fingerprints ---------------------------------------------------------

describe('probeAndDetectUmbrelCore — detection fingerprints', () => {
	it('detects on HTTP 401 (bitcoind demanding auth) and seeds ONLY core_rpc_detected', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => 'Unauthorized' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual(['core_rpc_detected']);
		expect(getSetting('core_rpc_detected')).toBe('umbrel');
		expect(getSetting('core_rpc_url')).toBeNull();
		expect(getSetting('core_rpc_user')).toBeNull();
		expect(getSetting('core_rpc_pass')).toBeNull();
		expect(getSetting('connection_mode')).toBeNull();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Credential-free: no Authorization header sent.
		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(UMBREL_CORE_RPC_URL);
		expect((init.headers as Record<string, string>).authorization).toBeUndefined();
	});

	it('detects on HTTP 403 (disallowed-IP rejection — still a listener)', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({ status: 403, text: async () => 'Forbidden' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual(['core_rpc_detected']);
		expect(getSetting('core_rpc_detected')).toBe('umbrel');
	});

	it('detects on HTTP 200 (misconfigured unauthenticated node)', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({
			status: 200,
			text: async () => JSON.stringify({ result: { blocks: 1 }, error: null })
		}));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual(['core_rpc_detected']);
		expect(getSetting('core_rpc_detected')).toBe('umbrel');
		// Still marker-only, even on a 200 with a real-looking body.
		expect(getSetting('core_rpc_url')).toBeNull();
	});

	it('detects on HTTP 503 carrying the -28 warming-up JSON-RPC fingerprint', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({
			status: 503,
			text: async () => JSON.stringify({ error: { code: -28, message: 'Loading block index…' } })
		}));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual(['core_rpc_detected']);
		expect(getSetting('core_rpc_detected')).toBe('umbrel');
	});

	it('detects on HTTP 503 whose body says "Verifying blocks" without a -28 code', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({ status: 503, text: async () => 'Verifying blocks...' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual(['core_rpc_detected']);
	});

	it('does NOT detect on a generic 503 unrelated to the RPC warmup fingerprint', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({ status: 503, text: async () => 'Service Unavailable' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual([]);
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('does NOT detect on other HTTP statuses (e.g. 404/500 with no fingerprint)', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => ({ status: 404, text: async () => 'Not Found' }));

		const applied = await probeAndDetectUmbrelCore();

		expect(applied).toEqual([]);
		expect(getSetting('core_rpc_detected')).toBeNull();
	});
});

// ---- transport failures: silent, never throws ---------------------------------------

describe('probeAndDetectUmbrelCore — transport failures are silent', () => {
	it('is NOT detected on connection-refused, and does not throw', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => {
			throw Object.assign(new TypeError('fetch failed'), {
				cause: Object.assign(new Error('connect ECONNREFUSED 10.21.21.8:8332'), {
					code: 'ECONNREFUSED'
				})
			});
		});

		await expect(probeAndDetectUmbrelCore()).resolves.toEqual([]);
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('is NOT detected on a DNS failure, and does not throw', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => {
			throw Object.assign(new TypeError('fetch failed'), {
				cause: Object.assign(new Error('getaddrinfo ENOTFOUND 10.21.21.8'), {
					code: 'ENOTFOUND'
				})
			});
		});

		await expect(probeAndDetectUmbrelCore()).resolves.toEqual([]);
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('is NOT detected on an abort/timeout, and does not throw', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async (_url: unknown, init: unknown) => {
			const signal = (init as RequestInit).signal;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted', 'AbortError'));
				});
			});
		});

		vi.useFakeTimers();
		try {
			const pending = probeAndDetectUmbrelCore();
			// The module's DETECT_TIMEOUT_MS is 2s; advance past it to fire the abort.
			await vi.advanceTimersByTimeAsync(2_100);
			await expect(pending).resolves.toEqual([]);
		} finally {
			vi.useRealTimers();
		}
		expect(getSetting('core_rpc_detected')).toBeNull();
	});

	it('never throws even on a garbage/undefined-shaped response object', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		// A response missing `.text` entirely — 503 branch would call res.text().
		stubFetch(async () => ({ status: 503 }));

		await expect(probeAndDetectUmbrelCore()).resolves.toEqual([]);
	});

	it('never throws when fetch rejects with a non-Error value', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		stubFetch(async () => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal -- deliberately hostile input
			throw 'a bare string rejection';
		});

		await expect(probeAndDetectUmbrelCore()).resolves.toEqual([]);
	});
});

// ---- idempotence across repeated boots -----------------------------------------------

describe('probeAndDetectUmbrelCore — idempotence', () => {
	it('only ever seeds once; a second call after detection is a no-op', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		const fetchFn = stubFetch(async () => ({ status: 401, text: async () => '' }));

		const first = await probeAndDetectUmbrelCore();
		expect(first).toEqual(['core_rpc_detected']);

		const second = await probeAndDetectUmbrelCore();
		expect(second).toEqual([]);
		// Only the first call actually dialed out.
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});
