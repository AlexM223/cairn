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
	'CAIRN_CORE_RPC_PASS',
	'CAIRN_CORE_RPC_NETWORK'
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
		// Umbrel auto-connect design §4.1 A2: the settings UI's "auto-connected"
		// card keys off this marker.
		expect(getSetting('chain_provisioned_by')).toBe('umbrel-env');
		// Core RPC gets its OWN provenance marker (zero-config Core RPC wave §B) —
		// distinct from Electrum's chain_provisioned_by above.
		expect(getSetting('core_rpc_provisioned_by')).toBe('umbrel-env');
	});

	it('never overrides Electrum values an admin has already set, even with env vars present', () => {
		setSetting('electrum_host', 'admin-chosen.example');
		setSetting('electrum_port', '60001');
		setSetting('electrum_tls', 'true');
		setSetting('connection_mode', 'public');

		process.env.CAIRN_ELECTRUM_HOST = 'env-host.example';
		process.env.CAIRN_ELECTRUM_PORT = '50001';
		process.env.CAIRN_ELECTRUM_TLS = 'false';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('admin-chosen.example');
		expect(getSetting('electrum_port')).toBe('60001');
		expect(getSetting('electrum_tls')).toBe('true');
		expect(getSetting('connection_mode')).toBe('public');
		// The provenance marker must not be stamped — this is a manually-entered
		// connection, not an auto-connected one, even though the env vars exist.
		expect(getSetting('chain_provisioned_by')).toBeNull();
	});

	describe('Core RPC — reconcile-on-boot with provenance (zero-config Core RPC wave §B)', () => {
		it('manual-wins precedence: provenance stamped anything other than "umbrel-env" blocks env forever', () => {
			// Models the (now-fixed) admin settings save path, which stamps
			// 'manual' whenever a Core RPC URL is hand-entered through the plain
			// form fields (+page.server.ts) — the realistic way an admin-set
			// value acquires a provenance stamp today.
			setSetting('core_rpc_url', 'http://admin-chosen:8332');
			setSetting('core_rpc_user', 'admin-user');
			setSecretSetting('core_rpc_pass', 'admin-pass');
			setSetting('core_rpc_provisioned_by', 'manual');

			process.env.CAIRN_CORE_RPC_URL = 'http://env-host:8332';
			process.env.CAIRN_CORE_RPC_USER = 'env-user';
			process.env.CAIRN_CORE_RPC_PASS = 'env-pass';

			seedChainConfigFromEnv();

			expect(getSetting('core_rpc_url')).toBe('http://admin-chosen:8332');
			expect(getSetting('core_rpc_user')).toBe('admin-user');
			expect(readSecretSetting('core_rpc_pass')).toBe('admin-pass');
			expect(getSetting('core_rpc_provisioned_by')).toBe('manual');
		});

		it('manual-wins precedence: umbrel-detect (Wave B assisted-connect) also blocks env forever', () => {
			setSetting('core_rpc_url', 'http://detected:8332');
			setSetting('core_rpc_user', 'umbrel');
			setSecretSetting('core_rpc_pass', 'detected-pass');
			setSetting('core_rpc_provisioned_by', 'umbrel-detect');

			process.env.CAIRN_CORE_RPC_URL = 'http://env-host:8332';
			process.env.CAIRN_CORE_RPC_USER = 'env-user';
			process.env.CAIRN_CORE_RPC_PASS = 'env-pass';

			seedChainConfigFromEnv();

			expect(getSetting('core_rpc_url')).toBe('http://detected:8332');
			expect(readSecretSetting('core_rpc_pass')).toBe('detected-pass');
			expect(getSetting('core_rpc_provisioned_by')).toBe('umbrel-detect');
		});

		it('env-seeds and stamps provenance on a fresh (never-touched) install', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'rotated-secret';

			seedChainConfigFromEnv();

			expect(getSetting('core_rpc_url')).toBe('http://10.21.21.8:8332');
			expect(getSetting('core_rpc_user')).toBe('umbrel');
			expect(readSecretSetting('core_rpc_pass')).toBe('rotated-secret');
			expect(getSetting('core_rpc_provisioned_by')).toBe('umbrel-env');
		});

		// Empty-interpolation guard (§A, critical): the upcoming always-present
		// store compose block means an install with the Bitcoin app NOT
		// installed still gets CAIRN_CORE_RPC_URL=http://: (Docker Compose
		// interpolates the missing vars to empty strings) — truthy, but useless.
		// Must seed NOTHING and must never throw.
		it('empty-interpolation guard: "http://:" with empty user/pass seeds nothing and does not throw', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://:';
			process.env.CAIRN_CORE_RPC_USER = '';
			process.env.CAIRN_CORE_RPC_PASS = '';

			expect(() => seedChainConfigFromEnv()).not.toThrow();

			expect(getSetting('core_rpc_url')).toBeNull();
			expect(getSetting('core_rpc_user')).toBeNull();
			expect(readSecretSetting('core_rpc_pass')).toBeNull();
			expect(getSetting('core_rpc_provisioned_by')).toBeNull();
		});

		it('empty-interpolation guard: "http://:" with a VALID user/pass still seeds nothing (the URL itself is the guard)', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://:';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'realpass';

			expect(() => seedChainConfigFromEnv()).not.toThrow();

			expect(getSetting('core_rpc_url')).toBeNull();
			expect(getSetting('core_rpc_provisioned_by')).toBeNull();
		});

		it('present-check: a valid URL with an empty CAIRN_CORE_RPC_USER seeds nothing', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = '';
			process.env.CAIRN_CORE_RPC_PASS = 'realpass';

			seedChainConfigFromEnv();

			expect(getSetting('core_rpc_url')).toBeNull();
			expect(readSecretSetting('core_rpc_pass')).toBeNull();
		});

		it('present-check: a valid URL with an empty CAIRN_CORE_RPC_PASS seeds nothing', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = '';

			seedChainConfigFromEnv();

			expect(getSetting('core_rpc_url')).toBeNull();
			expect(getSetting('core_rpc_user')).toBeNull();
		});

		it('a non-URL CAIRN_CORE_RPC_URL ("not-a-url") seeds nothing and does not throw', () => {
			process.env.CAIRN_CORE_RPC_URL = 'not-a-url';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'realpass';

			expect(() => seedChainConfigFromEnv()).not.toThrow();
			expect(getSetting('core_rpc_url')).toBeNull();
		});

		// Credential-rotation self-heal — the whole point of §B: reinstalling
		// the Umbrel Bitcoin app rotates APP_BITCOIN_RPC_PASS. A seed-once
		// write would leave Cairn stuck on the stale password (401 forever).
		it('rotation: a changed env password overwrites the stored one while provenance is umbrel-env', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'password-X';
			seedChainConfigFromEnv();
			expect(readSecretSetting('core_rpc_pass')).toBe('password-X');
			expect(getSetting('core_rpc_provisioned_by')).toBe('umbrel-env');

			// Umbrel Bitcoin app reinstalled — rotates the password. Simulated
			// restart: the env var now carries the new value.
			process.env.CAIRN_CORE_RPC_PASS = 'password-Y';
			seedChainConfigFromEnv();

			expect(readSecretSetting('core_rpc_pass')).toBe('password-Y');
			expect(getSetting('core_rpc_provisioned_by')).toBe('umbrel-env');
		});

		it('rotation: a changed env password does NOT overwrite once provenance is manual/umbrel-detect', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'password-X';
			seedChainConfigFromEnv();
			expect(readSecretSetting('core_rpc_pass')).toBe('password-X');

			// Admin takes manual ownership (the settings page's "Switch to
			// manual" override, or a hand-edit through the plain form).
			setSetting('core_rpc_provisioned_by', 'manual');

			process.env.CAIRN_CORE_RPC_PASS = 'password-Y';
			seedChainConfigFromEnv();

			expect(readSecretSetting('core_rpc_pass')).toBe('password-X'); // unchanged
			expect(getSetting('core_rpc_provisioned_by')).toBe('manual');
		});

		// Network-mismatch guard (§C): CAIRN_CORE_RPC_NETWORK seeds the app's
		// configured network (chain_network) as a pre-flight HINT, under the
		// identical reconcile rule. The AUTHORITATIVE check against Core's own
		// getblockchaininfo().chain happens at mining engine start
		// (mining/index.ts's coreChainMatchesNetwork), not here.
		it('reconciles chain_network from CAIRN_CORE_RPC_NETWORK alongside the URL/user/pass', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'realpass';
			process.env.CAIRN_CORE_RPC_NETWORK = 'regtest';

			seedChainConfigFromEnv();

			expect(getSetting('chain_network')).toBe('regtest');
		});

		it('ignores an invalid CAIRN_CORE_RPC_NETWORK value rather than storing garbage', () => {
			process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
			process.env.CAIRN_CORE_RPC_USER = 'umbrel';
			process.env.CAIRN_CORE_RPC_PASS = 'realpass';
			process.env.CAIRN_CORE_RPC_NETWORK = 'signet'; // Cairn has no Signet support

			seedChainConfigFromEnv();

			expect(getSetting('chain_network')).toBeNull();
		});

		it('does not reconcile chain_network once provenance is manual, matching the URL/user/pass rule', () => {
			setSetting('core_rpc_url', 'http://admin-chosen:8332');
			setSetting('core_rpc_provisioned_by', 'manual');
			setSetting('chain_network', 'mainnet');

			process.env.CAIRN_CORE_RPC_URL = 'http://env-host:8332';
			process.env.CAIRN_CORE_RPC_USER = 'env-user';
			process.env.CAIRN_CORE_RPC_PASS = 'env-pass';
			process.env.CAIRN_CORE_RPC_NETWORK = 'regtest';

			seedChainConfigFromEnv();

			expect(getSetting('chain_network')).toBe('mainnet');
		});
	});

	// Wave A (design §4.1 A2): chain_provisioned_by must reflect whether the
	// env-provided host was actually ADOPTED, not merely whether the env var
	// was present — otherwise an admin's own pre-existing custom host would get
	// mislabeled as "auto-connected via Umbrel" the moment this env var shows
	// up in their compose (e.g. after an unrelated store update).
	it('does not stamp the provenance marker when the electrum_host write is skipped (admin-set host wins)', () => {
		setSetting('electrum_host', 'admin-host.example'); // admin-set, no connection_mode chosen yet

		process.env.CAIRN_ELECTRUM_HOST = 'env-host.example';

		seedChainConfigFromEnv();

		expect(getSetting('electrum_host')).toBe('admin-host.example'); // untouched
		expect(getSetting('connection_mode')).toBe('custom'); // still flips (existing behavior)
		expect(getSetting('chain_provisioned_by')).toBeNull(); // NOT stamped
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

	// Core RPC reconciliation is all-or-nothing (§B/§A): url + user + pass must
	// ALL be present, or nothing Core-related seeds at all — a partial set
	// (e.g. URL+user with no password yet) is exactly as useless/broken as the
	// empty-interpolation case and must not seed a guaranteed-401 endpoint.
	it('Core RPC: a partial env (no password) seeds nothing at all, not even the URL/user', () => {
		process.env.CAIRN_CORE_RPC_URL = 'http://10.21.0.5:8332';
		process.env.CAIRN_CORE_RPC_USER = 'cairn';
		// No CAIRN_CORE_RPC_PASS, no Electrum vars at all.

		seedChainConfigFromEnv();

		expect(getSetting('core_rpc_url')).toBeNull();
		expect(getSetting('core_rpc_user')).toBeNull();
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
		process.env.CAIRN_CORE_RPC_URL = 'http://10.21.21.8:8332';
		process.env.CAIRN_CORE_RPC_USER = 'umbrel';
		process.env.CAIRN_CORE_RPC_PASS = '  spaced-secret  ';
		seedChainConfigFromEnv();
		expect(readSecretSetting('core_rpc_pass')).toBe('  spaced-secret  ');
	});
});
