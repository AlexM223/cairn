// Regression test for cairn-wqkk: SvelteKit form actions never run a parent
// layout's load(), so the (app)/+layout.server.ts LOGIN redirect never gated
// these actions — only the locals.user!.id deref (a masked 500) saved them
// from being reachable anonymously. `preview` here in particular did no
// destructuring of `locals` at all, so it ran to completion for an anon
// caller (harmless today — pure computation, no mutation — but defense by
// accident). Every action now calls requireUser(event) first, converting
// that into a clean 401.

import { describe, it, expect } from 'vitest';
import { actions } from './+page.server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		locals: { user },
		request: new Request('http://localhost/wallets/new', { method: 'POST', body: form })
	};
}

describe('wallets/new actions — anon is denied with a 401 throw', () => {
	it('preview throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('xpub', 'not-a-real-xpub');
		await expect(actions.preview(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});

	it('create throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('xpub', 'not-a-real-xpub');
		form.set('name', 'Test wallet');
		await expect(actions.create(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});

	it('rememberSharedKey throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		await expect(actions.rememberSharedKey(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});
});
