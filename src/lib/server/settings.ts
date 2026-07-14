import { db } from './db';
import { childLogger } from './logger';
import { encryptSecret, decryptSecret, isSecretEnvelope } from './secretKey';
import type { InstanceMode, InstanceSettings, RegistrationMode } from '$lib/types';

const log = childLogger('settings');

const DEFAULTS: InstanceSettings = {
	registrationMode: 'invite',
	// New installs start narrow (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2);
	// existing installs get an explicit 'instance_mode' row written once by
	// instanceModeMigration.ts, based on evidence of prior multi-user usage.
	instanceMode: 'solo',
	connectionMode: 'public',
	electrumHost: 'electrum.blockstream.info',
	electrumPort: 50002,
	electrumTls: true,
	electrumTlsInsecure: false,
	electrumPoolSize: 3,
	socks5Host: null,
	socks5Port: null,
	coreRpcUrl: null,
	coreRpcUser: null,
	coreRpcPass: null,
	chainProvisionedBy: null,
	coreRpcDetected: null,
	coreRpcProvisionedBy: null
};

/** Public-mode defaults for the chain backends (used when connectionMode === 'public'). */
export const PUBLIC_DEFAULTS = {
	electrumHost: DEFAULTS.electrumHost,
	electrumPort: DEFAULTS.electrumPort,
	electrumTls: DEFAULTS.electrumTls
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
 * Store a SECRET setting encrypted at rest (secretKey.ts envelope) in the
 * dedicated instance_secrets table (cairn-e9mz.3/.4), so a leaked copy of
 * cairn.db doesn't carry it in the clear and the schema itself shows what's
 * sensitive. An empty value is stored as '' — the explicit-clear convention —
 * and must stay falsy for presence checks. Any legacy copy of the key still in
 * the plain `settings` table is removed so a stale plaintext row can't linger.
 */
export function setSecretSetting(key: string, value: string): void {
	db.prepare(
		`INSERT INTO instance_secrets (key, value_enc, updated_at)
		 VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc,
		                                updated_at = excluded.updated_at`
	).run(key, value === '' ? '' : encryptSecret(value));
	db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** The stored form of a secret setting: instance_secrets first, falling back to
 *  a not-yet-migrated legacy row in `settings`. Null when neither exists. */
function rawSecretSetting(key: string): string | null {
	const row = db.prepare('SELECT value_enc FROM instance_secrets WHERE key = ?').get(key) as
		| { value_enc: string }
		| undefined;
	if (row) return row.value_enc;
	return getSetting(key);
}

/** Whether ANY stored value exists for this secret (even one that fails to
 *  decrypt) — lets callers fail closed instead of regenerating over a value
 *  they can no longer read (e.g. the Nostr identity key). */
export function hasSecretSetting(key: string): boolean {
	const raw = rawSecretSetting(key);
	return raw !== null && raw !== '';
}

/**
 * Read a secret setting written by {@link setSecretSetting}. Legacy plaintext
 * values (written before at-rest encryption; moved + re-encrypted by the
 * startup migration) pass through unchanged. An undecryptable envelope logs and
 * returns null — fail closed rather than handing a ciphertext blob to a
 * consumer.
 */
export function readSecretSetting(key: string): string | null {
	const raw = rawSecretSetting(key);
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
	if (str('instance_mode')) s.instanceMode = str('instance_mode') as InstanceMode;
	if (str('connection_mode')) s.connectionMode = str('connection_mode') as 'public' | 'custom';
	if (str('electrum_host')) s.electrumHost = str('electrum_host')!;
	if (str('electrum_port')) s.electrumPort = parseInt(str('electrum_port')!, 10);
	if (map.has('electrum_tls')) s.electrumTls = str('electrum_tls') === 'true';
	if (map.has('electrum_tls_insecure')) s.electrumTlsInsecure = str('electrum_tls_insecure') === 'true';
	if (str('electrum_pool_size')) {
		const n = parseInt(str('electrum_pool_size')!, 10);
		if (Number.isInteger(n) && n >= 1 && n <= 4) s.electrumPoolSize = n;
	}
	if (str('socks5_host')) s.socks5Host = str('socks5_host')!;
	if (str('socks5_port')) {
		const p = parseInt(str('socks5_port')!, 10);
		s.socks5Port = Number.isInteger(p) ? p : null;
	}
	if (str('core_rpc_url')) s.coreRpcUrl = str('core_rpc_url')!;
	if (str('core_rpc_user')) s.coreRpcUser = str('core_rpc_user')!;
	// Lives in instance_secrets (with a legacy `settings` fallback), not the map.
	const rpcPass = readSecretSetting('core_rpc_pass');
	if (rpcPass) s.coreRpcPass = rpcPass;
	// Umbrel auto-connect provenance marker (docs/UMBREL-AUTOCONNECT-DESIGN.md
	// §4.1 A2/A1) — 'umbrel-env' (chainEnvSeed.ts) or 'umbrel-probe'
	// (umbrelProbe.ts). Drives the settings page's "auto-connected" card; never
	// affects which connection is actually used.
	if (str('chain_provisioned_by')) s.chainProvisionedBy = str('chain_provisioned_by')!;
	// Umbrel Core RPC detect-and-surface markers (Wave B,
	// docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md §6) — kept separate from the
	// Electrum-scoped chainProvisionedBy above. coreRpcDetected is the
	// pre-connect signal (umbrelCoreProbe.ts, or 'dismissed'); coreRpcProvisionedBy
	// is the post-connect provenance ('umbrel-env' | 'umbrel-detect'), written by
	// the assisted-connect save path (Unit B2, not yet built). Neither is ever
	// consulted by getChainConfig()/coreRpcConfigured() — display-only.
	if (str('core_rpc_detected')) s.coreRpcDetected = str('core_rpc_detected')!;
	if (str('core_rpc_provisioned_by')) s.coreRpcProvisionedBy = str('core_rpc_provisioned_by')!;

	return s;
}

/**
 * Just the instance mode ('solo' | 'team'), without the full settings-table
 * scan + core_rpc_pass decrypt that getInstanceSettings() does (cairn-xlrm).
 * The (app) layout load needs only this one field on every navigation, so
 * this is a single keyed lookup instead of getInstanceSettings()'s ~2 queries
 * (settings table + instance_secrets) plus decryption work that's irrelevant
 * here. Same fallback semantics as getInstanceSettings().instanceMode.
 */
export function getInstanceMode(): InstanceMode {
	return (getSetting('instance_mode') as InstanceMode | null) ?? DEFAULTS.instanceMode;
}

/**
 * Whether this instance's chain connection has never been touched by an admin
 * or an auto-connect mechanism — `connection_mode` was never written (so it's
 * still silently on the DEFAULTS `'public'` value) AND no seed mechanism ever
 * fired (`chain_provisioned_by` unset, docs/UMBREL-AUTOCONNECT-DESIGN.md §5).
 *
 * This distinguishes a fresh install quietly sitting on the public-server
 * default from an instance an admin has actually set up (even if they chose
 * to keep it on 'public') or that Umbrel auto-connected — see cairn-7zjo: the
 * former deserves a calm "not connected yet, go set this up" banner; the
 * latter, if it later goes unreachable, is a real "this broke" warning.
 * Two cheap keyed lookups — no full settings-table scan or core_rpc_pass
 * decrypt (unlike getInstanceSettings()).
 */
export function isChainNeverConfigured(): boolean {
	return getSetting('connection_mode') === null && getSetting('chain_provisioned_by') === null;
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
 * Whether a Bitcoin Core RPC endpoint is *configured* — i.e. an admin has set a
 * non-empty `coreRpcUrl`. This is a CONFIG-PRESENCE check only: it does NOT
 * confirm the node is reachable or that the credentials work (a live probe is a
 * separate, later concern owned by the settings-wiring bead cairn-zoz8.8). It's
 * deliberately independent of {@link getChainConfig} so the two compose without
 * collision.
 *
 * Route `+page.server.ts` loads pass the result down as a `coreRpcConfigured`
 * prop so the RPC-gated Explorer sections can render an honest
 * `CoreRpcRequiredNotice` empty-state (never a silent 0/blank) when Core RPC
 * isn't set up. Cheap enough to call per-load — a single keyed lookup.
 */
export function coreRpcConfigured(): boolean {
	const url = getSetting('core_rpc_url');
	return url !== null && url.trim() !== '';
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
	socks5Host: string | null;
	socks5Port: number | null;
	coreRpcUrl: string | null;
	coreRpcUser: string | null;
	coreRpcPass: string | null;
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
	// Bitcoin Core RPC is inherently a custom/self-hosted-only backend: there is
	// no "public default" Core node to fall back to, so unlike Electrum these
	// values are NOT swapped out in public mode — whatever is actually stored is
	// always returned, in both modes (cairn-zoz8.8).
	const coreRpc = {
		coreRpcUrl: s.coreRpcUrl,
		coreRpcUser: s.coreRpcUser,
		coreRpcPass: s.coreRpcPass
	};
	if (s.connectionMode === 'public') {
		// The public default server presents a valid, trusted certificate — always
		// verify it. The insecure opt-out is a custom-server-only escape hatch.
		return {
			...PUBLIC_DEFAULTS,
			electrumTlsInsecure: false,
			...tuning,
			...coreRpc,
			mode: 'public'
		};
	}
	return {
		electrumHost: s.electrumHost,
		electrumPort: s.electrumPort,
		electrumTls: s.electrumTls,
		electrumTlsInsecure: s.electrumTlsInsecure,
		...tuning,
		...coreRpc,
		mode: 'custom'
	};
}
