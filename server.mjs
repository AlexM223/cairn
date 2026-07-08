/**
 * Production entry point: adapter-node's request handler on plain HTTP, plus
 * an optional self-signed HTTPS listener (cairn-wgr8).
 *
 * Why not `node build` (adapter-node's own server)? It only speaks HTTP. On
 * Umbrel — plain HTTP on the LAN, no platform TLS — that leaves the browser
 * without a secure context, so WebHID / Web Serial hardware-wallet signing
 * and camera QR scanning are unavailable. This wrapper serves the SAME app on
 * a second, TLS port using a certificate generated at first boot (see
 * scripts/tls-cert.mjs); the UI points users there for USB signing.
 *
 * Startup order matters (cairn-qv6h): Docker starts forwarding published
 * host ports the moment the container starts, so every second before a
 * listener binds shows up to the browser as ERR_EMPTY_RESPONSE (docker-proxy
 * accepts, finds no backend, closes). Importing the SvelteKit bundle is the
 * slow part of boot — DB open, migrations, Electrum pool — so both listeners
 * bind FIRST with a self-refreshing 503 placeholder, and the real handler is
 * swapped in when the app finishes loading.
 *
 * Environment:
 *   PORT / HOST            — HTTP listener (adapter-node conventions; default 3000).
 *   CAIRN_HTTPS_PORT       — enable the HTTPS listener on this port. Unset = off.
 *   CAIRN_TLS_DIR          — where key.pem/cert.pem persist. Default: <dir of
 *                            CAIRN_DB>/tls, falling back to ./data/tls.
 *   CAIRN_HTTPS_EXTERNAL_PORT — the HOST-visible port the UI should link to
 *                            when it differs from CAIRN_HTTPS_PORT (Docker
 *                            port mapping); read by the app, not by this file.
 *
 * adapter-node handles ADDRESS_HEADER / PROTOCOL_HEADER / BODY_SIZE_LIMIT etc.
 * inside the imported handler. Requests on the HTTPS listener arrive without
 * an x-forwarded-proto header and adapter-node's get_origin falls back to
 * "https" — exactly right for a direct TLS listener, so cookies and the CSRF
 * origin check behave on both ports.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { ensureCert } from './scripts/tls-cert.mjs';

/**
 * Process-level crash guard (cairn-ldvt-adjacent), boot-phase fallback.
 *
 * There is no `process.on('uncaughtException' | 'unhandledRejection')`
 * anywhere else in the app, so before this a stray throw (e.g. inside the SSE
 * heartbeat setInterval) or rejection (e.g. an Electrum data-listener error)
 * killed the whole process for every user with nothing but a bare Node stack
 * trace on stdout — no structured log line, no context.
 *
 * This has to be the very first thing that runs, before anything else in
 * this file (cert generation, listener bind) has a chance to throw. It can't
 * use the real app logger ($lib/server/logger's childLogger): this file is a
 * plain Node script that runs before Vite/SvelteKit's `$lib` alias resolution
 * exists, so that module isn't importable yet. console.error is the best
 * available fallback for this narrow window — it still lands in `docker
 * logs`/journald, just without the structured/rotating-file treatment.
 *
 * src/hooks.server.ts installs the same guard using the real logger and,
 * because it loads later (SvelteKit's server bundle is imported below, after
 * the listeners are already bound), REPLACES these fallback listeners the
 * moment it runs — see the comment there. In launch modes that never run this
 * file (`vite dev`/`vite preview`, or adapter-node's own `build/index.js`),
 * hooks.server.ts's registration is the only one that ever fires, so the app
 * is still covered.
 */
if (process.listenerCount('uncaughtException') === 0) {
	process.on('uncaughtException', (err) => {
		console.error('cairn: uncaughtException (boot-phase fallback, exiting) —', err);
		// A synchronous throw means the process state is unknown. This is a
		// wallet app — never keep serving requests in an undefined state.
		// Exit non-zero so the container/supervisor restart policy takes over.
		process.exit(1);
	});
	process.on('unhandledRejection', (reason) => {
		// Log-only, deliberately NOT process.exit() here: a single benign
		// stray rejection (e.g. a fire-and-forget promise somewhere in a
		// dependency) would otherwise turn into a crash loop. This matches
		// the same policy the real handler in hooks.server.ts uses.
		console.error('cairn: unhandledRejection (boot-phase fallback, not exiting) —', reason);
	});
}

const httpPort = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const httpsPort = process.env.CAIRN_HTTPS_PORT ? Number(process.env.CAIRN_HTTPS_PORT) : null;

/**
 * Swappable request handler: starts as a "still booting" 503 that refreshes
 * itself, becomes the SvelteKit handler once ./build/handler.js has loaded.
 */
let handle = (req, res) => {
	res.writeHead(503, {
		'content-type': 'text/html; charset=utf-8',
		'retry-after': '2',
		'cache-control': 'no-store'
	});
	res.end(
		'<!doctype html><meta http-equiv="refresh" content="2"><title>Cairn is starting…</title>' +
			'<p style="font-family:system-ui;margin:3rem auto;max-width:30rem;text-align:center">' +
			'Cairn is starting up — this page will retry by itself.</p>'
	);
};

const servers = [];

const httpServer = http.createServer((req, res) => handle(req, res));
httpServer.listen(httpPort, host, () => {
	console.log(`cairn: http listening on ${host}:${httpPort}`);
});
servers.push(httpServer);

if (httpsPort) {
	const tlsDir =
		process.env.CAIRN_TLS_DIR ??
		(process.env.CAIRN_DB
			? path.join(path.dirname(process.env.CAIRN_DB), 'tls')
			: path.join(process.cwd(), 'data', 'tls'));
	try {
		const { key, cert } = await ensureCert(tlsDir);
		const httpsServer = https.createServer({ key, cert }, (req, res) => handle(req, res));
		httpsServer.listen(httpsPort, host, () => {
			console.log(`cairn: https listening on ${host}:${httpsPort} (self-signed, ${tlsDir})`);
		});
		servers.push(httpsServer);
	} catch (err) {
		// HTTPS is an enhancement; a cert problem must never take down the app.
		// (ensureCert itself degrades to an in-memory cert on persistence
		// failures, so reaching this catch means generation broke outright.)
		console.error('cairn: https listener disabled —', err?.message ?? err);
	}
}

// The heavy part — SvelteKit bundle, DB, Electrum — AFTER the ports are open.
const { handler } = await import('./build/handler.js');
handle = handler;
console.log('cairn: app ready');

function shutdown(signal) {
	console.log(`cairn: ${signal} received, shutting down`);
	let open = servers.length;
	for (const server of servers) {
		server.close(() => {
			if (--open === 0) process.exit(0);
		});
	}
	// Idle keep-alive sockets keep close() pending; don't hang the container.
	setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
