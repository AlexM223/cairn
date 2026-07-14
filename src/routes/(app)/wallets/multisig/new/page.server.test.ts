// Regression test for cairn-wqkk: the `key` and `preview` actions here used
// destructured params ({ request }, { request, locals }) with no requireUser
// call — `preview` in particular never touched `locals` at all, so an
// anonymous POST ran it to completion (harmless today: pure computation, no
// mutation). Both now call requireUser(event) first, converting the
// previously-open path into a clean 401.

import { describe, it, expect } from 'vitest';
import { actions } from './+page.server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		locals: { user },
		request: new Request('http://localhost/wallets/multisig/new', { method: 'POST', body: form })
	};
}

describe('wallets/multisig/new actions — anon is denied with a 401 throw', () => {
	it('key throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('name', 'Test key');
		form.set('category', 'primary');
		await expect(actions.key(makeEvent(undefined, form))).rejects.toMatchObject({ status: 401 });
	});

	it('preview throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('config', '{}');
		await expect(actions.preview(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});
});
