/**
 * readMiningSettings() defaults + platform-aware bind (cairn-pz8v5, cairn-bm7c2).
 *
 * getSetting is mocked with a simple in-memory KV so each case controls exactly
 * which keys are "admin-saved"; env access ($env/dynamic/private) is aliased to
 * process.env by vitest, so CAIRN_PLATFORM is set/cleared directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('../settings', () => ({
	getSetting: (k: string) => store.get(k) ?? null
}));

import { readMiningSettings, DEFAULT_ASIC_SHARE_DIFFICULTY } from './settings';

const savedPlatform = process.env.CAIRN_PLATFORM;

beforeEach(() => {
	store.clear();
	delete process.env.CAIRN_PLATFORM;
});
afterEach(() => {
	if (savedPlatform === undefined) delete process.env.CAIRN_PLATFORM;
	else process.env.CAIRN_PLATFORM = savedPlatform;
});

describe('readMiningSettings — ASIC port defaults', () => {
	it('defaults the ASIC listener on, port 3334, difficulty 65536', () => {
		const s = readMiningSettings();
		expect(s.asicPortEnabled).toBe(true);
		expect(s.asicStratumPort).toBe(3334);
		expect(s.asicShareDifficulty).toBe(DEFAULT_ASIC_SHARE_DIFFICULTY);
		expect(DEFAULT_ASIC_SHARE_DIFFICULTY).toBe(65536);
	});

	it('an ASIC port equal to the standard 3334 default is above the standard 3333 port', () => {
		const s = readMiningSettings();
		expect(s.asicStratumPort).not.toBe(s.stratumPort);
	});

	it('reads admin-saved ASIC settings over the defaults', () => {
		store.set('mining_asic_port_enabled', 'false');
		store.set('mining_asic_stratum_port', '4444');
		store.set('mining_asic_share_difficulty', '1024');
		const s = readMiningSettings();
		expect(s.asicPortEnabled).toBe(false);
		expect(s.asicStratumPort).toBe(4444);
		expect(s.asicShareDifficulty).toBe(1024);
	});
});

describe('readMiningSettings — platform-aware bind default (cairn-bm7c2)', () => {
	it('defaults to loopback (127.0.0.1) on a non-Umbrel install', () => {
		const s = readMiningSettings();
		expect(s.bind).toBe('loopback');
		expect(s.bindHost).toBe('127.0.0.1');
	});

	it('defaults to all (0.0.0.0) when CAIRN_PLATFORM=umbrel', () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		const s = readMiningSettings();
		expect(s.bind).toBe('all');
		expect(s.bindHost).toBe('0.0.0.0');
	});

	it('does NOT flip the default for any other CAIRN_PLATFORM value', () => {
		process.env.CAIRN_PLATFORM = 'start9';
		expect(readMiningSettings().bind).toBe('loopback');
	});

	it('an explicit admin-saved bind wins over the Umbrel default', () => {
		process.env.CAIRN_PLATFORM = 'umbrel';
		store.set('mining_bind', 'loopback');
		const s = readMiningSettings();
		expect(s.bind).toBe('loopback');
		expect(s.bindHost).toBe('127.0.0.1');
	});

	it('an explicit admin-saved bind is honoured on a non-Umbrel install too', () => {
		store.set('mining_bind', 'all');
		const s = readMiningSettings();
		expect(s.bind).toBe('all');
		expect(s.bindHost).toBe('0.0.0.0');
	});
});
