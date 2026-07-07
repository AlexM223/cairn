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
