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

// --- Fiat visibility preference (cairn-r494) ---------------------------------
// Settings -> Display's "Fiat display: Hidden / USD shown" toggle, persisted
// under the same `cairn.fiat` localStorage key Home/wallet-detail heroes
// already read for their own privacy-gated snapshot fetch (cairn-r7si,
// cairn-d326). Those three heroes each compute their own gated price and pass
// it explicitly to Amount via the `price` prop — but every *other* Amount call
// site app-wide (tx rows, fee lines, address balances, etc.) previously fell
// through to Amount's default, which subscribes to the raw live-ticking
// `$btcUsd` store with zero awareness of this setting, leaking fiat on the
// wallet-detail pages whenever it was set to Hidden.
//
// Amount.svelte now reads this store directly and is the single, central
// enforcement point (`resolveAmountPrice` in `$lib/format`): whatever a call
// site passes or doesn't pass as `price`, a Hidden setting always wins. Every
// setter of the `cairn.fiat` key (currently just the Settings page) must call
// `setFiatVisible` rather than writing localStorage directly, so this store —
// and every Amount subscribed to it — updates immediately, including across
// client-side navigation within the same session.
const FIAT_VISIBLE_KEY = 'cairn.fiat';

function readFiatVisible(): boolean {
	if (!browser) return false;
	return localStorage.getItem(FIAT_VISIBLE_KEY) === 'on';
}

export const fiatVisible = writable<boolean>(readFiatVisible());

export function setFiatVisible(on: boolean): void {
	fiatVisible.set(on);
	if (browser) localStorage.setItem(FIAT_VISIBLE_KEY, on ? 'on' : 'off');
}
