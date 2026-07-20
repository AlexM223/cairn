// Network-mismatch guard (Umbrel zero-config Core RPC wave §C) — the
// mining engine must REFUSE to start against a Bitcoin Core node reporting a
// different chain than the instance is configured for, rather than silently
// building block templates / paying out on the wrong network. The
// AUTHORITATIVE check is getblockchaininfo().chain vs the app's configured
// network (CAIRN_CORE_RPC_NETWORK, seeded by chainEnvSeed.ts, is only the
// pre-flight hint).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../featureFlags/resolve', () => ({ isFeatureEnabled: () => true }));

vi.mock('./settings', () => ({
	readMiningSettings: () => ({
		enabled: true,
		bind: 'loopback',
		bindHost: '127.0.0.1',
		stratumPort: 3333,
		shareDifficulty: 1,
		vardiffEnabled: false,
		vardiffTargetPerMin: 6,
		poolTag: 'Heartwood',
		asicPortEnabled: false,
		asicStratumPort: 3334,
		asicShareDifficulty: 65536,
		sv2Enabled: false,
		sv2Port: 3335,
		sv2ShareDifficulty: 65536,
		sv2VersionRolling: false
	})
}));

let configuredNetwork: 'mainnet' | 'testnet' | 'regtest' = 'mainnet';
vi.mock('../settings', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../settings')>();
	return {
		...mod,
		getChainConfig: () => ({
			...mod.PUBLIC_DEFAULTS,
			electrumTlsInsecure: false,
			socks5Host: null,
			socks5Port: null,
			electrumPoolSize: 3,
			coreRpcUrl: 'http://core:8332',
			coreRpcUser: 'user',
			coreRpcPass: 'pass',
			mode: 'custom',
			network: configuredNetwork
		})
	};
});

let getBlockchainInfoMock: ReturnType<typeof vi.fn>;
vi.mock('../chain', () => ({
	getChain: () => ({
		coreConfigured: true,
		core: { getBlockchainInfo: getBlockchainInfoMock }
	})
}));

import { startMiningEngine, miningFatalErrors, coreChainMatchesNetwork, __resetMiningEngineForTests } from './index';

beforeEach(() => {
	__resetMiningEngineForTests();
	configuredNetwork = 'mainnet';
	getBlockchainInfoMock = vi.fn();
});

describe('coreChainMatchesNetwork — Core chain-name vocabulary vs ChainNetwork', () => {
	it.each([
		['main', 'mainnet', true],
		['test', 'mainnet', false],
		['test', 'testnet', true],
		['testnet4', 'testnet', true],
		['main', 'testnet', false],
		['regtest', 'regtest', true],
		['regtest', 'mainnet', false],
		['regtest', 'testnet', false],
		// Cairn has no Signet support — a signet node never matches anything.
		['signet', 'mainnet', false],
		['signet', 'testnet', false],
		['signet', 'regtest', false]
	] as const)('coreChain=%s network=%s -> %s', (coreChain, network, expected) => {
		expect(coreChainMatchesNetwork(coreChain, network)).toBe(expected);
	});
});

describe('doStart — network-mismatch guard refuses to start', () => {
	it('refuses with a clear fatal message when Core reports a different chain than configured', async () => {
		configuredNetwork = 'mainnet';
		getBlockchainInfoMock.mockResolvedValue({ chain: 'test', blocks: 100, bestblockhash: 'h'.repeat(64) });

		await startMiningEngine();

		const fatals = miningFatalErrors();
		expect(fatals.some((f) => /chain "test"/.test(f) && /mainnet/.test(f))).toBe(true);
	});

	it('refuses when a regtest instance is pointed at a mainnet Core node', async () => {
		configuredNetwork = 'regtest';
		getBlockchainInfoMock.mockResolvedValue({ chain: 'main', blocks: 800000, bestblockhash: 'h'.repeat(64) });

		await startMiningEngine();

		const fatals = miningFatalErrors();
		expect(fatals.some((f) => /chain "main"/.test(f) && /regtest/.test(f))).toBe(true);
	});
});
