import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Capture warn() calls made by childLogger('feature-flags'). We spread the real
// module so LOG_FILE / logger and every other export stay intact, and only swap
// childLogger for a lightweight stub whose warn forwards to a spy when (and only
// when) the tag is 'feature-flags' — so unrelated subsystems (db, auth) logging
// during import can't pollute the assertion.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../logger', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../logger')>();
	return {
		...actual,
		childLogger: (tag: string) => ({
			warn: (...args: unknown[]) => {
				if (tag === 'feature-flags') warnSpy(...args);
			},
			info: () => {},
			error: () => {},
			debug: () => {},
			fatal: () => {},
			trace: () => {},
			child: () => ({})
		})
	};
});

// Imported AFTER the mock is registered so api.ts's module-level
// childLogger('feature-flags') resolves to the stub above.
const { requireFeature } = await import('../api');

describe('requireFeature guard logging (blocked attempts → /admin/logs)', () => {
	it('emits exactly one warn-level entry carrying userId + flag when blocked', () => {
		warnSpy.mockClear();
		const evt = {
			locals: { user: { id: 42, email: 'x@y.com', isAdmin: false }, flags: { send: false } },
			request: new Request('http://localhost/api/wallets/1/psbt', { method: 'POST' }),
			url: new URL('http://localhost/api/wallets/1/psbt')
		} as unknown as RequestEvent;

		expect(() => requireFeature(evt, 'send')).toThrow(); // 403
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [fields, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
		expect(fields).toMatchObject({ userId: 42, flag: 'send', method: 'POST' });
		expect(String(msg)).toContain('feature blocked');
	});

	it('does NOT log when the flag is enabled (pass-through)', () => {
		warnSpy.mockClear();
		const evt = {
			locals: { user: { id: 7, email: 'a@b.com', isAdmin: false }, flags: { send: true } }
		} as unknown as RequestEvent;
		expect(requireFeature(evt, 'send').id).toBe(7);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
