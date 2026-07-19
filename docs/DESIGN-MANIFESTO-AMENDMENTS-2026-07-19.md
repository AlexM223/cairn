# Design Manifesto — Proposed Amendments — 2026-07-19

**Status: PROPOSALS. Not ratified. Do not treat as doctrine.** This document proposes deltas to
`docs/DESIGN-MANIFESTO.md`; the manifesto remains canonical and unchanged until Alex ratifies items
here. Nothing in this file edits the manifesto.

**Provenance.** Every amendment is traced to evidence already gathered and committed:
- `docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md` (findings F11–F19, improvements R10–R16, §3 pending items)
- `docs/UX-PSYCHOLOGY-RESEARCH-R3-2026-07-19.md` (findings F20–F27, improvements R17–R23, §3 pending items)
- `docs/COMPETITOR-ANALYSIS-R2-2026-07-19.md` (steal-worthy patterns; §7 synthesis; §8 unverified flags)

**How to read a status tag.**
- **EVIDENCE-BACKED** — the delta implements an existing MUST or codifies a measured/well-established
  research result without introducing a new doctrine tradeoff. Safe to ratify mechanically.
- **PENDING-ALEX** — a doctrine judgment call (a tradeoff the research deliberately did *not* decide,
  or new conceptual doctrine). Presented with options + a recommendation; **the recommendation is not
  a decision.**

Several EVIDENCE-BACKED amendments carry a **carved-out rider** that is itself PENDING-ALEX (e.g. the
error-copy grammar is buildable now, but the degraded-vs-broken *color* it implies is a pending
decision). Those riders are collected in the ratification sheet §II so nothing buildable is blocked on
an undecided color.

The **ratification sheet** at the end is a checkbox walk-down grouped: (I) mechanical / evidence-backed,
(II) standing pending decisions, (III) new judgment calls surfaced here.

---

## Amendment 1 — §5: add a severity × actionability notification taxonomy and a pull-default architecture

**Target:** §5 → "Notification & delta-display rules (MUST)".

**(a) Exact current wording:**

> - **Never push a notification on a fiat price drop. Ever.** Batch and throttle all value-change
>   notifications; real-time price alerts are prohibited by design (each is a fresh loss-aversion hit on
>   noise).
> - **No naked point-deltas.** [...]
> - **Attach a human rationale to notable events**, not a bare delta [...]
> - **Down is neutral, never red** — price wobble is not a decision.

The current rules govern *price* notifications and *delta display*, but say nothing about the four
non-price notification classes Cairn actually emits (tx-confirmed, backup-due, cosigner-needed,
system-health), nor about the push-vs-pull surface. A developer wiring any non-price notify hook today
has "batch and throttle" but no tiering rule.

**(b) Proposed wording delta — insert a new block after the "Never push … price" bullet:**

> - **Tier every notification by *actionability × time-criticality*, not by magnitude.** Cairn emits
>   four classes and they are not the same tier:
>   - **tx confirmed / received** — informational, not actionable, not urgent → **batch into a digest;
>     never an individual push.** (A confirmed tx is a growth signal, not an alarm; it is equally good
>     news in an evening digest.)
>   - **backup due / wallet unbacked** — actionable, not urgent (hours–days) → **in-app decaying nudge**
>     in Health's amber grammar (see the cadence rule below); never push.
>   - **cosigner: your signature is needed** — actionable, sometimes time-critical → the **only** class
>     that could justify near-real-time delivery, and only when a payment genuinely awaits this user.
>     (Whether it may *push* is the standing decision in the ratification sheet §II.)
>   - **system-health (node / Electrum / storage)** — rarely actionable → **fold into the Health object**
>     (surfaced at its three altitudes), not individual pings; a degraded state that self-heals never
>     notifies, only a persistent action-needing one surfaces.
> - **Default to pull, not push.** The account-menu bell-badge + notification panel is the **primary
>   notification surface** — an ambient, non-interrupting unread count the user checks at a breakpoint of
>   their own choosing. All batched classes live there. Push is the rare exception (the actionable-urgent
>   tier only), because every push costs the user resumption lag against, for most classes, near-zero
>   time-value.
> - **Backup-nudge cadence is state-driven, decaying, and polymorphic — never a metronome.** Surface once
>   at the earned moment (first meaningful balance), then re-surface at *widening* intervals; escalate
>   only on a stakes-raising state change (balance crosses a threshold, a second wallet goes unbacked),
>   not on the clock; vary the phrasing/illustration across re-surfacings; and cap it so it can never
>   become a per-session ritual. It stays amber attention, never red, never a modal.

