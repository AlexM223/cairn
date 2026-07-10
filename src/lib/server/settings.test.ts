// cairn-q40v — the stored Core RPC password must never round-trip to clients.
// getPublicInstanceSettings() is the serialization boundary every settings
// responder goes through: it must replace coreRpcPass with a hasCoreRpcPass
// presence flag. Pre-fix, the raw password rode along in the serialized
// settings object. (The API surface is pinned in
// src/routes/api/admin/settings/server.test.ts.)

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import {
	setSetting,
	getSetting,
	setSecretSetting,
	readSecretSetting,
	getInstanceSettings,
	getPublicInstanceSettings,
	getChainConfig
} from './settings';
import { isSecretEnvelope } from './secretKey';

const SECRET = 'super-secret-rpc-pass';

beforeEach(() => {
	db.exec('DELETE FROM settings; DELETE FROM instance_secrets;');
});

/** What actually sits at rest for a secret key (instance_secrets.value_enc). */
function rawInstanceSecret(key: string): string | null {
	const row = db.prepare('SELECT value_enc FROM instance_secrets WHERE key = ?').get(key) as
		| { value_enc: string }
		| undefined;
	return row?.value_enc ?? null;
}

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

// cairn-e9mz.3 — smtp_pass / core_rpc_pass / telegram_bot_token must be stored
// as encryptSecret() envelopes, never raw text, while every reader still gets
// the plaintext back (and legacy plaintext rows keep working until the startup
// migration rewrites them).
describe('setSecretSetting / readSecretSetting — encrypted at rest', () => {
	const KEYS = ['smtp_pass', 'core_rpc_pass', 'telegram_bot_token'];

	it.each(KEYS)('%s round-trips through an envelope, plaintext never stored', (key) => {
		setSecretSetting(key, SECRET);
		const raw = rawInstanceSecret(key)!; // what actually sits in instance_secrets
		expect(raw).not.toContain(SECRET);
		expect(isSecretEnvelope(raw)).toBe(true);
		expect(readSecretSetting(key)).toBe(SECRET);
		// The plain settings table never sees the secret (cairn-e9mz.4).
		expect(getSetting(key)).toBeNull();
	});

	it('writing a secret removes any stale legacy copy from the settings table', () => {
		setSetting('smtp_pass', 'legacy-plaintext');
		setSecretSetting('smtp_pass', SECRET);
		expect(getSetting('smtp_pass')).toBeNull(); // legacy row gone
		expect(readSecretSetting('smtp_pass')).toBe(SECRET);
	});

	it('getInstanceSettings decrypts an encrypted core_rpc_pass', () => {
		setSecretSetting('core_rpc_pass', SECRET);
		expect(getInstanceSettings().coreRpcPass).toBe(SECRET);
		// And the public shape still only carries the presence flag.
		const pub = getPublicInstanceSettings();
		expect(pub.hasCoreRpcPass).toBe(true);
		expect(JSON.stringify(pub)).not.toContain(SECRET);
	});

	it('reads legacy plaintext values through unchanged', () => {
		setSetting('smtp_pass', SECRET); // pre-encryption row
		expect(readSecretSetting('smtp_pass')).toBe(SECRET);
	});

	it("'' clears: stored as '' so presence checks stay falsy", () => {
		setSecretSetting('smtp_pass', SECRET);
		setSecretSetting('smtp_pass', '');
		expect(rawInstanceSecret('smtp_pass')).toBe('');
		expect(readSecretSetting('smtp_pass')).toBe('');
	});

	it('fails closed (null) on an undecryptable envelope', () => {
		setSetting('core_rpc_pass', JSON.stringify({ v: 1, iv: 'AAAA', tag: 'AAAA', data: 'AAAA' }));
		expect(readSecretSetting('core_rpc_pass')).toBeNull();
	});
});

// cairn-zoz8.8 — getChainConfig() now also surfaces the Bitcoin Core RPC
// url/user/pass so a future ChainService can talk to a self-hosted Core node.
// Unlike electrum/esplora, Core RPC has no "public default" to fall back to, so
// the stored values must pass through in BOTH public and custom connection mode.
describe('getChainConfig — Bitcoin Core RPC passthrough', () => {
	const RPC_URL = 'http://127.0.0.1:8332';
	const RPC_USER = 'rpcuser';

	it('returns null Core RPC fields when nothing is configured', () => {
		const cfg = getChainConfig();
		expect(cfg.coreRpcUrl).toBeNull();
		expect(cfg.coreRpcUser).toBeNull();
		expect(cfg.coreRpcPass).toBeNull();
	});

	it('surfaces the stored Core RPC url/user/pass in custom mode', () => {
		setSetting('connection_mode', 'custom');
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', SECRET);

		const cfg = getChainConfig();
		expect(cfg.mode).toBe('custom');
		expect(cfg.coreRpcUrl).toBe(RPC_URL);
		expect(cfg.coreRpcUser).toBe(RPC_USER);
		expect(cfg.coreRpcPass).toBe(SECRET);
	});

	it('still surfaces the stored Core RPC values in public mode (no public default hides them)', () => {
		setSetting('connection_mode', 'public');
		setSetting('core_rpc_url', RPC_URL);
		setSetting('core_rpc_user', RPC_USER);
		setSecretSetting('core_rpc_pass', SECRET);

		const cfg = getChainConfig();
		expect(cfg.mode).toBe('public');
		// The electrum/esplora fields ARE swapped for the public defaults here…
		expect(cfg.esploraUrl).toBe('https://mempool.space/api');
		// …but Core RPC is self-hosted-only, so its values are returned as stored.
		expect(cfg.coreRpcUrl).toBe(RPC_URL);
		expect(cfg.coreRpcUser).toBe(RPC_USER);
		expect(cfg.coreRpcPass).toBe(SECRET);
	});
});
