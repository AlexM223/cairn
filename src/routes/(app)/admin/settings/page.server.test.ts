// Regression test for the admin-settings action auth-bypass fix. SvelteKit
// form `actions` do NOT run a parent route's load() (see hooks.server.ts's
// admin-guard comment) — a POST straight to /admin/settings?/save (or any
// other action here) skipped the layout's isAdmin gate entirely and, before
// the fix, reached setSetting/setSecretSetting/reconfigureChain/testElectrum/
// testEsplora for an anonymous or non-admin caller. Every action now starts
// with `if (!locals.user?.isAdmin) return fail(403, ...)`. This pins that
// down for anon + non-admin, confirms the mutation is never invoked in either
// denied case, and confirms a real admin still reaches it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/settings', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/settings')>();
	return { ...mod, setSetting: vi.fn(), setSecretSetting: vi.fn() };
});

vi.mock('$lib/server/chain', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/chain')>();
	return {
		...mod,
		reconfigureChain: vi.fn(),
		testElectrum: vi.fn(async () => ({ ok: true })),
		testEsplora: vi.fn(async () => ({ ok: true }))
	};
});

vi.mock('$lib/server/disclosures', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/disclosures')>();
	return { ...mod, setUserAgreement: vi.fn(() => ({ text: 'stub', operator: 'stub', version: 2 })) };
});

vi.mock('$lib/server/admin', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/admin')>();
	return { ...mod, resetInstance: vi.fn() };
});

vi.mock('$lib/server/bitcoin/walletScan', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/bitcoin/walletScan')>();
	return { ...mod, invalidateWalletCache: vi.fn() };
});

import { setSetting, setSecretSetting } from '$lib/server/settings';
import { reconfigureChain, testElectrum, testEsplora } from '$lib/server/chain';
import { setUserAgreement } from '$lib/server/disclosures';
import { resetInstance } from '$lib/server/admin';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import { actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

/** Minimal RequestEvent for invoking a settings action. `locals.user` is
 *  `undefined` for the anon case — same as hooks.server.ts leaves it when
 *  getSessionUser() finds no cookie. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, fields: Record<string, string> = {}): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals: { user },
		request: new Request('http://localhost/admin/settings', { method: 'POST', body })
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('admin/settings actions — anon and non-admin are denied a 403 fail(), mutation never runs', () => {
	it('save', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.save(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(setSetting).not.toHaveBeenCalled();
			expect(setSecretSetting).not.toHaveBeenCalled();
			expect(reconfigureChain).not.toHaveBeenCalled();
		}
	});

	it('saveAgreement', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.saveAgreement(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(setUserAgreement).not.toHaveBeenCalled();
		}
	});

	it('testElectrum', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.testElectrum(
				makeEvent(user, { electrumHost: '10.0.0.5', electrumPort: '50001' })
			);
			expect(res).toMatchObject({ status: 403 });
			expect(testElectrum).not.toHaveBeenCalled();
		}
	});

	it('testEsplora', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.testEsplora(
				makeEvent(user, { esploraUrl: 'http://esplora.example' })
			);
			expect(res).toMatchObject({ status: 403 });
			expect(testEsplora).not.toHaveBeenCalled();
		}
	});

	it('unlockTeamMode', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.unlockTeamMode(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(setSetting).not.toHaveBeenCalled();
		}
	});

	it('lockTeamMode', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.lockTeamMode(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(setSetting).not.toHaveBeenCalled();
		}
	});

	it('resetInstance', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.resetInstance(makeEvent(user, { confirm: 'RESET' }));
			expect(res).toMatchObject({ status: 403 });
			expect(resetInstance).not.toHaveBeenCalled();
			expect(invalidateWalletCache).not.toHaveBeenCalled();
		}
	});
});

describe('admin/settings actions — a real admin still reaches the mutation', () => {
	it('save persists settings and reconfigures the chain', async () => {
		const res = await actions.save(makeEvent(ADMIN, { electrumPoolSize: '2' }));
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalled();
		expect(reconfigureChain).toHaveBeenCalledTimes(1);
	});

	it('saveAgreement calls setUserAgreement', async () => {
		const res = await actions.saveAgreement(makeEvent(ADMIN, { agreementText: 'New terms' }));
		expect(res).toMatchObject({ agreementSaved: true });
		expect(setUserAgreement).toHaveBeenCalledTimes(1);
	});

	it('testElectrum calls the chain test helper', async () => {
		const res = await actions.testElectrum(
			makeEvent(ADMIN, { electrumHost: '10.0.0.5', electrumPort: '50001' })
		);
		expect(res).toEqual({ electrumTest: { ok: true } });
		expect(testElectrum).toHaveBeenCalledTimes(1);
	});

	it('testEsplora calls the chain test helper', async () => {
		const res = await actions.testEsplora(makeEvent(ADMIN, { esploraUrl: 'http://esplora.example' }));
		expect(res).toEqual({ esploraTest: { ok: true } });
		expect(testEsplora).toHaveBeenCalledTimes(1);
	});

	it('unlockTeamMode / lockTeamMode persist the mode', async () => {
		expect(await actions.unlockTeamMode(makeEvent(ADMIN))).toEqual({ instanceModeSaved: true });
		expect(setSetting).toHaveBeenCalledWith('instance_mode', 'team');
		expect(await actions.lockTeamMode(makeEvent(ADMIN))).toEqual({ instanceModeSaved: true });
		expect(setSetting).toHaveBeenCalledWith('instance_mode', 'solo');
	});

	it('resetInstance resets, invalidates the cache, and redirects', async () => {
		await expect(
			actions.resetInstance(makeEvent(ADMIN, { confirm: 'RESET' }))
		).rejects.toMatchObject({ status: 303, location: '/signup' });
		expect(resetInstance).toHaveBeenCalledTimes(1);
		expect(invalidateWalletCache).toHaveBeenCalledTimes(1);
	});
});
