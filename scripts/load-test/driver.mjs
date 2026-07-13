// Fixed worker-pool load driver. For a given scenario + concurrency tier:
// spins up `tier` concurrent workers, each in a closed loop calling the
// scenario's `run(ctx)` repeatedly for WARMUP_S + durationS seconds total.
// Samples from the first WARMUP_S are discarded; only samples from the
// measured window are returned. Session assignment is round-robin across
// scenarios EXCEPT 'rapid-fire' (b), which deliberately pins every worker to
// the SAME session/wallet to model a single hammered user (bursty
// retry-loop / overzealous poller pattern) rather than N independent users.

import { performance } from 'node:perf_hooks';
import { SERVER_ORIGIN, ELMON_ORIGIN, WARMUP_S } from './config.mjs';
import { randomZpub } from './fixtures/generate-xpubs.mjs';

async function fetchElmonSnapshot() {
	try {
		const res = await fetch(`${ELMON_ORIGIN}/lag`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

function buildFetchJson(session) {
	return async function fetchJson(pathname, opts = {}) {
		const method = opts.method ?? 'GET';
		const headers = {
			Cookie: `cairn_session=${session.token}`,
			Origin: SERVER_ORIGIN,
			Accept: 'application/json, text/html'
		};
		if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
		const start = performance.now();
		try {
			const res = await fetch(`${SERVER_ORIGIN}${pathname}`, {
				method,
				headers,
				body: opts.body,
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000)
			});
			// Drain the body so the connection can be reused by keep-alive.
			await res.arrayBuffer().catch(() => {});
			const ms = performance.now() - start;
			// SvelteKit redirects (302) are a normal, successful outcome for page
			// GETs (e.g. an appGate redirect) — never an error.
			const ok = res.status < 400;
			return { path: pathname, method, status: res.status, ms, ok };
		} catch (err) {
			const ms = performance.now() - start;
			return { path: pathname, method, status: 0, ms, ok: false, error: String(err?.message ?? err) };
		}
	};
}

function makeCtx(session, seq) {
	return {
		session,
		fetchJson: buildFetchJson(session),
		walletId: session.firstWalletId,
		seedTxid: session.seedTxid,
		randomZpub,
		rand: (n) => (seq.i++ * 2654435761) % n >>> 0
	};
}

/**
 * Run one (scenario, tier) combination. Spins up `tier` concurrent workers
 * for warmupS + durationS seconds; samples from the first warmupS are
 * discarded. Returns the flat array of recorded samples
 * {scenario, tier, path, method, status, ms, ok} from the MEASURED window
 * only, plus the event-loop-lag snapshot taken over that same window.
 */
export async function runTier({ scenario, tier, sessions, durationS, warmupS = WARMUP_S }) {
	if (sessions.length === 0) throw new Error('runTier: no sessions available');

	const samples = [];
	const state = { measuring: false, stopped: false };
	const seq = { i: 1 };

	// Reset the event-loop-lag histogram right before warmup starts.
	await fetchElmonSnapshot();

	const workers = Array.from({ length: tier }, (_, w) => {
		const session = scenario.id === 'b' ? sessions[0] : sessions[w % sessions.length];
		const ctx = makeCtx(session, seq);
		return (async () => {
			while (!state.stopped) {
				const results = await scenario.run(ctx);
				if (state.measuring) {
					for (const r of results) samples.push({ scenario: scenario.id, tier, ...r });
				}
			}
		})();
	});

	await new Promise((r) => setTimeout(r, warmupS * 1000));
	// Reset again right as the measured window begins, so the elmon snapshot
	// taken at the end reflects lag during the measured window only.
	await fetchElmonSnapshot();
	state.measuring = true;

	await new Promise((r) => setTimeout(r, durationS * 1000));
	state.stopped = true;
	// Let in-flight requests land rather than aborting workers mid-request.
	await Promise.race([Promise.all(workers), new Promise((r) => setTimeout(r, 15_000))]);

	const eventLoopLag = await fetchElmonSnapshot();

	return { samples, eventLoopLag };
}
