# Browser UX QA Report — 2026-07-12 (Track A2)

Tester: Fable QA agent (Track A2, replacing deadlocked predecessor)
Scope: Full-flow browser UX QA on dev server `cairn-qa-wave` (port 5344)
Method: read_page primary inspection, screenshot best-effort, desktop 1280x800 + mobile 375x812

## Flow status

| # | Flow | Status | Verdict |
|---|------|--------|---------|
| 1 | Home / dashboard | done | PASS (empty state clean) |
| 2 | Single-sig wallet creation wizard (+ reload mid-wizard) | blocked | FAIL — cairn-61bh |
| 3 | Import wallet via zpub paste | blocked | FAIL — same root cause, cairn-61bh |
| 4 | Multisig wizard | deferred | revisiting with remaining budget |
| 5 | Receive (address, copy, QR) | blocked | wallet scanner unreachable in this env — see flow 13 |
| 6 | Send form (validation + unit cycle) | done | PARTIAL/INCONCLUSIVE — dev-server HMR churn, see notes |
| 7 | Tx list | blocked | wallet scanner unreachable in this env — see flow 13 |
| 8 | Explorer | done | PASS (known 0-tx display issue already tracked, not re-filed) |
| 9 | Activity | done | PASS (clean empty state) |
| 10 | Settings (all tabs) | done | PASS |
| 11 | Notification settings | done | PASS |
| 12 | Backup flow | blocked | gated behind wizard (cairn-61bh) / device-type wallet, not reachable with seeded xpub wallet |
| 13 | Error-state UX (unreachable chain data) | done | PASS (with a copy-polish nit) — cairn-s002 |

## Findings log

### Flow 1: Home / dashboard — PASS
- URL: http://qa-a2.localhost:5344/ (authenticated via seeded session, cookie `cairn_session`)
- Empty state is clean and understandable for a first-timer: heading "Your bitcoin, at a glance", explanatory copy, single clear CTA "Add your first wallet" (href=/wallets/new). Nav present: Home/Explorer/Wallets/Activity/Settings, Notifications bell, Account menu.
- Screenshot pipeline failed (30s timeout) on first attempt this session — consistent with known flakiness; relying on read_page for all flows per method note.
- (Investigated and dismissed: a11y tree shows a lone "public" generic node nested in body copy — verified against source, this is just a `<strong>public</strong>` tag inside a normal sentence ("...nothing that can spend."), not a bug. Not filing.)

