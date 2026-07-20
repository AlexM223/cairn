import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getAdminMiningView } from '$lib/server/mining/readModels';
import {
	reconfigureMiningEngine,
	startMiningEngine,
	stopMiningEngine,
	miningEngineStatus,
	miningFatalErrors,
	probeCoreRpcHealth
} from '$lib/server/mining';
import { readMiningSettings } from '$lib/server/mining/settings';
import { getSetting, setSetting } from '$lib/server/settings';
import { isFeatureEnabled } from '$lib/server/featureFlags/resolve';
import { childLogger } from '$lib/server/logger';
import { DEGRADED_ADMIN_MINING_VIEW, type MiningBind } from '$lib/components/mining/adminMiningView';
import type { Actions, PageServerLoad } from './$types';

const log = childLogger('admin-mining');

// Admin guard: identical to every other /admin/** route
// (src/routes/(app)/admin/+layout.server.ts already redirects non-admins
// before this ever loads, but every action below re-checks explicitly — the
// same belt-and-suspenders convention as admin/settings/+page.server.ts's
// `resetInstance` action.)
function requireAdmin(locals: App.Locals) {
	return locals.user?.isAdmin === true;
}

const MINING_BINDS: readonly MiningBind[] = ['loopback', 'lan', 'all'];

/** Manual-config message (unchanged, §F) — used on every non-Umbrel deployment
 *  and on Umbrel once the Bitcoin Node app has at least been DETECTED (the
 *  assisted-connect banner on Admin -> Settings already tells that story). */
const MANUAL_CORE_RPC_MESSAGE =
	"Mining needs your Bitcoin node. The pool builds block templates with your own node's help, and that connection isn't set up yet — connect Bitcoin Core under Admin → Settings, then start the engine.";

/** Umbrel, no env-provided connection and no detection probe hit either — the
 *  Bitcoin Node app most likely isn't installed/running at all (§D). */
const UMBREL_NO_NODE_MESSAGE =
	"Mining needs your Umbrel's Bitcoin Node. Open your Umbrel App Store, install (or start) the Bitcoin Node app, then restart Heartwood.";

/**
 * Honest post-start/reconfigure verdict (v0.2.42 QA; extended v0.2.47 —
 * cairn-mining-silent-start, then again for the Umbrel zero-config Core RPC
 * wave): doStart() deliberately never throws — EVERY gate (feature flag off,
 * engine disabled in settings, Core RPC unconfigured) and every listen
 * failure (port in use, Core RPC unreachable, etc.) either returns silently
 * or lands in the fatal list, leaving the engine stopped — so an action's own
 * promise resolving is NOT proof the engine came back. When settings say the
 * engine should be running but it isn't, surface an honest, specific reason
 * instead of a false success. Null = genuinely fine (running, or
 * intentionally off).
 *
 * Previously this returned null for the `coreRpc === 'unconfigured'` case,
 * deferring to a "separate notice" — but that notice (CoreRpcRequiredNotice,
 * pre-emptively rendered by AdminEngineHealth) only covers the case where
 * `chain.core` is null at page-load time. It does NOT cover a `startStop`
 * click while `chain.core` is non-null but Core is actually unreachable
 * (wrong credentials/host, node still syncing, etc.) — that path fell all the
 * way through to a bare `{ toggled: true }` with no error anywhere: the live
 * bug an operator hit with mining pointed at a Core RPC that wasn't actually
 * reachable. Every enabled-but-not-running outcome now gets an explicit
 * message.
 *
 * Umbrel-specific extension: `TipPoller` (mining/tipPoller.ts) deliberately
 * swallows every RPC connect failure and retries forever, so
 * `status.running === true` right after `engine.start()` is NOT proof Core is
 * actually reachable — a fresh engine can report "running" against
 * completely wrong credentials or a node still in IBD. On Umbrel (where we
 * can give a specific, actionable reason instead of a generic fatal-errors
 * dump) this now does one extra live `getblockchaininfo()` probe
 * (probeCoreRpcHealth, mining/index.ts) whenever the pool hasn't already
 * proven itself via a successful template round trip (`coreRpc !== 'ok'`),
 * and reports syncing/transport failures honestly. Skipped entirely off
 * Umbrel (§F) — non-Umbrel behavior is byte-for-byte unchanged.
 */
