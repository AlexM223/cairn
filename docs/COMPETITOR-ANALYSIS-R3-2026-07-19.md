# Competitor Analysis — Round 3 — Solo-mining landscape, Umbrel/Start9 app-store shelf, self-hosted wallet suites, positioning verdict

**Date:** 2026-07-19
**Status:** RESEARCH (web research current as of 2026-07-19; items that could not be primary-source verified are flagged inline)

**Delta vs R1/R2.** R1 (docs/COMPETITOR-ANALYSIS.md) profiled BlueWallet, Sparrow, Nunchuk, and Ocean in depth (incl. TIDES mechanics and legal posture — see R1 §4 rather than re-reading Ocean here). R2 (docs/COMPETITOR-ANALYSIS-R2-2026-07-19.md) covered Zeus, Green, Envoy/Passport, Liana, Casa/Bitkey, and the "good Umbrel citizen" UX bar (Alby Hub/LNbits/mempool — see R2 §5). **This round covers what neither touched: the solo-mining pool/software landscape (Public Pool, solo.ckpool, AtlasPool, Bassin, BASED, DATUM Gateway, Braiins, Bitaxe/AxeOS/NerdMiner, Stratum V2 status), the actual Umbrel/Start9 mining+wallet app-store shelf Heartwood competes on, a wallet-suite feature matrix vs Specter/Caravan (absent from R1/R2), and — new in this round — a positioning map with an explicit verdict on the "only product combining wallet + multi-user solo pool + explorer" uniqueness claim, threat scenarios, and a ranked 10-action list.** Key new finding: self-hosted Public Pool already implements per-address coinbase for any connecting miner, which narrows (but does not kill) the uniqueness claim — details in §1 below.

**Companion docs:** docs/HASH-ATTRACTION-STRATEGY.md (market economics, fee table, segments), docs/MINING-POOL-SCOPE.md, MANUAL.md (feature ground truth).

