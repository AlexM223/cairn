import { db } from './db';
import type { InstanceSettings, RegistrationMode } from '$lib/types';

const DEFAULTS: InstanceSettings = {
	registrationMode: 'invite',
	connectionMode: 'public',
	electrumHost: 'electrum.blockstream.info',
	electrumPort: 50002,
	electrumTls: true,
	electrumTlsInsecure: false,
	esploraUrl: 'https://mempool.space/api',
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
	if (str('esplora_url')) s.esploraUrl = str('esplora_url')!;
	if (str('core_rpc_url')) s.coreRpcUrl = str('core_rpc_url')!;
	if (str('core_rpc_user')) s.coreRpcUser = str('core_rpc_user')!;
	if (str('core_rpc_pass')) s.coreRpcPass = str('core_rpc_pass')!;

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
	esploraUrl: string;
	mode: 'public' | 'custom';
} {
	const s = getInstanceSettings();
	if (s.connectionMode === 'public') {
		// The public default server presents a valid, trusted certificate — always
		// verify it. The insecure opt-out is a custom-server-only escape hatch.
		return { ...PUBLIC_DEFAULTS, electrumTlsInsecure: false, mode: 'public' };
	}
	return {
		electrumHost: s.electrumHost,
		electrumPort: s.electrumPort,
		electrumTls: s.electrumTls,
		electrumTlsInsecure: s.electrumTlsInsecure,
		esploraUrl: s.esploraUrl || DEFAULTS.esploraUrl,
		mode: 'custom'
	};
}
