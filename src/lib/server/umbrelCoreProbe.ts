// Umbrel Bitcoin Core RPC detect-and-surface probe — Wave B, Unit B1
// (docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md). Sibling of umbrelProbe.ts
// (Wave A, Electrum), but Core RPC cannot be silently auto-connected the way
// Electrum is: bitcoind's JSON-RPC always requires a username/password, and
// on Umbrel that password lives ONLY inside the Bitcoin app's private `.env`,
// injected solely into apps that declare a hard `dependencies: [bitcoin]`
// manifest entry — which Cairn deliberately does not (cairn-2ldr "no node
// required" positioning). No cookie file is exported to non-dependent apps
// and bitcoind runs without `-rest`, so there is no unauthenticated endpoint
// to read credentials from either (design doc §2/§3).
//
// So this module does NOT connect anything. It only confirms bitcoind is
// LISTENING at the well-known address and seeds one advisory marker so the
// settings UI can offer an assisted one-paste connect (design §0/§5). It
// never writes core_rpc_url/user/pass, never touches connection_mode, and
// never throws — identical safety contract to umbrelProbe.ts and
// chainEnvSeed.ts.

import { env } from '$env/dynamic/private';
import { getSetting, setSetting, coreRpcConfigured } from './settings';
import { childLogger } from './logger';

const log = childLogger('umbrel-core-probe');

/**
 * Well-known Umbrel bitcoind address (design §2 evidence table: fixed IP on
 * the shared `umbrel_main_network` bridge, port from the bitcoin app's
 * `exports.sh`). Hardcoded constants, not values ever read from a probe
 * response — the settings UI prefill (Unit B3) imports these directly so
 * server and card share one source of truth, and so a rogue container
 * squatting on this address can never inject a different endpoint into
 * Cairn's config (design §7).
 */
export const UMBREL_CORE_RPC_URL = 'http://10.21.21.8:8332';
export const UMBREL_CORE_RPC_USER = 'umbrel';

/** Short — this blocks server boot (once, gated to Umbrel only) until it
 *  resolves, so an unreachable candidate must fail fast. Matches Wave A's
 *  PROBE_TIMEOUT_MS (umbrelProbe.ts). */
const DETECT_TIMEOUT_MS = 2_000;

/** Write `key` = `value` only if no row exists for it yet. Mirrors
 *  chainEnvSeed.ts / umbrelProbe.ts's seedIfUnset; duplicated rather than
 *  imported so each module's seed contract stays independently auditable.
 *  Returns whether it wrote. */
function seedIfUnset(key: string, value: string): boolean {
	if (getSetting(key) !== null) return false;
	setSetting(key, value);
	return true;
}

/**
 * Unwrap a fetch/undici error's chained `.cause` into a diagnosable string
 * for the (debug-level, non-fatal) log line below — mirrors the transport
 * hygiene in bitcoinCore/client.ts's fetchErrorDetail (cairn-s17j): don't let
 * a DNS/TLS/refused/timeout failure collapse to an opaque "fetch failed".
 * This is purely a logging aid; it never affects detection or seeding
 * (both treat any transport failure identically — not detected, silent
 * fall-through, design §5).
 */
function fetchErrorDetail(err: unknown): string {
	const parts: string[] = [];
	let cur: unknown = err;
	const seen = new Set<unknown>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (cur instanceof Error) {
			const code = (cur as { code?: unknown }).code;
			const msg = code != null ? `${cur.message} (${String(code)})` : cur.message;
			if (msg && !parts.includes(msg)) parts.push(msg);
			cur = (cur as { cause?: unknown }).cause;
		} else {
			const s = String(cur);
			if (s && !parts.includes(s)) parts.push(s);
			break;
		}
	}
	return parts.join(': ') || 'unknown error';
}

/**
 * Credential-free JSON-RPC POST against the well-known Umbrel bitcoind
 * address (design §5). Sends no Authorization header and never reads
 * anything from the response BODY as configuration — the only bit extracted
 * is "a bitcoind HTTP-RPC listener answered here at all":
 *
 * - HTTP 401 → detected (the definitive fingerprint: bitcoind demanding auth).
 * - HTTP 403 → detected (some configs 403 a disallowed-IP; still a listener).
 * - HTTP 503 whose body carries the JSON-RPC warmup fingerprint (`-28`, e.g.
 *   `"Loading block index…"`/`"Verifying blocks…"`) → detected (node up but
 *   still in IBD warmup, design §8).
 * - HTTP 200 → detected (would only happen against a misconfigured
 *   unauthenticated node; we still only seed the marker, never auto-connect).
 * - Connection refused / timeout / DNS error / any other transport failure →
 *   NOT detected. Silent fall-through — the Core app just isn't installed.
 */
