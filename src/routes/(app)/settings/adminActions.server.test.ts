// Regression test for the merged Settings page's admin actions
// (docs/UX-SIMPLIFICATION-SPEC.md §4.2, cairn-6c91u.2). The old
// /admin/settings actions moved wholesale into /settings; /settings is NOT under
// an admin layout, so each migrated action's own `requireAdmin(event)` guard is
// the ONLY server-side boundary. requireAdmin throws 401 for an anonymous caller
// and 403 for a signed-in non-admin, and never reaches the mutation in either
// case; a real admin still reaches it. The extensive core_rpc_* / chainNetwork /
// assisted-connect regressions (cairn-6uok / x6pr / 3p9z) ride along unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/settings', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/settings')>();
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
import { reconfigureChain, testElectrum, testCoreRpc } from '$lib/server/chain';
import { setUserAgreement } from '$lib/server/disclosures';
import { resetInstance } from '$lib/server/admin';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import { actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, fields: Record<string, string> = {}): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals: { user },
		request: new Request('http://localhost/settings', { method: 'POST', body })
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('settings admin actions — anon (401) and non-admin (403) are denied, mutation never runs', () => {
	it('save', async () => {
		await expect(actions.save(makeEvent(undefined))).rejects.toMatchObject({ status: 401 });
		await expect(actions.save(makeEvent(NON_ADMIN))).rejects.toMatchObject({ status: 403 });
		expect(setSetting).not.toHaveBeenCalled();
		expect(setSecretSetting).not.toHaveBeenCalled();
		expect(reconfigureChain).not.toHaveBeenCalled();
	});

	it('saveAgreement', async () => {
		await expect(actions.saveAgreement(makeEvent(undefined))).rejects.toMatchObject({ status: 401 });
		await expect(actions.saveAgreement(makeEvent(NON_ADMIN))).rejects.toMatchObject({ status: 403 });
		expect(setUserAgreement).not.toHaveBeenCalled();
	});

	it('testElectrum', async () => {
		const fields = { electrumHost: '10.0.0.5', electrumPort: '50001' };
		await expect(actions.testElectrum(makeEvent(undefined, fields))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.testElectrum(makeEvent(NON_ADMIN, fields))).rejects.toMatchObject({
			status: 403
		});
		expect(testElectrum).not.toHaveBeenCalled();
	});

	it('testCoreRpc', async () => {
		const fields = { coreRpcUrl: 'http://127.0.0.1:8332' };
		await expect(actions.testCoreRpc(makeEvent(undefined, fields))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.testCoreRpc(makeEvent(NON_ADMIN, fields))).rejects.toMatchObject({
			status: 403
		});
		expect(testCoreRpc).not.toHaveBeenCalled();
	});

	it('toggleFlag', async () => {
		const fields = { key: 'mining', enabled: 'true' };
		await expect(actions.toggleFlag(makeEvent(undefined, fields))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.toggleFlag(makeEvent(NON_ADMIN, fields))).rejects.toMatchObject({
			status: 403
		});
	});

	it('unlockTeamMode', async () => {
		await expect(actions.unlockTeamMode(makeEvent(undefined))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.unlockTeamMode(makeEvent(NON_ADMIN))).rejects.toMatchObject({ status: 403 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('lockTeamMode', async () => {
		await expect(actions.lockTeamMode(makeEvent(undefined))).rejects.toMatchObject({ status: 401 });
		await expect(actions.lockTeamMode(makeEvent(NON_ADMIN))).rejects.toMatchObject({ status: 403 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('resetInstance', async () => {
		await expect(
			actions.resetInstance(makeEvent(undefined, { confirm: 'RESET' }))
		).rejects.toMatchObject({ status: 401 });
		await expect(
			actions.resetInstance(makeEvent(NON_ADMIN, { confirm: 'RESET' }))
		).rejects.toMatchObject({ status: 403 });
		expect(resetInstance).not.toHaveBeenCalled();
		expect(invalidateWalletCache).not.toHaveBeenCalled();
	});

	it('dismissCoreDetection', async () => {
		await expect(actions.dismissCoreDetection(makeEvent(undefined))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.dismissCoreDetection(makeEvent(NON_ADMIN))).rejects.toMatchObject({
			status: 403
		});
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('switchCoreRpcToManual', async () => {
		await expect(actions.switchCoreRpcToManual(makeEvent(undefined))).rejects.toMatchObject({
			status: 401
		});
		await expect(actions.switchCoreRpcToManual(makeEvent(NON_ADMIN))).rejects.toMatchObject({
			status: 403
		});
		expect(setSetting).not.toHaveBeenCalled();
	});
});

describe('settings admin actions — a real admin still reaches the mutation', () => {
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

	it('dismissCoreDetection writes the dismissed marker', async () => {
		const res = await actions.dismissCoreDetection(makeEvent(ADMIN));
		expect(res).toEqual({ coreRpcDismissed: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_detected', 'dismissed');
	});

	it('switchCoreRpcToManual stamps manual provenance', async () => {
		const res = await actions.switchCoreRpcToManual(makeEvent(ADMIN));
		expect(res).toEqual({ coreRpcSwitchedToManual: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_provisioned_by', 'manual');
	});
});

// Regression tests for cairn-6uok: core_rpc_url/core_rpc_user/core_rpc_pass are
// only written when PRESENT in the payload (form.has), so "absent" means "leave
// unchanged," in every connectionMode.
describe('settings save action — core_rpc_* persistence (cairn-6uok)', () => {
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

	it('persists core_rpc_* fields present in the payload even while connectionMode is public, and never mutates connection_mode away from public', async () => {
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

	it('a blank-but-present coreRpcPass does not overwrite the stored secret', async () => {
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

	it('does not regress existing custom-mode Electrum behavior', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('electrum_host', '10.0.0.5');
		expect(setSetting).toHaveBeenCalledWith('electrum_port', '50001');
	});

	it('ignores a stray esploraUrl form field without error or persistence', async () => {
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
		expect(setSetting).not.toHaveBeenCalledWith('esplora_url', expect.anything());
	});
});

// Regression tests for cairn-x6pr: chainNetwork is only read/written inside the
// connectionMode === 'custom' branch.
describe('settings save action — chainNetwork (cairn-x6pr)', () => {
	it('persists chain_network when present in custom mode', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2',
				chainNetwork: 'regtest'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('chain_network', 'regtest');
	});

	it('rejects an invalid chainNetwork value with a 400, before reconfiguring the chain', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2',
				chainNetwork: 'garbage'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalledWith('chain_network', expect.anything());
		expect(reconfigureChain).not.toHaveBeenCalled();
	});

	it('ignores chainNetwork entirely when connectionMode is public', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'public',
				electrumPoolSize: '2',
				chainNetwork: 'testnet'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).not.toHaveBeenCalledWith('chain_network', expect.anything());
	});

	it('leaves chain_network untouched in custom mode when the field is omitted', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				connectionMode: 'custom',
				electrumHost: '10.0.0.5',
				electrumPort: '50001',
				electrumPoolSize: '2'
			})
		);
		expect(res).toEqual({ saved: true });
		expect(setSetting).not.toHaveBeenCalledWith('chain_network', expect.anything());
	});
});

// Regression tests for the Umbrel Wave B assisted-connect (cairn-3p9z): the
// `coreRpcAssisted=umbrel` branch validates with testCoreRpc() BEFORE persisting,
// stamps 'umbrel-detect' provenance, and returns before touching
// registration_mode/connection_mode.
describe('settings save action — Umbrel Wave B assisted-connect (cairn-3p9z)', () => {
	it('validates with testCoreRpc() before persisting, then persists core_rpc_* and stamps provenance', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				coreRpcAssisted: 'umbrel',
				coreRpcUrl: 'http://10.21.21.8:8332',
				coreRpcUser: 'umbrel',
				coreRpcPass: 'hunter2'
			})
		);
		expect(testCoreRpc).toHaveBeenCalledTimes(1);
		expect(testCoreRpc).toHaveBeenCalledWith({
			url: 'http://10.21.21.8:8332',
			user: 'umbrel',
			pass: 'hunter2'
		});
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('core_rpc_url', 'http://10.21.21.8:8332');
		expect(setSetting).toHaveBeenCalledWith('core_rpc_user', 'umbrel');
		expect(setSecretSetting).toHaveBeenCalledWith('core_rpc_pass', 'hunter2');
		expect(setSetting).toHaveBeenCalledWith('core_rpc_provisioned_by', 'umbrel-detect');
		expect(reconfigureChain).toHaveBeenCalledTimes(1);
		expect(setSetting).not.toHaveBeenCalledWith('connection_mode', expect.anything());
		expect(setSetting).not.toHaveBeenCalledWith('registration_mode', expect.anything());
	});

	it('a testCoreRpc() failure persists nothing and returns the error', async () => {
		vi.mocked(testCoreRpc).mockResolvedValueOnce({ ok: false, error: 'Unauthorized' });
		const res = await actions.save(
			makeEvent(ADMIN, {
				coreRpcAssisted: 'umbrel',
				coreRpcUrl: 'http://10.21.21.8:8332',
				coreRpcUser: 'umbrel',
				coreRpcPass: 'wrong'
			})
		);
		expect(res).toMatchObject({
			status: 400,
			data: { coreRpcTest: { ok: false, error: 'Unauthorized' } }
		});
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_url', expect.anything());
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_provisioned_by', expect.anything());
		expect(setSecretSetting).not.toHaveBeenCalled();
		expect(reconfigureChain).not.toHaveBeenCalled();
	});

	it('rejects a missing URL or password before calling testCoreRpc()', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, { coreRpcAssisted: 'umbrel', coreRpcUrl: 'http://10.21.21.8:8332' })
		);
		expect(res).toMatchObject({ status: 400 });
		expect(testCoreRpc).not.toHaveBeenCalled();
		expect(setSetting).not.toHaveBeenCalledWith('core_rpc_url', expect.anything());
	});
});
