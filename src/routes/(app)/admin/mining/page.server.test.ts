// Regression test for the admin-mining actions' auth gate, mirroring
// admin/settings/page.server.test.ts's pattern exactly (cairn-vn43.10):
// SvelteKit form `actions` do NOT run a parent route's load() (see
// hooks.server.ts's admin-guard comment) — a POST straight to
// /admin/mining?/save (or startStop/restart) would reach setSetting /
// reconfigureMiningEngine / startMiningEngine / stopMiningEngine for an
// anonymous or non-admin caller unless every action independently checks
// `locals.user?.isAdmin`. This pins that down for anon + non-admin and
// confirms the mutation is never invoked in either denied case.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
		stopMiningEngine: vi.fn(),
		// The startStop-honesty tests below need a controllable post-start
		// verdict without actually standing up a MiningPool + fake RPC — every
		// other test in this file never reaches these because
		// `readMiningSettings().enabled` is false under the default getSetting
		// mock (engineFailedToStart's early `!s.enabled` return), so mocking
		// these two is a no-op for them.
		miningEngineStatus: vi.fn(),
		miningFatalErrors: vi.fn(() => []),
		// Umbrel-specific live diagnosis (zero-config Core RPC wave §D) —
		// defaults to healthy so every pre-existing (non-Umbrel-focused) test in
		// this file is unaffected; the Umbrel-message describe block below
		// overrides this per-case.
		probeCoreRpcHealth: vi.fn(async () => ({ ok: true }))
	};
});

import { getSetting, setSetting } from '$lib/server/settings';
import {
	reconfigureMiningEngine,
	startMiningEngine,
	stopMiningEngine,
	miningEngineStatus,
	miningFatalErrors,
	probeCoreRpcHealth
} from '$lib/server/mining';
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

describe('admin/mining ?/startStop — honest failure when the engine cannot actually start (cairn-mining-silent-start)', () => {
	// doStart() never throws (mining/index.ts doc comment) — every gate it
	// checks either no-ops silently or lands in the fatal list, so
	// `startMiningEngine()` resolving is NOT proof the pool came up. Before
	// this fix, `startStop` was the ONE action (unlike `save`/`restart`) that
	// never re-checked reality afterward: it just flipped `mining_enabled` and
	// returned `{ toggled: true }` — the exact live bug (button flashes,
	// nothing happens, no error anywhere) reported on Alex's Umbrel, where
	// mining was turned on without a working Bitcoin Core RPC connection.
	//
	// `readMiningSettings().enabled` (real, unmocked) reads through the
	// module's mocked `getSetting`, so each test wires `getSetting`/`setSetting`
	// together over a tiny local `mining_enabled` cell: the action reads it once
	// to decide the toggle direction, writes the flip, and `engineFailedToStart`
	// (called afterward, still within the same action) must see that write.
	function wireMiningEnabledToggle(initial: 'true' | 'false'): void {
		let enabled = initial;
		vi.mocked(getSetting).mockImplementation((key: string) => (key === 'mining_enabled' ? enabled : null));
		vi.mocked(setSetting).mockImplementation((key: string, value: string) => {
			if (key === 'mining_enabled') enabled = value as 'true' | 'false';
		});
	}

	it('start without Core RPC configured: fails loudly instead of a false "toggled" success', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined); // doStart()'s real no-op behavior
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: false,
			engine: null,
			coreRpc: 'unconfigured',
			startedAt: null
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(setSetting).toHaveBeenCalledWith('mining_enabled', 'true');
		expect(startMiningEngine).toHaveBeenCalledOnce();
		expect(res).toMatchObject({ status: 500 });
		expect((res as { data?: { error?: string } }).data?.error).toMatch(/bitcoin node/i);
	});

	it('start with Core RPC reachable but the engine still failed (fatal recorded): surfaces the fatal reason', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: false,
			engine: null,
			coreRpc: 'down',
			startedAt: null
		});
		vi.mocked(miningFatalErrors).mockReturnValue(['listen EADDRINUSE: address already in use :::3333']);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		expect((res as { data?: { error?: string } }).data?.error).toMatch(/EADDRINUSE/);
	});

	it('start succeeds: the engine actually reached running state, so the toggle reports success', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: true,
			engine: null,
			coreRpc: 'ok',
			startedAt: Date.now()
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ toggled: true });
	});

	it('stop is unaffected: no post-check runs, no engine-status call needed to succeed', async () => {
		// mining_enabled starts 'true' (already running) so this call is a stop.
		wireMiningEnabledToggle('true');
		vi.mocked(stopMiningEngine).mockResolvedValue(undefined);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(setSetting).toHaveBeenCalledWith('mining_enabled', 'false');
		expect(stopMiningEngine).toHaveBeenCalledOnce();
		expect(res).toMatchObject({ toggled: true });
	});
});

