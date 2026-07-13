// Event-loop-lag monitor, loaded INSIDE the server process via
// `NODE_OPTIONS=--import <this file>` (see bootstrap.mjs). Runs
// perf_hooks.monitorEventLoopDelay and exposes a tiny unauthenticated HTTP
// endpoint on 127.0.0.1:ELMON_PORT that returns {p50,p95,p99,max,mean} in
// milliseconds and resets the histogram — so the driver can snapshot
// per-tier lag without the server's own app code knowing this exists.
//
// This file is imported as a Node `--import` module hook, so it runs before
// the app's own modules load. It must not import anything from $lib/server
// (path aliases aren't resolved at this point) — it only touches node:*
// builtins.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import http from 'node:http';

const ELMON_PORT = Number(process.env.CAIRN_LOADTEST_ELMON_PORT ?? 9399);
const ELMON_HOST = '127.0.0.1';

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

function nsToMs(ns) {
	return ns / 1e6;
}

const server = http.createServer((req, res) => {
	if (req.url !== '/' && req.url !== '/lag') {
		res.writeHead(404).end();
		return;
	}
	const snapshot = {
		p50: nsToMs(histogram.percentile(50)),
		p95: nsToMs(histogram.percentile(95)),
		p99: nsToMs(histogram.percentile(99)),
		max: nsToMs(histogram.max),
		mean: nsToMs(histogram.mean)
	};
	histogram.reset();
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(snapshot));
});

server.listen(ELMON_PORT, ELMON_HOST, () => {
	// Deliberately plain console.log — this runs before the app's structured
	// logger is available, same constraint server.mjs documents for itself.
	console.log(`cairn-loadtest: elmon listening on ${ELMON_HOST}:${ELMON_PORT}`);
});

// Never let the monitor's own listener keep the process alive past a normal
// shutdown, and never let it become a second thing that has to be torn down
// by hand — SIGTERM to the whole process closes it along with everything
// else.
server.unref();
