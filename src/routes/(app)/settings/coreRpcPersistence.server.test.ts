// Persistence proof for Core RPC settings after the /admin/settings → /settings
// merge (cairn-6c91u.2). setSetting('core_rpc_url'/'core_rpc_user') +
// setSecretSetting('core_rpc_pass') must round-trip with the secret encrypted at
// rest (never plaintext in the raw DB row), and the merged Settings page's own
// load() — the actual server→browser boundary — must surface url/user + a
// hasCoreRpcPass presence flag under data.admin.settings WITHOUT ever handing the
// raw password to the page. The admin-config data lives under `data.admin`, which
// is null for a non-admin load (proven in the last case) so it never leaves the
// server for a regular user (spec §4.2 / risk R1).
//
// Deliberately does NOT mock '$lib/server/settings' — this file proves the real
// persistence path end to end through getPublicInstanceSettings().

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { setSetting, setSecretSetting, getInstanceSettings } from '$lib/server/settings';
import { isSecretEnvelope } from '$lib/server/secretKey';
import { load } from './+page.server';

const RPC_URL = 'http://127.0.0.1:8332';
const RPC_USER = 'rpcuser';
const RPC_PASS = 'super-secret-rpc-pass';

const ADMIN = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'user@example.com', displayName: 'User', isAdmin: false };

function loadEvent(user: typeof ADMIN | typeof NON_ADMIN) {
	return {
		locals: { user },
		url: new URL('http://localhost/settings')
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
});

describe('Core RPC settings persistence via the merged Settings load', () => {
	it('setSetting(core_rpc_url/core_rpc_user) + setSecretSetting(core_rpc_pass) round-trip, secret encrypted at rest', () => {
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', RPC_PASS);

		const row = db
			.prepare('SELECT value_enc FROM instance_secrets WHERE key = ?')
			.get('core_rpc_pass') as { value_enc: string } | undefined;
		expect(row).toBeDefined();
		expect(row!.value_enc).not.toContain(RPC_PASS);
		expect(isSecretEnvelope(row!.value_enc)).toBe(true);

		const legacyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('core_rpc_pass');
		expect(legacyRow).toBeUndefined();

		const fresh = getInstanceSettings();
		expect(fresh.coreRpcUrl).toBe(RPC_URL);
		expect(fresh.coreRpcUser).toBe(RPC_USER);
		expect(fresh.coreRpcPass).toBe(RPC_PASS);
	});

	it("admin load() surfaces coreRpcUrl/coreRpcUser and hasCoreRpcPass under data.admin.settings, but the raw password never appears", async () => {
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', RPC_PASS);

		const data = (await load(loadEvent(ADMIN))) as {
			admin: { settings: Record<string, unknown> } | null;
		};

		expect(data.admin).not.toBeNull();
		expect(data.admin!.settings.coreRpcUrl).toBe(RPC_URL);
		expect(data.admin!.settings.coreRpcUser).toBe(RPC_USER);
		expect(data.admin!.settings.hasCoreRpcPass).toBe(true);
		expect('coreRpcPass' in data.admin!.settings).toBe(false);
		expect(JSON.stringify(data)).not.toContain(RPC_PASS);
	});

	it('admin load() reports hasCoreRpcPass: false and null coreRpcUrl when nothing is configured', async () => {
		const data = (await load(loadEvent(ADMIN))) as {
			admin: { settings: Record<string, unknown> } | null;
		};
		expect(data.admin).not.toBeNull();
		expect(data.admin!.settings.hasCoreRpcPass).toBe(false);
		expect(data.admin!.settings.coreRpcUrl).toBeNull();
		expect('coreRpcPass' in data.admin!.settings).toBe(false);
	});

	it('a non-admin load() carries NO admin config at all — data.admin is null (spec R1)', async () => {
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', RPC_PASS);

		const data = (await load(loadEvent(NON_ADMIN))) as { admin: unknown };
		expect(data.admin).toBeNull();
		// No chain/agreement/registration/flag values, and certainly no secret,
		// anywhere in a regular user's payload.
		expect(JSON.stringify(data)).not.toContain(RPC_URL);
		expect(JSON.stringify(data)).not.toContain(RPC_PASS);
	});
});
