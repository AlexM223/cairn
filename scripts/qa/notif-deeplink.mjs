#!/usr/bin/env node
// Durable QA gate (Wave-5R piece 2): notification deep-link round-trip.
//
// Regression coverage for cairn-ay45q (fixed in 268f628): notify()'s
// payload.link must persist into the `events.detail` JSON so the bell panel
// (NotificationPanel.svelte's linkFor()) can read it back out, AND older rows
// written before that fix (detail has no `link` key, only a bare `txid`) must
// still fall back to an explorer tx link instead of going dead.
//
// This drives the SERVER side of that contract (GET /api/notifications) and
// re-implements linkFor()'s tiny resolution rule locally to assert against
// the API response — the actual DOM rendering of the panel is exercised
// separately by the browser-QA rule (visual pass), not by this script.
//
// Flow:
//   1. Boot the app (prod boot mode) against a fresh throwaway DB. No regtest
//      chain needed — Electrum stays unreachable (CAIRN_ELECTRUM_PORT=1),
//      which is irrelevant to the notifications API.
//   2. Seed an admin user + session (INSERT-only, qa-harness.mjs).
//   3. Insert two `events` rows directly into the DB:
//        - "new-style": detail = {"link":"/wallets"}
//        - "legacy":    detail = {"txid":"<64-hex>"} only, no link key
//   4. GET /api/notifications?limit=30 with the session cookie.
//   5. Assert both rows come back, and that applying the panel's own
//      link-resolution rule to each yields: new-style -> "/wallets",
//      legacy -> "/explorer/tx/<txid>".
//
// Usage: node scripts/qa/notif-deeplink.mjs
// Env: CAIRN_QA_SKIP_BUILD=1 to skip the production build for fast local
//   iteration (never set in CI).

import { randomBytes } from 'node:crypto';
import { buildForProduction, bootApp, seedAdminAndSession, openDb, getWithCookie, cleanupDir } from './qa-harness.mjs';

const failures = [];
function assertTrue(cond, msg) {
	if (!cond) failures.push(msg);
	else console.log(`  ok: ${msg}`);
}

// Mirrors NotificationPanel.svelte's linkFor() (src/lib/components/NotificationPanel.svelte)
// minus the explorer-feature-flag suppression, which is irrelevant here (flag
// defaults on and this script never disables it).
function linkFor(detail) {
	const raw = detail?.link;
	if (typeof raw === 'string' && raw.startsWith('/')) return raw;
	const txid = detail?.txid;
	if (typeof txid === 'string') return `/explorer/tx/${txid}`;
	return null;
}

function insertEvent(db, { userId, type, level, message, detail }) {
	db.prepare(
		`INSERT INTO events (user_id, type, level, message, detail) VALUES (?, ?, ?, ?, ?)`
	).run(userId, type, level, message, detail === undefined ? null : JSON.stringify(detail));
	return db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
}

async function main() {
	let app = null;
	try {
		await buildForProduction();
		app = await bootApp();
		console.log(`[notif-deeplink] app ready at ${app.base}`);

		const session = await seedAdminAndSession(app.dbPath, { email: 'qa-notif-deeplink@test.local' });
		console.log(`[notif-deeplink] seeded admin user id=${session.userId}`);

		const legacyTxid = randomBytes(32).toString('hex');

		const db = openDb(app.dbPath);
		let newStyleId, legacyId;
		try {
			newStyleId = insertEvent(db, {
				userId: session.userId,
				type: 'wallet_created',
				level: 'info',
				message: '[qa] new-style notification (detail.link)',
				detail: { link: '/wallets' }
			});
			legacyId = insertEvent(db, {
				userId: session.userId,
				type: 'tx_received',
				level: 'info',
				message: '[qa] legacy notification (txid only, no link)',
				detail: { txid: legacyTxid }
			});
		} finally {
			db.close();
		}
		console.log(`[notif-deeplink] inserted events id=${newStyleId} (new-style), id=${legacyId} (legacy)`);

		const res = await getWithCookie(`${app.base}/api/notifications?limit=30`, session.cookie);
		assertTrue(res.status === 200, `GET /api/notifications?limit=30 is 200 (got ${res.status})`);

		let body;
		try {
			body = JSON.parse(res.text);
		} catch (e) {
			failures.push(`GET /api/notifications returned parseable JSON (${e.message})`);
			body = { notifications: [] };
		}
		assertTrue(Array.isArray(body.notifications), 'response has a notifications array');
		assertTrue(typeof body.unread === 'number', 'response has a numeric unread count');

		const newStyleRow = body.notifications?.find((n) => n.id === newStyleId);
		const legacyRow = body.notifications?.find((n) => n.id === legacyId);
		assertTrue(!!newStyleRow, `new-style event id=${newStyleId} present in feed`);
		assertTrue(!!legacyRow, `legacy event id=${legacyId} present in feed`);

		if (newStyleRow) {
			assertTrue(
				newStyleRow.detail?.link === '/wallets',
				`new-style row's detail.link round-trips as "/wallets" (got ${JSON.stringify(newStyleRow.detail)})`
			);
			const resolved = linkFor(newStyleRow.detail);
			assertTrue(resolved === '/wallets', `new-style row resolves to detail.link "/wallets" (got ${resolved})`);
		}
		if (legacyRow) {
			assertTrue(
				legacyRow.detail?.link === undefined,
				`legacy row has no detail.link (got ${JSON.stringify(legacyRow.detail)})`
			);
			const resolved = linkFor(legacyRow.detail);
			const expected = `/explorer/tx/${legacyTxid}`;
			assertTrue(resolved === expected, `legacy row falls back to explorer tx link ${expected} (got ${resolved})`);
		}

		if (failures.length > 0) {
			console.error(`\n[notif-deeplink] FAIL — ${failures.length} assertion(s) failed:`);
			for (const f of failures) console.error(`  - ${f}`);
			process.exitCode = 1;
		} else {
			console.log('\n[notif-deeplink] PASS — all assertions held.');
			process.exitCode = 0;
		}
	} catch (e) {
		console.error('[notif-deeplink] FAIL (exception):', e instanceof Error ? e.stack || e.message : e);
		process.exitCode = 1;
	} finally {
		console.log('[notif-deeplink] tearing down...');
		if (app) {
			await app.stop().catch((e) => console.error('  app stop error:', e?.message || e));
			cleanupDir(app.dbDir);
		}
		console.log('[notif-deeplink] teardown complete.');
	}
}

main();
