// Persistence proof for Core RPC settings (orchestrator priority, tracked
// alongside cairn-3p9z): setSetting('core_rpc_url'/'core_rpc_user') +
// setSecretSetting('core_rpc_pass') must round-trip correctly, with the
// secret encrypted at rest (never plaintext in the raw DB row), survive a
// fresh read (settings.ts holds no module-level cache — every getSetting/
// getInstanceSettings call is a brand-new DB query, the closest equivalent to
// "after a process restart" available in a unit test), and the admin
// settings page's own `load()` — the actual boundary between the server and
// the browser — must surface url/user and a hasCoreRpcPass presence flag
// WITHOUT ever handing the raw password to the page.
//
// Deliberately does NOT mock '$lib/server/settings' (unlike page.server.test.ts,
// which stubs setSetting/setSecretSetting to isolate the `actions` unit tests
// from the DB) — this file's whole point is proving the real persistence path
// end to end, through the real getPublicInstanceSettings() serialization
// boundary that `load()` calls.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { setSetting, setSecretSetting, getInstanceSettings } from '$lib/server/settings';
import { isSecretEnvelope } from '$lib/server/secretKey';
import { load } from './+page.server';

const RPC_URL = 'http://127.0.0.1:8332';
const RPC_USER = 'rpcuser';
const RPC_PASS = 'super-secret-rpc-pass';

function loadEvent() {
	return {} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
});

describe('Core RPC settings persistence (cairn-3p9z verification)', () => {
	it('setSetting(core_rpc_url/core_rpc_user) + setSecretSetting(core_rpc_pass) round-trip, secret encrypted at rest', () => {
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', RPC_PASS);

		// The raw DB row for the secret must not be plaintext.
		const row = db
			.prepare('SELECT value_enc FROM instance_secrets WHERE key = ?')
			.get('core_rpc_pass') as { value_enc: string } | undefined;
		expect(row).toBeDefined();
		expect(row!.value_enc).not.toContain(RPC_PASS);
		expect(isSecretEnvelope(row!.value_enc)).toBe(true);

		// The plain `settings` table must never carry the secret either.
		const legacyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('core_rpc_pass');
		expect(legacyRow).toBeUndefined();

		// A fresh read (see file header — no cache to bypass) recovers the plaintext.
		const fresh = getInstanceSettings();
		expect(fresh.coreRpcUrl).toBe(RPC_URL);
		expect(fresh.coreRpcUser).toBe(RPC_USER);
		expect(fresh.coreRpcPass).toBe(RPC_PASS);
	});

	it("load() surfaces coreRpcUrl/coreRpcUser and hasCoreRpcPass, but the raw password never appears in the page's data", async () => {
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', RPC_PASS);

		const data = (await load(loadEvent())) as { settings: Record<string, unknown> };

		expect(data.settings.coreRpcUrl).toBe(RPC_URL);
		expect(data.settings.coreRpcUser).toBe(RPC_USER);
		expect(data.settings.hasCoreRpcPass).toBe(true);
		// The raw secret key must not even be present on the returned object —
		// getPublicInstanceSettings() destructures it out entirely, it isn't just
		// nulled — and it must not appear ANYWHERE in the serialized load payload
		// (belt and braces, mirrors settings.test.ts's redaction pins).
		expect('coreRpcPass' in data.settings).toBe(false);
		expect(JSON.stringify(data)).not.toContain(RPC_PASS);
	});

	it('load() reports hasCoreRpcPass: false and null coreRpcUrl when nothing is configured', async () => {
		const data = (await load(loadEvent())) as { settings: Record<string, unknown> };
		expect(data.settings.hasCoreRpcPass).toBe(false);
		expect(data.settings.coreRpcUrl).toBeNull();
		expect('coreRpcPass' in data.settings).toBe(false);
	});
});
