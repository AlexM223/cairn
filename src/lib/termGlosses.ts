// Shared plain-language gloss text for <Term tip="..."> wraps (cairn-vxbk).
// Centralized so the same jargon term reads identically wherever it surfaces
// across auth, wallet, and nav copy — keep new sites importing from here
// rather than inventing a slightly different sentence.

export const PASSKEY_TIP =
	"A passkey signs you in with your device's fingerprint, face, or PIN — no password to type or remember.";

// Multisig wording (quorum + every key) — reused verbatim from the existing
// import-flow gloss in wallets/multisig/new/+page.svelte so the term reads
// the same on creation and on the wallet-detail export panel.
export const DESCRIPTOR_TIP_MULTISIG =
	'A descriptor is a single line of text that describes a multisig wallet completely — the quorum and every public key. Wallets like Sparrow export it under Settings.';

export const DESCRIPTOR_TIP_SINGLE =
	'A descriptor is a single line of text that describes this wallet completely — its type and public key. Wallets like Sparrow or Electrum can import it directly.';
