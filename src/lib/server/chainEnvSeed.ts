// Seed chain-backend settings (Electrum + Bitcoin Core RPC) from env vars on
// first boot (cairn-loq7), so a fresh Umbrel install is zero-config against
// the operator's own node. Umbrel's `bitcoin`/`electrs` app dependencies get
// wired through the store package's docker-compose.yml as
// CAIRN_ELECTRUM_HOST/PORT/TLS and CAIRN_CORE_RPC_URL/USER/PASS — this module
// reads exactly those names. Without it, a fresh install silently keeps using
// the public-server defaults (electrum.blockstream.info) until an admin
// manually copies the injected values into Admin -> Settings (cairn-2ldr is
// the separate, still-open product decision about what those defaults should
// be for non-Umbrel installs; this bead only closes the Umbrel zero-config
// gap).
//
// Runs at server start from hooks.server.ts, alongside bootstrapAdminFromEnv
// and BEFORE anything that can construct the ChainService singleton
// (startAddressWatcher/startFirstSync/startPortfolioWarm all call
// getChain() during init()) — settings.ts's getChainConfig() is read once at
// ChainService construction time, so seeding has to land in the `settings`
// table before that first read.
//
// Seed-once, per-setting, same non-destructive pattern as
// instanceModeMigration.ts: each env var is written ONLY IF that setting has
// never been stored. An operator who later edits Admin -> Settings must never
// have a value clobbered by a restart — env vars from a compose file don't go
// away, so this has to stay idempotent-and-non-destructive forever, not just
// on the very first boot. core_rpc_pass goes through the same
// setSecretSetting() encrypted-at-rest path the admin form uses, never
// plaintext in the `settings` table.

import { env } from '$env/dynamic/private';
import { getSetting, setSetting, hasSecretSetting, setSecretSetting } from './settings';
import { childLogger } from './logger';

const log = childLogger('chain-env-seed');

/** true for '1'/'true' (case-insensitive), false for anything else (including '0'/'false'). */
function parseBoolEnv(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	return v === 'true' || v === '1';
}

/** Write `key` = `value` only if no row exists for it yet. Returns whether it wrote. */
function seedIfUnset(key: string, value: string): boolean {
	if (getSetting(key) !== null) return false;
	setSetting(key, value);
	return true;
}

/**
 * Seed chain-backend settings from the CAIRN_ELECTRUM_ and CAIRN_CORE_RPC_ env
 * vars. Never throws — a bad/missing env value just means that field isn't
 * seeded, not a boot failure.
 *
 * Returns the setting keys actually WRITTEN this call (empty array if env
 * vars were absent, invalid, or every one was already customized and thus
 * skipped) — Wave 1 / log-request.md §5 wants this so hooks.server.ts's
 * startup summary line can report `seededThisBoot` without re-reading
 * `settings` itself. Previously `void`; purely additive, callers that ignore
 * the return value are unaffected.
 */
export function seedChainConfigFromEnv(): string[] {
	const applied: string[] = [];
	try {
		let seeded = false;
		let skipped = false;
		const note = (key: string, wrote: boolean) => {
			if (wrote) {
				seeded = true;
				applied.push(key);
			} else {
				skipped = true;
			}
		};

		const electrumHost = env.CAIRN_ELECTRUM_HOST?.trim();
		if (electrumHost) {
			const wroteHost = seedIfUnset('electrum_host', electrumHost);
			note('electrum_host', wroteHost);
			// Provenance marker (Umbrel auto-connect design §4.1 A2): only stamped
			// when the env-provided host was actually ADOPTED (wroteHost), never
			// when an admin's own pre-existing custom host silently blocked the
			// write above — otherwise a manually-entered connection would get
			// mislabeled as auto-connected-via-Umbrel in the settings UI (§5).
			if (wroteHost) {
				note('chain_provisioned_by', seedIfUnset('chain_provisioned_by', 'umbrel-env'));
			}
			// A stored Electrum host is inert unless connectionMode is 'custom' —
			// getChainConfig() ignores it entirely in 'public' mode. Only flip this
			// when the admin hasn't chosen a mode yet, mirroring the per-setting
			// don't-clobber rule above.
			if (getSetting('connection_mode') === null) {
				setSetting('connection_mode', 'custom');
				seeded = true;
				applied.push('connection_mode');
			}
		}

		const electrumPortRaw = env.CAIRN_ELECTRUM_PORT?.trim();
		if (electrumPortRaw) {
			const port = Number(electrumPortRaw);
			if (Number.isInteger(port) && port >= 1 && port <= 65535) {
				note('electrum_port', seedIfUnset('electrum_port', String(port)));
			} else {
				log.debug({ value: electrumPortRaw }, 'ignoring invalid CAIRN_ELECTRUM_PORT');
			}
		}

		const electrumTlsRaw = env.CAIRN_ELECTRUM_TLS?.trim();
		if (electrumTlsRaw) {
			note(
				'electrum_tls',
				seedIfUnset('electrum_tls', parseBoolEnv(electrumTlsRaw) ? 'true' : 'false')
			);
		}

		const coreRpcUrl = env.CAIRN_CORE_RPC_URL?.trim();
		if (coreRpcUrl) note('core_rpc_url', seedIfUnset('core_rpc_url', coreRpcUrl));

		const coreRpcUser = env.CAIRN_CORE_RPC_USER?.trim();
		if (coreRpcUser) note('core_rpc_user', seedIfUnset('core_rpc_user', coreRpcUser));

		// Not trimmed — a password's leading/trailing whitespace, however
		// unlikely, is significant, and the admin form's own coreRpcPass field
		// (+page.server.ts) doesn't trim it either.
		const coreRpcPass = env.CAIRN_CORE_RPC_PASS;
		if (coreRpcPass) {
			if (!hasSecretSetting('core_rpc_pass')) {
				setSecretSetting('core_rpc_pass', coreRpcPass);
				seeded = true;
				applied.push('core_rpc_pass');
			} else {
				skipped = true;
			}
		}

		if (seeded) {
			log.info(
				{ event: 'chain_env_seeded', keys: applied },
				'chain-backend settings seeded from env (Umbrel zero-config)'
			);
		} else if (skipped) {
			log.debug(
				{ event: 'chain_env_seed_skipped' },
				'chain env vars present but settings already customized — not overriding'
			);
		}
	} catch (e) {
		log.error({ err: e }, 'chain config env seed failed');
	}
	return applied;
}
