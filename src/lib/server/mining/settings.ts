/**
 * Mining engine settings, read from the instance settings kv (settings.ts).
 *
 * Bastion lesson (memory: Bastion reference codebase; and the "never freeze at
 * module load" rule the chain config already follows): these values are read
 * FRESH on every call — {@link readMiningSettings} does one keyed lookup per
 * field each time — so a reconfigure after an admin saves the mining form picks
 * up the new values without a process restart. Nothing here is cached at module
 * scope.
 */
import { env } from '$env/dynamic/private';
import { getSetting } from '../settings';

/** Tri-state bind selector. Kept as a tri-state (not just a host) so the admin
 *  UI can show honest copy about loopback-only vs LAN exposure; the engine only
 *  cares about the resolved {@link MiningSettings.bindHost}. */
export type MiningBind = 'loopback' | 'lan' | 'all';

export interface MiningSettings {
	/** Whether the operator has turned the engine on (separate from the feature flag). */
	enabled: boolean;
	/** The stored tri-state, for UI copy. */
	bind: MiningBind;
	/** Resolved Stratum bind host: loopback → 127.0.0.1; lan/all → 0.0.0.0. */
	bindHost: string;
	stratumPort: number;
	/** Vardiff floor + per-connection starting difficulty. */
	shareDifficulty: number;
	vardiffEnabled: boolean;
	/** Vardiff target, shares per minute. */
	vardiffTargetPerMin: number;
	/** ASCII coinbase tag placed after the BIP34 height push. */
	poolTag: string;
	/**
	 * Whether the SECOND (ASIC-class) Stratum listener runs. On by default: an
	 * S19/S21-class ASIC pointed at the low-floor standard port would flood the
	 * share tracker with trivially-easy shares, so big machines get their own
	 * high-floor port. Same engine, same jobs, same auth — only the port and the
	 * difficulty floor differ.
	 */
	asicPortEnabled: boolean;
	/** Bind port for the ASIC listener (defaults 3334, one above the standard 3333). */
	asicStratumPort: number;
	/** Vardiff floor + starting difficulty for the ASIC listener (defaults 65536). */
	asicShareDifficulty: number;
	/** Whether the native Stratum V2 listener runs (cairn-qfez8.8). Off by default. */
	sv2Enabled: boolean;
	/** Bind port for the SV2 listener (defaults 3335, per qfez8.5). */
	sv2Port: number;
	/** Fixed share difficulty for the SV2 listener (v1: static channel targets, no vardiff). */
	sv2ShareDifficulty: number;
	/** Server-wide version-rolling advertisement for every SV2 channel. Off by default (parity with V1). */
	sv2VersionRolling: boolean;
}

/**
 * Default share difficulty. A deliberately LOW floor so even a sub-TH/s USB /
 * Bitaxe-class miner submits shares promptly on connect; vardiff (target 6
 * shares/min) then ratchets each connection up from here to its steady-state
 * weight. Tessera never hardcoded a default (it was always config-supplied), so
 * this is chosen for Heartwood's small-solo-miner target rather than inherited.
 * 0.5 keeps the first-share latency low without flooding — the vardiff loop
 * owns the real per-miner difficulty within a minute of connecting.
 */
export const DEFAULT_SHARE_DIFFICULTY = 0.5;

/**
 * Default ASIC-listener share difficulty. Deliberately HIGH (2^16) so an
 * S19/S21-class machine — which at the standard 0.5 floor would submit millions
 * of shares per second and swamp the share tracker — starts at a sane weight and
 * lets vardiff ratchet from there. Chosen for Heartwood's ASIC target rather than
 * inherited from Tessera (which never hardcoded a default).
 */
export const DEFAULT_ASIC_SHARE_DIFFICULTY = 65536;

/**
 * Default SV2 listener share difficulty. ASIC-oriented like
 * {@link DEFAULT_ASIC_SHARE_DIFFICULTY} — SV2's first real-world clients are
 * expected to be ASIC firmware/proxies, not low-power USB miners, and v1
 * ships a static (non-vardiff) channel target, so the floor should already be
 * a sane steady-state weight rather than a low ramp-up value.
 */
export const DEFAULT_SV2_SHARE_DIFFICULTY = DEFAULT_ASIC_SHARE_DIFFICULTY;