async function engineFailedToStart(): Promise<string | null> {
	const s = readMiningSettings();
	if (!s.enabled) return null; // stopped on purpose
	if (!isFeatureEnabled('mining', null)) {
		return "Mining isn't turned on for this instance — enable it under Admin → Feature flags, then start the engine.";
	}

	const isUmbrel = env.CAIRN_PLATFORM === 'umbrel';
	const status = miningEngineStatus();

	if (status.coreRpc === 'unconfigured') {
		// Distinguish "nothing at all found" from "the Bitcoin Node app was
		// detected but the admin hasn't pasted the password yet" — the latter
		// already has its own assisted-connect banner on Admin -> Settings, so
		// the generic manual-config copy (which also points there) still fits.
		if (isUmbrel && getSetting('core_rpc_detected') === null) {
			return UMBREL_NO_NODE_MESSAGE;
		}
		return MANUAL_CORE_RPC_MESSAGE;
	}

	if (isUmbrel && status.coreRpc !== 'ok') {
		const health = await probeCoreRpcHealth();
		if (!health.ok) {
			if (health.reason === 'syncing') {
				return health.blocks != null
					? `Your Bitcoin node is still syncing (block ${health.blocks.toLocaleString()}). Mining will start automatically once it finishes.`
					: 'Your Bitcoin node is still syncing. Mining will start automatically once it finishes.';
			}
			if (health.reason === 'transport') {
				// The reconcile-on-boot credential-rotation self-heal (chainEnvSeed.ts
				// §B) should have already fixed a 401 caused by a rotated Umbrel
				// Bitcoin-app password on the NEXT restart — if we're still seeing a
				// transport failure with umbrel-env provenance, that self-heal hasn't
				// caught up yet (or something else is wrong); worth a log line to
				// investigate, even though the admin-facing copy stays generic.
				if (getSetting('core_rpc_provisioned_by') === 'umbrel-env') {
					log.warn(
						'Core RPC unreachable while provisioned via umbrel-env — expected the reconcile-on-boot rotation self-heal to have fixed this by now'
					);
				}
				return "Couldn't reach your Bitcoin node's RPC — it may be restarting. Try again in a moment.";
			}
		}
	}

	if (status.running) return null;
	const fatals = miningFatalErrors();
	return fatals.length > 0
		? `The mining engine failed to start: ${fatals[fatals.length - 1]}`
		: 'The mining engine failed to start — check the fatal errors panel.';
}

