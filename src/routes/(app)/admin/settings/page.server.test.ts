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
	// readSecretSetting is stubbed so the testCoreRpc action's "blank password =
	// use the stored one" fallback doesn't reach the real DB in these unit tests.
	return {
		...mod,
		setSetting: vi.fn(),
		setSecretSetting: vi.fn(),
		readSecretSetting: vi.fn(() => null)
	};
});

vi.mock('$lib/server/chain', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/chain')>();
	return {
		...mod,
		reconfigureChain: vi.fn(),
		testElectrum: vi.fn(async () => ({ ok: true })),
		testEsplora: vi.fn(async () => ({ ok: true })),
		testCoreRpc: vi.fn(async () => ({ ok: true, blockHeight: 800_000, chain: 'main' }))
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
import { reconfigureChain, testElectrum, testEsplora, testCoreRpc } from '$lib/server/chain';
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

	it('testCoreRpc', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.testCoreRpc(
				makeEvent(user, { coreRpcUrl: 'http://127.0.0.1:8332' })
			);
			expect(res).toMatchObject({ status: 403 });
			expect(testCoreRpc).not.toHaveBeenCalled();
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

	it('testCoreRpc calls the chain test helper and echoes its result', async () => {
		const res = await actions.testCoreRpc(
			makeEvent(ADMIN, { coreRpcUrl: 'http://127.0.0.1:8332', coreRpcUser: 'rpcuser' })
		);
		expect(res).toEqual({ coreRpcTest: { ok: true, blockHeight: 800_000, chain: 'main' } });
		expect(testCoreRpc).toHaveBeenCalledTimes(1);
		expect(testCoreRpc).toHaveBeenCalledWith({
			url: 'http://127.0.0.1:8332',
			user: 'rpcuser',
			pass: null
		});
	});

	it('testCoreRpc surfaces a failure result from the helper', async () => {
		vi.mocked(testCoreRpc).mockResolvedValueOnce({ ok: false, error: 'ECONNREFUSED' });
		const res = await actions.testCoreRpc(makeEvent(ADMIN, { coreRpcUrl: 'http://127.0.0.1:8332' }));
		expect(res).toEqual({ coreRpcTest: { ok: false, error: 'ECONNREFUSED' } });
	});

	it('testCoreRpc rejects a missing URL with a 400 before hitting the helper', async () => {
		const res = await actions.testCoreRpc(makeEvent(ADMIN, {}));
		expect(res).toMatchObject({ status: 400 });
		expect(testCoreRpc).not.toHaveBeenCalled();
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

// Regression tests for cairn-6uok: core_rpc_url/core_rpc_user/core_rpc_pass
// used to be written ONLY inside the `connectionMode === 'custom'` block, so
// (a) a 'public'-mode submission that included Core RPC fields (e.g. the
// Umbrel Wave B assisted-connect flow) silently dropped them — never
// persisted — and (b) within that block, a field simply absent from the
// FormData (`form.get(...) ?? ''`) was written as an empty string, clearing
// whatever was already stored. The fix moves the three writes outside the
// custom-only block and gates each on `form.has(...)`, so "absent from the
// payload" now always means "leave unchanged," in every connectionMode.
describe('admin/settings save action — core_rpc_* persistence (cairn-6uok)', () => {
	it('preserves existing core_rpc_* settings when the payload omits them entirely (public mode)', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, { connectionMode: 'public', electrumPoolSize: '2' })
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_url', expect.anything());
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_user', expect.anything());
		expect(setSecretSetting).not.toHaveBeenCalledWith('core_rpc_pass', expect.anything());
	});

	it('preserves existing core_rpc_* settings when the payload omits them entirely (custom mode)', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_url', expect.anything());
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_user', expect.anything());
		expect(setSecretSetting).not.toHaveBeenCalledWith('core_rpc_pass', expect.anything());
	});

	it('persists core_rpc_* fields present in the payload while connectionMode is custom', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2',
				coreRpcUrl: 'http://10.21.21.8:8332',
				coreRpcUser: 'umbrel',
				coreRpcPass: 'hunter2'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_url', 'http://10.21.21.8:8332');
		expect(setSetting).toHaveBeenCalledWith('core_rpc_user', 'umbrel');
		expect(setSecretSetting).toHaveBeenCalledWith('core_rpc_pass', 'hunter2');
	});

	it('persists core_rpc_* fields present in the payload even while connectionMode is public (assisted-connect), and never mutates connection_mode away from public', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'public',
				electrumPoolSize: '2',
				coreRpcUrl: 'http://10.21.21.8:8332',
				coreRpcUser: 'umbrel',
				coreRpcPass: 'hunter2'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_url', 'http://10.21.21.8:8332');
		expect(setSetting).toHaveBeenCalledWith('core_rpc_user', 'umbrel');
		expect(setSecretSetting).toHaveBeenCalledWith('core_rpc_pass', 'hunter2');
		expect(setSetting).toHaveBeenCalledWith('connection_mode', 'public');
		expect(setSetting).not.toHaveBeenCalledWith('connection_mode', 'custom');
	});

	it('an explicit present-but-empty coreRpcUrl/coreRpcUser still clears them (distinct from "absent")', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'public',
				electrumPoolSize: '2',
				coreRpcUrl: '',
				coreRpcUser: ''
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_url', '');
		expect(setSetting).toHaveBeenCalledWith('core_rpc_user', '');
	});

	it('a blank-but-present coreRpcPass does not overwrite the stored secret (existing "blank means keep" convention)', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'public',
				electrumPoolSize: '2',
				coreRpcUrl: 'http://10.21.21.8:8332',
				coreRpcPass: ''
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_url', 'http://10.21.21.8:8332');
		expect(setSecretSetting).not.toHaveBeenCalledWith('core_rpc_pass', expect.anything());
	});

	it('clearCoreRpcPass="on" clears the stored secret regardless of connectionMode', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'public',
				electrumPoolSize: '2',
				clearCoreRpcPass: 'on'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSecretSetting).toHaveBeenCalledWith('core_rpc_pass', '');
	});

	it('does not regress existing custom-mode Electrum/Esplora behavior', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2',
				esploraUrl: 'http://esplora.example'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('electrum_host', '10.0.0.5');
		expect(setSetting).toHaveBeenCalledWith('electrum_port', '50001');
		expect(setSetting).toHaveBeenCalledWith('esplora_url', 'http://esplora.example');
	});
});
