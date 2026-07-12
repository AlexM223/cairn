import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ActionResult } from '@sveltejs/kit';
import { safeAction, NETWORK_ERROR_MESSAGE, REJECTED_MESSAGE, type SafeActionEnv } from './safeAction';

/** A `deserialize` stand-in that mirrors the real one closely enough for these
 *  tests: JSON.parse, no devalue decoding step (none of the fixtures below
 *  need it — see the design note in the progress log for why this is a fair
 *  simplification when unit-testing safeAction's own classification, not
 *  SvelteKit's `deserialize` internals). */
function jsonDeserialize(raw: string): ActionResult {
	return JSON.parse(raw);
}

function fakeResponse(status: number, body: string): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: () => Promise.resolve(body)
	} as Response;
}

function makeEnv(applyAction = vi.fn(async () => {})): SafeActionEnv {
	return { deserialize: jsonDeserialize, applyAction };
}

describe('safeAction', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('returns ok:true with the decoded data on a success result', async () => {
		global.fetch = vi.fn(async () =>
			fakeResponse(
				200,
				JSON.stringify({ type: 'success', status: 200, data: { multisigId: 42 } })
			)
		) as unknown as typeof fetch;

		const res = await safeAction<{ multisigId: number }>(
			makeEnv(),
			'create',
			new FormData(),
			'Could not create that multisig.'
		);

		expect(res).toEqual({ ok: true, data: { multisigId: 42 } });
	});

	it('surfaces the fail() message on a failure result (e.g. a 400-class rejection)', async () => {
		global.fetch = vi.fn(async () =>
			fakeResponse(
				200, // SvelteKit sends failure results back with HTTP 200; the real
				// status lives inside the JSON body's own `status` field.
				JSON.stringify({
					type: 'failure',
					status: 400,
					data: { error: "Give this key a short name (1-60 characters)." }
				})
			)
		) as unknown as typeof fetch;

		const res = await safeAction(makeEnv(), 'key', new FormData(), 'fallback');

		expect(res).toEqual({ ok: false, error: "Give this key a short name (1-60 characters)." });
	});

	it('classifies a type-less 403 JSON body (SvelteKit\'s own CSRF/origin check) as REJECTED, not a network problem', async () => {
		// Confirmed against @sveltejs/kit's respond.js: with an `accept:
		// application/json` header, the CSRF check returns `json({message},
		// {status:403})` — valid JSON, but with no `type` field at all, so it
		// isn't a recognized ActionResult shape.
		global.fetch = vi.fn(async () =>
			fakeResponse(403, JSON.stringify({ message: 'Cross-site POST form submissions are forbidden' }))
		) as unknown as typeof fetch;

		const res = await safeAction(makeEnv(), 'preview', new FormData(), 'That key could not be read.');

		expect(res).toEqual({ ok: false, error: REJECTED_MESSAGE });
	});

	it('surfaces the server-error message on a type:"error" result (e.g. an unhandled 500)', async () => {
		global.fetch = vi.fn(async () =>
			fakeResponse(
				500,
				JSON.stringify({
					type: 'error',
					status: 500,
					error: { message: 'Something went wrong', errorId: 'ab12cd34' }
				})
			)
		) as unknown as typeof fetch;

		const res = await safeAction(makeEnv(), 'create', new FormData(), 'fallback');

		expect(res).toEqual({ ok: false, error: 'Something went wrong' });
	});

	it('reports a real fetch() failure as the network message, never a "bad key"/rejection message', async () => {
		global.fetch = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch;

		const res = await safeAction(makeEnv(), 'preview', new FormData(), 'That key could not be read.');

		expect(res).toEqual({ ok: false, error: NETWORK_ERROR_MESSAGE });
	});

	it('falls back to the caller-provided message on a non-JSON body that is not a 403 (e.g. a proxy HTML page)', async () => {
		global.fetch = vi.fn(async () =>
			fakeResponse(200, '<!doctype html><html><body>Please sign in again</body></html>')
		) as unknown as typeof fetch;

		const res = await safeAction(makeEnv(), 'preview', new FormData(), 'That key could not be read.');

		expect(res).toEqual({ ok: false, error: 'That key could not be read.' });
	});

	it('follows a redirect result via applyAction instead of surfacing a false error (the auth-expiry fix)', async () => {
		global.fetch = vi.fn(async () =>
			fakeResponse(200, JSON.stringify({ type: 'redirect', status: 303, location: '/login' }))
		) as unknown as typeof fetch;

		const applyAction = vi.fn(async () => {});
		const res = await safeAction(makeEnv(applyAction), 'preview', new FormData(), "That key could not be read.");

		expect(applyAction).toHaveBeenCalledWith({ type: 'redirect', status: 303, location: '/login' });
		expect(res).toEqual({ ok: false, error: '' });
	});

	it('sends accept:application/json alongside x-sveltekit-action, matching use:enhance', async () => {
		const fetchMock = vi.fn(async () =>
			fakeResponse(200, JSON.stringify({ type: 'success', status: 200, data: { ok: true } }))
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await safeAction(makeEnv(), 'preview', new FormData(), 'fallback');

		expect(fetchMock).toHaveBeenCalledWith(
			'?/preview',
			expect.objectContaining({
				method: 'POST',
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
			})
		);
	});
});