const DEFAULTS = {
	enabled: false,
	bind: 'loopback' as MiningBind,
	stratumPort: 3333,
	shareDifficulty: DEFAULT_SHARE_DIFFICULTY,
	vardiffEnabled: true,
	vardiffTargetPerMin: 6,
	poolTag: 'Heartwood',
	asicPortEnabled: true,
	asicStratumPort: 3334,
	asicShareDifficulty: DEFAULT_ASIC_SHARE_DIFFICULTY,
	sv2Enabled: false,
	sv2Port: 3335,
	sv2ShareDifficulty: DEFAULT_SV2_SHARE_DIFFICULTY,
	sv2VersionRolling: false
};

/**
 * Resolve the DEFAULT bind selector, honouring the deployment platform.
 *
 * On a container deployment (Umbrel) the app runs inside its own network
 * namespace: the docker-compose maps a HOST port to the container, but that only
 * reaches the app if the app is listening on 0.0.0.0 — a loopback-only bind
 * (127.0.0.1) is unreachable from outside the container, so the advertised
 * Stratum address can never accept a connection. `CAIRN_PLATFORM` is set to
 * 'umbrel' ONLY by the store package's compose (never on a bare-metal install),
 * so we key the default off it: Umbrel defaults to 'all' (0.0.0.0), everything
 * else stays loopback-only. An explicit admin-saved `mining_bind` value always
 * wins over this default (see {@link readMiningSettings}).
 */
function defaultBind(): MiningBind {
	return env.CAIRN_PLATFORM === 'umbrel' ? 'all' : DEFAULTS.bind;
}

function boolSetting(key: string, dflt: boolean): boolean {
	const v = getSetting(key);
	if (v === null) return dflt;
	return v === '1' || v === 'true';
}

function intSetting(key: string, dflt: number): number {
	const v = getSetting(key);
	if (v === null) return dflt;
	const n = parseInt(v, 10);
	return Number.isInteger(n) && n > 0 ? n : dflt;
}

function floatSetting(key: string, dflt: number): number {
	const v = getSetting(key);
	if (v === null) return dflt;
	const n = parseFloat(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Resolve the tri-state bind selector to a concrete host. LAN detection is
 *  intentionally NOT attempted — lan/all both bind 0.0.0.0 and let the OS admit
 *  every interface; the tri-state exists only to drive UI copy about exposure. */
function bindHostFor(bind: MiningBind): string {
	return bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
}

/**
 * Read the current mining settings from the kv store. Fresh every call — see the
 * module note. Unset keys fall back to {@link DEFAULTS}; a malformed stored value
 * (non-numeric port/difficulty) also falls back rather than propagating NaN into
 * the engine config.
 */
export function readMiningSettings(): MiningSettings {
	const bindRaw = getSetting('mining_bind');
	// An explicit admin-saved value wins; only an unset/invalid value falls back to
	// the platform-aware default (loopback everywhere except Umbrel — see defaultBind).
	const bind: MiningBind =
		bindRaw === 'lan' || bindRaw === 'all' || bindRaw === 'loopback' ? bindRaw : defaultBind();
	return {
		enabled: boolSetting('mining_enabled', DEFAULTS.enabled),
		bind,
		bindHost: bindHostFor(bind),
		stratumPort: intSetting('mining_stratum_port', DEFAULTS.stratumPort),
		shareDifficulty: floatSetting('mining_share_difficulty', DEFAULTS.shareDifficulty),
		vardiffEnabled: boolSetting('mining_vardiff_enabled', DEFAULTS.vardiffEnabled),
		vardiffTargetPerMin: intSetting('mining_vardiff_target_rate', DEFAULTS.vardiffTargetPerMin),
		poolTag: getSetting('mining_pool_tag') || DEFAULTS.poolTag,
		asicPortEnabled: boolSetting('mining_asic_port_enabled', DEFAULTS.asicPortEnabled),
		asicStratumPort: intSetting('mining_asic_stratum_port', DEFAULTS.asicStratumPort),
		asicShareDifficulty: floatSetting('mining_asic_share_difficulty', DEFAULTS.asicShareDifficulty),
		sv2Enabled: boolSetting('mining_sv2_enabled', DEFAULTS.sv2Enabled),
		sv2Port: intSetting('mining_sv2_port', DEFAULTS.sv2Port),
		sv2ShareDifficulty: floatSetting('mining_sv2_share_difficulty', DEFAULTS.sv2ShareDifficulty),
		sv2VersionRolling: boolSetting('mining_sv2_version_rolling', DEFAULTS.sv2VersionRolling)
	};
}
