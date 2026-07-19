# Federation Prior-Art Survey

**Companion to [FEDERATION-SCOPE.md](./FEDERATION-SCOPE.md) — epic cairn-cz3q, security gates F1/F4/F12.**

Date: 2026-07-18
Method: web research (search + primary-source fetch where accessible) surveying instance-to-instance / cosigner-coordination prior art in the Bitcoin multisig space, conducted specifically to pressure-test FEDERATION-SCOPE.md's design calls (transport choice, encryption posture, Fedimint rejection, Nostr verdict) against what shipped systems actually do as of mid-2026. This document does not modify FEDERATION-SCOPE.md — it extends it with sourced detail.

---

## 1. Systems Surveyed

### 1.1 Nunchuk — Group Wallet (current, 2026)

**Protocol shape.** A centrally-owned relay/server mediates a group session. The wallet's own output descriptor is run through PBKDF2 to derive two things at once: a **group-wallet ID** and a **symmetric session key**. Initial exchange uses NaCl public-key authenticated encryption (Curve25519/Salsa20/Poly1305); ongoing group chat and PSBT/data exchange switch to NaCl secret-key authenticated encryption (Salsa20/Poly1305) under that derived key. Join is via invite link, QR, or pasted wallet link. Built-in chat carries spend coordination with configurable auto-delete.

**Predecessor (Matrix-based) model**, for contrast: Bitcoin wallet/tx state rode as custom Matrix event types (`m.relates_to` graph linking init → join → sign → broadcast), keys in BSMS format, PSBTs base64-encoded inline or — once over Matrix's 64KB event cap — pushed out as encrypted media uploads. Encryption was entirely Matrix's Olm/Megolm; Nunchuk defined no crypto layer of its own.

**Trust assumptions.** The relay/homeserver is centrally owned by Nunchuk. It cannot read message content when E2EE is engaged, but it does see group/session membership, timing, and metadata. Recovery depends on the BSMS file (wallet config) being retained independently of the encrypted channel.

**Failure modes.** Relay-down = no coordination (no self-hosted fallback documented). Explicit cancel events exist for both wallet-creation and signing flows. No documented handling of Byzantine or malicious-server behavior beyond "server can't read your content."

**Verdict vs. Cairn.** The strongest server-assisted model reviewed, and the reason FEDERATION-SCOPE.md §11 calls it out by name. Structurally incompatible with Cairn's peer-to-peer/sovereign requirement because it depends on a shared, centrally-owned relay — exactly what Cairn's star-topology, no-relay design avoids. The descriptor→PBKDF2→session-key derivation technique, however, is transport-agnostic and worth lifting on its own (see §4).

Sources: https://github.com/nunchuk-io/docs/blob/main/e2ee-multisig.md, https://nunchuk.io/blog/group-wallet, https://www.nobsbitcoin.com/nunchuk-group-wallet/

### 1.2 Caravan (Unchained) — coordinator-less

**Protocol shape.** No server, no network transport at all. Caravan is a static web app that reads/writes a **wallet configuration file** (JSON: `addressType`, `network`, quorum, per-key `{xpub, bip32path, xfp}`). Every participant's tool independently reconstructs the identical multisig descriptor from that file — the same "silent rebuild, correlate by descriptor bytes" approach Bastion uses internally (FEDERATION-SCOPE.md §2). PSBTs move by file export/import, QR (BCUR/BCURv2 for air-gapped hardware), or SD card. PSBT v2 support and air-gapped xpub export were added via Ledger v2 / BCURv2 work.

**Trust assumptions.** None beyond "the file you were handed is the file the coordinator built" — there's no channel authentication at all; verification is entirely on the receiving party to check the descriptor/fingerprints themselves.

**Failure modes.** None specific to a transport, since there isn't one — failure modes are purely sneakernet ones (stale file, wrong file, lost USB stick).

**Verdict vs. Cairn.** Not a coordination protocol so much as an interchange-format standard. Its main relevance to Cairn is validating that the wallet-config JSON format Caravan popularized is the correct choice for the Recovery Kit export (FEDERATION-SCOPE.md Open Question 5) — it already functions as the de facto lossless multisig-config interchange format across the ecosystem (Sparrow, Specter, Coldcard, BitBox all round-trip it), independent of any coordination-protocol question.

