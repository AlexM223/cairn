# Cairn Process Retrospective — 2026-07-06

Scope: all 305 closed beads in `.beads/` as of 2026-07-06 (`br list --status closed --json`), spanning 2026-07-04T03:58 to 2026-07-06T15:24 — roughly **2.5 days of wall-clock time**, almost entirely AI-agent-driven development. 2 beads remain open; 1 tombstoned. This is a retrospective on how the work happened, not a scorecard on any individual session.

## Bottom line

The tracker shows a very high-velocity, high-signal process (99 real bugs found, only 3% turned out to be duplicate/false-positive) that is **structurally under-tested against regression**: only 6% of bug fixes added a test, and the single clearest incident in the dataset — a P1 correctness bug (`cairn-j6fv`) reintroduced almost verbatim as a P0 (`cairn-v13r`) in new code eleven hours later — is a direct, provable consequence of that gap. The second-biggest theme isn't a bug category at all, it's a workflow hazard: with no `closed_by`/fixer field in the tracker and many concurrently-running sessions on one branch, this repo has at least one on-record case (`cairn-5kth`) of a real fix existing only in an uncommitted working tree, at risk of being silently discarded by another session's git operation. Both problems have the same root cause — the team optimized entirely for finding bugs fast (which worked excellently) and under-invested in making fixes stick.

## 1. Volume and velocity

| Metric | Value |
|---|---|
| Total closed beads | 305 (of 307 total; 2 still open) |
| Timeframe | 2026-07-04 03:58 → 2026-07-06 15:24 (~59.5 hours) |
| Mean lead time (create → close) | 3.99 hours |
| Median lead time | 1.05 hours |
| Fastest close | 0.009h (~30 sec) — `cairn-a77.6`, "Logo and favicon" |
| Slowest close | 38.08h — `cairn-a4k`, vault E2E emulator verification (legitimately long-running verification work, not neglect) |

By issue type: **99 bugs, 94 tasks, 91 features, 14 epics, 5 docs, 2 questions.**

Lead-time distribution is heavily front-loaded — most work closed same-session or same-day:

| Bucket | Count | % |
|---|---|---|
| < 15 min | 37 | 12% |
| 15–60 min | 111 | 36% |
| 1–4 h | 66 | 22% |
| 4–12 h | 58 | 19% |
| 12–24 h | 31 | 10% |
| > 24 h | 2 | 1% |

