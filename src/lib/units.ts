// Shared BTC/sats display-unit preference (Settings -> Units toggle, cairn-nb8e).
// Same writable-store-over-localStorage shape as `fiatPrimaryPref`/`fiatVisible`
// in $lib/price.ts, kept in its own module because this is a bitcoin-unit
// choice (BTC vs sats), not a fiat one. Persisted under the pre-existing
// `hw.unit` key (Settings already wrote this key before any other surface
// read it back — see cairn-nb8e). Any surface that lets the user pick or
// cycle between BTC and sats — Settings' own toggle, AmountEntry's
// unit-cycle button, future ones — must read/write through here so they
// can never drift out of sync with each other again.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const UNIT_KEY = 'hw.unit';

export type DisplayUnit = 'btc' | 'sats';

function readUnitPref(): DisplayUnit {
	if (!browser) return 'btc';
	return localStorage.getItem(UNIT_KEY) === 'sats' ? 'sats' : 'btc';
}

/** Preferred BTC/sats display unit. Defaults to BTC (sats-first doctrine
 *  still applies at the amount level -- this only picks which Bitcoin
 *  denomination is shown/entered, fiat is a separate opt-in axis). */
export const unitPref = writable<DisplayUnit>(readUnitPref());

export function setUnitPref(u: DisplayUnit): void {
	unitPref.set(u);
	if (browser) localStorage.setItem(UNIT_KEY, u);
}
