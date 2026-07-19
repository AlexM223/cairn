# Heartwood Decision Queue — Consolidated Batch-Ratification Sheet — 2026-07-19

**Status:** AWAITING ALEX. One sitting, one pen. Bead: `cairn-pzgef`.

**What this is.** The single consolidated ratification sheet for every doctrine, product, and legal
decision currently parked on Alex. It **merges and supersedes** the scattered per-topic asks in:

- `docs/DESIGN-MANIFESTO-AMENDMENTS-2026-07-19.md` (ratification sheet §I/§II/§III)
- `docs/DECISION-BRIEF-R5-R8-R9.md` (three one-page briefs)
- `docs/HEARTWOOD-ROADMAP.md` §5 (decision-gate table)
- Standing beads: `cairn-4vh2`, `cairn-koy4.13`, `cairn-l1zu.1`, `cairn-vn43.19`
- `docs/HEARTWOOD-VISION-REVIEW.md` Addendum (solo-default instanceMode question)

Those documents remain the *evidence*; this sheet is the *ballot*. Nothing here is new research —
per the vision review's rule ("halt the strategy-doc production machine"), this document is the
sanctioned exception because it REPLACES the scattered queue rather than adding to it. Each item:
the question in one sentence, a recommended default with rationale grounded in the existing docs,
what unblocks when decided, and a literal line to annotate.

**How to answer.** Annotate each `DECISION:` line with ACCEPT (take the recommendation), REJECT
(status quo / do nothing), or MODIFY (write one line saying what instead). Partial passes are fine —
each item is independent unless noted.

**Not on this ballot (already settled — no decision needed):**
- **Difficulty raffle** — settled dead. `DIFFICULTY-RAFFLE-ANALYSIS.md` concluded best-share-wins is
  superior *and* that the `vn43.14` legal gate applies regardless of mechanism. Nothing to decide.
- **Retry-safety failure copy (`cairn-gt05.7`) and semantic-transparency send review
  (`cairn-gt05.11`)** — their beads document they are buildable under existing ratified doctrine
  (no doctrine change); implemented in the Move 3 wave. The *doctrine codification* halves remain
  on the ballot as D1/D11.
- **Federation security gates F1/F4/F12** — these are review checkpoints that fire when federation
  waves actually ship; federation is parked per the vision review, so nothing is currently waiting.

---

## Section A — Design-doctrine ratification (the manifesto amendments wave)

### D1. Batch-ratify the seven mechanical amendments (A1–A7)

**Question:** Do the seven EVIDENCE-BACKED amendments (notification taxonomy + pull-default,
error-copy grammar, trust-anchor paragraph, semantic-transparency review, risk-with-efficacy,
four AVOID additions, Heartwood tests 8–10) enter `DESIGN-MANIFESTO.md` as written?

