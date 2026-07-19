// Canonical chain/node-down copy (cairn-6edk). Before this, the same
// "we can't reach the Bitcoin backend" condition was worded independently in
// (at least) four places -- the global ChainHealthBanner, the /admin
// Overview status pill + hero fallback, the /admin/settings inline transport
// line, and the /activity `network_down` feed entry -- each hand-rolling its
// own string, some leaking internals ("Electrum", raw connect-error text) a
// plain-language UX philosophy (no exposed Bitcoin/network internals) says a
// user should never see. This module is the single source every one of those
// surfaces now reads from, so the wording (and any future tweak to it) never
// drifts apart again.
//
// Kept in $lib (not $lib/server) because it's plain string constants used
// from both server code (chainEvents.ts's activity-feed message) and client
// Svelte components (ChainHealthBanner, the admin pages) -- unlike
// $lib/server/chainErrors.ts, which classifies raw scan-failure errors for a
// different surface (wallet/multisig scan results) and stays server-only.
//
// Deliberately just the base phrase, no trailing punctuation/casing: call
// sites compose it into a full sentence, a status-pill label, or a one-line
// activity message as their own layout needs, without duplicating the words.

/** The core plain-language phrase for "we can't reach your node/server" --
 *  no "Electrum", "chain tip", or other backend jargon in the primary text,
 *  per UX philosophy (plain language, no exposed Bitcoin/network internals). */
export const CHAIN_DOWN = "Can't reach your Bitcoin node";

/** Same condition, when the configured SOCKS5/Tor proxy is the likely culprit
 *  (as opposed to the node/server itself). */
export const CHAIN_DOWN_PROXY = "Can't reach your Bitcoin node through your proxy";

/** One-line activity-feed phrasing for the moment connectivity is lost
 *  (`network_down`, mirrors `network_up`'s existing "Connected to the Bitcoin
 *  network" tense/shape). */
export const CHAIN_DOWN_ACTIVITY = 'Lost connection to your Bitcoin node';