describe('admin/mining ?/startStop — Umbrel-specific honest errors (zero-config Core RPC wave §D)', () => {
	// $env/dynamic/private is aliased straight to process.env in tests
	// (src/tests/env-stub.ts) — CAIRN_PLATFORM is set/cleared directly.
	const savedPlatform = process.env.CAIRN_PLATFORM;
	beforeEach(() => {
		process.env.CAIRN_PLATFORM = 'umbrel';
	});
	afterEach(() => {
		if (savedPlatform === undefined) delete process.env.CAIRN_PLATFORM;
		else process.env.CAIRN_PLATFORM = savedPlatform;
	});

	// getSetting is mocked module-wide to `() => null` by default (top of file);
	// per-test overrides layer a tiny key->value map on top so
	// `core_rpc_detected` / `core_rpc_provisioned_by` reads resolve as each
	// case needs, while `mining_enabled` keeps flowing through
	// wireMiningEnabledToggle's own implementation.
	function wireMiningEnabledToggle(initial: 'true' | 'false', extra: Record<string, string> = {}): void {
		let enabled = initial;
		vi.mocked(getSetting).mockImplementation((key: string) => {
			if (key === 'mining_enabled') return enabled;
			if (key in extra) return extra[key];
			return null;
		});
		vi.mocked(setSetting).mockImplementation((key: string, value: string) => {
			if (key === 'mining_enabled') enabled = value as 'true' | 'false';
		});
	}

	it('no env + no detection: "install the Bitcoin Node app" message', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: false,
			engine: null,
			coreRpc: 'unconfigured',
			startedAt: null
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);
		// core_rpc_detected unset (default null from wireMiningEnabledToggle).

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		expect((res as { data?: { error?: string } }).data?.error).toMatch(/Umbrel's Bitcoin Node/);
		expect((res as { data?: { error?: string } }).data?.error).toMatch(/App Store/);
	});

	it('Core detected but not yet connected: falls back to the manual/Settings message (not the "install" message)', async () => {
		wireMiningEnabledToggle('false', { core_rpc_detected: 'umbrel' });
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: false,
			engine: null,
			coreRpc: 'unconfigured',
			startedAt: null
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		const msg = (res as { data?: { error?: string } }).data?.error;
		expect(msg).toMatch(/Admin → Settings/);
		expect(msg).not.toMatch(/App Store/);
	});

	it('env creds valid but node still syncing: "still syncing (block N)" message', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: true, // TipPoller swallowed the connect entirely — reports running
			engine: null,
			coreRpc: 'down',
			startedAt: Date.now()
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);
		vi.mocked(probeCoreRpcHealth).mockResolvedValue({ ok: false, reason: 'syncing', blocks: 512_345 });

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		const msg = (res as { data?: { error?: string } }).data?.error;
		expect(msg).toMatch(/still syncing/);
		expect(msg).toMatch(/512,345/);
	});

	it('creds/transport failure (401/conn-refused): "couldn\'t reach your Bitcoin node" message', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: true,
			engine: null,
			coreRpc: 'down',
			startedAt: Date.now()
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);
		vi.mocked(probeCoreRpcHealth).mockResolvedValue({ ok: false, reason: 'transport' });

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		const msg = (res as { data?: { error?: string } }).data?.error;
		expect(msg).toMatch(/Couldn't reach your Bitcoin node's RPC/);
	});

	it('healthy on Umbrel: probeCoreRpcHealth ok + running -> success, no probe needed once coreRpc is already "ok"', async () => {
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: true,
			engine: null,
			coreRpc: 'ok',
			startedAt: Date.now()
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ toggled: true });
		// coreRpc is already 'ok' — the extra live probe is skipped entirely.
		expect(probeCoreRpcHealth).not.toHaveBeenCalled();
	});

	it('non-Umbrel deployment: unchanged manual-config message even with the same unconfigured status', async () => {
		delete process.env.CAIRN_PLATFORM; // not Umbrel for this one case
		wireMiningEnabledToggle('false');
		vi.mocked(startMiningEngine).mockResolvedValue(undefined);
		vi.mocked(miningEngineStatus).mockReturnValue({
			running: false,
			engine: null,
			coreRpc: 'unconfigured',
			startedAt: null
		});
		vi.mocked(miningFatalErrors).mockReturnValue([]);

		const res = await actions.startStop(makeEvent(ADMIN));

		expect(res).toMatchObject({ status: 500 });
		const msg = (res as { data?: { error?: string } }).data?.error;
		expect(msg).toMatch(/Admin → Settings/);
		expect(msg).not.toMatch(/App Store/);
		expect(probeCoreRpcHealth).not.toHaveBeenCalled();
	});
});
