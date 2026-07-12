# UX Punch List -- 2026-07-12

UX elevation blueprint + visual audit delta, 2026-07-12, produced by the research/audit session for the UX orchestrator. P0s are marked visually-unverified pending a cookie-environment fix (see the Visual Audit Delta below).

---

# Cairn / Heartwood — UX-Elevation Blueprint

## How to read this

Cairn is **already a mature, unusually well-crafted app**. Loading, empty, success, and error states are designed on every screen I audited; SWR keeps navigation instant; mobile breakpoints are thorough; the multisig differentiator is well-surfaced. So this is not a "fix the broken UX" report — it's a "close the gap to Cash App / Muun / Strike for a non-technical user" report. The dominant theme is **progressive disclosure of Bitcoin internals** (sat/vB, derivation paths, xpub, and a heavy "rings/timechain" metaphor that in a few load-bearing places *replaces* the plain word a beginner needs), plus **the absence of fiat-denominated amounts in the money flows**.

---

## Part 1 — Best-in-class patterns (external research)

**Muun** ([coinspot](https://coinspot.io/en/reviews/muun-wallet/), [h17n](https://h17n.com/mobile-wallets/muun/)) — Two-button home (Send / Receive). Abstracts on-chain vs Lightning entirely; user never picks a "rail." Mempool-based fee estimator picks the fee *for* you; no rate exposed. Amounts entered/shown in the user's fiat by default with a BTC toggle.

**Phoenix** ([bitcoinproducts](https://www.bitcoinproducts.com/blog/phoenix-wallet-review), [areabitcoin](https://blog.areabitcoin.co/phoenix-wallet/)) — "The whole wallet is about two buttons – Receive and Send." Fees shown as a **fixed, absolute number before you confirm** (e.g. "0.4%, min 4 sats"), never as a rate to choose. Onboarding is a short path: write 12 words → fund → done.

**BlueWallet** ([fintechreview](https://fintechreview.net/bluewallet-review-from-newcomers-to-experts/), [gncrypto](https://www.gncrypto.news/news/bluewallet-review/)) — The *power-user* reference: a fee slider with sat/byte **plus** Slow/Medium/Fast **plus** a plain-time target ("10 min / 3 hours / 1 day") and a live recalculated total. On-chain vs Lightning txs visually distinguished. This is the closest model to Cairn's audience-of-self-hosters, and Cairn already matches most of it.

**Strike** ([bitdegree](https://www.bitdegree.org/crypto/strike-crypto-review), [coinspot](https://coinspot.io/en/reviews/strike-crypto/)) — Home surfaces balance + recent transactions, *no charts/market data by default*. Four verbs only: buy/send/receive/manage. Fees + speed shown before authorizing. Amounts entered in fiat. A "touch of humor + education" tone.

**Cash App** ([cash.app help](https://cash.app/help/31021-sending-and-receiving-bitcoin), [koinly](https://koinly.io/blog/send-bitcoin-cash-app/)) — Enter amount **in BTC or its fiat equivalent** (toggle), review estimated fee + speed before authorizing. Fresh receive address per transaction, explained as a privacy feature. Fee shown as an amount, never a rate.

**The five recurring principles:** (1) two verbs — Send/Receive — dominate the surface; (2) amounts live in **fiat** with a crypto toggle; (3) fees are an **absolute amount + a speed word**, never a rate a beginner must reason about; (4) confirmation/plumbing detail (rates, paths, txids, block internals) is hidden until tapped; (5) tone is plain and reassuring.

---

## Part 2 — Internal audit summary

**Already excellent (do NOT re-dispatch):** empty states (`No transactions yet / Send some sats…`), three-state portfolio (ready/first-sync/unreachable, never a fake zero), skeletons, retry affordances, the `Term` dotted-underline tooltip pattern for progressive disclosure, the typo-fee guard ("That's 12× the current fast rate…"), the irreversible-broadcast modal, plain-language fee ETAs ("~30 min to confirm"), backup nudges, multisig discoverability, wizard reload-resume, the "down is amber, never red" balance-delta choice.

**Where non-technical users hit friction:** the money-entry unit is BTC/sats with **no fiat entry**; **sat/vB is exposed by default** in the fee picker, the Review, and the speed-up forms; **derivation paths and xpub are shown by default** on Receive and wallet detail; and the **"rings/timechain" metaphor replaces the plain word** ("block", "confirmed") in several places a beginner must act on.

---

## Part 3 — Prioritized punch list

Legend: **[COPY]** = string/label change, cheap. **[STRUCT]** = layout/logic change. Wallet citations name the best-in-class exemplar.

### P0 — Confusing or blocking for a non-technical user

**P0-1 — No fiat-denominated amount entry in Send. [STRUCT]**
`src/routes/(app)/wallets/[id]/send/+page.svelte` (amount hero, `unit` state, `toggleUnit`, `rowSats`). The amount hero accepts **BTC or sats only**; placeholder is `0.00`. A beginner thinking in dollars who types "50" is trying to send 50 BTC. The balance-cap check ("That's more than this wallet holds") only catches it when it exceeds balance.
*Best-in-class:* Cash App and Strike enter amounts in **fiat**, converting to BTC under the hood; Muun defaults to fiat. *Proposed:* when fiat is enabled (the same opt-in `cairn.fiat` flag the Home hero already uses), add USD as a third entry unit in the hero unit-swap, show the live BTC/sats equivalent beneath, and echo the fiat value on Review. Keep the privacy stance (no price fetch until fiat is on). This is the single highest-leverage change for the stated audience.

**P0-2 — Fee shown as a rate (sat/vB), not an amount, at the point of choice. [STRUCT + COPY]**
Same file, Create step fee section (lines ~1107-1167). The three toggles read **"Low · 3 / Medium · 5 / High · 8"** and the caption is **"5 sat/vB · ~30 min to confirm"**. The absolute fee (what the user actually pays) is not shown until the *next* step (Review). A non-technical user cannot judge "3 vs 8 sat/vB."
*Best-in-class:* Phoenix and Cash App show the **absolute fee before you confirm**; BlueWallet pairs the rate with a live total. *Proposed:* compute and show the estimated **total fee in sats (and fiat if on)** under each tier on the Create step, lead with that number, and demote the raw sat/vB figure to a `Term` tooltip or a small "· 5 sat/vB" tail. Keep the excellent Low/Medium/High + "~30 min to confirm" framing.

**P0-3 — Confirmation status shown only as poetic ring-depth. [COPY]**
`src/lib/components/heartwood/BurialRings.svelte` → `burialRingsLabel()` returns `"no rings yet"` / `"buried 3 rings deep"` / `"sealed · six rings deep"`. This is the **only status text** a user sees for their own money's safety, on the wallet-detail tx rows (`src/routes/(app)/wallets/[id]/+page.svelte`) and the activity feed (`src/routes/(app)/activity/+page.svelte`, `metaFor`). "Buried 3 rings deep" does not tell a beginner whether their money is safe.
*Best-in-class:* Cash App/Strike show **"Pending" → "Completed"**; on tap, a plain "N confirmations." *Proposed:* lead every confirmation label with a plain status word — **`Pending` (0), `Confirming · N of 6` (1–5), `Confirmed` (6+)** — and keep the ring poetry as secondary texture or inside the tooltip. Cheapest possible fix: rewrite the three strings in `burialRingsLabel` to `"Pending"` / `"Confirming — N of 6"` / `"Confirmed"`. The ring *glyph* stays; only the words change. Keep the metaphor as flavor, not as the primary signal.

**P0-4 — Derivation path shown by default on the Receive panel. [STRUCT]**
`src/routes/(app)/wallets/[id]/+page.svelte`, Receive section (~line 673): renders `receive.path` (e.g. `m/84'/0'/0'/0/5`) in mono directly under the address.
*Best-in-class:* Muun / Cash App / Strike **never** show a derivation path on receive — it's noise that reads as scary. *Proposed:* remove the path from the default view; move it behind a small "Address details" `<details>` disclosure (alongside the existing path/index metadata). The QR + address + Copy + Rotate + "fresh address every time" copy are perfect as-is.

### P1 — Friction

**P1-5 — Speed-up (RBF/CPFP) asks a beginner to type a sat/vB rate. [STRUCT]**
`src/routes/(app)/wallets/[id]/+page.svelte`, `openBump`/`submitBump`/`openSpeedUp`/`submitCpfp`. The "Speed up" / "Bump fee" buttons are good plain language, but the form beneath is a raw `<input type="number">` labelled "New rate / Target rate · sat/vB." The seed already picks the live fast tier, so the input is usually needless friction — and a non-technical user has no basis to change it.
*Best-in-class:* Muun auto-bumps with one tap. *Proposed:* make the primary action a one-tap **"Speed it up"** using the pre-seeded fast rate (show the resulting new fee in sats/fiat), and hide the numeric rate box behind a secondary "Adjust rate" link. Keep the reassuring "Your original transaction is unchanged and still valid" copy.

**P1-6 — "Rings" replaces "block" in actionable Explorer/Activity references. [COPY]**
`src/routes/(app)/explorer/+page.svelte` ("Latest rings", "Rings below N", "ring N forming — X of 2,016", "blocks · not one removed") and especially `src/routes/(app)/activity/+page.svelte` where a block link reads **`ring segment 800000`**. A beginner cannot map "ring segment 800000" to "block 800000." The Explorer's own `HowItWorks` and the Home welcome tour both say "block," so this is internally inconsistent.
*Best-in-class:* every consumer explorer says **"block."** *Proposed:* keep the ring *visual* identity, but make the **primary noun "block"** wherever it's a clickable/actionable reference — change `ring segment {height}` → `block {height}`, "Latest rings" → "Latest blocks" (or "Latest blocks" with a ring glyph). You can keep poetic flavor in non-actionable captions ("one ring per difficulty epoch"). Lowest-risk, high-clarity.

**P1-7 — Send-success primary CTA is "Watch it get buried." [COPY]**
`src/routes/(app)/wallets/[id]/send/+page.svelte`, Sent step (~line 1796). The primary button after a broadcast is **"Watch it get buried"** (links to the explorer tx page); sub-copy says "waiting for its first ring… We'll nudge you at the first ring — and at six."
*Best-in-class:* Cash App/Strike say "View transaction" / "Track payment." *Proposed:* rename the CTA **"Track this transaction"** (or "View transaction"), and reword the nudge line to "We'll let you know when it confirms." The headline "0.5 BTC is on its way" is great — keep it. Keep the ring animation.

**P1-8 — xpub exposed inline on the wallet-detail hero. [STRUCT]**
`src/routes/(app)/wallets/[id]/+page.svelte` (~line 578): the sign-note line ends with a truncated `xpub` in mono. It's dimmed, but it's raw internals on the main wallet screen.
*Proposed:* move the xpub into the existing "Export config" section or a details disclosure; keep the friendly "Signs with your Trezor · Trezor wallet" part on the hero.

**P1-9 — Review step defaults to plumbing vocabulary. [COPY]**
Same file, Review detail list (~lines 1263-1300): "Network fee … · Y sat/vB · Z% of amount" and "**Total input**" shown by default. "Total input" is UTXO-speak; "% of amount" + sat/vB are power-user framings.
*Proposed:* keep "Network fee" but show it as **amount (+ fiat)** with the rate/percent behind a tooltip; rename "Total input" → "Total from your wallet" (or fold it into the collapsed "Coins being spent" disclosure, which is already correctly collapsed). "Change back to your wallet" is already good plain language.

**P1-10 — Multiple vocabularies for "pending." [COPY]**
Across screens the unconfirmed state is variously "on its way" (wallet hero), "in the mempool" + "no rings yet" (tx row), "no rings yet" (activity), "pending" (explorer). Four phrasings for one lifecycle state confuses a beginner building a mental model.
*Proposed:* standardize on one plain word — **"Pending"** — as the lead status everywhere, with the richer phrasing ("in the mempool," ring language) as secondary/tooltip. Pairs naturally with P0-3.

**P1-11 — Settings fiat is display-only and US-locked. [STRUCT, small]**
`src/routes/(app)/settings/+page.svelte` (~line 334): "Fiat display: USD · shown" is a static, non-editable row; the only unit control is BTC/sats.
*Proposed:* make fiat a real preference — an on/off (respecting the privacy stance) and a currency selector — and expose a "Show amounts in USD/BTC/sats" primary-unit choice. This is the settings-side enabler for P0-1. Even shipping just the on/off toggle here (mirroring the Home `cairn.fiat` key) is a cheap win.

### P2 — Polish

**P2-12 — Explorer landing is the densest jargon surface. [COPY/STRUCT]**
`src/routes/(app)/explorer/+page.svelte`: "The timechain," "mempool 12 vMB," "difficulty +2.1% in 5 days," "ring N forming — X of 2,016." It's flag-gated and has an explainer, so lower stakes, but for a non-technical user the default framing is opaque. *Proposed:* plainer default labels ("Blocks," "waiting to confirm," "how hard mining is right now"), with the technical terms available on tap. Lower priority than the money flows.

**P2-13 — Address-type badges assume the user knows script types. [COPY]**
`src/routes/(app)/wallets/labels.ts` `SCRIPT_TYPE_LABELS` ("Native SegWit / Nested SegWit / Legacy / Taproot") appear as bare badges on wallet detail and rows. These are correct but meaningless to a beginner. *Proposed:* wrap them in a `Term` tooltip ("the address format your wallet uses — newer formats have lower fees") wherever they appear as a primary badge.

**P2-14 — "vMB", "sat/vB" units unexplained. [COPY]** `src/lib/format.ts` `formatFeeRate`/`formatBytes` feed several surfaces. Where these appear on user (not admin) pages, pair the first occurrence with a `Term`.

**P2-15 — Signup password has no strength guidance. [COPY]** `src/routes/(auth)/signup/+page.svelte`: min-8 only. A one-line strength hint or meter would help. Minor; auth is otherwise clean and plain.

**P2-16 — "Export config" language on wallet detail vs wizard "Done" is inconsistent. [COPY]** Wizard Done says "Nothing to back up here"; wallet-detail Export section says "optional." Both are correct for single-sig but the two framings could align. Minor.

---

## Suggested dispatch grouping

- **Cheap copy sweep (one worker, [COPY]):** P0-3, P1-6, P1-7, P1-10, P2-13, P2-14 — all string/label edits in `BurialRings.svelte`, `activity/+page.svelte`, `explorer/+page.svelte`, `send/+page.svelte` Sent step, `labels.ts`. High clarity-per-effort; no logic risk. Standardize confirmation + pending vocabulary and de-jargon the ring/block references in one pass.
- **Fiat epic (structural, highest leverage):** P0-1 + P0-2 + P1-11 together — fiat entry in Send, absolute-fee-first fee picker, and the settings enabler. Reuses the existing `cairn.fiat` localStorage flag and `/api/price` already wired in `+page.svelte`.
- **Progressive-disclosure sweep ([STRUCT], low risk):** P0-4, P1-8, P1-9 — hide derivation path (Receive), xpub (wallet hero), and soften Review plumbing behind disclosures.
- **Speed-up simplification:** P1-5 standalone.

The two things I'd treat as non-negotiable P0s for the "non-technical self-hoster" goal are **fiat amounts in Send (P0-1)** and **plain confirmation status (P0-3)** — the first because the target user thinks in dollars, the second because it's the only signal telling them their money is safe.

---

# VISUAL AUDIT DELTA — live browser pass (supplements the code-based punch list)

## Coverage

Ran the `cairn-fresh` dev server (port 5199, isolated throwaway DB), registered a throwaway non-admin account (`audit@example.com`, minted a one-off invite in the disposable dev DB — no real credentials, no real data touched), which correctly mirrors the **target end-user's view** (no admin surface). Captured **desktop + mobile (375×812)** where reached.

**Screens captured and evaluated (screenshots seen):**
- Login — desktop + mobile
- Signup — desktop
- First-run terms/agreement gate — desktop
- Home: welcome tour — desktop
- Home: empty first-run — desktop + mobile
- Wallets: empty onboard chooser — mobile
- Add-wallet wizard, Step 1 "Key" — mobile

**Screens NOT reached visually (blocker, stated honestly):** wallet detail, Send, Receive, Activity, Explorer, Settings, multisig wizard, populated wallets/Home. Cause: **this preview environment drops the httpOnly session cookie on every full top-level `navigate`** (the cookie is only carried by `fetch`/SvelteKit client-router requests). Deeper pages whose `load()` re-checks auth server-side kept bouncing to `/login`. I created a real wallet (id 2, BIP84 test-vector zpub) via the wizard's own form-action API to reach its detail page, but the navigation still bounced. So my earlier P0/P1 items on those screens remain **code-confirmed only, not screenshot-verified** — I flag each below rather than claim visual evidence I don't have.

---

## NEW items found only in the visual pass

**V1 — Desktop primary nav is an icon-only rail with no text labels. [STRUCT] — propose P1.**
Confirmed by screenshot + zoom: the desktop left rail is a ~55px strip of stacked icons (logo-ring, grid, target, wallet, activity-squiggle, gear, a second ring-mark, a second squiggle, avatar) with **no visible text labels**. A non-technical first-timer cannot tell that the "target" icon is Explorer or what the ring-marks do, and two pairs of icons look nearly identical at that size. This is a sharp inconsistency with the **mobile** shell, which has an excellent labeled tab row (Home · Explorer · Wallets · Activity) — see the mobile Home screenshot. *Best-in-class:* Muun / Cash App / Strike all use **labeled** tabs. *Proposed:* add persistent text labels beside the rail icons (or an expand-on-hover label is insufficient for first-timers — prefer always-on labels on desktop ≥ the 940px content width), and differentiate the two look-alike icon pairs. File: `src/lib/components/heartwood/HWRail.svelte`.

**V2 — Add-wallet method list is a long mobile scroll before "Paste public key." [COPY/STRUCT] — P2.**
On mobile the Key step stacks: restore box → multisig hand-off card → Trezor → Ledger → ColdCard → BitBox02 → Jade → Air-gapped QR → **Paste public key** (last). A keyless beginner (the person most likely to *paste* an xpub from another app) must scroll past six hardware options first. *Proposed:* on mobile, surface "Paste public key" and "Connect a device" as the top two choices, or group the six device brands behind a single "Connect a hardware wallet" expander. File: `src/routes/(app)/wallets/new/+page.svelte` (`METHOD_CARDS`).

**V3 — Session cookie did not persist across full navigations in the preview. [INFRA/verify] — P2, possibly env-only.**
Observed: login/register succeed and `fetch` stays authenticated, but full top-level page loads arrive unauthenticated (httpOnly cookie not sent). This is most likely a preview-proxy SameSite artifact and **not necessarily a product bug** — but it is the exact failure mode the login page already guards against (`COOKIE_ERROR`, the plain-HTTP Umbrel case). Worth a deliberate test of the session cookie's `SameSite`/`Secure` attributes on a real plain-HTTP deployment. Files: cookie config in `src/lib/server/auth.ts` / session layer. Do not act on this as a UX item without reproducing outside the preview.

---

## Confirmations (screenshots corroborate earlier claims / "already strong")

- **Onboarding + empty states are genuinely polished, not just adequate.** Login, signup, the agreement gate, and both first-run empty states (Home, Wallets) render as clean, high-contrast, generously spaced, single-primary-CTA screens. Emotional read: **premium and trustworthy, not sketchy or overwhelming.** No hierarchy or readability problems on any captured screen. This validates the report's framing — treat this as elevation, not rescue.
- **The agreement gate is a model first-run screen** ("Before you continue / NOT A CUSTODIAN / YOUR BACKUPS ARE YOUR RESPONSIBILITY" + single checkbox). Plain, honest, expectation-setting. No change needed.
- **The concentric-ring "Heartwood" logo is a coherent, attractive brand mark** (login/signup/rail). This *strengthens* my earlier nuance on the ring metaphor (P0-3/P1-6): keep rings as **brand/logo texture**, but still stop "rings" from replacing the functional words "block"/"confirmed." The visual identity earns the metaphor; the functional labels don't.
- **P1-6 inconsistency seen on screen:** the Home welcome-tour tile literally reads "Explorer — Browse blocks, transactions, and addresses" (plain "blocks"), which visually confirms the clash with the Explorer page's own "rings/timechain" chrome. The plain word already wins in the tour; make the Explorer match it.
- **Mobile-first hierarchy is excellent:** the orange primary CTA carries a subtle glow and is unmistakably the primary action on every mobile screen; the labeled tab row is clear. Alex's mobile-first testing bias is well served on the screens I saw.

---

## Items I could NOT visually verify (do not claim screenshot evidence)

These remain **code-confirmed only** — the money screens never rendered due to the cookie blocker. They should be visually re-checked when the environment allows, but the code reading is unambiguous on each:
- **P0-1** fiat amount entry in Send — the amount hero unit-swap is BTC↔sats only in code; not seen rendered.
- **P0-2** fee shown as sat/vB rate not amount — Create-step fee toggles; not seen rendered.
- **P0-3** confirmation labels ("buried N rings deep" / "sealed") — on wallet-detail tx rows + Activity; not seen rendered.
- **P0-4** derivation path on the Receive panel — not seen rendered.
- **P1-5** speed-up sat/vB entry, **P1-8** xpub on wallet hero, **P1-9** Review "Total input" wording — not seen rendered.

---

## Net re-ranks

- **Add V1 (icon-only desktop nav) as a new P1** — it's a real first-timer legibility gap I'd have missed on code alone, and it's a cheap CSS/markup fix.
- **No downward re-ranks.** The visual pass did not reveal any earlier item as overstated; if anything the onboarding polish confirms the "elevation not rescue" framing.
- **No upward re-ranks of the P0s** — but note they are now explicitly *unverified visually*; the fiat-entry and confirmation-label P0s should be the first two things screenshotted in a follow-up pass once the session-cookie environment issue is resolved, since they are the two highest-leverage claims and the only ones I could not put eyes on.

**One continuous recommendation for the next visual pass:** run it against a deployment where the session cookie persists across navigations (or drive the whole flow through SvelteKit client-router link clicks, which I verified keeps auth), and lead with Send → Receive → wallet-detail so the P0 money-flow items get the screenshot evidence this pass could not obtain.
