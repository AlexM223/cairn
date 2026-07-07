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
import { handler } from './build/handler.js';
import { ensureCert } from './scripts/tls-cert.mjs';

const httpPort = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const httpsPort = process.env.CAIRN_HTTPS_PORT ? Number(process.env.CAIRN_HTTPS_PORT) : null;

const servers = [];

const httpServer = http.createServer(handler);
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
		const httpsServer = https.createServer({ key, cert }, handler);
		httpsServer.listen(httpsPort, host, () => {
			console.log(`cairn: https listening on ${host}:${httpsPort} (self-signed, ${tlsDir})`);
		});
		servers.push(httpsServer);
	} catch (err) {
		// HTTPS is an enhancement; a cert problem must never take down the app.
		console.error('cairn: https listener disabled —', err?.message ?? err);
	}
}

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
