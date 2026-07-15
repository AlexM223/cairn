// Client-side BTC→USD price store (bead cairn-vnfs). Backs the Amount
// component's fiat-primary display: any component that subscribes (`$btcUsd`)
// triggers a fetch of the existing /api/price endpoint and gets refreshed
// roughly every 60s for as long as at least one subscriber is listening —
// Svelte's readable() start/stop contract tears the interval down once the
// last subscriber unmounts, so navigating away from every price-showing page
// stops the polling automatically.
//
// Silent-fails to null on any error (network hiccup, non-OK response, bad
// body shape) — callers (Amount.svelte) already render a clean BTC-only
// layout when the price is null, so a flaky price feed never breaks a page.
//
// Client-side only: no $lib/server imports, guarded so SSR never attempts the
// relative fetch.
import { readable, writable } from 'svelte/store';
import { browser } from '$app/environment';

const REFRESH_MS = 60_000;
const FIAT_PRIMARY_KEY = 'cairn.fiatPrimary';

async function fetchBtcUsd(): Promise<number | null> {
	try {
		const res = await fetch('/api/price');
		if (!res.ok) return null;
		const body = await res.json();
		return typeof body?.usd === 'number' ? body.usd : null;
	} catch {
		return null;
	}
}

/** Current BTC→USD spot price, or null when unavailable (or not yet fetched). */
export const btcUsd = readable<number | null>(null, (set) => {
	if (!browser) return;
	let cancelled = false;

	async function tick() {
		const value = await fetchBtcUsd();
		if (!cancelled) set(value);
	}

	void tick();
	const id = setInterval(() => void tick(), REFRESH_MS);

	return () => {
		cancelled = true;
		clearInterval(id);
	};
});

// --- Fiat-primary display preference (cairn-6ppq) ---------------------------
// DESIGN-MANIFESTO.md §3 MUST rule: BTC/sats is primary BY DEFAULT everywhere
// Amount.svelte renders. Default OFF (sats-first); a user who explicitly
// flips "Primary display" to Fiat in Settings -> Display gets that durable
// preference persisted here (same localStorage-preference pattern as the
// `cairn.fiat` show/hide toggle) and honored by every Amount instance,
// overriding the default rather than being overridden by it.
function readFiatPrimaryPref(): boolean {
	if (!browser) return false;
	return localStorage.getItem(FIAT_PRIMARY_KEY) === 'on';
}

export const fiatPrimaryPref = writable<boolean>(readFiatPrimaryPref());

export function setFiatPrimaryPref(on: boolean): void {
	fiatPrimaryPref.set(on);
	if (browser) localStorage.setItem(FIAT_PRIMARY_KEY, on ? 'on' : 'off');
}
