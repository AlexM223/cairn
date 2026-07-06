import { db } from './db';
import { childLogger } from './logger';
import { encryptSecret, decryptSecret, isSecretEnvelope } from './secretKey';
import type { InstanceSettings, RegistrationMode } from '$lib/types';

const log = childLogger('settings');

const DEFAULTS: InstanceSettings = {
	registrationMode: 'invite',
	connectionMode: 'public',
	electrumHost: 'electrum.blockstream.info',
	electrumPort: 50002,
	electrumTls: true,
	electrumTlsInsecure: false,
	electrumPoolSize: 2,
	esploraUrl: 'https://mempool.space/api',
	socks5Host: null,
	socks5Port: null,
	coreRpcUrl: null,
	coreRpcUser: null,
	coreRpcPass: null
};

/** Public-mode defaults for the chain backends (used when connectionMode === 'public'). */
export const PUBLIC_DEFAULTS = {
	electrumHost: DEFAULTS.electrumHost,
	electrumPort: DEFAULTS.electrumPort,
	electrumTls: DEFAULTS.electrumTls,
	esploraUrl: DEFAULTS.esploraUrl
};

export function getSetting(key: string): string | null {
	const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
	db.prepare(
		'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
	).run(key, value);
}

/**
 * Store a SECRET setting encrypted at rest (secretKey.ts envelope), so a leaked
 * copy of cairn.db doesn't carry it in the clear (cairn-e9mz.3). An empty value
 * is stored as-is — '' is the explicit-clear convention and must stay falsy for
 * the presence checks built on getSetting().
 */
export function setSecretSetting(key: string, value: string): void {
	setSetting(key, value === '' ? '' : encryptSecret(value));
}

/**
 * Read a secret setting written by {@link setSecretSetting}. Legacy plaintext
 * values (written before at-rest encryption; re-encrypted by the startup
 * migration) pass through unchanged. An undecryptable envelope logs and returns
 * null — fail closed rather than handing a ciphertext blob to a consumer.
 */
export function readSecretSetting(key: string): string | null {
	const raw = getSetting(key);
	if (!raw) return raw;
	if (!isSecretEnvelope(raw)) return raw;
	try {
		return decryptSecret(raw);
	} catch (e) {
		log.error({ key, err: e }, 'failed to decrypt secret setting');
		return null;
	}
}

export function getInstanceSettings(): InstanceSettings {
	const s = { ...DEFAULTS };
	const rows = db.prepare('SELECT key, value FROM settings').all() as {
		key: string;
		value: string;
	}[];
	const map = new Map(rows.map((r) => [r.key, r.value]));

	const str = (k: string) => map.get(k);

	if (str('registration_mode')) s.registrationMode = str('registration_mode') as RegistrationMode;
	if (str('connection_mode')) s.connectionMode = str('connection_mode') as 'public' | 'custom';
	if (str('electrum_host')) s.electrumHost = str('electrum_host')!;
	if (str('electrum_port')) s.electrumPort = parseInt(str('electrum_port')!, 10);
	if (map.has('electrum_tls')) s.electrumTls = str('electrum_tls') === 'true';
	if (map.has('electrum_tls_insecure')) s.electrumTlsInsecure = str('electrum_tls_insecure') === 'true';
	if (str('electrum_pool_size')) {
		const n = parseInt(str('electrum_pool_size')!, 10);
		if (Number.isInteger(n) && n >= 1 && n <= 4) s.electrumPoolSize = n;
	}
	if (str('esplora_url')) s.esploraUrl = str('esplora_url')!;
	if (str('socks5_host')) s.socks5Host = str('socks5_host')!;
	if (str('socks5_port')) {
		const p = parseInt(str('socks5_port')!, 10);
		s.socks5Port = Number.isInteger(p) ? p : null;
	}
	if (str('core_rpc_url')) s.coreRpcUrl = str('core_rpc_url')!;
	if (str('core_rpc_user')) s.coreRpcUser = str('core_rpc_user')!;
	if (str('core_rpc_pass')) s.coreRpcPass = readSecretSetting('core_rpc_pass');

	return s;
}

/**
 * Instance settings safe to serialize to the client: the stored Core RPC
 * password is replaced by a presence flag so the secret never leaves the
 * server.
 */
export function getPublicInstanceSettings(): Omit<InstanceSettings, 'coreRpcPass'> & {
	hasCoreRpcPass: boolean;
} {
	const { coreRpcPass, ...rest } = getInstanceSettings();
	return { ...rest, hasCoreRpcPass: !!coreRpcPass };
}

/**
 * The chain connection config the app should actually use right now.
 * In public mode this ignores any custom values and returns the public defaults.
 */
export function getChainConfig(): {
	electrumHost: string;
	electrumPort: number;
	electrumTls: boolean;
	electrumTlsInsecure: boolean;
	electrumPoolSize: number;
	esploraUrl: string;
	socks5Host: string | null;
	socks5Port: number | null;
	mode: 'public' | 'custom';
} {
	const s = getInstanceSettings();
	// The SOCKS5 proxy and pool size are independent of connection mode: a
	// privacy-conscious operator may well want to reach even a public server over
	// Tor, and connection parallelism is a client-side tuning knob either way — so
	// both are applied in both branches.
	const tuning = {
		socks5Host: s.socks5Host,
		socks5Port: s.socks5Port,
		electrumPoolSize: s.electrumPoolSize
	};
	if (s.connectionMode === 'public') {
		// The public default server presents a valid, trusted certificate — always
		// verify it. The insecure opt-out is a custom-server-only escape hatch.
		return { ...PUBLIC_DEFAULTS, electrumTlsInsecure: false, ...tuning, mode: 'public' };
	}
	return {
		electrumHost: s.electrumHost,
		electrumPort: s.electrumPort,
		electrumTls: s.electrumTls,
		electrumTlsInsecure: s.electrumTlsInsecure,
		esploraUrl: s.esploraUrl || DEFAULTS.esploraUrl,
		...tuning,
		mode: 'custom'
	};
}