Sources: https://www.unchained.com/blog/what-is-a-multisig-wallet-configuration-file, https://github.com/caravan-bitcoin/caravan, https://www.unchained.com/blog/gearing-up-the-caravan

### 1.3 Fedimint — contrast only (not a coordination model, a custody model)

**Protocol shape.** A federation of guardians (3m+1, tolerating m Byzantine/offline) runs AlephBFT — asynchronous BFT consensus, no leader election — to jointly custody funds and issue Chaumian e-cash notes. Users hold e-cash, not UTXOs; guardians collectively control the underlying multisig. Recent (2026) Fedi releases added Iroh networking specifically so federations can run without a public IP — solving the same home-NAT-traversal problem Cairn's transport section grapples with, but via a P2P overlay network rather than Tor.

**Trust assumptions.** Users trust the guardian quorum not to collude to steal or debase funds; the mint is blind to balances/transaction history (privacy-preserving) but is *not* blind to custody — a colluding guardian quorum has capital control.

**Failure modes.** Guardian collusion above the fault threshold = fund loss. This is the structural property, not a bug.

**Verdict vs. Cairn.** Confirms FEDERATION-SCOPE.md's rejection is correct on the merits, not just by assertion: Fedimint's guardian model is custodial by construction (pooled funds, threshold-controlled), which is categorically incompatible with "funds never travel between instances, nobody holds anyone else's money." The Iroh-for-NAT-traversal precedent is the one transferable idea, already captured in FEDERATION-SCOPE.md's transport table as a Phase 2+ option.

Sources: https://xmr.club/wallets/fedimint, https://blog.bitfinex.com/education/fedi-fedimint-decentralised-chaumian-e-cash-on-bitcoin/, https://www.gate.com/learn/course/introduction-to-bitcoin-layer-2s/federated-pooled-systems-fedimint-and-ark

### 1.4 Nostr-based PSBT coordination

No PSBT-specific NIP exists (confirmed — no standard found across NIPs repo or proposal threads).

