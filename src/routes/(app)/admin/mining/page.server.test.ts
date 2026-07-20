// Regression test for the admin-mining actions' auth gate, mirroring
// admin/settings/page.server.test.ts's pattern exactly (cairn-vn43.10):
// SvelteKit form `actions` do NOT run a parent route's load() (see
// hooks.server.ts's admin-guard comment) — a POST straight to
// /admin/mining?/save (or startStop/restart) would reach setSetting /
// reconfigureMiningEngine / startMiningEngine / stopMiningEngine for an
// anonymous or non-admin caller unless every action independently checks
// `locals.user?.isAdmin`. This pins that down for anon + non-admin and
// confirms the mutation is never invoked in either denied case.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/settings', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/settings')>();
	return {
		...mod,
		setSetting: vi.fn(),
		getSetting: vi.fn(() => null)
	};
});

vi.mock('$lib/server/mining', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/mining')>();
	return {
		...mod,
		reconfigureMiningEngine: vi.fn(),
		startMiningEngine: vi.fn(),
		stopMiningEngine: vi.fn()
	};
});

import { setSetting } from '$lib/server/settings';
import { reconfigureMiningEngine, startMiningEngine, stopMiningEngine } from '$lib/server/mining';
import { actions } from './+page.server';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

/** Minimal RequestEvent for invoking a mining action. `locals.user` is
 *  `undefined` for the anon case — same as hooks.server.ts leaves it when
 *  getSessionUser() finds no cookie. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: typeof ADMIN | undefined, fields: Record<string, string> = {}): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals: { user },
		request: new Request('http://localhost/admin/mining', { method: 'POST', body })
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('admin/mining actions — anon and non-admin are denied a 403 fail(), mutation never runs', () => {
	it('save', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.save(
				makeEvent(user, {
					bind: 'loopback',
					port: '3333',
					shareDifficulty: '1',
					vardiffTargetPerMin: '10',
					poolTag: 'Heartwood'
				})
			);
			expect(res).toMatchObject({ status: 403 });
			expect(setSetting).not.toHaveBeenCalled();
			expect(reconfigureMiningEngine).not.toHaveBeenCalled();
		}
	});

	it('startStop', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.startStop(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(setSetting).not.toHaveBeenCalled();
			expect(startMiningEngine).not.toHaveBeenCalled();
			expect(stopMiningEngine).not.toHaveBeenCalled();
		}
	});

	it('restart', async () => {
		for (const user of [undefined, NON_ADMIN]) {
			const res = await actions.restart(makeEvent(user));
			expect(res).toMatchObject({ status: 403 });
			expect(reconfigureMiningEngine).not.toHaveBeenCalled();
		}
	});
});

describe('admin/mining ?/save — validation (admin caller)', () => {
	it('rejects an out-of-range port without persisting anything', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				bind: 'loopback',
				port: '70000',
				shareDifficulty: '1',
				vardiffTargetPerMin: '10',
				poolTag: 'Heartwood'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
		expect(reconfigureMiningEngine).not.toHaveBeenCalled();
	});

	it('rejects a non-ASCII pool tag', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				bind: 'loopback',
				port: '3333',
				shareDifficulty: '1',
				vardiffTargetPerMin: '10',
				poolTag: 'Ⓗeartwood'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('rejects an invalid bind option', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				bind: 'everywhere',
				port: '3333',
				shareDifficulty: '1',
				vardiffTargetPerMin: '10',
				poolTag: 'Heartwood'
			})
		);
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('persists and reconfigures on valid input', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, {
				enabled: 'on',
				bind: 'lan',
				port: '3333',
				shareDifficulty: '2.5',
				vardiffEnabled: 'on',
				vardiffTargetPerMin: '12',
				poolTag: 'Heartwood',
				asicPortEnabled: 'on',
				asicStratumPort: '3334',
				asicShareDifficulty: '65536',
				sv2Enabled: 'on',
				sv2Port: '3335',
				sv2ShareDifficulty: '65536',
				sv2VersionRolling: 'on'
			})
		);
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('mining_enabled', 'true');
		expect(setSetting).toHaveBeenCalledWith('mining_bind', 'lan');
		expect(setSetting).toHaveBeenCalledWith('mining_stratum_port', '3333');
		expect(setSetting).toHaveBeenCalledWith('mining_share_difficulty', '2.5');
		expect(setSetting).toHaveBeenCalledWith('mining_vardiff_enabled', 'true');
		expect(setSetting).toHaveBeenCalledWith('mining_vardiff_target_rate', '12');
		expect(setSetting).toHaveBeenCalledWith('mining_pool_tag', 'Heartwood');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_port_enabled', 'true');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_stratum_port', '3334');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_share_difficulty', '65536');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_enabled', 'true');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_port', '3335');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_share_difficulty', '65536');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_version_rolling', 'true');
		expect(reconfigureMiningEngine).toHaveBeenCalledOnce();
	});
});

describe('admin/mining ?/save — ASIC port validation (cairn-pz8v5)', () => {
	const BASE = {
		enabled: 'on',
		bind: 'loopback',
		port: '3333',
		shareDifficulty: '1',
		vardiffTargetPerMin: '10',
		poolTag: 'Heartwood',
		asicPortEnabled: 'on',
		asicStratumPort: '3334',
		asicShareDifficulty: '65536',
		sv2Port: '3335',
		sv2ShareDifficulty: '65536'
	};

	it('rejects an ASIC port equal to the main Stratum port', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, port: '3333', asicStratumPort: '3333' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
		expect(reconfigureMiningEngine).not.toHaveBeenCalled();
	});

	it('rejects an out-of-range ASIC port', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, asicStratumPort: '70000' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('rejects a non-positive ASIC share difficulty', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, asicShareDifficulty: '0' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('persists asicPortEnabled=false when the switch is off (checkbox absent)', async () => {
		const fields = { ...BASE };
		delete (fields as Record<string, string>).asicPortEnabled;
		const res = await actions.save(makeEvent(ADMIN, fields));
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('mining_asic_port_enabled', 'false');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_stratum_port', '3334');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_share_difficulty', '65536');
	});
});

describe('admin/mining ?/save — Stratum V2 validation (cairn-qfez8.9)', () => {
	const BASE = {
		enabled: 'on',
		bind: 'loopback',
		port: '3333',
		shareDifficulty: '1',
		vardiffTargetPerMin: '10',
		poolTag: 'Heartwood',
		asicPortEnabled: 'on',
		asicStratumPort: '3334',
		asicShareDifficulty: '65536',
		sv2Enabled: 'on',
		sv2Port: '3335',
		sv2ShareDifficulty: '65536'
	};

	it('rejects an out-of-range SV2 port without persisting anything', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, sv2Port: '70000' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
		expect(reconfigureMiningEngine).not.toHaveBeenCalled();
	});

	it('rejects an SV2 port equal to the main Stratum port', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, sv2Port: '3333' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('rejects an SV2 port equal to the big-machine (ASIC) port', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, sv2Port: '3334' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('rejects a non-positive SV2 share difficulty', async () => {
		const res = await actions.save(makeEvent(ADMIN, { ...BASE, sv2ShareDifficulty: '0' }));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	it('persists sv2Enabled=false when the switch is off (checkbox absent)', async () => {
		const fields = { ...BASE };
		delete (fields as Record<string, string>).sv2Enabled;
		const res = await actions.save(makeEvent(ADMIN, fields));
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_enabled', 'false');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_port', '3335');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_share_difficulty', '65536');
	});

	it('persists sv2Enabled=true with the configured port/difficulty', async () => {
		const res = await actions.save(makeEvent(ADMIN, BASE));
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_enabled', 'true');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_port', '3335');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_share_difficulty', '65536');
		expect(setSetting).toHaveBeenCalledWith('mining_sv2_version_rolling', 'false');
	});
});

describe('admin/mining ?/save — ASIC subgroup toggle-off preserves port/difficulty (cairn-qfez8.27)', () => {
	const BASE = {
		enabled: 'on',
		bind: 'loopback',
		port: '3333',
		shareDifficulty: '1',
		vardiffTargetPerMin: '10',
		poolTag: 'Heartwood',
		sv2Port: '3335',
		sv2ShareDifficulty: '65536'
	};

	// REPRO (cairn-qfez8.27): before the fix, AdminPoolSettingsForm.svelte's
	// {#if asicPortEnabled} block removed asicStratumPort/asicShareDifficulty
	// from the DOM entirely when the subgroup was collapsed — so toggling ASIC
	// off and saving posted a form with those two fields (and the checkbox)
	// genuinely absent. This models that exact wire shape.
	it('400s when asicPortEnabled, asicStratumPort, and asicShareDifficulty are all absent from form data', async () => {
		const res = await actions.save(makeEvent(ADMIN, BASE));
		expect(res).toMatchObject({ status: 400 });
		expect(setSetting).not.toHaveBeenCalled();
	});

	// FIX: AdminPoolSettingsForm.svelte now ships the ASIC subgroup's
	// port/difficulty as hidden <input>s when the subgroup is collapsed
	// (mirroring the SV2 subgroup's pattern) instead of removing them from the
	// DOM — so a save with the toggle off still posts the last-known values,
	// exactly like the SV2-equivalent test above, and this succeeds.
	it('persists asicPortEnabled=false with the last-known port/difficulty preserved via hidden inputs', async () => {
		const res = await actions.save(
			makeEvent(ADMIN, { ...BASE, asicStratumPort: '3334', asicShareDifficulty: '65536' })
		);
		expect(res).toMatchObject({ saved: true });
		expect(setSetting).toHaveBeenCalledWith('mining_asic_port_enabled', 'false');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_stratum_port', '3334');
		expect(setSetting).toHaveBeenCalledWith('mining_asic_share_difficulty', '65536');
	});
});