async function detectUmbrelCore(): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
	try {
		const res = await fetch(UMBREL_CORE_RPC_URL, {
			method: 'POST',
			signal: controller.signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '1.0',
				id: 'cairn-detect',
				method: 'getblockchaininfo',
				params: []
			})
		});

		if (res.status === 401 || res.status === 403) return true;
		if (res.status === 200) return true;
		if (res.status === 503) {
			// Warmup fingerprint only — a generic 503 unrelated to bitcoind's RPC
			// warmup path is deliberately NOT treated as detected. Body is read only
			// to look for this fingerprint string, never parsed as config (§5/§7).
			const text = await res.text().catch(() => '');
			return /-28/.test(text) || /warming up/i.test(text) || /verifying blocks/i.test(text);
		}
		return false;
	} catch (e) {
		log.debug(
			{ event: 'umbrel_core_probe_transport_error', detail: fetchErrorDetail(e) },
			'umbrel core RPC probe: no response (expected when the Core app is not installed)'
		);
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe the well-known Umbrel bitcoind address and, if a listener answers,
 * seed the ADVISORY-ONLY `core_rpc_detected='umbrel'` marker (design §5/§6).
 * Writes nothing else — no `core_rpc_url`/`core_rpc_user`/`core_rpc_pass`,
 * no `connection_mode`, no `chain_provisioned_by` (that marker stays
 * Electrum-scoped, design §6). `getChainConfig()`'s output is byte-for-byte
 * identical before and after a successful detection; the only observable
 * effect is that the settings UI (Unit B3) can render an assisted-connect
 * banner.
 *
 * Gating (design §4), checked in order:
 * 1. `CAIRN_PLATFORM === 'umbrel'` — never dial 10.21.21.8 anywhere else.
 * 2. `coreRpcConfigured() === false` — never probe/nudge once Core is already
 *    wired, by an admin OR by chainEnvSeed.ts's env-based seed (which runs
 *    earlier in hooks.server.ts's init() and always wins when present).
 * 3. `core_rpc_detected` unset — seed-once idempotence; at most one detection
 *    per install, every later boot is a no-op.
 *
 * Deliberately NOT gated on (and never touches) `connection_mode` — Core RPC
 * is independent of the Electrum connection mode (design §4:
 * `getChainConfig()` returns `coreRpc*` in both `public` and `custom` modes).
 *
 * Returns the setting keys actually WRITTEN this call — same contract as
 * chainEnvSeed.ts's seedChainConfigFromEnv() / umbrelProbe.ts's
 * probeAndSeedUmbrelElectrum(), so hooks.server.ts can fold all three into
 * one `seededThisBoot` startup-summary signal. Never throws — the whole body
 * is wrapped; any failure just leaves settings untouched.
 */
export async function probeAndDetectUmbrelCore(): Promise<string[]> {
	const applied: string[] = [];
	try {
		if (env.CAIRN_PLATFORM !== 'umbrel') return applied;
		if (coreRpcConfigured()) return applied;
		if (getSetting('core_rpc_detected') !== null) return applied;

		const detected = await detectUmbrelCore();
		if (!detected) {
			log.debug(
				{ event: 'umbrel_core_probe_no_match' },
				'no Umbrel Bitcoin Core RPC listener detected at the well-known address'
			);
			return applied;
		}

		if (seedIfUnset('core_rpc_detected', 'umbrel')) applied.push('core_rpc_detected');

		log.info(
			{ event: 'umbrel_core_detected', url: UMBREL_CORE_RPC_URL },
			'detected Umbrel Bitcoin Core RPC listener (marker-only — no connection settings written; see design doc §5)'
		);
		return applied;
	} catch (e) {
		log.error({ err: e }, 'umbrel core RPC detection probe failed');
		return applied;
	}
}
