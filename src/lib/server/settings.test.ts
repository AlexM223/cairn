// cairn-q40v — the stored Core RPC password must never round-trip to clients.
// getPublicInstanceSettings() is the serialization boundary every settings
// responder goes through: it must replace coreRpcPass with a hasCoreRpcPass
// presence flag. Pre-fix, the raw password rode along in the serialized
// settings object. (The API surface is pinned in
// src/routes/api/admin/settings/server.test.ts.)

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { setSetting, getInstanceSettings, getPublicInstanceSettings } from './settings';

const SECRET = 'super-secret-rpc-pass';

beforeEach(() => {
	db.exec('DELETE FROM settings;');
});

describe('getPublicInstanceSettings — Core RPC password redaction', () => {
	it('reports hasCoreRpcPass: false and no coreRpcPass key when unset', () => {
		const pub = getPublicInstanceSettings();
		expect(pub.hasCoreRpcPass).toBe(false);
		expect('coreRpcPass' in pub).toBe(false);
	});

	it('replaces a stored password with hasCoreRpcPass: true — the secret never appears', () => {
		setSetting('core_rpc_pass', SECRET);
		const pub = getPublicInstanceSettings();
		expect(pub.hasCoreRpcPass).toBe(true);
		expect('coreRpcPass' in pub).toBe(false);
		// Belt and braces: the secret must not appear anywhere in the serialized form.
		expect(JSON.stringify(pub)).not.toContain(SECRET);
	});

	it('the server-internal getInstanceSettings still sees the password (redaction is the public boundary)', () => {
		setSetting('core_rpc_pass', SECRET);
		expect(getInstanceSettings().coreRpcPass).toBe(SECRET);
	});
});
