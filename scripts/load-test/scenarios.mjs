// Scenario definitions for the load-test driver. Each scenario is a function
// `(ctx) => Promise<{path, method, status, ok}>` — one "unit of work" for one
// simulated user, called repeatedly by the worker pool for the duration of a
// tier's measured window. `ctx` carries:
//   - session: { userId, email, token, isAdmin } assigned to this worker
//   - fetchJson(path, opts): fetch against the running server with the
//     session cookie + Origin header pre-set, returns { status, ms, ok, json }
//   - randomZpub(): mint a fresh unique zpub for scenario (c)'s POST
//   - rand(n): small deterministic-enough helper for picking indices
//
// Real endpoints/payloads were verified against the routes' own source
// before wiring these up (see FINAL REPORT): POST /api/wallets body
// {name?, xpub, deviceType?, fingerprint?, derivationPath?}
// (src/routes/api/wallets/+server.ts), PUT /api/wallets/:id/labels body
// {txid, label} (src/routes/api/wallets/[id]/labels/+server.ts), PATCH
// /api/notifications/preferences body {updates:[{eventType,channel,enabled,config?}]}
// (src/routes/api/notifications/preferences/+server.ts).

function pick(arr, i) {
	return arr[i % arr.length];
}

/** (a) steady browsing: GET / -> /wallets -> /wallets/<own id> -> /activity
 *  -> /api/portfolio, one full lap per call. */
export async function scenarioSteadyBrowsing(ctx) {
	const results = [];
	results.push(await ctx.fetchJson('/'));
	results.push(await ctx.fetchJson('/wallets'));
	if (ctx.walletId != null) {
		results.push(await ctx.fetchJson(`/wallets/${ctx.walletId}`));
	}
	results.push(await ctx.fetchJson('/activity'));
	results.push(await ctx.fetchJson('/api/portfolio'));
	return results;
}

/** (b) rapid-fire: a single session hammers dashboard + wallets list back to
 *  back with no think time (bursty single-user pattern, e.g. a stuck retry
 *  loop or an overzealous client poller). */
export async function scenarioRapidFire(ctx) {
	const results = [];
	results.push(await ctx.fetchJson('/'));
	results.push(await ctx.fetchJson('/wallets'));
	return results;
}

/** (c) mixed 40/20/40: GET send page render / POST /api/wallets with a fresh
 *  xpub / GET /api/portfolio. */
export async function scenarioMixed(ctx) {
	const roll = ctx.rand(100);
	if (roll < 40) {
		if (ctx.walletId == null) return [await ctx.fetchJson('/api/portfolio')];
		return [await ctx.fetchJson(`/wallets/${ctx.walletId}/send`)];
	}
	if (roll < 60) {
		const xpub = ctx.randomZpub();
		return [
			await ctx.fetchJson('/api/wallets', {
				method: 'POST',
				body: JSON.stringify({ name: `Load Test Import ${Date.now()}-${roll}`, xpub })
			})
		];
	}
	return [await ctx.fetchJson('/api/portfolio')];
}

/** (d) write-pressure: concurrent tx-label upserts + notification-preference
 *  PATCHes against real, pre-seeded rows (seed.mjs writes one tx_label +
 *  one notification_preferences row per user up front). */
export async function scenarioWritePressure(ctx) {
	const results = [];
	if (ctx.walletId != null && ctx.seedTxid) {
		results.push(
			await ctx.fetchJson(`/api/wallets/${ctx.walletId}/labels`, {
				method: 'PUT',
				body: JSON.stringify({ txid: ctx.seedTxid, label: `Load test label ${Date.now()}` })
			})
		);
	}
	results.push(
		await ctx.fetchJson('/api/notifications/preferences', {
			method: 'PATCH',
			body: JSON.stringify({
				updates: [
					{ eventType: 'tx_received', channel: 'email', enabled: ctx.rand(2) === 0 },
					{ eventType: 'tx_large', channel: 'email', enabled: true, config: { thresholdSats: 500_000 } }
				]
			})
		})
	);
	return results;
}

export const SCENARIOS = {
	a: { name: 'steady-browsing', run: scenarioSteadyBrowsing },
	b: { name: 'rapid-fire', run: scenarioRapidFire },
	c: { name: 'mixed-40-20-40', run: scenarioMixed },
	d: { name: 'write-pressure', run: scenarioWritePressure }
};

export function resolveScenarios(selector) {
	if (selector === 'all') return Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s }));
	const ids = selector.split(',').map((s) => s.trim());
	return ids.map((id) => {
		const s = SCENARIOS[id];
		if (!s) throw new Error(`unknown scenario "${id}" (expected one of a,b,c,d,all)`);
		return { id, ...s };
	});
}
