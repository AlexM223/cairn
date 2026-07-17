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

const DEFAULTS = {
	enabled: false,
	bind: 'loopback' as MiningBind,
	stratumPort: 3333,
	shareDifficulty: DEFAULT_SHARE_DIFFICULTY,
	vardiffEnabled: true,
	vardiffTargetPerMin: 6,
	poolTag: 'Heartwood'
};

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
	const bind: MiningBind =
		bindRaw === 'lan' || bindRaw === 'all' || bindRaw === 'loopback' ? bindRaw : DEFAULTS.bind;
	return {
		enabled: boolSetting('mining_enabled', DEFAULTS.enabled),
		bind,
		bindHost: bindHostFor(bind),
		stratumPort: intSetting('mining_stratum_port', DEFAULTS.stratumPort),
		shareDifficulty: floatSetting('mining_share_difficulty', DEFAULTS.shareDifficulty),
		vardiffEnabled: boolSetting('mining_vardiff_enabled', DEFAULTS.vardiffEnabled),
		vardiffTargetPerMin: intSetting('mining_vardiff_target_rate', DEFAULTS.vardiffTargetPerMin),
		poolTag: getSetting('mining_pool_tag') || DEFAULTS.poolTag
	};
}