Heartwood baseline used for comparison (v0.2.42): self-hosted SvelteKit app on Umbrel; single-sig + multisig (BIP-48, Caravan-compatible) wallet with Trezor/Ledger/BitBox02, coin control (`CoinControl.svelte`/`onlyUtxos`), address+tx labels and address book, RBF/CPFP fee bumping, collaborative custody (owner/viewer/cosigner), notifications/SMTP, built-in block explorer, live SSE updates; multi-user SOLO mining pool (Stratum v1, per-connection coinbase paying each miner's own wallet, best-share leaderboard, public pool stats, dual difficulty ports 3333/3334); local Bitcoin Core + Electrum only, zero third-party API calls.

---

## A. Solo-mining pools & software

| Product | Fee | Hosting | Multi-user? | Coinbase custody | UI / stats | Min hardware | Notes |
|---|---|---|---|---|---|---|---|
| **Public Pool** | 0% (hosted and self-hosted) | Both: hosted web.public-pool.io + one-click Umbrel/Start9 app | **Yes** — any miner connects with own BTC address as stratum username; block reward pays that address | Non-custodial (coinbase pays the finder's address) | Web UI (separate public-pool-ui repo): hashrate, per-worker stats, best difficulty; no accounts, no wallet | Any Stratum v1 ASIC (Bitaxe-first crowd) | NestJS/TypeScript, ~440 stars, active. 4 confirmed blocks, **all from self-hosted Umbrel instances** (latest #937,218, Feb 2026, 3.14 BTC). A 2% figure circulates for a multi-coin "public-pool.io" operation [solominer.com — likely a different/forked operation; official hosted + self-hosted are 0%]. https://apps.umbrel.com/app/public-pool ; https://github.com/benjamin-wilson/public-pool ; https://blockdyor.com/public-pool-review/ |
| **solo.ckpool.org** | 2% | Hosted only | Yes (address-as-username) | Non-custodial | Bare stats pages; no accounts, no leaderboard product | Any Stratum ASIC; no node needed | The reference solo lottery: 299 confirmed solo blocks / 5,553 BTC since 2014 (ckpool lineage), 40+ since mid-2023; geo endpoints with failover (US/EU/Asia/Oceania). Zero self-host UX, zero social layer. https://solo.ckpool.org/ ; https://www.solosatoshi.com/best-solo-mining-pool/ |
| **OCEAN + DATUM Gateway** | 2%, 1% with DATUM | Hosted pool; DATUM Gateway self-hosted (Umbrel + Start9 apps) | Yes (pool) | Non-custodial above 0.01048576 BTC threshold; carry-forward ledger below (de-facto custody for small miners) | Polished pool dashboards; TIDES transparency ledger (mechanics: R1 §4.1) | Gateway runs on Pi 5 / mini-PC / Umbrel next to a full node (Knots recommended) | DATUM = miner builds own block templates against own node but still gets pooled TIDES payouts — the closest ideological competitor to "sovereign mining," and it smooths variance, which Heartwood cannot. https://ocean.xyz/docs/datum ; https://github.com/OCEAN-xyz/datum_gateway ; https://apps.umbrel.com/app/datum |
| **Braiins Pool / Braiins OS(+)** | 2% FPPS (0% effective pool fee when mining via Braiins OS firmware); Lightning payouts | Hosted | Yes | Custodial (FPPS treasury) | Best-in-class dashboards, fleet management | ASICs; Braiins OS targets Antminers (+ open-source builds for Bitaxe-class) | Only top-ten pool with **production Stratum V2**; authored the SV2 spec. Moat = firmware autotuning tie-in, not sovereignty. https://braiins.com/pool ; https://academy.braiins.com/en/braiins-pool/stratum-v2-manual/ |
| **AtlasPool** | 1.5% (block subsidy only) | Hosted only, no self-host | Yes | Non-custodial (solo model) | Proprietary closed-source UI; 8 anycast endpoints, TLS | Any Stratum ASIC | Launched late 2025, zero blocks yet; competes on latency/infra polish for the same lottery segment. https://www.solosatoshi.com/best-solo-mining-pool/ |
| **Bassin (Umbrel app)** | 0% | Self-hosted (wraps ckpool in Docker) | ckpool solo semantics (address-as-username) | Non-custodial | Separate Bassin UI; hobby-grade; README: "for academic and research purposes only" | Umbrel box + ASIC | 34 stars / 64 commits — a wrapper, not a product. https://github.com/duckaxe/bassin ; https://apps.umbrel.com/app/bassin |
| **BASED Mining Pool** | 0%, "hybrid payout" | Umbrel community app store (official store submission pending) | Unclear | Unclear ("hybrid payout" implies some pooled ledger) | Own web UI | Umbrel box + ASIC | New 2026 entrant; watch it — "hybrid payout" on a self-hosted Umbrel pool is the closest anyone has come to Heartwood's (legally gated) split-mode idea. Details thin [needs re-check before citing externally]. https://community.umbrel.com/t/introducing-based-mining-app/25294 |
| **Solo Satoshi / Bitaxe ecosystem (AxeOS)** | n/a (hardware + firmware) | On-device firmware | n/a | n/a | AxeOS: browser dashboard per device, no telemetry/cloud/accounts; **AxeOS Swarm** = multi-device fleet dashboard | Bitaxe ~1.2 TH/s (~$150) up to NerdQaxe++ ~4.8–6 TH/s | The demand side of Heartwood's market, not a competitor — but Swarm + third-party monitors are absorbing the "dashboard" job. 5+ confirmed blocks won by Bitaxe/NerdQaxe-class hardware through late 2025, more in 2026. https://www.solosatoshi.com/axeos-guide/ ; https://www.solosatoshi.com/what-is-bitaxe/ |
| **NerdMiner community** | n/a | ESP32 devices (~kH/s) | n/a | n/a | Tiny screens, meme-tier odds | ~$30 | Educational/gateway tier; funnels people toward Bitaxe then toward node-based mining — free top-of-funnel for Heartwood content. https://d-central.tech/bitaxe-vs-nerdaxe-comparison/ |

**Protocol context (mid-2026):** only Braiins and DEMAND (DMND, launched Nov 2025) run Stratum V2 natively in production, but seven majors (~75% of network hashrate: Foundry, Antpool, F2Pool, SpiderPool, MARA, Block, DMND) joined the SV2 Working Group in May 2026; the SRI group projects V2 as default in new ASIC firmware by end-2026. Heartwood is SV1-only; the SRI Translation Proxy bridges V1 hardware to V2 pools (and vice-versa scenarios matter for us — see Threats). https://www.coindesk.com/markets/2026/05/11/bitcoin-mining-pools-with-75-of-btc-hashrate-join-open-standard-for-block-construction ; https://d-central.tech/data/stratum-protocol-matrix/

## B. Umbrel / Start9 app-store landscape

Mining-adjacent apps on Umbrel today: **Public Pool**, **Public Pool's Web** (hosted-UI companion app), **DATUM**, **Bassin**, **BASED** (community store), plus monitoring-only apps **MinerSentinel** (Bitaxe/Avalon Nano fleet dashboard: performance, health, profitability) and **Bitaxe Sentry** (stats + alerts). https://apps.umbrel.com/category/bitcoin ; https://apps.umbrel.com/app/miner-sentinel ; https://community.umbrel.com/t/list-of-mining-pool-apps/23511

Wallet-side apps on Umbrel: **Specter Desktop** (the only real wallet-suite app in the store), **BTCPay Server** (merchant processor, not a personal wallet), **Electrs/ElectrumX/Fulcrum** (servers that external desktop wallets connect to), **Mempool** (explorer app), Lightning apps (Alby Hub, LND, LNbits — R2 §5 covers their UX patterns). **Sparrow and Nunchuk are NOT Umbrel apps** — the documented pattern is "run Electrs on Umbrel, connect Sparrow/Nunchuk/Specter desktop over LAN/Tor"; no Sparrow-via-VNC app found in the official store. https://apps.umbrel.com/app/specter-desktop ; https://community.umbrel.com/t/guide-connect-umbrel-to-your-wallet/7653 ; https://apps.umbrel.com/app/electrs

Start9: marketplace has Bitcoin Core/Knots, BTCPay, electrs, **DATUM Gateway**, Alby Hub; Start9 documents connecting external wallets (Sparrow, BlueWallet, Zeus) to your server rather than hosting them. No multi-user mining pool app beyond community-packaged Public Pool. https://marketplace.start9.com/ ; https://docs.start9.com/0.3.5.x/service-guides/bitcoin/bitcoin-integrations ; https://community.start9.com/t/public-pool-fully-open-source-public-bitcoin-mining-pool-as-an-app/1767

**Landscape read:** the app stores are full of *single-purpose* pieces — a pool daemon here, an explorer there, an Electrum server for a wallet that lives on your laptop, a separate monitor for your Bitaxe fleet. Nobody ships the assembled product. Heartwood's real app-store competitor is not any one app; it is the *combination* "Bitcoin Core + Electrs + Mempool + Public Pool + MinerSentinel + Sparrow-on-laptop" — exactly the multi-app chore Heartwood collapses into one install.

## C. Self-hosted wallet suites

| Feature | **Heartwood** | Sparrow | Specter Desktop | Nunchuk | Liana | Caravan (Unchained) |
|---|---|---|---|---|---|---|
| Form factor | Self-hosted web app (Umbrel) | Desktop app | Desktop/server web app (Umbrel app exists) | Mobile-first + desktop | Desktop app (+ Liana Connect hosted backend) | Stateless browser app |
| Multisig | Yes (BIP-48, sortedmulti, Caravan round-trip) | Yes (to 9-of-9) | Yes (its core purpose) | Yes (2-of-3/3-of-5 focus) | Miniscript policies (primary + timelocked recovery paths) | Yes (stateless coordinator) |
| Hardware wallets | Trezor, Ledger, BitBox02 (browser/WebUSB + HTTPS listener) | Very broad (USB + airgap QR/SD) | Broad, airgap-first | Broad incl. NFC (Tapsigner/Coldcard) | Ledger, Coldcard, Specter DIY, BitBox02 (tap-miniscript/taproot as of Liana 7.0+) | Ledger, Trezor, Coldcard |
| Coin control | **Yes** (`onlyUtxos`, reservation-aware) | Yes (gold standard) | Yes | Yes | Limited (policy-driven) | Minimal |
| Labels | Yes (address/tx labels + address book) — **no BIP-329 import/export found** | Yes + **BIP-329 export/import** | Yes | Yes (+ encrypted sync) | Basic | No (stateless) |
| PSBT flows | Full (draft → sign → finalize → broadcast; file flows; shared CPFP/RBF engine) | Full, best-in-class | Full | Full incl. remote co-signer relay | Full | Full (its whole job) |
| Collaborative custody | **Yes, self-hosted**: owner/viewer/cosigner tiers, share links, notifications | No (manual file/QR passing) | No | Yes, but via **Nunchuk's servers/subscription** (Honey Badger/Byzantine tiers, inheritance — R1 §3) | Via Liana Connect (hosted by Wizardsardine) | Unchained's paid business sits on top |
| Backend | Your Bitcoin Core + Electrum, zero third-party APIs | Your node or public servers | Bitcoin Core | Nunchuk servers or own Electrum | Own node or Liana Connect | **mempool.space API by default** or own node |
| Block explorer | **Built in** | No (external links) | No | No | No | No |
| Mining | **Built-in multi-user solo pool** | No | No | No | No | No |
| Taproot | Receive-only; **no p2tr spend, no tr() multisig** (MANUAL §11) | Yes | Partial | Yes (single-sig) | Yes (taproot miniscript) | Partial |
| Maintenance risk | Active (this repo) | Active; bus-factor-one (single maintainer) | Slow but alive (v2.1.x releases; small team) | Active, product-funded | Active (Wizardsardine) | Active (Unchained-funded OSS) |

Sources: https://knowingbitcoin.com/sparrow-vs-nunchuk-vs-specter-multisig-coordinators/ ; https://thebitcoinhole.com/software-wallets/sparrow-vs-specter ; https://thebitcoinhole.com/software-wallets/liana-vs-sparrow ; https://nunchuk.io/individuals ; https://wizardsardine.com/blog/liana-7.0-release/ ; https://github.com/cryptoadvance/specter-desktop/releases ; https://unchained-capital.github.io/caravan/ ; https://blockdyor.com/nunchuk-review/

**Wallet-suite read:** on pure wallet features Sparrow beats Heartwood (coin-control depth, BIP-329, Taproot, device breadth) — but Sparrow is a *single-user desktop app with no server, no accounts, no collaboration*. Heartwood's true peer group for "multi-user, always-on, self-hosted" is only Specter Desktop (aging, no collaboration tiers) and Nunchuk (collaboration, but through *their* cloud with subscription pricing). Nobody else does self-hosted collaborative custody with role tiers on your own box.

---

## 1. Positioning map + uniqueness verdict

Two axes that actually separate the field: **integration breadth** (single-purpose daemon → full command center) and **sovereignty** (hosted/custodial → self-hosted/non-custodial).

- Hosted + custodial: Braiins, FPPS majors.
- Hosted + non-custodial: solo.ckpool, AtlasPool, OCEAN (above threshold), hosted Public Pool.
- Self-hosted + single-purpose: Public Pool app, Bassin, DATUM Gateway, Electrs, Mempool app, Specter (wallet-only), MinerSentinel (monitor-only).
- **Self-hosted + integrated (wallet + pool + explorer + accounts): Heartwood, alone.**

**Verdict on the uniqueness claim — HOLDS, with one required narrowing.** No product found combines a full wallet suite + multi-user solo pool + block explorer in one self-hosted Umbrel app; the assembled equivalent is 4–6 separate apps plus a laptop wallet. **BUT the pool mechanic alone is not unique:** self-hosted Public Pool already lets any number of miners connect with their own BTC addresses and pays the finder's address directly in the coinbase — functionally a multi-user solo pool with per-address coinbase, at 0% fee, with 4 real blocks found on Umbrel instances. So never market "the only multi-user solo pool with per-connection coinbase" — market the *integration*: user accounts, wallet-landing, leaderboard, notifications, explorer, and custody tiers wrapped around that mechanic. Also watch BASED (self-hosted hybrid-payout pool, details thin) as the nearest-motion competitor.

## 2. Differentiation (what nobody else has)

1. **The block reward lands in a wallet the same app manages.** Every other pool pays an address string; Heartwood closes the loop — find a block, watch it mature (available-vs-maturing split UX, `maturingTotal`), spend it via PSBT with your hardware wallet, all in one product on one box. No competing pool even has a wallet.
2. **Users as first-class objects.** Public Pool/ckpool know addresses; Heartwood knows *people* — auth (passkeys + password), per-user wallets, cosigner roles, per-user SMTP notifications. That is the substrate the "solo mining with friends" social layer needs and which address-keyed pools structurally lack.
3. **Self-hosted collaborative custody with role tiers** (owner/viewer/cosigner) — Nunchuk sells this through their cloud; Sparrow/Specter don't have it; Heartwood does it on your node with no subscription.
4. **Verifiable social layer around mining:** best-share leaderboard + public pool stats + an explorer that can attribute your own shares and blocks — ckpool's lottery with a scoreboard and a press kit (HASH-ATTRACTION-STRATEGY §5.3).
5. **Zero third-party calls doctrine** (Core + local Electrum only) — stronger than Caravan (defaults to mempool.space) and than any hosted pool by definition.

## 3. Table-stakes gaps (honest)

| Gap | Who has it | Severity |
|---|---|---|
| **Taproot spend + tr() multisig** (receive-only today; `'Spending from p2tr wallets is not supported yet'`) | Sparrow, Nunchuk, Liana | High — reads as "incomplete wallet" to exactly the power users we court |
| **Stratum V2** (SV1 only) | Braiins, DEMAND native; 75%-of-hashrate working group; SRI proxy exists | Medium now, High by 2027 as firmware defaults flip |
| **BIP-329 label import/export** (labels exist, no portable format) | Sparrow (reference implementation) | Medium — cheap, high credibility signal |
| **Variance smoothing of any kind** (no PPLNS/TIDES/split; split-mode gated on cairn-l1zu.1) | OCEAN TIDES, Braiins FPPS, BASED "hybrid" | High for income miners — but out of scope by strategy; don't chase FPPS |
| **Mobile app / installable PWA** | Nunchuk (mobile-first), Braiins app | Medium — responsive web exists; no app-store presence |
| **Airgap signing breadth** (QR/SD flows; Coldcard/Keystone/SeedSigner) | Sparrow, Specter, Nunchuk | Medium — USB trio covers the mainstream, not the airgap sovereignty crowd |
| **Miniscript / timelock recovery & inheritance** | Liana (core product — R2 §4), Nunchuk (paid) | Low-Medium — future "custody for families" differentiator |
| **Fleet monitoring depth** (per-device temps/power/efficiency à la MinerSentinel/AxeOS Swarm) | MinerSentinel, Bitaxe Sentry, AxeOS Swarm | Medium — miners will run a second app and Heartwood loses the dashboard job |
| **DATUM-style external template serving** (Heartwood's templates serve only its own pool) | DATUM Gateway | Low — different philosophy; ours pays the miner directly |
| **Lightning / payments** | BTCPay, Alby Hub, Braiins LN payouts | Low — explicit non-goal; keep it that way |

## 4. Threats

- **Public Pool adds a UI/accounts layer.** Mechanic parity already exists; if its active community adds users/leaderboards, Heartwood's pool story compresses to "nicer paint." Mitigation: ship the social/verifiable layer (leaderboard cairn-192dr, public stats cairn-19o5e, press kit cairn-7msai) *first*, and keep wallet integration as the moat — they'd have to build an entire wallet suite to follow.
- **Umbrel ships or blesses an official mining bundle** (e.g. promotes Public Pool + Bitaxe Sentry, or an umbrelOS mining feature). Our distribution advantage evaporates on our own channel. Mitigation: be the best-reviewed mining app in the store before that happens; multi-store presence (docs/START9-PLAN.md); own the Bitaxe onboarding content funnel.
- **OCEAN/DATUM captures the sovereignty narrative** with real payouts + smoothing at 1% — "own node, own templates, still paid monthly" beats "own node, paid never (statistically)" for anyone income-motivated. Mitigation: never fight on income; lottery + social + zero-custody framing (HASH-ATTRACTION-STRATEGY §1); federation later.
- **Stratum V2 firmware default flip (end-2026 per SRI projections)** brands an SV1-only pool "legacy" in reviews, even though Bitaxe-class hardware will speak V1 for years. Mitigation: verify SRI-translation-proxy compatibility now (cheap); native SV2 as a deliberate epic.
- **BASED or a successor normalizes self-hosted hybrid payouts** while Heartwood waits on the legal gate (cairn-l1zu.1). No action needed yet — but if hybrid payouts become table stakes on Umbrel, the legal gate becomes the critical path and should be re-prioritized with counsel.
- **A maintained Sparrow-server/web fork lands on Umbrel.** Low probability (bus-factor-one, desktop architecture), but it would attack the wallet half directly. Specter is the current occupant and is drifting, not advancing.

## 5. Top 10 recommended actions (ranked)

1. **Reposition all copy off "only multi-user solo pool" onto "the only pool where the block reward lands in a wallet the same app manages"** — folds into existing positioning bead cairn-g7eqi. (bead)
2. **BIP-329 label export/import** for single-sig + multisig — parity with Sparrow, cheap credibility with exactly our audience. (bead)
3. **Ship the verifiable best-share leaderboard + public stats page** (existing beads cairn-192dr, cairn-19o5e) — the anti-Public-Pool moat; top pool priority. (beads, already filed)
4. **Bitaxe/NerdQaxe onboarding wizard + guide** (existing bead cairn-8tfek), explicitly covering AxeOS setup and the dual 3333/3334 difficulty ports — this segment buys from Solo Satoshi and reads their pool comparisons. (bead)
5. **SV2 compatibility test + statement:** verify an SRI translation-proxy / SV2-capable firmware in V1 mode works against Heartwood's stratum; document in MANUAL + marketing ("SV2-proxy compatible today"). (bead; native SV2 support = separate EPIC, defer)
6. **Taproot spend support for single-sig p2tr wallets** (close the `'not supported yet'` throw; tr() multisig stays deferred). (EPIC — descriptor, PSBT, HW-signing surface)
7. **Per-worker fleet cards in /mining** (uptime, hashrate, best-diff per connection; later temps/power where reported) so users don't need MinerSentinel alongside — defend the dashboard job. (bead for stats cards; telemetry depth = small EPIC)
8. **Start9 packaging** (existing plan docs/START9-PLAN.md) — second store, DATUM-adjacent audience, near-zero product change. (EPIC, plan exists)
9. **Solo-win celebration + verifiable press kit** (existing bead cairn-7msai) — every ckpool/Bitaxe block win is a news cycle; be the pool whose wins are self-verifying. (bead)
10. **Airgap QR signing for multisig PSBTs** (SeedSigner/Keystone/Jade-class; JadeQrSigner plumbing exists) — widens the sovereignty-crowd device matrix beyond USB. (small EPIC; scope one device as the first bead)

Explicitly *not* recommended: FPPS/PPLNS payout chasing (custodial treasury, wrong fight), Lightning integration (non-goal), DATUM-style external template serving (different product), native mobile apps before PWA polish.

---

## Source index

Pools/market: https://apps.umbrel.com/app/public-pool ; https://github.com/benjamin-wilson/public-pool ; https://blockdyor.com/public-pool-review/ ; https://www.solosatoshi.com/best-solo-mining-pool/ ; https://solo.ckpool.org/ ; https://ocean.xyz/docs/datum ; https://github.com/OCEAN-xyz/datum_gateway ; https://apps.umbrel.com/app/datum ; https://braiins.com/pool ; https://academy.braiins.com/en/braiins-pool/stratum-v2-manual/ ; https://github.com/duckaxe/bassin ; https://community.umbrel.com/t/introducing-based-mining-app/25294 ; https://www.solosatoshi.com/axeos-guide/ ; https://www.solosatoshi.com/what-is-bitaxe/ ; https://d-central.tech/bitcoin-mining-pool-comparison-2026/ ; https://d-central.tech/bitaxe-vs-nerdaxe-comparison/
Stratum V2: https://www.coindesk.com/markets/2026/05/11/bitcoin-mining-pools-with-75-of-btc-hashrate-join-open-standard-for-block-construction ; https://d-central.tech/data/stratum-protocol-matrix/ ; https://solofury.com/blog/stratum-v2-vs-v1/
App stores: https://apps.umbrel.com/category/bitcoin ; https://apps.umbrel.com/app/specter-desktop ; https://apps.umbrel.com/app/miner-sentinel ; https://community.umbrel.com/t/list-of-mining-pool-apps/23511 ; https://marketplace.start9.com/ ; https://docs.start9.com/0.3.5.x/service-guides/bitcoin/bitcoin-integrations ; https://community.start9.com/t/public-pool-fully-open-source-public-bitcoin-mining-pool-as-an-app/1767 ; https://community.umbrel.com/t/guide-connect-umbrel-to-your-wallet/7653
Wallets: https://knowingbitcoin.com/sparrow-vs-nunchuk-vs-specter-multisig-coordinators/ ; https://thebitcoinhole.com/software-wallets/sparrow-vs-specter ; https://thebitcoinhole.com/software-wallets/liana-vs-sparrow ; https://nunchuk.io/individuals ; https://blockdyor.com/nunchuk-review/ ; https://wizardsardine.com/blog/liana-7.0-release/ ; https://github.com/cryptoadvance/specter-desktop/releases ; https://unchained-capital.github.io/caravan/

*Research time-boxed 2026-07-19; hosted-service fees, app-store listings, and SV2 adoption figures drift — re-verify before external/marketing use. Items marked [needs re-check] were not primary-source confirmed.*