export const load: PageServerLoad = async () => {
	// The mining engine/read-model module is being built in the same wave
	// (cairn-vn43) — wrap in try/catch so a not-yet-landed module or a live
	// read failure degrades to a calm "nothing running" view instead of a
	// 500 (this route's contract, mirrors admin/settings' defensive loads).
	try {
		const view = await getAdminMiningView();
		return { view };
	} catch (e) {
		log.warn({ err: e }, 'getAdminMiningView() failed — serving degraded view');
		return { view: DEGRADED_ADMIN_MINING_VIEW };
	}
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!requireAdmin(locals)) return fail(403, { error: 'Admin access required.' });
		const form = await request.formData();

		const enabled = form.get('enabled') === 'on';

		const bind = String(form.get('bind') ?? 'loopback');
		if (!MINING_BINDS.includes(bind as MiningBind))
			return fail(400, { error: 'Invalid bind option.' });

		const port = Number(form.get('port'));
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return fail(400, { error: 'Stratum port must be between 1 and 65535.' });

		const shareDifficulty = Number(form.get('shareDifficulty'));
		if (!Number.isFinite(shareDifficulty) || shareDifficulty <= 0)
			return fail(400, { error: 'Share difficulty must be greater than 0.' });

		const vardiffEnabled = form.get('vardiffEnabled') === 'on';

		const vardiffTargetPerMin = Number(form.get('vardiffTargetPerMin'));
		if (!Number.isFinite(vardiffTargetPerMin) || vardiffTargetPerMin < 1 || vardiffTargetPerMin > 60)
			return fail(400, {
				error: 'Vardiff target must be between 1 and 60 shares per minute.'
			});

		// Pool tag is embedded in the coinbase scriptSig — plain ASCII only, and
		// capped well under scriptSig space (mirrors the ~24-byte cap other solo
		// pools use for a BIP34-height-plus-tag coinbase).
		const poolTag = String(form.get('poolTag') ?? '').trim();
		if (poolTag.length > 24) return fail(400, { error: 'Pool tag must be 24 characters or fewer.' });
		// eslint-disable-next-line no-control-regex -- deliberately matching printable ASCII only
		if (!/^[\x20-\x7e]*$/.test(poolTag))
			return fail(400, { error: 'Pool tag must be plain ASCII text.' });

		// Second (ASIC-class) listener: a separate high-floor Stratum port so big
		// machines don't drown the low-floor standard port in trivially-easy shares.
		const asicPortEnabled = form.get('asicPortEnabled') === 'on';

		const asicStratumPort = Number(form.get('asicStratumPort'));
		if (!Number.isInteger(asicStratumPort) || asicStratumPort < 1 || asicStratumPort > 65535)
			return fail(400, { error: 'ASIC port must be between 1 and 65535.' });
		if (asicStratumPort === port)
			return fail(400, { error: 'The ASIC port must be different from the main Stratum port.' });

		const asicShareDifficulty = Number(form.get('asicShareDifficulty'));
		if (!Number.isFinite(asicShareDifficulty) || asicShareDifficulty <= 0)
			return fail(400, { error: 'ASIC share difficulty must be greater than 0.' });

		// Native Stratum V2 listener (cairn-qfez8.9): a THIRD, optional listener —
		// same port/difficulty validation shape as the ASIC port above, plus the
		// same mutual-collision check against BOTH other ports (not just the main
		// one) since all three can be enabled at once.
		const sv2Enabled = form.get('sv2Enabled') === 'on';

		const sv2Port = Number(form.get('sv2Port'));
		if (!Number.isInteger(sv2Port) || sv2Port < 1 || sv2Port > 65535)
			return fail(400, { error: 'Stratum V2 port must be between 1 and 65535.' });
		if (sv2Port === port)
			return fail(400, { error: 'The Stratum V2 port must be different from the main Stratum port.' });
		if (sv2Port === asicStratumPort)
			return fail(400, { error: 'The Stratum V2 port must be different from the big-machine port.' });

		const sv2ShareDifficulty = Number(form.get('sv2ShareDifficulty'));
		if (!Number.isFinite(sv2ShareDifficulty) || sv2ShareDifficulty <= 0)
			return fail(400, { error: 'Stratum V2 share difficulty must be greater than 0.' });

		const sv2VersionRolling = form.get('sv2VersionRolling') === 'on';

		setSetting('mining_enabled', enabled ? 'true' : 'false');
		setSetting('mining_bind', bind);
		setSetting('mining_stratum_port', String(port));
		setSetting('mining_share_difficulty', String(shareDifficulty));
		setSetting('mining_vardiff_enabled', vardiffEnabled ? 'true' : 'false');
		setSetting('mining_vardiff_target_rate', String(vardiffTargetPerMin));
		setSetting('mining_pool_tag', poolTag);
		setSetting('mining_asic_port_enabled', asicPortEnabled ? 'true' : 'false');
		setSetting('mining_asic_stratum_port', String(asicStratumPort));
		setSetting('mining_asic_share_difficulty', String(asicShareDifficulty));
		setSetting('mining_sv2_enabled', sv2Enabled ? 'true' : 'false');
		setSetting('mining_sv2_port', String(sv2Port));
		setSetting('mining_sv2_share_difficulty', String(sv2ShareDifficulty));
		setSetting('mining_sv2_version_rolling', sv2VersionRolling ? 'true' : 'false');

		try {
			await reconfigureMiningEngine();
		} catch (e) {
			log.error({ err: e }, 'reconfigureMiningEngine() failed after settings save');
			return fail(500, { error: 'Settings saved, but the mining engine failed to restart with them.' });
		}
		{
			const startError = await engineFailedToStart();
			if (startError) return fail(500, { error: `Settings saved, but ${startError}` });
		}

		return { saved: true };
	},

	/**
	 * Quick start/stop from the engine health panel — flips only mining_enabled
	 * (the settings form's other fields are untouched) and drives the engine
	 * directly, rather than a full reconfigure, so a stopped engine starts
	 * fast and a bad config elsewhere doesn't block a plain stop.
	 */
	startStop: async ({ locals }) => {
		if (!requireAdmin(locals)) return fail(403, { error: 'Admin access required.' });

		const enabling = getSetting('mining_enabled') !== 'true';
		setSetting('mining_enabled', enabling ? 'true' : 'false');

		try {
			if (enabling) await startMiningEngine();
			else await stopMiningEngine();
		} catch (e) {
			log.error({ err: e }, 'startMiningEngine/stopMiningEngine failed');
			return fail(500, {
				error: enabling
					? 'Could not start the mining engine — check the fatal errors below.'
					: 'Could not stop the mining engine cleanly.'
			});
		}

		if (enabling) {
			// doStart() never throws — every gate (Core RPC not configured/reachable,
			// feature flag off, port conflict, ...) either no-ops silently or lands in
			// the fatal list. startMiningEngine() resolving is NOT proof the engine
			// came up (this was the live silent-no-op bug: the button flipped
			// mining_enabled, returned `{ toggled: true }`, and the pool never
			// started — no error anywhere). Verify and surface an honest reason.
			const startError = await engineFailedToStart();
			if (startError) return fail(500, { error: startError });
		}

		return { toggled: true };
	},

	restart: async ({ locals }) => {
		if (!requireAdmin(locals)) return fail(403, { error: 'Admin access required.' });
		try {
			await reconfigureMiningEngine();
		} catch (e) {
			log.error({ err: e }, 'reconfigureMiningEngine() failed on manual restart');
			return fail(500, { error: 'Restart failed — check the fatal errors below.' });
		}
		{
			// reconfigure resolving is not proof of life — see engineFailedToStart.
			const startError = await engineFailedToStart();
			if (startError) return fail(500, { error: startError });
		}
		return { restarted: true };
	}
};
