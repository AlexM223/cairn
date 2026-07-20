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
// Electrum fields are seed-once, per-setting, same non-destructive pattern as
// instanceModeMigration.ts: each env var is written ONLY IF that setting has
// never been stored. An operator who later edits Admin -> Settings must never
// have a value clobbered by a restart — env vars from a compose file don't go
// away, so this has to stay idempotent-and-non-destructive forever, not just
// on the very first boot.
//
// Bitcoin Core RPC fields are different (zero-config Core RPC wave, §B):
// reconciled on EVERY boot rather than seed-once, gated by the
// `core_rpc_provisioned_by` provenance marker (manual > auto-env > detect >
// none — see reconcileCoreRpcFromEnv()'s doc comment below), so a rotated
// Umbrel Bitcoin-app RPC password self-heals without admin action. Both an
// empty-interpolation guard (§A — a compose block with no bitcoin app
// installed interpolates the truthy-but-useless `http://:`) and a
// network-mismatch guard (§C — the authoritative check lives at mining
// engine start, this only seeds the pre-flight hint) protect it. core_rpc_pass
// goes through the same setSecretSetting() encrypted-at-rest path the admin
// form uses, never plaintext in the `settings` table.

import { env } from '$env/dynamic/private';
import { getSetting, setSetting, setSecretSetting, readSecretSetting } from './settings';
import type { ChainNetwork } from '$lib/types';
import { childLogger } from './logger';

const log = childLogger('chain-env-seed');

const CHAIN_NETWORKS: readonly ChainNetwork[] = ['mainnet', 'testnet', 'regtest'];

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
 * Empty-interpolation guard (cairn zero-config Core RPC wave, §A): validates a
 * candidate `CAIRN_CORE_RPC_URL` BEFORE it's ever written to settings. The
 * upcoming always-present store compose block means a Cairn install with the
 * Bitcoin app NOT installed still gets `CAIRN_CORE_RPC_URL=http://:` — Docker
 * Compose interpolates the missing `${APP_BITCOIN_NODE_IP}:${APP_BITCOIN_RPC_PORT}`
 * vars to empty strings rather than omitting the var entirely. That string is
 * still *truthy* (`.trim()` non-empty), so a plain `if (url)` check treats it
 * as a real value and seeds a connection that 401s/ECONNREFUSEDs forever.
 * Requires BOTH a non-empty hostname and a non-empty port — `new URL('http://:')`
 * already throws on its own, but the explicit hostname/port checks are kept as
 * defense-in-depth against any other empty-but-parseable shape. Never throws;
 * returns the parsed URL when valid, null otherwise.
 */
function validCoreRpcUrl(raw: string): URL | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (!parsed.hostname || !parsed.port) return null;
	return parsed;
}

/**
 * Reconcile Bitcoin Core RPC settings from env on EVERY boot — deliberately
 * NOT seed-once like Electrum above (cairn zero-config Core RPC wave, §B).
 * Reinstalling the Umbrel Bitcoin app rotates `APP_BITCOIN_RPC_PASS`; a
 * seed-once write would leave Cairn stuck presenting the stale password
 * forever (401 on every RPC call) until an admin noticed and manually
 * re-pasted it under Admin -> Settings. Reconciling on every boot lets a
 * rotated credential self-heal on the next restart with zero admin action.
 *
 * Provenance rule — manual > auto-env > detect > none — enforced via the
 * `core_rpc_provisioned_by` marker (also read/written by the admin settings
 * save path and the Wave B assisted-connect flow):
 *   - unset (null) or `'umbrel-env'` -> this function may freely overwrite.
 *   - anything else (`'manual'`, `'umbrel-detect'`) -> a human already made a
 *     deliberate choice here; never touch it again, no matter what env says.
 *
 * Applies the §A empty-interpolation guard, and the same non-empty
 * present-check to user/pass as the guard's spirit demands: an empty string
 * for either must never seed/overwrite a real value (a compose block with a
 * missing dependency can just as easily interpolate an empty user/pass as an
 * empty host/port). `core_rpc_pass` is intentionally NOT trimmed, matching
 * the seed-once path above.
 *
 * Also reconciles `chain_network` from `CAIRN_CORE_RPC_NETWORK` under the
 * identical rule (§C) — this is only the PRE-FLIGHT hint the settings UI and
 * mining engine start with; the AUTHORITATIVE check is
 * `getblockchaininfo().chain` at engine start (mining/index.ts), which
 * refuses to run against a node reporting a different chain than configured,
 * env hint or not.
 *
 * Returns the setting keys actually WRITTEN this call (values that changed —
 * re-reconciling the same already-current env is reported as a no-op, same
 * `seededThisBoot` contract as the rest of this module). Never throws.
 */
function reconcileCoreRpcFromEnv(): string[] {
	const applied: string[] = [];

	const rawUrl = env.CAIRN_CORE_RPC_URL?.trim();
	if (!rawUrl) return applied; // nothing to reconcile without a URL

	if (!validCoreRpcUrl(rawUrl)) {
		log.debug(
			{ value: rawUrl },
			'ignoring invalid/empty-interpolated CAIRN_CORE_RPC_URL — not reconciling Core RPC from env'
		);
		return applied;
	}

	const user = env.CAIRN_CORE_RPC_USER?.trim();
	// Not trimmed — see the seed-once core_rpc_pass comment below; a password's
	// leading/trailing whitespace is significant.
	const pass = env.CAIRN_CORE_RPC_PASS;
	if (!user || !pass) {
		log.debug('CAIRN_CORE_RPC_URL present but user/pass missing or empty — not reconciling Core RPC from env');
		return applied;
	}

	const provenance = getSetting('core_rpc_provisioned_by');
	if (provenance !== null && provenance !== 'umbrel-env') {
		log.debug(
			{ provenance },
			'Core RPC env present but provenance is manual/assisted-connect — never overriding (manual wins)'
		);
		return applied;
	}

	const write = (key: string, value: string): void => {
		if (getSetting(key) !== value) {
			setSetting(key, value);
			applied.push(key);
		}
	};

	write('core_rpc_url', rawUrl);
	write('core_rpc_user', user);

	if (readSecretSetting('core_rpc_pass') !== pass) {
		setSecretSetting('core_rpc_pass', pass);
		applied.push('core_rpc_pass');
	}

	const networkRaw = env.CAIRN_CORE_RPC_NETWORK?.trim();
	if (networkRaw && (CHAIN_NETWORKS as readonly string[]).includes(networkRaw)) {
		write('chain_network', networkRaw);
	} else if (networkRaw) {
		log.debug({ value: networkRaw }, 'ignoring invalid CAIRN_CORE_RPC_NETWORK');
	}

	if (provenance !== 'umbrel-env') {
		write('core_rpc_provisioned_by', 'umbrel-env');
	}

	if (applied.length > 0) {
		log.info(
			{ event: 'core_rpc_env_reconciled', keys: applied },
			'Bitcoin Core RPC settings reconciled from env (Umbrel zero-config, credential-rotation self-heal)'
		);
	}

	return applied;
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

		// Bitcoin Core RPC is reconciled on EVERY boot, not seed-once like the
		// Electrum fields above — see reconcileCoreRpcFromEnv()'s doc comment
		// (§B: credential-rotation self-heal + §A/§C empty-interpolation and
		// network guards).
		const coreApplied = reconcileCoreRpcFromEnv();
		if (coreApplied.length > 0) {
			seeded = true;
			applied.push(...coreApplied);
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
