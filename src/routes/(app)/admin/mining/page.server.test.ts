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
				poolTag: 'Heartwood'
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
		expect(reconfigureMiningEngine).toHaveBeenCalledOnce();
	});
});
