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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCreateEvent(user: { id: number }, form: FormData): any {
	return {
		locals: { user, flags: { multisig_create: true } },
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

describe('wallets/multisig/new create action — bare legacy P2SH bypass is blocked server-side (cairn-etz9)', () => {
	it('rejects scriptType=p2sh with a 400 fail() when source is not "imported"', async () => {
		const form = new FormData();
		form.set('name', 'Legacy vault');
		form.set('scriptType', 'p2sh');
		form.set('threshold', '2');
		form.set('keys', '[]');
		// source omitted entirely, same as a from-scratch wizard build
		const result = await actions.create(makeCreateEvent({ id: 1 }, form));
		expect(result).toMatchObject({ status: 400, data: { error: expect.stringMatching(/p2sh/i) } });
	});

	it('does not block scriptType=p2sh when source=imported (restoring a legacy config)', async () => {
		const form = new FormData();
		form.set('name', 'Restored vault');
		form.set('scriptType', 'p2sh');
		form.set('source', 'imported');
		form.set('threshold', '2');
		form.set('keys', '[]'); // empty keys fails downstream validation, not this guard
		const result = await actions.create(makeCreateEvent({ id: 1 }, form));
		// Falls through to createMultisig, which now rejects for a DIFFERENT
		// reason (no keys) — proving the p2sh guard itself did not fire.
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data?: { error?: string } }).data?.error ?? '').not.toMatch(
			/can no longer be created new/i
		);
	});
});