**(c) Evidence trail:** R3 **F26** (only ~5–13% of alarms actionable; tier by consequence × time-to-
respond; non-actionable classes demote to informational/off), R3 **F27** (interruption/resumption-lag;
batched & breakpoint delivery beats constant delivery on workload/accuracy/strain; the spec's bell-badge
is already a pull surface). R2 **F16** (cadence decay + polymorphism; alarm-fatigue endpoint). Competitor
R2 **§5** (good-Umbrel-citizen: fold system-health into the platform/Health layer, don't ping in parallel).

**(d) Status: EVIDENCE-BACKED** for the taxonomy, the pull-default, and the cadence rule — all *implement*
the existing "batch and throttle" MUST rather than trade against it. **Carved-out rider (PENDING-ALEX):**
whether the cosigner-needed class may ever *push* is R3 §3.1 — see ratification sheet §II. The taxonomy
ships either way; only the cosigner row's push flag waits on that decision.

---

## Amendment 2 — §5: add an error/failure copy grammar (attribution-complete + retry-safety)

**Target:** §5 → confirmation-friction ladder, the closing error-copy line.

**(a) Exact current wording (the entire current rule on failure copy):**

> Error copy is specific and forward-looking, never a bare "failed" ("We paused this transfer to confirm
> it's you…").

One sentence and one example — no structural grammar, no guidance for the money-specific failures
(node-unreachable, rejected broadcast, Electrum disconnect, stale tip) that dominate a self-custody app.

**(b) Proposed wording delta — replace that single line with a named sub-rule:**

> **Failure copy is an attribution instrument (MUST).** After a money error a frightened user asks three
> questions — *whose fault?* (locus), *will it recur?* (stability), *can I fix it?* (controllability) —
> and an *unattributed* error is more corrosive than the breakage itself (an unresolved, uncaused failure
> drives materially higher abandonment even when nothing was lost). Every failure banner answers all three
> in the calm voice:
> - **Locus** — name whose layer it is, and steer blame away from both the user and their money: "this is
>   the connection to your node — not your bitcoin, and not something you did." Never a bare accusatory
>   verdict ("invalid," "illegal," "failed").
> - **Stability** — frame a transient event as one-off and self-healing ("reconnecting…"); frame a real
>   config problem as stable-until-fixed so the user acts.
> - **Controllability** — always a concrete next step, or a plain statement of what the app is already
>   doing about it.
> - **Retry-safety, for any irreversible-money failure (send / broadcast).** State the **fund-state** and
>   whether retry is safe, in plain words — "This payment was not sent. Nothing left your wallet — you can
>   safely try again." — because in an irreversible medium the paralyzing question is "did it half-send?
>   will retrying double-spend?" **Preserve the draft**; never dump the user to an empty create screen
>   (that reads as "my work and maybe my money vanished").
>
> *Degraded* (transient, self-healing, no user action possible) and *broken* (action-blocking, needs a
> decision) get different copy — and, once the color decision is made, different color.

**(c) Evidence trail:** R2 **F15** (NN/g heuristic 9: non-accusatory, plain, actionable banner grammar —
plain name · whose layer · funds safe · next step), R3 **F22** (Weiner attribution: locus/stability/
controllability map one-to-one onto the three post-error questions; self-blame vs "my funds are gone" is
the worst attribution to pre-empt), R3 **F23** (irreversible-money retry-ambiguity → freeze; preserve
work, state retry-safety), R2 **F14** (unattributed failure drives ~40% higher churn even when refunded).

**(d) Status: EVIDENCE-BACKED** for the *copy* grammar (locus/stability/controllability + retry-safety +
preserve-draft) — it implements NN/g canon and measured attribution results and needs no color decision.
**Carved-out rider (PENDING-ALEX):** the degraded-vs-broken **amber/red boundary** the stability dimension
implies is R2 §3.1 — see ratification sheet §II. Two rounds of research (R2 F14/F15, R3 F22) now depend on
that one boundary; its priority has effectively risen. The final sentence above is written to slot the
color rule in once decided.

---

## Amendment 3 — §1: name the trust anchor (mechanism + own node), and the reassurance-theater it is not

**Target:** §1 "Identity thesis".

**(a) Exact current wording (the close of §1):**

> Where Linear's tell is near-black luminance stacking and Mercury's is indigo-tinted neutrals,
> **Heartwood's tell is the serif living balance and the growth-rings.**

§1 carries the *visual* identity thesis. It never states the *trust* thesis — which matters because a
self-custody wallet has no company for the user to trust, so the manifesto's own restraint and its
own-node explorer are load-bearing trust surfaces, not just aesthetics.

**(b) Proposed wording delta — append one paragraph to §1:**

> **The trust thesis, stated once.** There is no company here to extend trust to — no institution holding
> funds, no brand standing behind the money. So trust must attach to the **mechanism** and to **the
> user's own competence**, never to a vendor-shaped surrogate. The own-node block explorer is the single
> strongest trust cue Heartwood has: "your node confirmed this" is the sovereign, *verifiable* analogue of
> a bank's logo — agency replacing guarantee. Integrity is read from plain-language honesty about what the
> tool does and does not do; competence is *demonstrated* (the visible signing mechanism, the own-node
> authority), never *asserted* (badges, seals, "bank-grade"). And because credibility is judged first by
> design look, the calm restraint of this whole document is itself read as competence before a word is
> parsed — the squint test (§6) is, in trust terms, a competence-cue test. The failure mode to avoid is
> the dark-pattern inverse: a trustworthy-*looking* surface that manufactures unwarranted confidence in a
> specific payment. Trust the mechanism; verify the transaction.

**(c) Evidence trail:** R3 **F20** (McKnight initial-trust model with the vendor removed — competence →
visible mechanism, integrity → transparency, structural assurance → own-node verified state; Fogg
prominence-interpretation → design-look-first is a competence cue), R3 **F21** (measured, crypto-specific:
64% trust a familiar interface over verifiable data; the app looking trustworthy makes users verify
*less*). Competitor R2 **§2/§3** (Green's and Envoy's concrete "we literally cannot read your backup" /
"you can recover even if we disappear" honesty beats generic "your data is safe").

**(d) Status: EVIDENCE-BACKED** in content (fully consistent with §7's existing badge-wall ban and §1's
own-node emphasis). **Minor placement judgment (ratification sheet §III):** §1 is the most load-bearing
section; Alex may prefer this paragraph live in §6 (as a test) or §7 (as an AVOID) rather than expand the
identity thesis. The *content* is safe; only *where it lands* is a call.

---

## Amendment 4 — §5: harden the send review into a first-person semantic-transparency verification act

**Target:** §5 → confirmation-friction ladder, the "High, irreversible — real money / broadcast a send"
row.

**(a) Exact current wording (the broadcast row):**

> | High, **irreversible — real money** | broadcast a send | **"Slide to send"** physical gesture on a
> review that restates amount + recipient as the hero. This is where the pain-of-paying *should* be felt —
> the act must register as intentional. Confident, not scary. |

The gesture is specified; the *content* of the review is only "restates amount + recipient as the hero."
The measured finding is that the gesture alone is not enough — a polished UI lets users slide through a
check they never actually performed.

**(b) Proposed wording delta — extend the row's treatment (and add a MUST note under the ladder):**

> …restates amount + recipient as the hero, **phrased as a first-person verification the user owns** —
> "Confirm this payment is going to the right place," not a generic "Review." Restate the destination as
> the *one* load-bearing fact being confirmed (grouped address, emphasized first/last characters —
> recognition, not recall), and surface the **own-node authority** as the competence cue ("your node will
> broadcast this"). The slide gesture forces intentionality; the *content* must carry the check.
>
> **(MUST) Semantic transparency, not reassurance.** Restate *intent* in human terms as the thing being
> confirmed — and keep it to the single load-bearing fact (where the money is going). Do **not** bury it
> under a data wall (transparency is an inverted U — too much explanation makes users follow a wrong
> output), and do **not** tip into reassurance-theater (seals, "bank-grade," badge walls) that manufactures
> unwarranted confidence. In multi-party (shared-wallet) signing, re-personalize the check *per signer* —
> each co-signer confirms "*you* are confirming this payment goes to [address]," with light maker-checker
> role differentiation (builder: "you entered this"; co-signer: "confirm the builder got this right") —
> because a second signer, absent assigned responsibility, checks *less*, not more.

**(c) Evidence trail:** R3 **F21** (measured: semantic transparency lifted correct identification
67.9%→84.2% *and lowered* mental demand; blind-signing is the attack vector; the goal is calibrated
appropriate reliance, not maximal trust), R3 **F20** (own-node as the competence cue; guardrail against the
reassurance-theater inverse), R2 **F11** (diffusion of responsibility: a second signer under-invests in the
address check unless it is *assigned*; inverse of banking four-eyes/maker-checker). Round-1 R2 recognition
aids referenced throughout both.

**(d) Status: EVIDENCE-BACKED.** F21 is a direct, quantitative, crypto-wallet-specific study — the
strongest single evidence base in the whole research line — and the multi-party re-personalization is
robust social psychology. Adding a MUST is a substantive strengthening; see ratification sheet §III if
Alex wants the "semantic transparency" MUST flagged as a deliberate elevation rather than mechanical.

---

## Amendment 5 — §5: add a risk-with-efficacy rule and just-in-time staging (PMT)

**Target:** §5 (new MUST sub-rule), with a pointer from §4 empty states.

**(a) Exact current wording (nearest existing doctrine — §4 empty states + §5 friction ladder's "plain
line"):**

> **Empty states.** One plain sentence + at most one action; never a spinner-wall, never a caveat wall […]
> Constructive and forward-looking, never a dead ledger […]

and, in the friction ladder:

> Gated subpage + one plain "what this does / does not do" line ("your funds are safe if you keep your
> backup").

The manifesto forbids caveat walls and models good risk copy by example, but states no *rule* for how to
teach self-custody risk without either terrifying or numbing the user.

**(b) Proposed wording delta — add a MUST sub-rule to §5:**

> ### Risk education — pair every risk with a doable action; stage it just-in-time (MUST)
>
> Self-custody's core lessons ("you are the bank; there is no reset button; lose the backup and it's
> gone") are fear appeals, and fear *without* an available coping action produces **defensive avoidance**
> — denial, fatalism, click-through — not caution. Efficacy is a stronger driver of protective behavior
> than threat.
> - **Never state a self-custody risk without an immediately-doable efficacy action in the same view.**
>   "No reset button" ships beside a verify-once "save it now"; the backup risk ships beside "Back up now";
>   any "you are the bank" line is followed by the specific protective step.
> - **Keep threat singular and calibrated** — one plain idea, never a wall of risk bullets (a risk wall
>   numbs and overloads; it is the §7 caveat-wall failure mode with the volume turned up).
> - **Stage the curriculum just-in-time, not front-loaded.** Attach each lesson to its teachable moment
>   with a present, actionable stake — "no reset button" at the recovery-phrase step; "back it up" at first
>   funds; "this address is only yours" at first receive; "a lost cosigner key can lock the funds" at
>   shared-wallet creation; "a spend is irreversible" at first send review. A front-loaded onboarding wall
>   spends its threat budget when the user has nothing at stake and no way to act — the numbing condition.

**(c) Evidence trail:** R3 **F24** (Protection Motivation Theory across two meta-analyses: self-efficacy is
the strongest predictor, stronger than threat; EPPM: high-threat/low-efficacy → fear-control/defensive
avoidance; the ~70% seed-phrase-backup dropoff is this mechanism; over-communicating risk numbs), R3
**F25** (just-in-time teachable-moment education outperforms front-loaded training; the teachable window is
brief). Competitor R2 **§4** (Liana's "explain graphically before commit" comprehension gate for
maximum-stakes setup) and **§2** (Green's honest "protects you from / doesn't protect you from" per-choice
framing).

**(d) Status: EVIDENCE-BACKED.** It codifies the mechanism *behind* the existing no-caveat-wall rule and
friction ladder rather than contradicting them; PMT is a mature literature.

---

## Amendment 6 — §7 AVOID: four additions (reassurance-theater, risk-without-efficacy, non-actionable push, front-loaded risk wall)

**Target:** §7 AVOID → "Fintech / anxiety failure modes".

**(a) Exact current wording (the relevant existing entries):**

> - **Push notifications on price** — prohibited.
> - **Badge-wall security theater** — no wall of lock/shield badges. Privacy is an active control, not a
>   reassurance banner.
> - **Compliance / caveat walls** — 4-bullet warnings, footnote-stacking under every control. One plain
>   sentence up top; detail one tap down.

**(b) Proposed wording delta — add four bullets:**

> - **Reassurance without mechanism** — "bank-grade security," seals, or any trustworthy-*looking* chrome
>   that manufactures confidence a mechanism doesn't earn. With no vendor to trust, the trust cue is the
>   visible mechanism and the own-node authority, never a vendor-shaped surrogate. (This is the
>   badge-wall's subtler cousin: it is about *transaction* over-trust, not just privacy theater.)
> - **Risk without an efficacy action** — a self-custody hazard stated with no immediately-doable next
>   step in the same view. Fear without a coping action produces avoidance, not caution; every risk line
>   carries its protective step.
> - **Front-loaded risk walls** — reciting every self-custody hazard in one onboarding sequence, before
>   the user has funds or a way to act. Stage each lesson to its teachable moment instead.
> - **Non-actionable push / notification-as-alarm** — pushing anything that isn't both actionable *and*
>   time-critical. A confirmed tx, a due backup, a self-healing degraded state: none of these interrupt;
>   they wait on the pull surface. Crying wolf on the non-actionable is how the one true alarm gets missed.

**(c) Evidence trail:** R3 **F20/F21** (reassurance-theater = the dark-pattern inverse of warranted trust),
R3 **F24/F25** (risk-without-efficacy; front-loaded numbing), R3 **F26/F27** (non-actionable push; alarm
fatigue). Competitor R2 **§7 guards** (no unglossed internals; no silent dependency; surface residual risk
before opt-in).

**(d) Status: EVIDENCE-BACKED.** Each is the AVOID-list restatement of a rule proposed above; adds no new
tradeoff.

---

## Amendment 7 — §6: add falsifiable trust, notification, and failure criteria to the Heartwood test

**Target:** §6 "The Heartwood test (falsifiable)".

**(a) Exact current wording (the test list's frame + the last existing test):**

> Shown a cropped screenshot, or run against a fixture — ship only if all pass:
> [tests 1–7 …]
> 7. **The two-themes-one-soul test.** […]

The test currently falsifies *visual* identity (squint, serif-balance, one-hero, color-count, red-day,
friction, two-themes). It has no falsifiable criterion for the trust, notification, or failure-copy
doctrine — the areas the research most strengthened.

**(b) Proposed wording delta — add tests 8–10:**

> 8. **The trust-anchor test.** On any trust-fragile surface (onboarding, first-deposit confirm, send
>    review), the trust cue is a visible mechanism or the own-node authority ("your node confirmed this"),
>    never a badge, seal, or "bank-grade" reassurance. A vendor-shaped trust surrogate fails. The send
>    review restates the destination as a first-person check ("confirm this is going to the right place"),
>    not a generic "Review."
> 9. **The pull-default / notification-tier test.** Run the four notification classes through a fixture:
>    tx-confirmed batches into the digest (no individual push), backup-due is an in-app decaying amber
>    nudge (no push), system-health folds into the Health object (no ping), and nothing price-related
>    notifies at all. Any individual push of a non-actionable class fails.
> 10. **The failure-attribution test.** Trigger a node-unreachable and a rejected-broadcast in a fixture.
>     Each banner names whose layer it is (not "your money," not "you"), says whether it's transient or
>     needs a change, and gives a next step; the broadcast failure states fund-state + retry-safety and
>     preserves the draft. A bare "failed"/"error," or a send failure that dumps to an empty create
>     screen, fails.

**(c) Evidence trail:** test 8 ← R3 F20/F21 + Amendments 3/4; test 9 ← R3 F26/F27 + Amendment 1; test 10 ←
R2 F15 + R3 F22/F23 + Amendment 2. These make the new doctrine falsifiable in the same register as the
existing red-day and friction-proportionality tests.

**(d) Status: EVIDENCE-BACKED** as written (each test asserts only the copy/architecture halves that are
themselves evidence-backed). **Carved-out rider:** tests 9 and 10 gain a *color* clause only once the
pending decisions land — e.g. test 10 could add "a reconnecting node shows amber, not red" after R2 §3.1,
and test 9 could add a tier-chip redundancy clause after R2 §3.2. Written to accept those clauses later.

---

## Amendment 8 — §7 AVOID (+ §1 nod): sovereignty-honesty guard for server-assisted / recovery features

**Target:** §7 AVOID → "Crypto clichés" or a short new "Sovereignty" group; forward-looking (governs
features not yet built: recovery, inheritance, collaborative custody, any server-assisted flow).

**(a) Exact current wording:** the manifesto has **no** doctrine on server-assisted trust tradeoffs — the
competitor round surfaced this as a gap Cairn will hit "the moment it offers *any* server-assisted
feature."

**(b) Proposed wording delta — add a short guard group:**

> **Sovereignty honesty (governs any future server-assisted, recovery, or shared-custody feature)**
> - **No silent third-party or cloud dependency.** A "magic" convenience must never quietly introduce a
>   cloud/vendor dependency; disclose it in plain language with a fully-local alternative on the same
>   screen. (Envoy's iCloud/Android reliance behind a "no seed words!" headline is the anti-pattern.)
> - **Server participation must degrade to self-custody.** Any server-assisted feature is a convenience
>   with an expiry date, never a permanent dependency — the honest template is "after N months you can
>   recover with your key alone, even if Cairn is gone" (Green's timelock-degrades-to-1-of-2). A permanent
>   third-party key cuts against the brand.
> - **Surface lockout / residual-risk consequences before opt-in, not in a help article.** Friction ∝
>   stakes: a maximum-stakes recovery choice deserves the consequence stated up front (Green's
>   under-communicated 1-year 2FA-reset cliff is the anti-pattern).
> - **Comprehension is the feature, shipped with the mechanism — not after it.** For maximum-stakes setup
>   (recovery, inheritance, shared wallet), ship the plain-language wizard *with* the primitive: named
>   templates ("Simple recovery," "Shared wallet," "Build your own"), a mandatory plain-diagram preview
>   before commit, and consistent primary-vs-recovery key coloring in the evergreen palette (recovery in a
>   distinct calm tone, never red unless destructive). Never ship the powerful primitive first and the UX
>   later (Liana's origin sin).

**(c) Evidence trail:** Competitor R2 **§2** (Green: timelock-degrades-to-self-custody; the honest
policy-chooser; the 2FA lockout cliff to avoid), **§3** (Envoy: encrypted-config-backup honesty; silent
cloud dependency to avoid), **§4** (Liana: templates + graphical-preview + color-coded key roles;
ship-UX-with-the-primitive), **§6** (Bitkey/Casa: abstracted quorum, but vendor-held key cuts against the
brand), **§7 guards** #1–#3. Reinforced by R3 **F20** (integrity = plain honesty about what the tool does).

**(d) Status: PENDING-ALEX (doctrine judgment call).** Unlike Amendments 1–7, this governs features that
do **not exist yet** (no recovery/inheritance story today). Enshrining doctrine ahead of the feature is a
deliberate call: it front-runs the build so the eventual wizard can't drift, but it also commits the
manifesto to product directions still on the roadmap. Competitor beads `cairn-u7vtd`, `cairn-givyl`,
`cairn-i16vl` already carry the buildable patterns; this amendment asks only whether their *doctrine
boundaries* enter the manifesto now or when the features land. **Recommendation: adopt the four guard
bullets now** (they are boundaries, not feature commitments — they constrain *how* any such feature must
behave without committing to build it), but this is Alex's call, not mechanical.

---

# Ratification sheet

A walk-down checklist. Check to ratify; ratified items then land in `docs/DESIGN-MANIFESTO.md` in a
separate pass. Nothing here edits the manifesto until checked.

## I. Mechanical / evidence-backed (safe to ratify as-is)

- [ ] **A1 — Notification taxonomy + pull-default + decaying backup cadence** (§5). Tier by actionability ×
      time-criticality; bell-badge is the primary pull surface. *(Carries the A1 rider in §II: cosigner
      push flag.)*
- [ ] **A2 — Error/failure copy grammar** (§5): attribution-complete (locus/stability/controllability) +
      retry-safety + preserve-draft. *(Carries the A2 rider in §II: degraded-vs-broken color.)*
- [ ] **A3 — Trust-anchor paragraph** (§1): mechanism + own-node as the trust anchor; not reassurance
      theater. *(See §III for the placement judgment: §1 vs §6/§7.)*
- [ ] **A4 — Semantic-transparency send review** (§5 broadcast row): first-person verification act +
      own-node cue + per-signer re-personalization. *(See §III if elevating "semantic transparency" to a
      MUST should be a deliberate flag.)*
- [ ] **A5 — Risk-with-efficacy + just-in-time staging** (§5 new MUST): pair every risk with a doable
      action; stage to teachable moments; threat singular.
- [ ] **A6 — Four AVOID additions** (§7): reassurance-without-mechanism, risk-without-efficacy,
      front-loaded risk wall, non-actionable push.
- [ ] **A7 — Heartwood test 8–10** (§6): trust-anchor, pull-default/notification-tier, failure-attribution.
      *(Color clauses in tests 9–10 land after the §II decisions.)*

## II. Standing pending decisions — present options + a recommendation; DECIDE THESE (not decided here)

Each blocks a carved-out rider above. Options are laid out neutrally; the recommendation is a lean, not a
decision.

- [ ] **P1 — Degraded-vs-broken color taxonomy (R2 §3.1).** *Blocks:* A2 color half, A7 test-10 color clause.
  - **A.** Boundary on *actionability + reversibility*: amber = degraded/transient/self-healing/no user
    action; red = broken/action-blocking/needs a decision. Move "node unreachable/down" to the correct
    side by *which* condition it is.
  - **B.** Keep both hues, add the existing salmon `--caution` as a middle tier only if QA finds A too binary.
  - **C.** No amendment; case-by-case per banner (guarantees drift).
  - **Recommendation: A** — it draws the one boundary two rounds of failure-copy work now depend on, reuses
    existing tokens, and matches doctrine (amber already = "expected swing, not error"; red = irrecoverable).
- [ ] **P2 — Non-color redundancy for semantic states (R2 §3.2).** *Blocks:* A7 test-9 tier-chip clause; the
      new notification tier-chips (A1) are exactly the hue-only surface this governs — decide before they're designed.
  - **A.** Minimal "no hue-only status": any state-bearing use of a semantic color carries a second cue
    (text or shape); balance/prose exempt (found by size, not hue). Plus retune `--caution` toward amber.
  - **B.** Full shape/icon token per semantic app-wide (most CVD-robust; risks iconography the minimalist
    identity avoids / caveat-wall feel).
  - **C.** No amendment; QA-only (leaves ~8% of male users guessing between opposite-meaning states; fails
    WCAG 1.4.1 where any hue-only indicator exists).
  - **Recommendation: A** — cheapest defensible fix, preserves the palette and the §6 color-count aesthetic,
    forbids only the lone colored dot; the `--caution` retune is already invited by the manifesto.
- [ ] **P3 — Is push ever allowed, or is Cairn pull-only? (R3 §3.1).** *Blocks:* A1 cosigner-needed push flag.
  - **A.** Pull-only (strict): no push ever; all classes on the bell-badge. Simplest, most interruption-
    respecting; risk = a rarely-opening cosigner is slow to sign, extending the other party's waiting anxiety.
  - **B.** Pull-only + one opt-in exception: default pull, user may opt in to a single push class ("tell me
    when someone needs my signature"), rate-limited. Preserves the default, gives the one high-value interrupt.
  - **C.** Case-by-case per hook (guarantees drift; eventual price-push-adjacent mistake).
  - **Recommendation: B** — keeps the pull default the interruption literature demands while honoring the one
    genuinely actionable-and-urgent class; the rate-limit shares R2 R11's remind discipline.
- [ ] **P4 — USD-vs-sats default (`cairn-4vh2a`).** *Note:* the manifesto's §3 rule 3 currently makes
      **sats-first a MUST** ("the single most load-bearing rule in the manifesto"), fiat-primary toggle **off
      by default**. A USD default is a **doctrine-level reversal**, not a tweak — surfaced here because Alex
      flagged it.
  - **A.** Keep sats-first default (status quo): every glance is a growth signal; a fiat-hero pays the ~2×
    myopic-loss-aversion penalty on price noise.
  - **B.** USD-first default: matches mainstream mental model / lowers first-run confusion for fiat-native
    users; contradicts the §3 MUST and the whole growth-only-motion / no-red-day thesis it anchors.
  - **C.** Locale/first-run-choice default: ask once at onboarding, remember the choice; splits the difference
    but adds an onboarding decision and can still land a fiat-hero for savers.
  - **Recommendation: A** — the sats-first MUST is load-bearing for §3, §5 motion, and the red-day test; B
    would cascade through multiple sections. But this is squarely Alex's doctrine call and is **not decided
    here.** If B or C is chosen, it triggers a coordinated multi-section amendment, not a one-line flip.

## III. New judgment calls surfaced here (not in the standing pending set)

- [ ] **J1 — Placement of the trust thesis (A3).** Expand §1 (identity thesis — most load-bearing section),
      or place the same content in §6 (as test 8's rationale) / §7 (as an AVOID)? *Lean: a short paragraph in
      §1 plus test 8 in §6 — the thesis deserves a home, the test makes it falsifiable.*
- [ ] **J2 — Elevate "semantic transparency" to a named MUST (A4)?** F21 is the strongest measured evidence
      in the research line, which argues for MUST-level; but it adds a second MUST to the broadcast flow.
      *Lean: yes, MUST — the measured 67.9%→84.2% lift on the single highest-stakes screen earns it.*
- [ ] **J3 — Adopt the sovereignty-honesty guard now, ahead of the features (A8)?** The four guard bullets
      constrain *how* any future recovery/server-assisted feature behaves without committing to build it.
      *Lean: adopt now as boundaries — cheap insurance against Liana's "primitive first, UX later" drift —
      but it is a forward-looking doctrine call, hence PENDING-ALEX.*
- [ ] **J4 — (Optional, low-stakes) Graduated-upgrade / first-week-clean as doctrine?** Competitor Zeus steal
      + spec §1: advanced capability (multisig, recovery, collaborative custody) is an *earned next step*
      surfaced to tenured funded users, never an onboarding fork. *Lean: fits §5/§9 as a one-line principle;
      minor enough to defer or fold into the spec rather than the manifesto.*

---

*End of proposals. No git commit performed; no other files created or modified.*
