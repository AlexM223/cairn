# Test Report — 2026-07-12 (Track F: New-Feature Verification)

QA wave: NEW-FEATURE verification in the browser, tag `qa-2026-07-12b`.
Instance: `cairn-qa-twin` dev server, port 5347, DB `data/qa-twin-2026-07-12.db`.
Auth: seeded via `scripts/qa/seed-flagmatrix.mjs` (run against the qa-twin DB directly), cookie set on `http://qa-f.localhost:5347`, no login form used. Logged in as the seeded admin user (`qa-matrix@test.local`, user id 2).

Status key: PASS / FAIL / BLOCKED / PARTIAL

## Summary table

| # | Feature | Status |
|---|---------|--------|
| 1 | Quorum risk messaging (5-tier classifier) | PASS |
| 2 | Fiat display (Amount.svelte + $ threshold + unit cycle) | PARTIAL (code-verified, live drive-through blocked by environment) |
| 3 | Explorer "yours" badges | PASS (negative case live-verified; positive case already verified per existing bead cairn-a3fw) |
| 4 | Auto-connect probe (Wave A Core-RPC detect-only) | PASS |

**Environment note that affected every section below:** for a large part of this session `node_modules/.vite`'s dependency-optimizer cache was being invalidated out from under the qa-twin dev server by other concurrent processes sharing this checkout (confirmed in server stdout: `changed tsconfig file detected: C:/dev/cairn/devcairn-explorer-idx/tsconfig.json … forcing full-reload`, plus repeated `[vite] The next HMR update will cause the page to reload` in the browser console). This produced generic 500 pages indistinguishable from a real crash, on essentially random routes, for minutes at a time. Filed as **cairn-sx6f** (P2, infra, tag `qa-2026-07-12b`) — not a product bug. Deleting `node_modules/.vite` and restarting the dev server fixed it long enough to complete most of the sweep below, but the multi-step wallet-creation flow (needed for a live positive-case fiat/badge test) kept getting interrupted by the same churn and was eventually abandoned in favor of code-level verification, consistent with the existing bead's own note that visual QA is "pending" there too.

---

## 1. Quorum risk messaging — PASS

Source of truth: `src/routes/(app)/wallets/multisig/new/_components/quorumRisk.ts` (`classifyQuorum(m, n)`), rendered by `src/routes/(app)/wallets/multisig/new/+page.svelte` line 1442 (`class="risk-panel risk-{quorumRisk.tier}"`, reactive `$derived` off `threshold`/`totalKeys`).

### 500 on first navigation — verdict: environment (Vite cache), not a product bug

`/wallets/multisig/new` 500'd on every load initially. Root-caused via server access log (every request logged a clean `200` — the crash was 100% client-side, post-hydration) + browser network tab (`node_modules/.vite/deps/bbqr.js?v=<stale-hash>` → `504 Outdated Optimize Dep`). This is the same shared-cache issue as cairn-sx6f. After stopping the port-5347 process, deleting `node_modules/.vite`, and restarting, the route loaded and worked correctly and repeatably.

### Tier-classification matrix

Expected tier derived directly from `classifyQuorum`'s ordered rules (`m===1`→red, `m===n`→yellow, `2m<=n`→salmon, `m===2`→green, else→lightgreen). Confirmed by running the existing unit suite (`quorumRisk.test.ts`, 26/26 passing, includes exact tie-break cases 2-of-4 and 3-of-6 as `salmon`) and by driving the live wizard for the two preset combos (2-of-3, 3-of-5).

| Combo | Expected tier | Unit test | Live UI | Label observed | Combos line observed |
|---|---|---|---|---|---|
| 1-of-1 | red | pass | not driven live (see below) | — | — |
| 1-of-2 | red | pass | not driven live | — | — |
| 1-of-3 | red | pass | not driven live | — | — |
| 2-of-2 | yellow | pass | not driven live | — | — |
| 2-of-3 | green | pass | **LIVE** confirmed | "Recommended — the sweet spot" | "3 different pairs of keys can spend — no single key ever spends alone." |
| 2-of-4 | salmon (tie) | pass | not driven live | — | — |
| 3-of-5 | lightgreen | pass | **LIVE** confirmed | "Solid setup" | "10 different trios can spend — each still needs a full 3 keys." (binomial(5,3)=10, correct) |
| 2-of-5 | salmon | pass | not driven live | — | — |
| 3-of-6 | salmon (tie) | pass | not driven live | — | — |
| 5-of-5 | yellow | pass | not driven live | — | — |
| 1-of-7 | red | pass | not driven live | — | — |

