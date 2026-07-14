// Regression test for cairn-v27o (follow-up to cairn-wqkk): the `receive` and
// `delete` actions here used destructured params ({ params, locals, request })
// with no requireUser call — only the locals.user!.id non-null assertion (a
// masked 500 for an anonymous caller) stood between an action and an
// unauthenticated request. Both now call requireUser(event) first, converting
// that into a clean 401.

import { describe, it, expect } from 'vitest';
import { actions } from './+page.server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		params: { id: '1' },
		locals: { user },
		request: new Request('http://localhost/wallets/multisig/1', { method: 'POST', body: form })
	};
}

describe('wallets/multisig/[id] actions — anon is denied with a 401 throw', () => {
	it('receive throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		await expect(actions.receive(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});

	it('delete throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		await expect(actions.delete(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});
});