- **Bitcoin-Safe** (BDK-based desktop wallet, OpenSats-funded) — the most concrete live evidence of Nostr actually carrying PSBTs in 2026. Uses Nostr's "Chat&Sync" feature: peer discovery, encrypted label/category sync across devices, encrypted chat, and one-click PSBT sharing for multisig participants, with relays storing encrypted messages for asynchronous pickup. This is closer to shipped/production than the other Nostr projects surveyed. Direct fetch of the collaboration page 403'd; detail is corroborated via search snippets and the project's GitHub (https://github.com/andreasgriffin/bitcoin-safe) rather than a primary-source read — **flagged as lower-confidence** on exact mechanics (chunking scheme, relay set, key derivation for the chat channel are all unconfirmed).
- **Munstr** — MuSig2 + Nostr terminal wallet, positioned around chain-analysis resistance. Thin project; no evidence of production maturity found.
- **Smart Vaults** (formerly Coinstr) — "multi-custody signature orchestration" protocol; had a testnet beta with a tester bounty. GitHub org is live (https://github.com/smartvaults) but nothing in the search results indicates it has graduated past beta. **Status flagged as unverified/stalled** — consistent with FEDERATION-SCOPE.md's characterization.
- **JoinStr** — CoinJoin (not multisig-signing) coordination over Nostr, 5-peer, no fidelity bonds. Notably, encrypted channels (NIP-38/48) were *planned* but, per the most recent information found, **not yet implemented** — meaning current JoinStr coordination happens in the clear over public relays. This is a concrete, named example of exactly the DoS/privacy gap FEDERATION-SCOPE.md's relay-transport skepticism warns about.
- **NIP-46 (Nostr Connect)** — closest existing standard, but it's a remote-signer RPC protocol (app↔signer), a different problem shape from peer-instance PSBT exchange. Not directly reusable.

**Verdict vs. Cairn.** Confirms FEDERATION-SCOPE.md's verdict: no PSBT NIP standard exists, relay size/delivery-guarantee limits are real (Bitcoin-Safe's own workaround — chunking via encrypted messages stored for async pickup — is evidence people are routing around the 128KB cap, not evidence the cap isn't a problem), and the ecosystem still treats Nostr as signaling/chat rather than a bulk PSBT pipe. Bitcoin-Safe shipping in 2026 is the one data point that has moved since the scope doc was written — see §6.

Sources: https://bitcoin-safe.org/en/features/collaboration/ (search-corroborated, fetch blocked), https://github.com/andreasgriffin/bitcoin-safe, https://www.nobsbitcoin.com/munstr-musig-nostr/, https://www.nobsbitcoin.com/smart-vaults-beta/, https://github.com/smartvaults, https://www.nobsbitcoin.com/joinstr-decentralized-coinjoin-implementation-using-nostr/, https://github.com/uncle-jj/JoinStr, https://nostr-nips.com/nip-46

### 1.5 Other prior art surveyed

- **Specter Desktop** — pure sneakernet coordinator (USB/QR/SD-card only), no network transport, JSON backup export. Confirms "sneakernet fallback everywhere" is the *baseline* posture across this entire tool category, not a fallback bolted onto a networked design. Sources: https://docs.specter.solutions/desktop/multisig-guide/, https://github.com/cryptoadvance/specter-diy
- **Bitcoin Keeper (BitHyve)** — non-custodial collaborative/inheritance multisig wallet. No protocol-level detail on instance-to-instance transport surfaced in research; appears to coordinate within a single app/account context rather than peer-instance federation. Not close enough prior art to inform F1/F4/F12 either way — **flagged as inconclusive**, not a negative finding. Source: https://bitcoinkeeper.app/
- **Start9 / LNbits** — per-app `.onion` addressing is standard practice on Start9 (supports feasibility of Cairn's Tor-default assumption), but nothing surfaced showing an authenticated *instance-to-instance protocol* comparable to Bastion's handshake — Start9's pattern is "reach your own instance remotely," not "two independent instances mutually authenticate and exchange signed data." Doesn't validate or contradict Bastion's handshake/token design either way. Sources: https://docs.start9.com/0.3.5.x/user-manual/connecting-tor.html, https://docs.start9.com/0.3.5.x/service-guides/lightning/connecting-lnbits.html
- **BDK** — no coordination crate exists in BDK itself; Bitcoin-Safe (§1.4) is the reference app that layers Nostr coordination on top of BDK's descriptor/PSBT primitives. Confirms Cairn's own `src/lib/server/bitcoin/psbt.ts` (`summarizePsbt`/`validateRecipientsAndFeeRate`) is the right layer to build F1 verification on — no library hands this over for free. Source: https://bitcoindevkit.org/blog/descriptors-in-the-wild/

---

## 2. Scope-doc judgments revisited

FEDERATION-SCOPE.md §11 made three calls that this survey was explicitly aimed at pressure-testing. All three survive:

- **"Nunchuk's model... not chosen because it depends on a shared relay/server."** Confirmed even under Nunchuk's newer, more sophisticated Group Wallet design (§1.1) — the PBKDF2-from-descriptor key derivation is elegant, but the architecture still routes every message through a centrally-owned relay that sees membership/timing metadata. The relay-dependence objection holds regardless of how good the encryption on top of it is.
- **"Fedimint... rejected... custodial... wrong trust model."** Confirmed with more precision than the original one-line dismissal: the guardian quorum isn't just "trusted," it has actual threshold capital control over pooled funds (§1.3) — categorically different from Cairn's "funds never travel between instances" invariant, not just a matter of degree.
- **"Nostr... bad as a PSBT pipe... good only as signaling/wakeup channel."** Confirmed. No PSBT NIP exists as of this survey. The one system that ships PSBT-over-Nostr in production (Bitcoin-Safe) works around the size/delivery limits rather than proving they aren't real, and JoinStr's *unimplemented* encrypted-channel roadmap is a concrete illustration of the cleartext-relay risk the scope doc flags generically.

No finding in this survey contradicts any FEDERATION-SCOPE.md design decision.

---

## 3. Adoption candidates

**Headline candidate — Nunchuk's descriptor→PBKDF2→session-key derivation, mapped onto D3.**
The core insight: *the wallet configuration participants already both hold independently is itself sufficient shared secret material* — no separate key-exchange ceremony needed, and the technique doesn't presuppose Nunchuk's relay architecture. FEDERATION-SCOPE.md's D3 (vault-manifest push, explicit accept, byte-identical descriptor verified on both sides) already produces exactly the shared, mutually-verified artifact this derivation needs as input. Concretely: once D3's manifest is accepted and the descriptor bytes match on both sides, both peers could derive a session/encryption key via PBKDF2 over the agreed descriptor — giving Phase 2's mandatory application-layer PSBT encryption (§8 of the scope doc) a derivation scheme that requires no additional handshake round-trip, layered on top of Cairn's own peer-to-peer ed25519 identity keys rather than a shared relay. This is a Phase 2 candidate for the D2/F12 encryption-mandatory transition, not an MVP change.

**Lower-confidence candidates, noted but not recommended for near-term adoption:**
- Bitcoin-Safe's async-pickup-via-relay chunking pattern — interesting as evidence Nostr-as-wakeup-signal is viable, but internals are unverified (§1.4) and the pattern is relay-dependent, which cuts against Cairn's peer-to-peer requirement the same way Nunchuk's does.
- Caravan's wallet-config JSON — already the intended Recovery Kit format per Open Question 5; this survey just corroborates it's the right choice, it isn't a new adoption idea.

---

## 4. Confirmed differentiators — do not dilute

- **F1 (independent PSBT verification).** Nothing surveyed does this rigorously. Nunchuk and Bitcoin-Safe both lean on the *transport* being trusted (E2EE room/relay) rather than requiring the receiving client to independently re-derive amounts/fees/change from its own locally-held descriptor before rendering anything to the user. Cairn's F1 design — verify from decoded PSBT bytes only, never trust the coordinator's claims — is stricter than any prior art found in this survey. Keep it as-is; there is no competitive pattern here to converge toward.
- **Tor-first, no-relay, star-topology transport.** No competitor surveyed defaults to this. Every server-assisted system (Nunchuk, Bitcoin-Safe) routes through a relay/homeserver; every relay-less system (Specter, Caravan) has no network transport at all. The nearest analog is Fedimint's Iroh-based NAT traversal (§1.3), which solves the same reachability problem but via a P2P overlay network, not Tor, and inside a fundamentally custodial system. Cairn's combination — no relay, no custody, Tor for NAT traversal and transport-level encryption at once — has no direct competitor analog in this survey. Keep it.

---

## 5. Phase-2 revisit triggers

- **Bitcoin-Safe shipping PSBT-over-Nostr in production (2026)** is the named trigger to re-evaluate Nostr as more than a wakeup/signaling channel for Phase 2+. It's the first system found in this survey that has moved Nostr-as-PSBT-transport from proposal to shipped software. If Bitcoin-Safe's chunking/delivery approach proves durable in the field (worth a follow-up check on relay size limits and delivery guarantees once primary-source docs are accessible — the collaboration page 403'd during this survey), it's the concrete precedent to reassess against, rather than the stalled Smart Vaults/Munstr projects.

---

## 6. Unverified / flagged

Preserved as flagged, not smoothed over:

- **Bitcoin-Safe internals** (exact chunking scheme, relay set, chat-channel key derivation) — could not fetch the primary source directly (403); detail is search-snippet-corroborated only.
- **Smart Vaults (ex-Coinstr) production status** — beta/testnet confirmed, graduation to production unverified.
- **Bitcoin Keeper instance-coordination internals** — no protocol-level detail surfaced; treated as inconclusive rather than a negative finding.
- **JoinStr's current encryption state** — "NIP-38/48 planned but not yet implemented" is based on the most recent information found in this survey; could have changed since.
- **Start9/LNbits instance-to-instance protocol** — no evidence found of an authenticated peer-to-peer protocol comparable to Bastion's; absence of evidence, not confirmed absence of any such feature.

---

*End of prior-art survey.*