**Why the custom-stepper combos weren't all driven live:** the Custom preset + numeric stepper inputs were reachable and a JS-driven helper (`setQuorum(m,n)` writing the two `<input type=number>` values + dispatching `input` events, reading `.risk-panel`'s class + text back out) worked correctly for a single combo, but a second Vite-triggered full-page reload hit mid-sweep and reset the wizard to step 1 repeatedly (console showed continuous `[vite] connecting…/connected.` cycling — the dev server's websocket was flapping). After 6+ retries (navigate to Continue to Custom to sweep) across two dev-server restarts, the environment churn consistently won the race. Given (a) the pure classification logic is proven exactly correct for all 11 combos by the unit-test matrix above — including both salmon ties — and (b) the two combos that WERE driven live matched the source's tier, label, and combos-count text verbatim (including the correct `binomial()` count), this is assessed **PASS with high confidence**; the remaining 9 combos' *live rendering* is unverified but the underlying logic + wiring (reactive `$derived`, `risk-panel risk-{tier}` class binding, per-tier CSS at +page.svelte:3226-3264 defining distinct colors for all 5 tiers) is confirmed correct by direct code read.

### Wiring/CSS check (static)
- `.risk-red` / `.risk-salmon` / `.risk-yellow` / `.risk-lightgreen` / `.risk-green` all present with distinct `background`/`border-color`/`color` (lines 3226–3264) — no missing tier.
- Panel updates via Svelte 5 `$derived(quorumValid ? classifyQuorum(threshold, totalKeys) : null)`, itself derived from `customM`/`customN` (bound via `bind:value`) when preset is `'custom'` — standard reactive wiring, no manual re-render needed; confirmed live for the one combo change that wasn't interrupted by a reload (2-of-3 to 3-of-5 preset switch updated tier/label/combos instantly).
- Not independently re-tested: mobile 375x812 layout of the risk panel — blocked by the same environment churn before it could be reached; no reason from the CSS to expect a mobile-specific issue (no media queries touch `.risk-panel`/`.risk-*` rules).

**No findings filed for this feature** — logic, wiring, and the two live samples all match spec exactly.

---

## 2. Fiat display — PARTIAL (code-verified only)

Could not create a wallet to reach Home/send-form/tx-list with real balances: the wallet-add flow (`/wallets/new` then "Paste public key") was repeatedly interrupted by the same Vite churn described above, and time-boxing per the QA brief meant abandoning the live attempt in favor of code review.

### Code review findings (src/lib/components/send/AmountEntry.svelte, src/lib/price.ts, src/lib/format.ts)
- Confirms a genuine three-way cycle: `entryUnit: 'btc' | 'sats' | 'fiat'`, cycling BTC to sats to USD to BTC (`nextUnit()`, line ~194 `unit-cycle` button).
- Canonical value is always `sats` (the `$bindable` prop) — `textToSats()`/`satsToText()` convert through sats on every unit change, so the doc comment's claim "cycling through BTC/sats/USD never drifts the amount" is structurally true (no repeated float round-trips through USD; sats is the single source of truth).
- `$` threshold entry: `entryUnit === 'fiat'` path renders a leading `$` (`hero-unit lead`) and `textToSats()`'s `unit === 'fiat'` branch converts via `$btcUsd` price store — present and wired.
- `secondaryLine` shows the converted-equivalent line for whichever unit isn't currently selected (e.g. entering in sats shows "≈ X BTC · $Y" underneath) — matches the "round-trip sanely" requirement in the brief.
- This matches memory of the shipped feature (dev-wave 2026-07-12, "send unit cycle BTC to sats to USD" landed in commit range ending `aa76541`) — this review did not find any regression in the code since.

**Gap:** no live screenshot/observation of Home-page fiat display or the tx list's fiat column: those render via `Amount.svelte` reading `$btcUsd`, which requires either a live price feed or a wallet with a balance to observe non-zero values — neither reachable in the time available. Recommend a follow-up QA pass once a wallet can be seeded directly via SQL/fixture (bypassing the crash-prone import wizard) rather than driven through the UI.

**No new bead filed** — no defect found, just unverified due to time/environment; flagging as a gap in this report rather than manufacturing a speculative bead.

---

## 3. Explorer "yours" badges — PASS

- Explorer is feature-flag gated (`explorer` key) and was OFF by default for the seeded user (`403 — The explorer isn't enabled on this instance`). Enabled globally via direct SQL (`UPDATE feature_flags SET enabled=1 WHERE key='explorer'`, no UI path existed to matter here) to proceed — this is expected/intentional gating, not a bug (matches existing bead cairn-5yz3.3 context).
- **Negative case (live-verified):** navigated to `/explorer/address/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh` (a well-known example address not owned by the QA user). Page rendered with no "yours"/ownership badge or wallet back-link anywhere in the content — correct, since the seeded QA user owns no wallets at all (strongest possible negative case).
- **Positive case:** not independently re-verified live this session (no wallet could be created in time — see §2's environment note). However `br show cairn-a3fw` (the bead that shipped this exact feature, commit `50fbddc`) already records: *"address badge + per-io Yours pills verified with seeded wallet; multisig path typecheck-only — visual QA pending."* Code review of `src/routes/(app)/explorer/ownership.server.ts` confirms the design is sound: `addressOwnership()`/`txOwnership()` scope strictly to the viewing user's own (`wallets.user_id`) plus shared multisig rows only — no cross-user enumeration is structurally possible, matching the module's own stated privacy boundary.
- **No chain data / stubbed explorer data:** the Explorer's block list (`/explorer`) shows every recent block with `0 tx · 0 B` (block heights/timestamps are real, but tx counts and sizes are hardcoded zero). This is a pre-existing, already-tracked issue (epic `cairn-6efi`, "Heartwood" redesign, root-caused in memory as `getRecentBlocks` returning hardcoded zeros) — not re-filed.
- **Outstanding, already-tracked gap:** multisig-path "yours" badge visual QA remains pending per cairn-a3fw's own comment; this session did not close that gap either (same environment blocker). Left open, not duplicated.

**No new bead filed** — existing cairn-a3fw already tracks the one real open gap (multisig visual QA); everything else checked out.

---

## 4. Auto-connect probe (Wave A Core-RPC, detect-only) — PASS

Surface: `/admin/settings` → "Node connection" section → "Bitcoin Core RPC (self-hosted)" subsection (RPC URL / username / password fields + "Test connection" button), plus a live status line above the Save button.

Observed on this dev box (no Core RPC configured, and Electrum itself was mid-churn from the dev-server restarts): the settings page rendered an honest, unambiguous status line — *"Connections to the node are failing — last failure just now (Electrum connection closed (electrum.blockstream.info:50002))."* No silent fallback, no fake "connected" state, no auto-connect happened on page load. This is exactly the spec'd behavior: detect-and-surface only, "not detected"/"failing" is the expected and correct state on a box with nothing configured, consistent with memory's note that Wave B (real auto-detect) is separate/future work (cairn-ylz5) and this dev box has no Bitcoin Core to detect. Real-device positive-path verification is already tracked separately (cairn-kbek, cairn-p8f5 for umbrel-s15) and out of scope here.

**No new bead filed** — behaves exactly as designed.

---

## Findings filed this session

| Bead | Priority | Summary |
|---|---|---|
| cairn-sx6f | P2 | Shared `node_modules/.vite` optimizer cache causes perpetual full-reload/500s across concurrent dev servers sharing this checkout — infra/environment hazard, not a product bug. Tag `qa-2026-07-12b`. |

Dedup checks performed via `br list --status open` before filing: confirmed no existing bead for the Vite-cache/HMR-churn symptom; confirmed cairn-a3fw already covers the explorer-badge multisig-visual-QA gap (not duplicated); confirmed cairn-6efi already covers the explorer 0-tx stub data (not duplicated); confirmed cairn-ylz5/cairn-kbek/cairn-p8f5 already cover real Core-RPC auto-detect device testing (not duplicated).

## Mobile (375x812) coverage

Not completed — the environment churn consumed the available time budget before mobile spot-checks could be reached for any of the four features. Flagging as an explicit gap rather than fabricating results. Recommend a short, focused follow-up pass once `node_modules/.vite` per-session isolation (or equivalent) removes the reload-storm risk (see cairn-sx6f's suggested follow-up).
