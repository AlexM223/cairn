// Umbrel zero-config Electrum auto-connect — credential-free probe (Wave A,
// docs/UMBREL-AUTOCONNECT-DESIGN.md §3). Covers
// exactly the three properties the design calls out as must-hold:
//  1. The probe never runs unless CAIRN_PLATFORM === 'umbrel' (footgun guard
//     against probing 10.21.21.x on a non-Umbrel host).
//  2. The probe never re-runs / never overrides once connection_mode is set
//     (idempotent across restarts, and env-seed always wins when present).
//  3. On a successful handshake it seeds electrum_host/port/tls +
//     connection_mode='custom' + the chain_provisioned_by='umbrel-probe'
//     marker, all via the same seed-once semantics as chainEnvSeed.ts.
//
// ElectrumClient's own network/protocol behavior is already covered by
// electrum/client.test.ts; this suite mocks that module so it can drive the
// probe's gating and seeding logic directly, without a real TCP server.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from './db';
import { getSetting, setSetting } from './settings';

const headersSubscribe = vi.fn();
const close = vi.fn();

vi.mock('./electrum/client', () => ({
	// A regular `function`, not an arrow function — vitest's mock needs a real
	// constructor here since umbrelProbe.ts calls `new ElectrumClient(...)`;
	// an arrow-function implementation can't be invoked with `new` and the
	// resulting client silently comes back unusable.
	ElectrumClient: vi.fn().mockImplementation(function () {
		return { headersSubscribe, close };
	})
}));

const { probeAndSeedUmbrelElectrum } = await import('./umbrelProbe');
const { ElectrumClient } = await import('./electrum/client');

let savedPlatform: string | undefined;

beforeEach(() => {
	db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
	savedPlatform = process.env.CAIRN_PLATFORM;
	delete process.env.CAIRN_PLATFORM;
	headersSubscribe.mockReset();
	close.mockReset();
	vi.mocked(ElectrumClient).mockClear();
});

afterEach(() => {
	if (savedPlatform === undefined) delete process.env.CAIRN_PLATFORM;
	else process.env.CAIRN_PLATFORM = savedPlatform;
});

describe('probeAndSeedUmbrelElectrum — platform gate', () => {
	it('never probes when CAIRN_PLATFORM is unset', async () => {
		const applied = await probeAndSeedUmbrelElectrum();
		expect(applied).toEqual([]);
		expect(ElectrumClient).not.toHaveBeenCalled();
		expect(getSetting('electrum_host')).toBeNull();
	});

	it('never probes when CAIRN_PLATFORM is set to something other than "umbrel"', async () => {
		process.env.CAIRN_PLATFORM = 'docker';
		const applied = await probeAndSeedUmbrelElectrum();
		expect(applied).toEqual([]);
		expect(ElectrumClient).not.toHaveBeenCalled();
	});
});

describe('probeAndSeedUmbrelElectrum — connection_mode gate', () => {
	it('does not probe (or re-probe) once connection_mode is already set to public', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('connection_mode', 'public');

		const applied = await probeAndSeedUmbrelElectrum();

		expect(applied).toEqual([]);
		expect(ElectrumClient).not.toHaveBeenCalled();
	});

	it('does not re-probe once already auto-connected (idempotent across restarts)', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('connection_mode', 'custom');
		setSetting('electrum_host', '10.21.21.10');

		const applied = await probeAndSeedUmbrelElectrum();

		expect(applied).toEqual([]);
		expect(ElectrumClient).not.toHaveBeenCalled();
	});
});

describe('probeAndSeedUmbrelElectrum — seeding on a successful handshake', () => {
	it('seeds electrum_host/port/tls + connection_mode + provenance marker from the first reachable candidate (electrs)', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		headersSubscribe.mockResolvedValueOnce({ height: 800000, hex: 'deadbeef' });

		const applied = await probeAndSeedUmbrelElectrum();

		expect(getSetting('electrum_host')).toBe('10.21.21.10');
		expect(getSetting('electrum_port')).toBe('50001');
		expect(getSetting('electrum_tls')).toBe('false');
		expect(getSetting('connection_mode')).toBe('custom');
		expect(getSetting('chain_provisioned_by')).toBe('umbrel-probe');
		expect(applied.sort()).toEqual(
			[
				'electrum_host',
				'electrum_port',
				'electrum_tls',
				'connection_mode',
				'chain_provisioned_by'
			].sort()
		);
		expect(close).toHaveBeenCalled();
		// Only the first (electrs) candidate should have been tried.
		expect(ElectrumClient).toHaveBeenCalledTimes(1);
	});

	it('falls through to the second candidate (fulcrum) when the first fails', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		headersSubscribe.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		headersSubscribe.mockResolvedValueOnce({ height: 800000, hex: 'deadbeef' });

		const applied = await probeAndSeedUmbrelElectrum();

		expect(getSetting('electrum_host')).toBe('10.21.21.200');
		expect(getSetting('electrum_port')).toBe('50002');
		expect(applied).toContain('electrum_host');
		expect(ElectrumClient).toHaveBeenCalledTimes(2);
	});

	it('leaves settings untouched and returns [] when every candidate fails', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		headersSubscribe.mockRejectedValue(new Error('timeout'));

		const applied = await probeAndSeedUmbrelElectrum();

		expect(applied).toEqual([]);
		expect(getSetting('electrum_host')).toBeNull();
		expect(getSetting('connection_mode')).toBeNull();
		expect(getSetting('chain_provisioned_by')).toBeNull();
	});

	it('does not clobber an already-set electrum_port even if connection_mode was somehow left unset', async () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		setSetting('electrum_port', '9999'); // pre-existing, no connection_mode chosen yet
		headersSubscribe.mockResolvedValueOnce({ height: 800000, hex: 'deadbeef' });

		const applied = await probeAndSeedUmbrelElectrum();

		expect(getSetting('electrum_port')).toBe('9999'); // untouched
		expect(getSetting('electrum_host')).toBe('10.21.21.10'); // still seeded
		expect(applied).not.toContain('electrum_port');
		expect(applied).toContain('electrum_host');
	});
});