**Recommended default: ACCEPT as one batch.** The amendments doc itself grades all seven as
implementing existing MUSTs or codifying measured results with no new tradeoff ("safe to ratify
mechanically"); each carries a full evidence trail (R2 F11–F19, R3 F20–F27), and their carved-out
judgment riders are separated out below (D2, D4, D10, D11) so ratifying the batch decides nothing
contested. Ratifying them ends the current limbo where build work (gt05.7/.9/.11) implements the
*content* of unratified doctrine — the code and the manifesto should say the same thing.

**Unblocks:** the manifesto-edit pass landing A1–A7; falsifiable tests 8–10 joining the Heartwood
test; gt05.9's taxonomy getting doctrine cover.

**DECISION (D1): ACCEPT / REJECT / MODIFY — ______**

### D2. Amber vs red: the degraded-vs-broken color boundary (amendments §II P1, R2 §3.1)

**Question:** Is the boundary between amber and red drawn at *actionability + reversibility*
(amber = degraded/transient/self-healing; red = broken/action-blocking/needs a decision)?

**Recommended default: ACCEPT Option A (the actionability boundary).** Two rounds of failure-copy
research (R2 F14/F15, R3 F22) now depend on this one line; Option A reuses existing tokens
(`--attention`, `--error`), matches ratified doctrine exactly (amber already = "expected swing, not
error"; red already = destructive/irrecoverable-only), and requires no new color. The alternatives
were a third middle tier (only if QA proves A too binary) or per-banner case-by-case (guaranteed
drift). Deciding this also unlocks the color clauses of Heartwood tests 9–10.

**Unblocks:** the color half of the error-copy grammar (A2 rider); banner-by-banner sweep moving
"node unreachable" vs "node down" to the correct side; test-10 color clause.

**DECISION (D2): ACCEPT / REJECT / MODIFY — ______**

### D3. Non-color redundancy for semantic states (amendments §II P2, R2 §3.2)

**Question:** Does every state-bearing use of a semantic color require a second non-color cue
(text or shape), with balance/prose exempt?

**Recommended default: ACCEPT Option A (minimal "no hue-only status" rule + retune `--caution`
toward amber).** It is the cheapest defensible fix for the ~8%-of-male-users CVD gap and the WCAG
1.4.1 exposure, preserves the §6 color-count aesthetic (it forbids only the lone colored dot, not
the palette), and the `--caution` retune is already invited by the manifesto's own note on the
salmon token. The full icon-token system (Option B) risks exactly the iconography the minimalist
identity avoids; QA-only (Option C) leaves opposite-meaning states distinguishable only by hue.
Note: Move 3's accessibility pass already applied non-color redundancy where it was an unambiguous
improvement under existing doctrine; this decision makes it a *rule*.

**Unblocks:** notification tier-chips design (A1); test-9 redundancy clause; a systematic sweep
replacing hue-only dots.

**DECISION (D3): ACCEPT / REJECT / MODIFY — ______**

### D4. Push notifications: pull-only, or one opt-in exception? (amendments §II P3, R3 §3.1)

**Question:** May the cosigner-signature-needed class ever push, or is Heartwood strictly pull
(bell-badge only)?

**Recommended default: ACCEPT Option B (pull default + one opt-in, rate-limited push class:
"tell me when someone needs my signature").** The interruption literature behind the pull default
(R3 F26/F27) is about non-actionable noise; cosigner-needed is the one class that is genuinely
actionable *and* time-critical, and a rarely-opening cosigner extends the other party's waiting
anxiety. Opt-in preserves the default; the rate limit inherits the existing remind discipline.
Strict pull-only (Option A) is the defensible fallback if simplicity wins.

**Unblocks:** the cosigner row of the notification taxonomy (gt05.9 finishes its matrix); the
notification-settings surface.

**DECISION (D4): ACCEPT / REJECT / MODIFY — ______**

### D5. USD-first vs sats-first default (`cairn-4vh2`, amendments §II P4)

**Question:** Does the hero balance stay bitcoin-first (sats/BTC) with fiat muted — or flip to
USD-first by default?

**Recommended default: ACCEPT Option A — keep sats-first.** This is the manifesto's
self-described "single most load-bearing rule": a bitcoin-denominated hero is monotonically
non-decreasing for a saver, so every glance is a growth signal, while a fiat hero pays the ~2×
myopic-loss-aversion penalty on price noise (Benartzi & Thaler, manifesto §3 rule 3). Reversing it
cascades through §3, §5 growth-only motion, and the red-day test — a multi-section doctrine
rewrite, not a toggle. The fiat-primary *user* toggle already exists (off by default) for
fiat-native users. **Independent, decidable-now sub-item:** the non-doctrine half of `cairn-4vh2`
(the $ / BTC entry-unit affordance in Send is easy to miss; remember last-used unit, make the
active unit visually louder) is a UX bug fix consistent with either outcome — recommend approving
it for build regardless.

**Unblocks:** closes `cairn-4vh2`'s product-decision half; ends the recurring "should it be USD"
re-litigations; sub-item unblocks a small Send polish bead.

**DECISION (D5, default): ACCEPT / REJECT / MODIFY — ______**
**DECISION (D5, entry-unit affordance fix): ACCEPT / REJECT / MODIFY — ______**

### D6. Sats→BTC legibility threshold for display heroes (R9, decision brief #1)

**Question:** Above 0.1 BTC, does the *display* hero flip from sats to BTC (sats demoted to the
muted line), with entry/review surfaces never auto-switching?

**Recommended default: ACCEPT Option A (0.1 BTC threshold, display-only, with a Settings →
Display "Always show sats" override).** A 9-digit sats figure is texture, not a quantity — the
growth drumbeat the sats hero exists to deliver dies past the familiar band (Landy et al.,
redenomination literature, Bitcoin Design Guide convergence). The brief's own guardrail is the
important half: **no auto-switching anywhere near amount entry or review** (F5: sats↔BTC is a
10⁸× slip amplifier). The bitcoin-first-vs-fiat MUST is untouched — this is legibility *inside*
the bitcoin denomination. Effort S (one formatter seam).

**Unblocks:** large-balance legibility on Home/wallet-detail heroes; one-paragraph §3 amendment;
a small format.ts bead.

**DECISION (D6): ACCEPT / REJECT / MODIFY — ______**

### D7. Mechanism-fact carve-out to the reassurance ban (R5, decision brief #2)

**Question:** May a commit-moment surface carry one muted line stating a verifiable mechanism fact
("You approve this on your device"), under a falsifiable information-vs-theater test, while the
badge/seal ban stays absolute?

**Recommended default: ACCEPT Option A (amend with the mechanism-fact test).** The evidence runs
cleanly in opposite directions for the two things the current rule conflates: passive badges are
among the weakest-measured trust interventions (Schechter 2007; CXL), procedural transparency
among the strongest (Buell & Norton labor illusion; operational-transparency line). The proposed
rule *strengthens* the badge ban by stating why badges fail, and the test is falsifiable in the
manifesto's own §6 style: delete the line — if the user knows less about what will happen, it was
information (keep); if merely less reassured, theater (cut). Max one per screen. Note the shipped
`gt05.6` first-deposit states and the `gt05.11` own-node cue already rely on this distinction.

**Unblocks:** R5 copy across Send sign/broadcast, Receive, Health; retroactive doctrine cover for
gt05.6/gt05.11 copy.

**DECISION (D7): ACCEPT / REJECT / MODIFY — ______**

### D8. Wallet purpose-naming chips + goal ring — net-new feature go/no-go (R8, decision brief #3)

**Question:** Build purpose-naming chips at wallet creation now (v1), with the sats-target goal
ring deferred to its own anti-guilt-constrained bead — or don't build at all?

**Recommended default: ACCEPT Option A (chips now, goal ring as a follow-up go/no-go).** The core
earmarking effect is the strongest-evidenced item in the whole research line (Gargano & Rossi,
*Journal of Finance* 2024, causal; Cheema & Soman field experiment) and Heartwood's wallets are
already the partitions — chips just activate the mental account, at S/M effort riding the wizard
pass. The only documented failure mode (goal-failure guilt, what-the-hell effect) lives entirely
in the deferred ring half, whose bead must carry the anti-guilt constraints (sats-denominated,
deposits-only progress, no deadlines, no regression, no nag) before any go. **This is the one
net-new-scope item on the ballot** — REJECT is fully defensible on vision-review focus grounds
("story elevation ≠ build-list expansion"); the recommendation is ACCEPT because the evidence is
causal and the slice is small, but focus is a legitimate veto.

**Unblocks:** a wizard-step bead (single-sig + multisig trees) + wallet-card purpose display;
the deferred ring bead gets filed with constraints written in.

**DECISION (D8): ACCEPT / REJECT / MODIFY — ______**

### D9. Sovereignty-honesty doctrine, ahead of the features (amendments A8 / §III J3)

**Question:** Do the four sovereignty-honesty guard bullets (no silent cloud dependency; server
participation degrades to self-custody; lockout consequences surfaced before opt-in; comprehension
ships with the mechanism) enter §7 now, before any recovery/server-assisted feature exists?

**Recommended default: ACCEPT — adopt the four bullets now, as boundaries.** They constrain *how*
any future recovery/inheritance/server-assisted feature must behave without committing to build
any of them — cheap insurance against the documented "primitive first, UX later" drift (Liana's
origin sin, Green's 2FA-cliff, Envoy's silent iCloud dependency, all in COMPETITOR-ANALYSIS-R2).
The vision review's freeze on build-list expansion is *compatible* with this: doctrine that
prevents future features from betraying the brand is a fence, not a feature. This is the amendments
doc's own lean, flagged PENDING-ALEX only because it is forward-looking.

**Unblocks:** nothing today (that is the point) — it pre-empts a doctrine gap the moment any
server-assisted feature is proposed.

**DECISION (D9): ACCEPT / REJECT / MODIFY — ______**

### D10. Trust-thesis placement (amendments §III J1)

**Question:** Does the trust-anchor paragraph (A3) land in §1 (identity thesis) plus test 8 in §6,
or live only in §6/§7?

**Recommended default: ACCEPT the lean — short paragraph in §1 + test 8 in §6.** The thesis
("trust attaches to the mechanism and the user's own competence; the own-node explorer is the
verifiable analogue of a bank's logo") deserves a home in the section that states what Heartwood
*is*, and the test makes it falsifiable. Pure placement; zero content risk either way. Decide with
D1 in the same pen-stroke.

**Unblocks:** the A1–A7 landing pass knows where to put the paragraph.

**DECISION (D10): ACCEPT / REJECT / MODIFY — ______**

### D11. Elevate "semantic transparency" to a named MUST (amendments §III J2)

**Question:** Does the send-review semantic-transparency rule (restate intent as a first-person
verification, own-node authority cue, per-signer re-personalization) carry MUST weight in §5?

**Recommended default: ACCEPT — MUST.** F21 is the single strongest measured result in the
research line (correct identification 67.9%→84.2% *with lower* mental demand, in a crypto-wallet
study) on the single highest-stakes screen in the product. The buildable copy shipped with
`gt05.11` either way; this decision is about whether the manifesto enforces it on every future
send-surface rewrite. A second MUST on the broadcast flow is a feature, not a cost — the broadcast
flow is where MUSTs belong.

**Unblocks:** doctrine cover for the shipped review-hardening; the multisig per-signer
re-personalization bead inherits MUST priority.

**DECISION (D11): ACCEPT / REJECT / MODIFY — ______**

---

## Section B — Product/identity decisions outside the manifesto

### D12. Umbrel App-Store identity: does the app ID ever change? (`cairn-koy4.13`, open 12 days)

**Question:** Does Heartwood keep its Umbrel app ID (and `CAIRN_DB`/`CAIRN_LOG_FILE` env vars,
`cairn` UID/GID) forever, with "Heartwood" living only in display metadata?

**Recommended default: ACCEPT — freeze the operational identity permanently; rebrand display
metadata only.** The bead's own analysis is decisive: existing installs have real user data at the
exact current paths/names, Umbrel app IDs are effectively permanent (a rename reads as a new app;
installed users don't auto-migrate), and the store listing already presents as Heartwood
(`heartwood-bitcoin` per the store repo) while internals stay `cairn`. Every alternative (new
listing + deprecate old; env-var alias migration) risks stranding real wallets for zero user-visible
gain. Write it down once — "the app ID and env vars are internal and permanent" — and close the
oldest open identity question in the tracker. If Alex wants the `HEARTWOOD_DB` alias-with-fallback
as belt-and-suspenders for *future* installs, that is the MODIFY line, and it must ship with a
fallback that never breaks an existing path.

**Unblocks:** closes `cairn-koy4.13`; removes the last open item under the retired koy4 epic;
store-update runbook stops carrying a "pending identity decision" caveat.

**DECISION (D12): ACCEPT / REJECT / MODIFY — ______**

### D13. Solo-default `instanceMode`: flip to team, or keep solo + discoverable toggle?
(vision review Addendum, move 2)

**Question:** Does a fresh install default to `instanceMode: 'solo'` (status quo, `settings.ts:13`)
or to team mode, now that multi-user is co-headline?

**Recommended default: REJECT the flip — keep `'solo'` as the default; make the team-mode toggle
discoverable instead.** The Addendum itself files this as "a doctrine call, not an engineering
one" and the evidence favors the status quo: most first-week installs are one person on one node
(the first-week visibility test says don't render crew machinery they won't touch), the existing
`instanceModeMigration` already flips to team on evidence of actual multi-user use, and solo-mode
hides admin surfaces that would otherwise confuse a solo operator. The real gap the Addendum found
is the *come-aboard experience* (Move 2's flagship), which works regardless of default. A
discoverable "invite someone aboard" affordance (which activates team mode when used) delivers the
navigator story without defaulting every solo install into crew chrome.

**Unblocks:** removes this from the decision backlog; Move 2's onboarding work proceeds against a
stable default; a small "discoverable team-mode entry point" bead can be filed.

**DECISION (D13): ACCEPT-KEEP-SOLO / FLIP-TO-TEAM / MODIFY — ______**

---

## Section C — The legal gate

### D14. Coinbase-payout pool: kill the epic, or send the counsel package? (`cairn-l1zu.1`, P0)

**Question:** Is epic `cairn-l1zu` killed per the vision review's cut list, or does Alex send the
ready counsel package (`COUNSEL-QUESTION-PACKAGE-L1ZU1-2026-07-19.md`) and hold the epic pending a
legal answer?

**Recommended default: ACCEPT the kill (the vision review's call, twice-adjudicated).** The
review and its Addendum both land here independently: 21 implementation beads sit under an unmade
P0 legal gate that exists because the project's own hard line (`MINING-POOL-SCOPE.md`: "any
shared-reward mode requires legal review before any code") forbids exactly this mode; the
economics only work above ~1–10 PH/s, a scale no self-hosted instance reaches; and the
trust-the-captain framing makes an operator-split coinbase *more* of a betrayal, not less. Killing
means: close the l1zu implementation beads (keep the analysis docs as shelf reference), and the
decision-gate table collapses by four rows (l1zu.1, .19, .20, .21). **The MODIFY path is honest
too:** if Alex is not ready to kill, the *only* permitted action is sending the already-written
counsel package — the roadmap calls it "the fastest unblock on the whole roadmap" — and no
implementation bead moves until counsel answers. What is not on the menu is the status quo
(21 beads accumulating under an unsent question).

**Unblocks (kill):** 10 open P1s + the P0 leave the backlog; the single-maintainer decision queue
loses its heaviest item. **Unblocks (send):** counsel clock starts; economics beads l1zu.19–.21
become decidable in parallel.

**DECISION (D14): ACCEPT-KILL / SEND-COUNSEL-PACKAGE / MODIFY — ______**

---

## Tally

| # | Decision | Recommended default | Effort if accepted |
|---|---|---|---|
| D1 | Ratify mechanical amendments A1–A7 | ACCEPT (batch) | S (doc edit pass) |
| D2 | Amber/red = actionability boundary | ACCEPT Option A | S (banner sweep) |
| D3 | No hue-only status (minimal rule) | ACCEPT Option A | S/M (sweep + chips) |
| D4 | Push: one opt-in cosigner class | ACCEPT Option B | M (rides gt05.9) |
| D5 | Keep sats-first default (+ entry-unit affordance fix) | ACCEPT A (+ fix) | 0 (+S) |
| D6 | 0.1 BTC display-hero threshold | ACCEPT Option A | S |
| D7 | Mechanism-fact carve-out | ACCEPT Option A | S (copy pass) |
| D8 | Purpose chips now, ring deferred | ACCEPT Option A (REJECT defensible) | S/M |
| D9 | Sovereignty-honesty guards now | ACCEPT | S (doc only) |
| D10 | Trust thesis in §1 + test 8 | ACCEPT lean | 0 (placement) |
| D11 | Semantic transparency = MUST | ACCEPT | 0 (doc only) |
| D12 | Umbrel/env identity frozen forever | ACCEPT | S (doc + bead close) |
| D13 | Keep solo default, discoverable toggle | REJECT the flip | S (toggle bead) |
| D14 | Kill l1zu (or send counsel package) | ACCEPT-KILL | Bead cleanup |

Fourteen pen-strokes clear the entire non-federation decision backlog. Items D1–D11 land in one
manifesto edit pass; D12–D14 are bead/process actions. After this sheet is annotated, the
per-topic ratification sections in the amendments doc and the decision brief are historical —
this sheet is the record.