Daily throughput accelerated, not slowed, as the backlog grew: created 105 (07-04) → 171 (07-05) → 29 (07-06, partial day); closed 102 → 92 → 111. There's no sign of the backlog outrunning the team's ability to close it — if anything 07-06 shows a "clean-up the queue" day (fewer new beads filed, most of the day's closures).

## 2. Who found what, who fixed it

The tracker only records `created_by` (finder). There is **no `closed_by`/fixer field** — `close_reason` names a git commit hash in most cases, but never a session identity, and the `assignee` field is empty except for 74 beads auto-assigned to `fable`. This is itself a process gap (see §10): we can reconstruct *what* fixed a bug, not reliably *which session* did it.

13 distinct `created_by` identities appear across 305 beads — evidence of many separately-invoked sessions working the same backlog over 2.5 days:

| created_by | Total beads | Bugs filed |
|---|---|---|
| quality-auditor | 83 | 27 |
| unknown | 69 | 20 |
| assistant | 54 | 15 |
| fable | 32 | 2 |
| auditor | 22 | 6 |
| claude-code | 12 | 11 |
| claude-security-audit | 6 | 5 |
| claude | 8 | 0 |
| userB-qa | 7 | 6 |
| claude-hw-e2e-test | 5 | 2 |
| browser-tester | 4 | 4 |
| qa-testing | 2 | 1 |
| opus | 1 | 0 |

What *is* inferable from lead times: bugs were essentially never fixed in the same tool-call that filed them (median lead time for bugs is well over a few minutes), and the sessions with audit-style names (`auditor`, `quality-auditor`, `claude-security-audit`) read code and filed findings, while later, differently-named sessions (`claude-code`, `assistant`, unnamed default sessions) show up in commits referenced by `close_reason`. So finding and fixing were consistently split across separate invocations — good separation of concerns — but the tracker can't prove *who* did the fixing, which matters for the reopened-bug story in §5.

## 3. Common themes

Grouping the 99 real bugs by keyword pattern in title+description:

| Theme | Count | Example |
|---|---|---|
| **Silent failure** (fails/drops/clamps/skips with no user or log signal) | **27 (27%)** | `cairn-sd3n`: `restoreBackup()` silently skips malformed rows, zero logging; `cairn-hzg1`/`cairn-sh5h`: invite creation silently clamps out-of-range values |
| Crash / unhandled 500 | 14 (14%) | `cairn-z6i1`: `/agreement` 500s on every real signup (reserved Svelte action name); `cairn-mlxf`: multisig wizard 500s on null `locals.user` |
| UI/server state mismatch | 4 | `cairn-xvze`: backup status checked via `localStorage` instead of the server truth; `cairn-8ye`: fiat price endpoint hardcodes mempool.space, ignoring configured Esplora URL |
| Feature built but never wired in | 3 | `cairn-xkpd`: full 3-tier collaborative-custody access gate built, zero call sites in any route; `cairn-5i3`: Ledger/ColdCard/QR signers built and tested, never added to the Sign step's method list |
| Race condition | 3 | `cairn-dr6`: check-then-act race on the already-sent broadcast guard; `cairn-veh`: rapid double-click on "Test connection" |
| Missing validation | 2 (filed as 2 separate beads for the identical bug — see §5) | `cairn-n31s`/`cairn-yzjq`: `PUT /api/admin/settings` has no validation, unlike its sibling form action |
| Single-sig/multisig parity gap | 2 explicit, but structural per [Cairn architecture review 2026-07-06](ARCHITECTURE-REVIEW-2026-07-06.md) | `cairn-xqfb`: Admin overview wallet count omits multisig wallets |

"Silent failure" is by a wide margin the dominant recurring shape of bug in this codebase — more than double the next category. It cuts across every subsystem: notifications (`cairn-s0p5`), hardware wallets (`cairn-yaw1` Trezor swallows parse failures), Electrum (`cairn-zjih` silent resubscribe failure), signup (`cairn-gy79`, `cairn-1qv7`, `cairn-4lp` — three separate silent-failure bugs on the signup form alone), and backups (`cairn-sd3n`). This lines up exactly with the 2026-07-05 tech-debt audit's own conclusion that the recurring theme is silent-failure-on-unhappy-path, not missing features — that finding is fully corroborated by an independent count here.

## 4. Priority accuracy

Priority correlated with lead time in the *right direction on average*, but not cleanly — and small-N (only 5 P0s, 7 P4s) means outliers dominate:

| Priority | Count | Avg lead time | Median | Max |
|---|---|---|---|---|
| P0 | 5 | 4.88h | 5.69h | 7.71h |
| P1 | 93 | 2.27h | **0.65h** | 38.08h |
| P2 | 123 | 3.35h | 0.96h | 19.81h |
| P3 | 77 | 6.56h | 3.74h | 30.20h |
| P4 | 7 | 9.41h | 14.55h | 15.67h |

All 5 P0s were genuinely critical (collaborative-custody sharing totally non-functional, an SSRF DNS-rebinding TOCTOU gap, ntfy channel with zero SSRF protection, a signup-blocking 500, and the reintroduced tx-amount bug) — no P0 in this set looks over-labeled. But P1's median (0.65h) beats P0's median (5.69h): several P1s were one-line fixes closed almost instantly, while P0s got the deliberate, multi-hour remediation-and-verification treatment their label implies. That's priority working as intended, not miscalibration.

The clearer signal is at the *low* end: several P3/P4 bugs took as long or longer to close than P0s (`cairn-oqri` 14.6h, `cairn-mlxf` 14.7h, `cairn-9g6b`/`cairn-973j`/`cairn-t6t7` at P4 sitting for many hours) — consistent with P3/P4 being correctly triaged as *lower urgency*, not misfiled. One P2 was explicitly **retracted** after a second audit agent traced it and found it wasn't real:

> `cairn-3r2k` ("Multisig wallet name concatenates imported config name...") — close reason: *"RETRACTED: not a real bug. A deep code trace by a second audit agent... confirmed [it does not happen]."*

This is the one clean example of over-eager priority-setting in the dataset, and the process caught it via adversarial re-verification before it consumed a fix cycle — a good sign for the practice of having a second agent check a first agent's finding before acting on it.

## 5. Reopened or re-found

The tracker has **no reopen mechanism exercised** in this window (`updated_at` == `closed_at` to the microsecond for all 305 beads — no bead was closed, reopened, and reclosed). But re-discovery absolutely happened, just as *new* beads:

- **The headline case: `cairn-j6fv` → `cairn-v13r`.** `cairn-j6fv` ("Wallet transaction amounts always report as 0") was filed P1, fixed same-day (`close_reason: "done"`). Roughly 8 hours later, `cairn-v13r` was filed — title: *"addressWatcher.ts reintroduces the exact Tier-0 cairn-j6fv bug in fresh code: tx amounts computed by address-string match, not scriptPubKey"* — and this time rated **P0**. Same root defect, in new code, closed in 5.7 hours the second time. This is the strongest single piece of evidence in the dataset that fixes without regression tests don't stick when adjacent code gets rewritten.
- **Independent re-filing by a different session, same bug:** `cairn-f50s` (old `/vaults/*` URLs 404 after a rename) and `cairn-kfn` ("filed independently by the browser tester with a sharper repro (a real, live 2-of-3 vault with 0.24999216 BTC...)") describe the same defect. `close_reason` on `cairn-kfn` explicitly says *"Duplicate of cairn-f50s"* — the browser-tester session found it again from a live-data angle without knowing it had already been filed.
- **`cairn-hzg1`** is explicitly marked duplicate of `cairn-sh5h` (same invite-clamp bug, same description, filed independently).
- **Self-duplicate within one session:** `cairn-n31s` and `cairn-yzjq` are the *identical* bug ("PUT /api/admin/settings has no validation...") filed by the same `claude-code` session 34 seconds apart, both later closed by the same commit `46dd16f`. This is tracker-hygiene noise rather than a real re-discovery, but it inflates the bug count and is worth a "did I already file this" check before creating a bead.
- **A fix that nearly evaporated:** `cairn-5kth` documents a real BitBox02 multisig-registration security fix that existed only as *uncommitted working-tree changes* when a security-audit session went looking for it — flagged explicitly because "until committed, this fix could be accidentally lost (e.g. a git reset/checkout by another session) and the gap would silently reopen." Per prior-session memory, an earlier version of this exact fix *was* lost this way and had to be re-implemented from scratch. This is a reopened bug in every sense except that the tracker's bookkeeping (a "verify and commit" task) doesn't say so explicitly.

## 6. Root causes

Ranked by how much of the bug volume each explains:

1. **Missing regression tests, not missing awareness (biggest).** Only 6% (6/99) of bug-fix close reasons mention adding a test. The `j6fv`→`v13r` recurrence (§5) shows the concrete cost: the same logical error (computing wallet delta by address-string match instead of `scriptPubKey`) was written twice by two different feature implementations because nothing asserted the correct behavior after the first fix.
2. **Rapid parallel feature development outpacing wiring-up.** Three separate "built but never connected" bugs (`cairn-xkpd` collaborative custody, `cairn-5i3` three hardware signers, and the underlying pattern behind several `audit-2026-07-05`-tagged findings) describe complete, tested backend logic with zero call sites in any route. This is what happens when a feature's plumbing and its wiring are built as separate work units without an end-to-end check closing the loop.
3. **Copy-paste single-sig → multisig duplication.** Confirmed structurally (not just anecdotally) by the [architecture review](ARCHITECTURE-REVIEW-2026-07-06.md)'s DRY-violation findings, and directly visible in this bead set: `cairn-xqfb` (admin wallet count omits multisig), the near-identical `n31s`/`yzjq` validation gap, and the general pattern of "single-sig has X, multisig doesn't" bugs. Every wallet-feature bug risks being fixed once and silently left unfixed in the sibling tree.
4. **Concurrent sessions on one branch.** `cairn-5kth` is the on-record case of a real fix nearly lost to this; separately-tracked session notes confirm at least one fix (the BitBox02 multisig-registration check) was actually lost this way and had to be redone from scratch. With 13 distinct session identities filing beads inside 2.5 days, this is a structural hazard, not a one-off.
5. **Silent-failure as a default coding idiom.** 27% of all bugs are some flavor of "something failed and nothing told anyone" (§3). This isn't concentrated in one module — it appears in notifications, hardware-wallet drivers, Electrum, signup, and backups — suggesting it's a house style/habit (e.g., defensive `try/catch` blocks that swallow rather than log or surface) rather than one team's oversight.

## 7. Session effectiveness

Comparing bugs filed by manual/E2E-testing-style sessions vs. audit/code-review-style sessions shows they found genuinely different, non-overlapping classes of bugs — both were high-value, for different reasons:

**Manual/E2E testers** (`userB-qa`, `browser-tester`, `claude-hw-e2e-test`, `qa-testing` — 13 bugs total, 0 duplicates/false-positives) found things only observable by *running* the app against real data: live-signup 500s (`cairn-z6i1`), a wizard crashing against a real 2-of-3 vault holding real regtest BTC (`cairn-kfn`), a quorum tracker showing stale state after a real cosigner's tool submitted a signature (`cairn-8y3b`), and the collaborative-custody P0 (`cairn-xkpd`) — found only because the tester logged in as a second real user and tried to actually use a shared wallet.

**Audit/code-review sessions** (`auditor`, `quality-auditor`, `claude-security-audit` — 38 bugs, 2 duplicates, 1 retracted = **7.9% noise**) found the deep, non-obvious classes that no amount of clicking would surface: the DNS-rebinding TOCTOU gap (`cairn-335b`), missing Electrum TLS certificate validation (`cairn-azei`), plaintext RPC-password round-tripping to the client (`cairn-g7a`), missing SIGHASH_ALL enforcement on cosigner signatures (`cairn-srte`), and the `j6fv` recurrence itself (`cairn-v13r`) — caught by an auditor re-reading new code, not by anyone clicking through the UI.

Neither style is a substitute for the other. The manual/E2E group has a **0% noise rate** (13/13 real, distinct bugs) — small sample, but notably cleaner than the audit group's 7.9%. That's expected: a live 500 or a visibly-stuck UI state is unambiguous, whereas a security auditor reasoning about theoretical attack surface (DNS rebinding, TOCTOU windows) has more room to flag something that turns out not to be exploitable in practice. Both are worth the false-positive cost given what each side of the pair found that the other couldn't.

## 8. Fix quality

Bug fixes were overwhelmingly one-and-done as far as the tracker shows: of 99 bugs, 96 were fixed and closed with no follow-up bead referencing incompletion, 2 were duplicates, 1 was retracted. Seven close reasons explicitly flag partial or layered fixes worth naming:

- `cairn-obb` ("No server-side logging anywhere") — close reason states plainly *"3 of 4 fix items landed solidly... "* — a rare case of an agent being upfront that a fix was partial rather than claiming full completion.
- `cairn-tp0` (PSBT magic-byte check) — *"Fixed in 8717710 **+ follow-up route fix**"* — the first commit didn't fully close the gap and needed a second pass, still within the same lead-time window.
- `cairn-l512.7` (rollout verification) — closed only after explicitly re-verifying all 5 checks live, rather than trusting the original implementation's self-report.

The pattern in what made a fix stick: fixes whose close reason cites a **specific commit hash + a specific verification action** ("897 tests pass, typecheck clean", "browser-verified", "VERIFIED on live regtest") read as more durable than the ~52 close reasons that just say "done" or "shipped" with no verification detail. The `j6fv` recurrence is the counter-example that proves the point — its close reason was a bare `"done"` with no test added, and it came back.

## 9. Testing gaps — what only manual testing caught

Cross-referencing §7's theme breakdown against test-mention rate: every bug in the "crash/500" and "silent failure" categories was caught by a session *running* the app (browser testers, QA sessions, or an agent reading live server logs — `cairn-z6i1` was found via `data/logs/cairn.log` for a real signup), never by a unit test catching it first. This tracks with the [architecture review](ARCHITECTURE-REVIEW-2026-07-06.md)'s independent finding that "only ~2 of 133 route files have any test, so the actual send/sign/broadcast HTTP paths are essentially untested." Categories automated tests structurally cannot catch here:

- **Real multi-user interaction** (`cairn-xkpd`, `cairn-8y3b`) — needs two real accounts and a real shared resource; no test fixture in this repo simulates that.
- **Live third-party/hardware state** (`cairn-kd5` Ledger BIP-48 path inference, `cairn-8y3b` a cosigner's external tool submitting a signature) — depends on real device/tool behavior a unit test can't fake convincingly.
- **UI affordance/discoverability bugs** (`cairn-8dup` disabled elements vanishing instead of showing why, `cairn-oqri` missing accessible names on wizard buttons) — these are visible only by looking at rendered output, not by asserting on data.
- **Log-derived bugs** (`cairn-z6i1`) — only found because a session went and read `data/logs/cairn.log` for a real user's session, not because a test asserted on the response code.

## 10. Process improvements

1. **Require a regression test as part of "done" for any bug fix, not just features.** Currently 6% of bug closures cite one. The `j6fv`/`v13r` pair is direct proof this gap has already cost a full duplicate fix cycle; it will recur wherever `single-sig`/`multisig` parallel code (root cause #3) gets touched again.
2. **Add a `closed_by`/fixer field to the bead schema**, or at minimum require close reasons to name the session/actor, not just a commit hash. Right now §2 and §5's most important question — "did the finder and fixer overlap, and did any fix actually get lost between sessions" — can only be answered by circumstantial memory (`cairn-5kth`), not by the tracker itself.
3. **Commit-as-you-go for security/correctness fixes touched during audits.** `cairn-5kth` shows a real fix sitting uncommitted mid-audit is a live risk with this many concurrent sessions on one branch; make "commit immediately, don't batch" the default for anything touching signing/security code.
4. **Grep the open+recently-closed backlog for a near-duplicate title before filing.** `cairn-n31s`/`cairn-yzjq` (same session, 34 seconds apart) and `cairn-hzg1`/`cairn-sh5h` (different sessions) show this costs little individually but is easy to avoid with one `br search` before `br create`.
5. **Treat "silent failure" as a lint target, not just a bug category.** At 27% of all bugs found, this is the single highest-leverage fix: a repo-wide sweep for bare `catch {}` / `catch (e) { return null }` patterns without a `logger.warn`/error surface would likely find several of these before a tester does.
6. **Keep the audit + manual-test pairing — don't cut either.** §7 shows they find non-overlapping bug classes; the manual/E2E group's 0% noise rate also suggests it's currently under-resourced relative to its hit rate (13 bugs from 4 identities, vs. 38 from 3 audit identities) and could bear more investment before audits should be scaled back further.
7. **When a second agent retracts a first agent's finding (`cairn-3r2k`), keep doing exactly that** — the adversarial-reverification step is working and caught a false P2 before it consumed a fix cycle.