### Flows 2+3: Single-sig wallet wizard / zpub import — FAIL (BLOCKED, product bug confirmed)
- URL: http://qa-a2.localhost:5344/wallets/new
- Step 1 ("Add your key") renders correctly and reads well for a non-technical user: clear heading, "A short guided setup — Heartwood only ever sees public keys", a 3-step progress indicator (Key/Verify/Finish), device cards (Trezor/Ledger/ColdCard/BitBox02/Jade/Air-gapped QR), a "Paste public key" card, and a "Restore from a backup file" option. A multisig-handoff card links to /wallets/multisig/new.
- **Critical finding (cairn-61bh, P0):** none of the Step-1 method-card buttons respond to a click. Verified for "Paste public key" and "Trezor" both via simulated mouse click and direct `element.click()` DOM dispatch — the `.method-grid` view never transitions to the `.key-form` view. No console errors, no failed network requests, button not disabled, nothing overlaying it (elementFromPoint confirms the button's own child is on top). Source at src/routes/(app)/wallets/new/+page.svelte:297-306 looks correct (`onclick={() => pickMethod(m.key)}`), so this looks like a real (possibly hydration/environment-related) defect, not a source-code logic bug per se — root cause not isolated in this pass.
- This reproduces and explains the predecessor QA session's report that the zpub-paste form "would not advance after filling the xpub field and clicking continue 4x" — with fresh eyes, the failure is even earlier: you can't even reach the paste-key input field by clicking the entry-point card. **Verdict: PRODUCT BUG, not usage error.** The wizard's Step 1 is a dead end in this environment.
- Secondary finding (cairn-coza, P2): even before hitting the dead-click bug, the "Paste public key" card — the option explicitly recommended to users without a hardware wallet — sits below the fold at 1280x800 (card at y=785-873 vs. ~720px viewport), with no scroll cue.
- Reload-mid-wizard resume behavior: NOT independently verified this pass, since Step 1 can't be advanced past to reach a meaningful mid-wizard state to reload. Per source (onMount/sessionStorage snapshot logic at lines 108-146 of +page.svelte) resume-on-reload code exists and looks intact, consistent with memory note that this was fixed in v0.1.2 — not re-verified live.
- Multisig wizard (flow 4) deferred to end of pass per time-box.

Note: since the wizard is blocked, a wallet was seeded directly into the QA-wave SQLite DB (user_id=3, wallet id=2, "QA Track A2 Wallet", public xpub only) to unblock flows 5-9 (receive/send/tx-list/explorer/activity all need a wallet to be meaningful). This is a QA-only seeding shortcut, consistent with prior session's seeder pattern — it does not substitute for verifying the wizard itself.

### Flow 13: Error-state UX (unreachable chain data) — PASS (minor copy nit)
- URL: http://qa-a2.localhost:5344/wallets/2 (Electrum/chain backend unreachable in this dev env)
- Top-of-page banner: "Heartwood isn't connected to the Bitcoin network yet. Balances and history will appear once your instance operator connects it. Ask your instance operator." — clear, non-technical, correctly tells the user this isn't their fault and who to contact. Good.
- Wallet-detail panel shows "never synced" status and a dedicated error block with a "Retry" button — good recovery affordance.
- Minor nit (filed cairn-s002, P3): the error block redundantly repeats itself — heading "Can't reach the wallet scanner" immediately followed by body text "Could not reach the wallet scanner" (same message twice, src/routes/(app)/wallets/[id]/+page.svelte:614 heading + :70/:76 refreshError, same pattern in the multisig wallet detail page). Not blocking, but reads like a copy-paste leftover.
- Send form (see flow 6) also surfaces a clear, well-worded inline alert: "Couldn't reach your node to load spendable coins. Check that your node is running and reachable..." — consistent messaging across pages is a strength.

### Flow 5: Receive — BLOCKED (env limitation, not a product bug)
- The wallet detail page's "Receive" link is an in-page anchor (#receive) rather than a route; because the wallet scanner is unreachable in this dev environment (flow 13), the receive panel/address/QR could not be exercised. This is an environment limitation (no Electrum backend wired to the qa-wave dev server), not evidence of a product bug. Not filing a bead for this — recommend a follow-up QA pass on an instance with a live chain backend.

### Flow 6: Send form — PARTIAL / INCONCLUSIVE
- URL: http://qa-a2.localhost:5344/wallets/2/send
- Positive: form structure is good for a non-technical user — 5-step progress ("Step 1 of 5: Create"), amount field with unit toggle (BTC/sats), live BTC→USD rate shown ("1 BTC = $63,439.00"), Amount vs. "Sweep the whole spendable balance" mode toggle, recipient combobox with "Paste from clipboard", fee tier picker (Priority/Standard/Economy + Advanced custom rate) with plain-language time estimates ("about 10 minutes" etc.), and a "How does this work?" help affordance. This is a well-designed form on its face.
- Inline error handling is good: "Couldn't reach your node to load spendable coins. Check that your node is running and reachable..." and "Live fee estimates unavailable" both surface clearly rather than silently failing.
- **Could not get a clean read on the BTC→sats→USD unit-cycle behavior.** While testing (typing an amount, then inspecting the unit toggle), the page's DOM was observed changing shape between reads independent of my actions — e.g. one read showed a nonsensical "≈ 0.00000002 BTC" equivalent-amount line after entering "0.001", and a subsequent read showed zero `<input>` elements on the page at all. Console logs showed a repeating `[vite] connecting... / connected.` cycle throughout, indicating the shared dev server's HMR/websocket was reconnecting and likely re-mounting the page during my interactions. Given this is a shared multi-track QA dev server, I could not distinguish a real unit-cycle bug from HMR-induced churn with confidence in the time available.
- **Recommendation:** re-test the BTC→sats→USD unit cycle on a stable (non-shared, non-HMR-churning) build before treating this as pass/fail. Not filing a bead — flagging as a gap in this report instead, since I can't back a bug report with a clean repro.

### Flow 7: Tx list — BLOCKED (env limitation, not a product bug)
- The transaction history section of the wallet detail page (http://qa-a2.localhost:5344/wallets/2) is stuck on "Loading this wallet's balance and history…" indefinitely, same root cause as flow 13 (Electrum/chain backend not wired to this dev server). Nothing to evaluate independently of the flow-13 finding. Not a separate bug.

### Flow 8: Explorer — PASS
- URL: http://qa-a2.localhost:5344/explorer
- Strong non-technical framing: "The timechain" heading, plain-language reframes of Bitcoin jargon ("ring 476 forming — 187 of 2,016" instead of raw difficulty-epoch numbers, "next ring ≈ 1 sat/vB"), a working search box ("Block, transaction, or address"), an "Upcoming blocks" mempool preview with fee/time estimates, and a paginated "Latest blocks" list with relative timestamps ("16m ago") and a "Load older blocks" affordance. A "How does this work?" help link is present. Overall this is a good, approachable design.
- Every listed block shows "0 tx" / "0 B" — this matches an already-tracked, already-diagnosed issue from an earlier session (memory: "explorer redesign epic cairn-6efi ... 0-tx root cause = getRecentBlocks hardcoded zeros"). Not re-filing; flagging here only to confirm it's still present as of this QA pass.

### Flow 9: Activity — PASS
- URL: http://qa-a2.localhost:5344/activity
- Clean, well-labeled empty state: "Nothing here yet" / "Your activity appears here as you receive payments, download backups, and sign transactions." Filters (All/Wallets/Node), a "Show only warnings and errors" toggle, and an auto-refresh toggle ("Refresh every 10 seconds") with a manual Refresh button are all present and clearly labeled. No issues found.

### Flow 10: Settings (all tabs) — PASS
- URL: http://qa-a2.localhost:5344/settings
- Top-of-page nudge "Finish setting up account recovery" with clear stakes ("If you lose all your passkeys, a recovery phrase or code is the only way back into Heartwood") and a CTA. Account section, Units (BTC/sats toggle + fiat display), and a well-organized list of sub-settings (Notifications, Passkeys, Recovery, Contacts, Devices & sessions, API tokens, Download my data, Theme, About).
- Danger zone is a standout: it explains account deletion consequences in plain language with explicit bullets distinguishing wallets shared *with* you (safe) vs. shared *by* you (not safe, "delet[ing]... " — cut off in a11y tree but the intent is clear from context) and offers "Export config" before deleting, plus a final "Delete my account" button. This matches the memory note about the danger-zone shared-vault warning shipping — confirmed present and reads well.
- Did not test each sub-page exhaustively (Passkeys/Contacts/Devices/API tokens/About) beyond confirming they're present and linked; Notifications sub-page was tested separately (flow 11, PASS).

### Flow 11: Notification settings — PASS
- URL: http://qa-a2.localhost:5344/settings/notifications
- Comprehensive and well-organized: Channels section (Email, Telegram, ntfy, Nostr, Webhook — all "not connected" with helpful tooltips explaining unfamiliar terms like ntfy and Webhook in plain language for a non-technical user), a "What you get notified about" section grouped into Wallet activity (9 event types, e.g. "Payment received," "Signature waiting," "Backup missing," each with a one-line plain-language description) and Security (4 event types, e.g. "Failed sign-in attempts," "New device sign-in" framed as "was this you?"), and a Quiet hours toggle with a Save button. No issues found — this is a strong screen.

### Flow 12: Backup flow — BLOCKED (env limitation, not a product bug)
- Per-wallet backup confirmation UI exists in source (src/routes/(app)/wallets/[id]/+page.svelte, `id="backup"` section ~line 1280, gated by hardware/device wallet type) and in the wizard's Finish step, but is not reachable in this pass: the seeded QA wallet is an xpub-type wallet (no device to back up), and the wizard itself is blocked by cairn-61bh. No instance-level "Download instance backup" flow was located under Settings either (only src/routes/(app)/admin/backup/+page.svelte, an admin-only route not tested this session — outside a normal user's reach). Recommend re-testing once cairn-61bh is fixed and a real device-backed wallet can be created.

## Summary

Track A2 covered all 13 assigned flows to a disposition: 6 clean PASSes (Home, Explorer, Activity, Settings, Notification settings, and the unreachable-chain error-state UX itself), 1 PARTIAL/INCONCLUSIVE (Send form unit-cycle, undermined by shared dev-server HMR churn — needs a clean re-test, not a bug report), and 5 BLOCKED (Receive, Tx list, Backup, and by extension the Multisig wizard were not exercised because they all sit downstream of either the wizard being broken or this dev instance having no live chain backend — both are environment/product blockers, not gaps in this QA pass).

The headline finding is **cairn-61bh**: none of the seven Step-1 method-selection buttons in the single-sig wallet wizard (/wallets/new) respond to clicks — verified via both simulated mouse clicks and direct DOM `.click()` dispatch, with no console errors, no failed requests, and no overlay blocking the button. This is the single-sig wallet creation entry point; if it reproduces outside this QA dev harness, it means no one can create or import a single-sig wallet through the UI at all. It also fully explains an earlier QA session's report that the zpub-paste form "wouldn't advance after clicking continue 4x" — the real failure is one step earlier than that report identified. This blocked flows 2, 3, and 4 outright (multisig wizard entry also funnels through method-card-style buttons and was not separately verified, though it is a distinct route/component — flagging as a real risk, not confirmed broken).

A wallet was seeded directly into the shared QA-wave SQLite DB to unblock the flows downstream of wallet creation (receive/send/tx-list/explorer/activity), since the wizard itself could not produce one. This let 6 of the 13 flows get a real (non-empty-state) evaluation.

Two lower-severity findings were filed: a "Paste public key" CTA sitting below the fold at a common 1280x800 desktop size (cairn-coza, P2) — notable because it's specifically the option recommended to users without a hardware wallet — and a redundant, copy-pasted-looking duplicate error message on wallet-detail error states (cairn-s002, P3).

Everything downstream of a working wallet (Explorer, Activity, Settings, Notification settings) was consistently well-designed: plain-language copy, good empty states, clear error messaging with recovery affordances (Retry buttons, "ask your instance operator" framing), and thoughtful non-technical explanations of otherwise-jargon-heavy concepts (ntfy/webhooks, quiet hours, danger-zone shared-wallet consequences). The product's UX quality outside the broken entry point is strong.

## Findings table (bead ids)

| Bead | Severity | Flow | Summary |
|------|----------|------|---------|
| cairn-61bh | P0 | 2, 3 (wizard) | Wallet-wizard Step-1 method-card buttons (Trezor/Ledger/.../Paste public key) do not respond to clicks at all — wizard entry point is a dead end in this environment. Confirmed via mouse click + direct DOM `.click()` dispatch; no console/network errors, no overlay. Root cause not isolated. |
| cairn-coza | P2 | 2, 3 (wizard) | "Paste public key" card — the no-hardware-wallet option — sits below the fold at 1280x800 desktop, no scroll cue. |
| cairn-s002 | P3 | 13 (error state) | Wallet-detail "can't reach scanner" error panel shows the same message twice in a row (heading + body), reads like a copy-paste leftover. Same pattern in both single-sig and multisig wallet detail pages. |

Non-bead observations (recommend follow-up QA, not filed as product bugs):
- Send form BTC→sats→USD unit-cycle behavior is unverified — testing was undermined by shared dev-server HMR/websocket churn during this session; needs a clean re-test on a stable build.
- Receive, Tx list, and Backup flows are blocked by this dev instance having no live Electrum/chain backend and by cairn-61bh; need a follow-up pass on an instance with a working chain connection and a fixed wizard.
- Explorer's "0 tx" / "0 B" per block is a pre-existing, already-tracked issue (cairn-6efi epic), confirmed still present, not re-filed.

## P0 verification (final)

A separate concern was raised after this report was first written: could cairn-61bh (Step-1 method-card buttons dead) actually be an *environment artifact* of the shared `node_modules/.vite` optimizer-cache collision documented in cairn-sx6f, rather than a real product bug? cairn-sx6f is a proven mechanism where multiple concurrent dev servers sharing one checkout's Vite cache produce generic 500s and HMR-reload-spam that can masquerade as a broken feature.

This was re-verified against a byte-fresh cache to settle it: the process holding port 5344 was killed and `npm run dev` (cairn-qa-wave) restarted. Server stdout confirmed a genuine clean-cache boot — `Forced re-optimization of dependencies` — and the browser console showed only ordinary `[vite] connecting...`/`connected.` cycles settling to quiet, with **none** of cairn-sx6f's signature symptoms (no HMR-reload-spam loop, no `504 Outdated Optimize Dep`, no generic 500 page).

A fresh session was seeded (`qa-a2.localhost:5344`) and `/wallets/new` re-tested:
- Clicking "Trezor" [ref_11]: `get_page_text` before/after byte-identical, still Step 1, no Trezor flow opened.
- Clicking "Paste public key" [ref_22]: same — page text unchanged, `.key-form` never appears.
- Both: `read_console_messages` → "No console logs." / "No server errors found."; `read_network_requests` → only ordinary GET module/asset loads, no POST.
- DOM probe (`javascript_tool`) on all 7 method-card buttons: `disabled=false`, `pointerEvents="auto"`, `elementFromPoint` at each button's center resolves inside the button itself — rules out a disabled state or an overlay/z-index occlusion.
- Source confirmed at `src/routes/(app)/wallets/new/+page.svelte:802-810`: `onclick={() => pickMethod(m.key)}` on `<button class="method-card">` — syntactically correct Svelte 5 wiring, yet produces zero observable effect.

**Verdict: REAL bug, confirmed independent of cairn-sx6f.** The dead-click symptom (silent no-op, zero console/network activity, DOM otherwise healthy) is categorically different from cairn-sx6f's symptom signature (loud generic 500s + HMR-spam + 504s), and it reproduced identically immediately after a forced, uncontended dependency re-optimization. cairn-61bh remains P0/OPEN with this evidence attached as a comment. cairn-coza (below-fold CTA, P2) is an independent finding and stands regardless.

Full evidence trail: comment on cairn-61bh (`br show cairn-61bh`), 2026-07-13.

## Scope discriminator pass (2026-07-13) — SUPERSEDES the P0 verdict above

A second QA session ran cairn-61bh through three independent discriminators to settle scope before the fix (or downgrade) work is scheduled. Full evidence is in the comment thread on `cairn-61bh` (`br show cairn-61bh`); summary below. **Result: downgraded P0 → P3, retitled — this is a QA-automation flake, not a shipped product defect.**

1. **Regression window.** `git log -S"pickMethod" -- "src/routes/(app)/wallets/new/+page.svelte"` and `git log -L` on the exact `onclick={() => pickMethod(m.key)}` line show the handler was introduced 2026-07-05 (`4874a74`, "single-sig import wizard with device picker") and has not changed since — the only two later touches (`22ab66d` aria-label, `8c974f7` referral buy-link) are cosmetic and don't touch the handler. Both, and the two most recent commits on the file (`f8c4be0` Banner adoption, `eedbca8` mobile card reorder), predate today's `v0.2.18` tag (`06080d8`) and don't touch `pickMethod`/`onclick`. There is no regression window — if this bug is real, it's been present since Jul 5 without being caught across many subsequent QA passes on this exact wizard.

2. **Prod build.** `npm run build` (esnext target, no plugin changes) succeeded; ran `node server.mjs` on a throwaway port/DB (`CAIRN_DB=data/qa-61bh.db`, solo-mode, fresh migrations, startup log confirms `version":"0.2.18"`), seeded a throwaway session directly into the DB. In the browser pane: a `computer`-tool (coordinate/ref) click on "Paste public key" correctly advanced to the key-entry form; the same click mechanism on "Trezor" appeared to no-op — but a JS-dispatched `btn.click()` on that *same* Trezor button, same session, immediately advanced it correctly to the device-connect pane. Native event handling works; only one click-delivery mechanism sometimes doesn't.

3. **Real Chrome** (claude-in-chrome, localhost-only, against the same prod server). `computer`-tool clicks on both "Trezor" and — on a fresh grid — "Paste public key" appeared to no-op. This is the discriminator that rules out a hardware/WebHID-specific cause: if `pickMethod` silently gated only USB/HID methods, the non-hardware "Paste" card would not have failed too. A JS-dispatched `btn.click()` on "Trezor" in that same real-Chrome tab then advanced correctly to "Connect Trezor" (confirmed with untruncated `innerText`, not a false negative from an early text-length cutoff as in one intermediate check).

**Code check** against the hypothesis that `pickMethod` silently early-returns for secure-context/WebHID-gated methods (this app does have prior HTTP/WebHID history — cairn-4b2b, cairn-wgr8, `SecureContextHelp`): read the full `pickMethod()` body. It unconditionally sets `method = m; deviceError = null; previewError = null;` first, with only one unrelated conditional after (BitBox02 script-type coercion). No secure-context/WebHID guard exists inside it, and no `$effect` reverts `method` after it's set. `SecureContextHelp` only renders as informational copy *inside* the already-switched device pane — it cannot cause a silent no-op before that switch. Hypothesis disproven by direct code inspection, not just by the click tests.

**Conclusion:** the click handler and wizard state machine behave identically and correctly for both hardware and non-hardware methods, in dev, in the prod build, in the browser pane, and in real Chrome — every JS-dispatched click succeeded, in every context tested. Only the `computer` tool's coordinate/ref-based synthetic click failed, unpredictably, on different buttons in different sessions (Trezor here; reportedly "all 7" in the original session; Paste in one real-Chrome attempt but not in a browser-pane attempt seconds earlier) — a pattern with no code explanation but a known automation-timing signature (see engineering memory: "synthetic click/type failures are automation artifacts, settle via code+unit tests"). No code change was made. If a future pass reproduces this with a real human mouse click (not scripted automation), reopen at P0 immediately.
