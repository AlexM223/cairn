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

// Admin > Settings connection jargon (cairn-3hwc8, follow-up to cairn-vxbk —
// that pass skipped src/routes/admin/** for a since-resolved concurrent edit).
export const ELECTRUM_TIP =
	'Electrum is the lightweight protocol Heartwood uses to check balances and send transactions — either a public server or one you run yourself.';

export const CORE_RPC_TIP =
	"RPC is the interface Bitcoin Core exposes for other software to talk to it. Connecting Heartwood to your own Core node's RPC unlocks richer block and transaction detail, fully self-hosted.";

// Explorer breadcrumb (cairn-s7rpg, follow-up to cairn-vxbk — that pass
// couldn't reach this one because EyebrowBreadcrumb had no Term-capable slot).
export const TIMECHAIN_TIP =
	"The timechain is Bitcoin's shared ledger — every block linked to the one before it, forming one unbroken, tamper-evident history.";

// Admin > Mining engine + pool-settings jargon (cairn-b55a5).
export const STRATUM_TIP =
	'Stratum is the protocol miners speak to a pool — it hands out work and collects the shares they find.';
