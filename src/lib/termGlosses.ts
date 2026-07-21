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

// Admin > Mining > Stratum V2 section (cairn-qfez8.9).
export const STRATUM_V2_TIP =
	'Stratum V2 is a newer version of the mining protocol. The connection is encrypted, and your miner can verify it is really talking to this server — not an impersonator.';

// Explorer de-jargon pass (UX-REDESIGN-SPEC.md §2.5 + §4 glossary, cairn-gt05.4).

// The raw fee-rate unit, kept on the surface beside a plain-language time via
// the shared FeeRate component (src/lib/components/FeeRate.svelte).
export const SAT_VB_TIP =
	"sat/vB is Bitcoin's fee price: satoshis paid per virtual byte of transaction size. Miners fill blocks highest-rate-first, so a higher rate confirms sooner.";

// "vMB" is dead as a surface label ("mempool size · N MB waiting"); the real
// unit survives one tap down here.
export const VMB_TIP =
	"Virtual megabytes of pending transactions — the mempool's size measured the same way block space is priced.";

// "ring" survives as the glossed Heartwood identity term; the default surface
// label is "difficulty period" (spec §2.5 — metaphor glossed once, never deleted).
export const RING_TIP =
	"Every 2,016 blocks (about two weeks) the network retunes how hard mining is — one difficulty period. Heartwood draws each one as a ring, like a tree's growth rings.";

// "not one removed" is dead as a surface label ("every block still stands").
export const NO_REORG_TIP =
	'No blocks have been reorganized out — the chain your node follows has only ever grown.';

// UX simplification jargon sweep (docs/UX-SIMPLIFICATION-SPEC.md §8, cairn-6c91u.4).

export const VARDIFF_TIP =
	'Vardiff automatically raises or lowers how hard each share has to be, so a miner reports in at a steady, manageable rate whether it is a tiny USB stick or a warehouse of machines.';

export const STATELESS_SIGNER_TIP =
	"A stateless signer works entirely from a wallet's config file — Heartwood never saves the wallet, so nothing about it lingers here after you close the tab.";
