// tipHeight — the shared chain-tip rune store (docs/LIVE-UPDATES-DESIGN.md §4.1).
//
// A single source of "how high is the chain right now", fed by `block` frames
// off the one /api/live EventSource (via liveClient). Every confirmation display
// derives from this through confirmationsFor(), so the whole app agrees on the
// tip at every instant and confirmation counts climb the moment a block lands —
// no reload, no per-component tip copy, no polling.
//
// Lazy: the block subscription is started on first read of `.height`, so merely
// importing the module doesn't open a connection — a page that reads the tip
// arms it; a page that never touches it pays nothing. SSR-safe: liveClient's
// subscribe() no-ops off the browser, so `.height` is simply 0 during SSR.

import { subscribe } from './liveClient';

let height = $state(0);
let started = false;

function ensureStarted(): void {
	if (started) return;
	started = true;
	subscribe('block', (ev) => {
		try {
			const h = Number((JSON.parse(ev.data as string) as { height: unknown }).height);
			// Monotonic: only ever advance. A reconnect re-primes the current tip and
			// a brief reorg is handled downstream by confirmationsFor's clamp, so the
			// rune itself never rewinds.
			if (Number.isFinite(h) && h > height) height = h;
		} catch {
			// Malformed frame — ignore.
		}
	});
}

/** The shared live tip. Reading `.height` lazily arms the block subscription. */
export const tipHeight = {
	get height(): number {
		ensureStarted();
		return height;
	}
};
