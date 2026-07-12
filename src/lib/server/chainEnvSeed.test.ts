// cairn-loq7 — a fresh Umbrel install must be zero-config against the
// operator's own bitcoin/electrs deps: seedChainConfigFromEnv() writes
// CAIRN_ELECTRUM_*/CAIRN_CORE_RPC_* env values into the settings table (and
// instance_secrets for core_rpc_pass) exactly once, and must never clobber a
// value an admin has already set via Admin -> Settings.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from './db';
import { getSetting, setSetting, setSecretSetting, readSecretSetting } from './settings';
import { seedChainConfigFromEnv } from './chainEnvSeed';

const ENV_KEYS = [
	'CAIRN_ELECTRUM_HOST',
	'CAIRN_ELECTRUM_PORT',
	'CAIRN_ELECTRUM_TLS',
	'CAIRN_CORE_RPC_URL',
	'CAIRN_CORE_RPC_USER',
	'CAIRN_CORE_RPC_PASS'
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('seedChainConfigFromEnv', () => {
	it('does nothing when no chain env vars are set', () => {
		seedChainConfigFromEnv();
		expect(getSetting('electrum_host')).toBeNull();
		expect(getSetting('connection_mode')).toBeNull();
		expect(getSetting('core_rpc_url')).toBeNull();
		expect(readSecretSetting('core_rpc_pass')).toBeNull();
	});

	it('seeds a fresh DB from the full Umbrel env set, including flipping connectionMode to custom', () => {
		process.env.CAIRN_ELECTRUM_HOST = '10.21.0.5';
		process.env.CAIRN_ELECTRUM_PORT = '50001';
		process.env.CAIRN_ELECTRUM_TLS = 'false';
		process.env.CAIRN_CORE_RPC_URL = 'http://10.21.0.5:8332';
		process.env.CAIRN_CORE_RPC_USER = 'cairn';
		process.env.CAIRN_CORE_RPC_PASS = 'hunter2';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('10.21.0.5');
		expect(getSetting('electrum_port')).toBe('50001');
		expect(getSetting('electrum_tls')).toBe('false');
		expect(getSetting('connection_mode')).toBe('custom');
		expect(getSetting('core_rpc_url')).toBe('http://10.21.0.5:8332');
		expect(getSetting('core_rpc_user')).toBe('cairn');
		expect(readSecretSetting('core_rpc_pass')).toBe('hunter2');
		// The secret must never land in the plain settings table.
		expect(getSetting('core_rpc_pass')).toBeNull();
	});

	it('never overrides values an admin has already set, even with env vars present', () => {
		setSetting('electrum_host', 'admin-chosen.example');
		setSetting('electrum_port', '60001');
		setSetting('electrum_tls', 'true');
		setSetting('connection_mode', 'public');
		setSetting('core_rpc_url', 'http://admin-chosen:8332');
		setSetting('core_rpc_user', 'admin-user');
		setSecretSetting('core_rpc_pass', 'admin-pass');

		process.env.CAIRN_ELECTRUM_HOST = 'env-host.example';
		process.env.CAIRN_ELECTRUM_PORT = '50001';
		process.env.CAIRN_ELECTRUM_TLS = 'false';
		process.env.CAIRN_CORE_RPC_URL = 'http://env-host:8332';
		process.env.CAIRN_CORE_RPC_USER = 'env-user';
		process.env.CAIRN_CORE_RPC_PASS = 'env-pass';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('admin-chosen.example');
		expect(getSetting('electrum_port')).toBe('60001');
		expect(getSetting('electrum_tls')).toBe('true');
		expect(getSetting('connection_mode')).toBe('public');
		expect(getSetting('core_rpc_url')).toBe('http://admin-chosen:8332');
		expect(getSetting('core_rpc_user')).toBe('admin-user');
		expect(readSecretSetting('core_rpc_pass')).toBe('admin-pass');
	});

	it('does not flip an already-chosen connectionMode even when the electrum host is freshly seeded', () => {
		// Admin explicitly chose public mode (e.g. deliberately, before ever
		// touching the Electrum host field) — a later env-seeded host must not
		// silently switch them into custom mode.
		setSetting('connection_mode', 'public');

		process.env.CAIRN_ELECTRUM_HOST = 'env-host.example';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('env-host.example');
		expect(getSetting('connection_mode')).toBe('public');
	});

	// Finding 6 (test-units): the connection_mode flip is gated only on
	// `connection_mode === null`, independent of whether seedIfUnset actually
	// WROTE the host. Scenario: an admin previously set electrum_host via
	// Settings but never picked a connection_mode; on restart with
	// CAIRN_ELECTRUM_HOST present, the host write is skipped (already
	// customized) yet connection_mode is still flipped to 'custom'. Likely
	// intended, but unpinned — a refactor could break either direction silently.
	it('flips connection_mode to custom even when the admin-set host itself is NOT overwritten', () => {
		setSetting('electrum_host', 'admin-host.example'); // admin-set, no connection_mode chosen yet

		process.env.CAIRN_ELECTRUM_HOST = 'env-host.example';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('admin-host.example'); // untouched
		expect(getSetting('connection_mode')).toBe('custom'); // flipped anyway
	});

	it('seeds only the env vars that are present, leaving the rest unset (partial env)', () => {
		process.env.CAIRN_CORE_RPC_URL = 'http://10.21.0.5:8332';
		process.env.CAIRN_CORE_RPC_USER = 'cairn';
		// No CAIRN_CORE_RPC_PASS, no Electrum vars at all.

		seedChainConfigFromEnv();

		expect(getSetting('core_rpc_url')).toBe('http://10.21.0.5:8332');
		expect(getSetting('core_rpc_user')).toBe('cairn');
		expect(readSecretSetting('core_rpc_pass')).toBeNull();
		expect(getSetting('electrum_host')).toBeNull();
		expect(getSetting('connection_mode')).toBeNull();
	});

	it('is idempotent — running twice with the same env only seeds once', () => {
		process.env.CAIRN_ELECTRUM_HOST = '10.21.0.5';
		seedChainConfigFromEnv();
		seedChainConfigFromEnv();
		expect(getSetting('electrum_host')).toBe('10.21.0.5');
	});

	it('a later admin edit sticks — re-running the seed after a manual change does not revert it', () => {
		process.env.CAIRN_ELECTRUM_HOST = '10.21.0.5';
		seedChainConfigFromEnv();
		expect(getSetting('electrum_host')).toBe('10.21.0.5');

		// Admin manually overrides it in Admin -> Settings.
		setSetting('electrum_host', 'operator-picked.example');

		// Simulated restart: env var is still set (compose files don't forget).
		seedChainConfigFromEnv();
		expect(getSetting('electrum_host')).toBe('operator-picked.example');
	});

	describe('CAIRN_ELECTRUM_TLS parsing', () => {
		it.each([
			['true', 'true'],
			['1', 'true'],
			['false', 'false'],
			['0', 'false'],
			['TRUE', 'true'],
			['garbage', 'false']
		])('parses %s as %s', (raw, expected) => {
			db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
			process.env.CAIRN_ELECTRUM_TLS = raw;
			seedChainConfigFromEnv();
			expect(getSetting('electrum_tls')).toBe(expected);
		});
	});

	it('ignores a non-numeric CAIRN_ELECTRUM_PORT rather than storing garbage', () => {
		process.env.CAIRN_ELECTRUM_PORT = 'not-a-port';
		seedChainConfigFromEnv();
		expect(getSetting('electrum_port')).toBeNull();
	});

	// Finding 5 (test-units): chainEnvSeed.ts's port validation
	// (`Number.isInteger(port) && port >= 1 && port <= 65535`) only had the
	// non-numeric-string case covered above; the numeric boundaries themselves
	// (0, 65536, negative, non-integer) and the trim path were untested.
	describe('CAIRN_ELECTRUM_PORT boundaries', () => {
		it.each([
			['0', null],
			['65536', null],
			['-1', null],
			['50001.5', null], // Number.isInteger('50001.5') is false
			['1', '1'],
			['65535', '65535'],
			[' 50001 ', '50001'] // whitespace trimmed before storing
		])('%s -> %s', (raw, expected) => {
			process.env.CAIRN_ELECTRUM_PORT = raw;
			seedChainConfigFromEnv();
			expect(getSetting('electrum_port')).toBe(expected);
		});
	});

	// Finding 4 (test-units): chainEnvSeed.ts deliberately does NOT `.trim()`
	// core_rpc_pass — the comment above that field is explicit that leading/
	// trailing whitespace in a password is significant, matching the admin
	// settings form. Every other seeded field in this file IS trimmed, so this
	// is exactly the kind of inconsistency a "tidying" refactor would silently
	// "fix" by adding `.trim()` here too, corrupting passwords with edge
	// whitespace with no test failing. Regression-locked verbatim below.
	it('does NOT trim core_rpc_pass — leading/trailing whitespace is preserved verbatim', () => {
		process.env.CAIRN_CORE_RPC_PASS = '  spaced-secret  ';
		seedChainConfigFromEnv();
		expect(readSecretSetting('core_rpc_pass')).toBe('  spaced-secret  ');
	});
});
