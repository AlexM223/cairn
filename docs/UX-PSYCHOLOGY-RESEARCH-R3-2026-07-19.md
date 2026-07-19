# UX Psychology Research — Round 3 — 2026-07-19

Third research pass in the ongoing line. Round 1 (`docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md`,
findings F1–F10 → improvements R1–R9) and Round 2 (`docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md`,
findings F11–F19 → improvements R10–R16) established the foundation. This round continues that
numbering: findings **F20–F27**, improvements **R17–R23**. It goes deep on four areas the first two
rounds under-explored: (1) **trust-building** in a wallet with no company to trust, (2) **error-message
psychology** below R2's F15 banner-grammar — the attribution layer, (3) **progressive disclosure of
self-custody risk** without either terrifying or numbing, and (4) **notification fatigue** below R2's
F16 cadence-decay — severity-tiering, actionability, and interruption cost.

Doctrine context unchanged: `docs/DESIGN-MANIFESTO.md` (evergreen identity, sats-first MUSTs, the
friction ladder, growth-only motion, semantic-color language, no-caveat-wall / no-badge-wall) and
`docs/UX-REDESIGN-SPEC.md` (epic cairn-gt05, 3-tier disclosure, the Health object surfaced at three
altitudes, the account-menu bell for notifications).

**Source-quality note.** Same preference order as rounds 1–2: peer-reviewed > NN/g and equivalent
research orgs > practitioner writeups (direction only, never magnitude). This round is **better-sourced
than R2's thinnest topics** because two of the four areas have mature primary literatures (protection
motivation theory; alarm fatigue / interruption cost), and — unusually — topic 1 has a **2026
crypto-wallet-specific primary study** ("What I Sign Is Not What I See") that measures the exact
verification-trust behavior at issue, rather than forcing an extrapolation from adjacent fields.
Where a claim rests on practitioner numbers (error-abandonment magnitudes, onboarding-dropoff
percentages) it is flagged inline and treated as direction only.

**Dependencies on pending decisions.** Two color-doctrine questions from R2 are still **PENDING ALEX**
(R2 §3.1 degraded-vs-broken amber/red taxonomy; R2 §3.2 non-color-redundancy) and one unit question
(USD-vs-sats default, bead `cairn-4vh2a`). This round's error-grammar finding (F22) leans on the R2
§3.1 taxonomy; anything downstream of it is marked **PENDING-ALEX** and is not re-filed as a bead.

---

## Executive summary

- **In a self-custody wallet there is no company to extend trust to — so trust must attach to the
  *mechanism* and to *the user's own competence*, not to a brand (F20).** McKnight's trust model
  (competence / benevolence / integrity + "structural assurance") was built for an e-commerce *vendor*;
  strip the vendor out and two of its pillars have nowhere to land. The replacement structural
  assurance is the **own-node block explorer and the visible signing mechanism** — "your node
  confirmed this" is the sovereign analogue of a bank's logo. And because credibility is judged first
  by *design look* (Fogg's prominence-interpretation), the manifesto's calm, considered restraint is
  itself a competence cue, not just aesthetics.

- **The single most dangerous trust failure is measured, crypto-specific, and points the opposite way
  from intuition (F21): users trust a *familiar interface* over *verifiable data* — 64% in a 2026
  wallet study — and interface-familiarity actively *substitutes* for checking the recipient.** This
  is the mechanism beneath R1's wrong-paste (F5) and R2's diffusion-of-responsibility (F11): the app
  looking trustworthy makes users check *less*. The fix is "semantic transparency" — restate the
  intent as the thing being confirmed — which lifted correct-identification from 67.9% to 84.2% in
  that study. Cairn's shipped review-restates-recipient pattern is exactly right and should be
  hardened into a deliberate, first-person verification act — **not** a reassurance banner, which is
  the dark-pattern inverse (trust without trustworthiness).

- **Error copy is an attribution instrument (F22).** After a money error a scared user asks three
  questions that map one-to-one onto Weiner's attribution dimensions: *whose fault?* (locus), *will it
  happen again?* (stability), *can I fix it?* (controllability). Self-serving bias pushes users to
  blame the app; the money context pushes them toward the worse fear — that they broke it or lost
  funds. R2's F15 fixed the banner *grammar*; F22 supplies the *why* and a copy structure that answers
  all three questions and pre-empts self-blame.

- **In an irreversible-money context the after-failure question is "is it safe to try again?" and
  silence there causes freeze (F23).** Error frustration converts to abandonment when there is no
  clear forward path; the money-specific twist is fear of *retry* ("did it half-send? will retrying
  double-spend?"). Every send/broadcast failure must state fund-state and retry-safety explicitly and
  preserve the draft. This is the genuinely-new, **non-color** half of failure copy (the color rule
  stays R2 §3.1 PENDING-ALEX).

- **Teaching "you are the bank, there is no reset button" fails if it's fear without efficacy (F24).**
  Protection Motivation Theory's most robust result — across two meta-analyses — is that **efficacy is
  a stronger predictor than threat**, and fear *without* an available, do-able coping action produces
  *defensive avoidance*: denial, fatalism, message-avoidance. That is the mechanism behind the
  ~70%-cited seed-phrase-backup dropoff. Every risk line must carry an immediately-doable action;
  never a wall of risk bullets (numbing/overload).

- **Don't front-load the risk curriculum — distribute it across teachable moments (F25).**
  Just-in-time education delivered at the moment of relevance outperforms front-loaded training and the
  teachable window is brief. "No reset button" belongs at the recovery-phrase step; "back it up" at
  first funds; "a lost cosigner key can lock funds" at shared-wallet creation. This is the *staging*
  answer that keeps F24's efficacy-pairing from collapsing into one overwhelming onboarding wall.

- **Notification fatigue is governed by actionability and severity, not just cadence (F26).** Only
  ~5–13% of clinical alarms are actionable; the fix is tiering by *consequence × time-to-respond*, not
  by deviation magnitude. Cairn's four notification classes (tx / backup / cosigner / system-health)
  are different tiers and must be treated differently: batch the non-actionable, nudge the
  actionable-not-urgent in-app, reserve anything near-real-time for the rare actionable-*and*-urgent
  case. System-health should fold into the Health object, not ping.

- **Every notification also costs interruption, and the wallet's "task" is the user's life (F27).**
  Resumption-lag research shows batched and breakpoint-timed delivery beats constant delivery on
  workload, accuracy, and strain. A wallet that pings mid-life pays a real cognitive cost for
  near-zero value. The spec's avatar-bell-badge is already a **pull** surface; endorse it as the home
  for batched classes and keep push for the rare exception only.

**New doctrine-decision candidate (laid out neutrally in §3, not decided):** the manifesto bans push
notifications *on price* but is silent on whether push is *ever* allowed. F26 needs a boundary —
is a genuinely actionable, time-critical event (a cosigner action truly required) allowed to push, or
is Cairn pull-only? That is a one-line doctrine clarification, prepared for decision.

---

## 1. Findings

### F20 — With no company to trust, trust must attach to the mechanism and to the user's own competence

**Confidence: high on the mechanism transfer; medium on the specific mapping to self-custody (reasoned,
not measured).**

McKnight's canonical initial-trust model decomposes trust into three **trusting beliefs** —
**competence, benevolence, integrity** — plus **structural assurance** (the belief that the environment
is safe because of guarantees, regulations, or a reputable institution standing behind it). It was
built for an e-commerce **vendor**: the beliefs are beliefs *about the vendor*, and structural
assurance is largely *supplied by the vendor's institution* (the bank's charter, the platform's
escrow, the brand's reputation). Fogg's **prominence-interpretation theory** adds the front door:
credibility is assessed by first *noticing* an element (prominence) then *judging* it (interpretation),
and the element noticed most often is the **design look** — layout, typography, whitespace, color —
ahead of information structure and stated motive.

A self-hosted, self-custody wallet **removes the vendor**. There is no company holding funds, no
institution whose reputation is the structural assurance, often no brand the user has heard of. Two of
McKnight's pillars have nowhere to land in their original form — and the naïve response (manufacture a
vendor-shaped trust surrogate: badges, seals, "bank-grade security" copy) is precisely the dark pattern
F21 warns against. The trust has to re-anchor:

- **Competence → the mechanism's competence, made visible.** The trustee is no longer a company; it is
  *the tool + the user's own keys + the user's own node*. Competence is demonstrated, not asserted:
  the block explorer pointed at **your** node (the manifesto's "sovereignty payoff") is the single
  strongest competence cue Cairn has — "your node confirmed this" is the self-custody analogue of an
  institutional logo, except it is *verifiable* rather than *reputational*. The "how this wallet signs"
  static line (spec §2.2: "Cairn holds only your public key; you approve each payment on your device")
  is a competence-of-mechanism statement.
- **Integrity → transparency of mechanism.** Integrity, absent a brand, is read from whether the tool
  does what it says and hides nothing load-bearing. Plain-language honesty ("this only stops Cairn
  tracking it; your funds are safe if you keep your backup") *is* the integrity signal.
- **Structural assurance → the user's own verified state, not an institution's guarantee.** The
  sovereign substitute for "the bank stands behind this" is "you can check this yourself, against your
  own node, any time." Agency replaces guarantee. (This is why R2's F17 answer to first-deposit anxiety
  was *agency, not reassurance* — same root.)
- **Fogg's design-look-first result** means the manifesto's restraint is not decoration: a calm,
  considered, non-crypto-cliché surface is *read as competence* before a single word is parsed. The
  "squint test" (manifesto §6) is, in trust terms, a competence-cue test.

- https://verdi.cs.ucl.ac.uk/constructDB/publications/mcknight-impact-2002.html (McKnight et al. 2002, initial-trust constructs)
- https://aisel.aisnet.org/jais/vol16/iss10/1/ (Lankton, McKnight & Tripp 2015 — human-like vs system-like trust constructs for technology)
- https://credibility.stanford.edu/pdf/PITheory.pdf ; https://www.nngroup.com/articles/prominence-interpretation-theory/ (Fogg prominence-interpretation)

**Design implication:** treat the **own-node explorer, the signing-mechanism line, and plain-language
integrity copy as the trust anchors** that a brand would otherwise carry — surface them at
trust-fragile moments (onboarding, first-deposit confirm, send review). Do **not** replace the missing
vendor with vendor-shaped reassurance (seals/badges/"bank-grade" — manifesto already bans badge-wall
theater). See R17 (own-node cue on confirms) and R23 (competence-cue audit).

*Literature note:* the McKnight/Fogg transfer to *self-custody specifically* is reasoned, not measured
— there is no initial-trust study of vendorless self-hosted wallets (searched). The mechanism is
robust; the exact mapping of "structural assurance → own-node verification" is an inference and is
flagged as such.

### F21 — Interface-familiarity substitutes for verification — the app looking trustworthy makes users check *less*

**Confidence: high — this round has a direct, quantitative, crypto-wallet primary study.**

The most important single result of this round, because it is measured in the exact context and it
points *against* intuition. In a 2026 study of crypto-wallet signing ("What I Sign Is Not What I See"),
when asked what they rely on to decide a transaction is safe, **64% of users trusted a familiar wallet
interface or a recognizable brand, while only 32% relied on verifiable contract/transaction data.**
At the surface, **78% checked the token amount and 71% the recipient address**, but attention was
shallow and selective, and **blind signing — approving opaque payloads without understanding — is
named a major attack vector.** The study's intervention, **"semantic transparency"** (reconstruct and
restate the *intent* of what is being signed, in human terms, before confirmation), lifted correct
identification of a transaction's real effect **from 67.9% to 84.2%** and *lowered* NASA-TLX mental
demand (from 67.8 to 42.6) — comprehension went **up** while effort went **down**.

The mechanism is the dangerous part: **a trustworthy-*looking* interface is consumed as evidence that
the transaction is safe**, so polish substitutes for verification. This is the same root as R1's
wrong-paste (F5) and R2's diffusion of responsibility (F11), now with a number on it — and it collides
head-on with F20, because the very competence cues that build *warranted* trust in the tool can, if
misapplied to the *transaction*, buy *unwarranted* trust in a specific payment. The distinction the
trust-calibration literature draws is exactly this: the goal is **appropriate reliance**, not maximal
trust; over-trust ("so impressed by the system they cease monitoring its outputs") is a failure mode,
and confident, reassuring presentation can *increase* over-reliance by reducing friction and critical
reflection.

The counter-pressure is that transparency is **not monotonic**: trust vs transparency follows an
**inverted U** — too much explanation causes information overload and can make users *follow a wrong
output*, and feature-dump explanations "are particularly prone to misleading users." So the answer is
not "show everything"; it is "restate the *one* load-bearing fact (where the money is going) as the
thing being confirmed," not bury it under a data wall (which the manifesto's no-caveat-wall rule
already forbids).

- https://arxiv.org/html/2601.16751 ("What I Sign Is Not What I See," 2026 — 64% interface-trust; 78/71% surface check; semantic transparency 67.9%→84.2%)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9023880/ (how transparency modulates trust — inverted-U, explanations can backfire)
- https://arxiv.org/pdf/2312.02034 (trust, distrust, appropriate reliance — over-trust vs disuse; the goal is calibration, not maximal trust)

**Design implication:** the send **review** must be a *deliberate, first-person verification act*, not a
confirmation-shaped speed bump the polished UI lets people click through. Restate the destination as
"confirm this payment is going to the right place" (semantic transparency), reuse R1's R2 recognition
aids (grouped address, emphasized ends), and surface the own-node authority (F20) as the competence
cue — **without** tipping into reassurance-theater that manufactures unwarranted confidence. The
slide-to-send gesture (manifesto friction ladder) already forces intentionality; F21 says the *content*
of the review, not just the gesture, has to carry the check. See R17.

### F22 — Error copy is an attribution instrument: answer whose-fault, will-it-recur, can-I-fix-it

**Confidence: high on the attribution framework and the non-accusatory canon; medium on the exact
three-question mapping (a synthesis, well-grounded but my framing).**

R2's F15 fixed the *grammar* of a failure banner (plain name · whose layer · funds safe · next step).
F22 supplies the psychological *why* and a sharper structure. Weiner's attribution theory decomposes a
causal explanation along three dimensions — **locus** (internal/self vs external/system), **stability**
(one-off vs recurring), **controllability** (fixable vs not) — and these are precisely the three
questions a frightened user asks after a money error:

1. **Locus — "Is this my fault or the app's?"** Self-serving / self-attribution bias predicts users
   will *default to blaming the system* for a failure (external locus protects self-esteem) — but in a
   self-custody money context the competing, worse fear is *self-blame*: "did I do something
   irreversible?" NN/g's canon is unambiguous: never blame the user (avoid "invalid," "illegal,"
   "incorrect," "failed" as bare verdicts), because accusatory phrasing makes users feel stupid and
   raises drop-off. The self-custody addition: the copy must also steer blame *away from "your money"*
   — the worst attribution is not "I'm dumb," it's "my funds are gone."
2. **Stability — "Will this keep happening?"** A transient event ("reconnecting to your node") must be
   framed as *unstable/one-off* so the user doesn't conclude the tool is chronically broken; a genuine
   config problem should be framed as stable-until-fixed so they act.
3. **Controllability — "Can I fix it, and how?"** Every error must offer a constructive next step
   (Nielsen heuristic #9); an error with no controllable action is the one that produces the fatalism
   F24 describes.

The R2 F14 result reinforces this: **unresolved errors with no identified cause drove ~40% higher churn
even when refunded** — an *unattributed* error is more corrosive than the breakage, because the user's
mind fills the locus/stability vacuum with the worst explanation.

- https://www.nngroup.com/articles/error-message-guidelines/ (non-accusatory, plain, actionable)
- https://www.biorxiv.org/content/10.1101/2025.03.18.644058.full.pdf ("Blaming Luck, Claiming Skill" — self-attribution bias in error assignment)
- https://uxmag.com/articles/who-is-to-blame (software-blaming vs self-blaming; locus of control in UI failures)

**Design implication:** extend R2's banner grammar into an **attribution-complete** template that
answers all three questions explicitly — locus ("this is the connection to your node, not your money
and not something you did"), stability ("temporary" vs "needs a change"), controllability (the next
step). The *copy* is buildable now; the **degraded-vs-broken color** that stability implies is R2 §3.1
and stays **PENDING-ALEX**. See R18.

### F23 — In irreversible-money contexts the after-failure question is "is it safe to try again?"

**Confidence: medium-high — error-aversion/abandonment direction is well-established; the retry-fear
specificity is reasoned from the irreversibility context.**

Error messages are "critical moments … where users are most vulnerable to frustration and abandonment";
when users feel blocked with no clear path forward, frustration "quickly turns into abandonment," and a
single error message "can make the difference between retrying and abandoning." The established recovery
pattern is three-part: **show the problem in context, preserve the user's work, provide a clear next
action.** The self-custody twist is a fear the generic literature doesn't carry: **retry ambiguity in
an irreversible medium.** After a failed send the user doesn't just wonder "what went wrong" — they
wonder *"did it partly go through? if I press send again, will I pay twice?"* Because Bitcoin payments
are irreversible and a double-broadcast is a real (if usually harmless due to same-inputs) fear in a
novice's mind, an error that fails to state **fund-state** and **retry-safety** leaves the user frozen
between two scary options: retry (maybe double-spend) or abandon (maybe the money is in limbo).

This compounds F24's efficacy point: an error with an *ambiguous* recovery action has effectively **low
response-efficacy**, which is exactly the condition that produces defensive avoidance rather than a
clean retry.

- https://www.nngroup.com/articles/error-message-guidelines/ (recover: preserve work, clear next action)
- https://www.uxtigers.com/post/heuristic-9-error-messages (Nielsen heuristic 9 — errors as abandonment points)
- (Abandonment/retry magnitudes are practitioner-sourced — direction only.)

**Design implication:** every send/broadcast failure states the fund-state and whether retry is safe in
plain words — "*This payment was not sent. Nothing left your wallet — you can safely try again.*" — and
**preserves the draft** (never dumps the user back to an empty create screen, which reads as "your work
and maybe your money vanished"). Buildable now, non-color. See R19 (filed).

### F24 — Teaching self-custody risk is fear-appeal design: fear without efficacy produces avoidance, not caution

**Confidence: high — two PMT meta-analyses plus EPPM neuroscience; the seed-phrase-dropoff magnitude is
practitioner-sourced (direction corroborated).**

Self-custody's core lesson — *you are the bank; there is no reset button; lose the backup and the money
is gone* — is a textbook **fear appeal**, and fear appeals have a mature, unforgiving literature.
**Protection Motivation Theory** (Rogers) says protective behavior follows from two appraisals: **threat
appraisal** (how bad / how likely) and **coping appraisal** (is there an effective response —
*response-efficacy* — and can *I* do it — *self-efficacy*). The most robust, replicated result across
two meta-analyses (Floyd et al. ~65 studies; Milne et al. ~27 studies; and infosec-specific two-stage
meta-analyses) is that **self-efficacy is the strongest, most consistent PMT predictor — stronger than
threat.** The **Extended Parallel Process Model** sharpens the failure mode: when threat is high but
efficacy is low, people switch from *danger control* (adaptive: do the protective thing) to *fear
control* (maladaptive: denial, fatalism, reactance, **defensive avoidance**) — and neuroscience shows
people literally *shift attention away* from self-relevant threatening information when they feel they
can't act on it.

This is the mechanism beneath the widely-cited **~70% self-custody onboarding dropoff concentrated at
the seed-phrase-backup step**: the moment presents maximal threat ("remember these 12 words forever or
lose everything") with minimal, unclear efficacy ("...store them safely" — *how?*), and users respond
exactly as EPPM predicts — they bail, or they click through in denial. Over-communicating the risk
makes it *worse*: risk-communication research warns that **more information can cause overload,
emotional numbing, and increased anxiety**, not more caution.

- https://www.researchgate.net/publication/222055931 (Rogers — PMT / self-efficacy revised theory of fear appeals)
- https://www.researchgate.net/publication/292677114 (PMT & information-security behaviour meta-analysis — efficacy strongest) ; https://www.researchgate.net/publication/369943863 (two-stage fear-appeal meta-analysis, infosec)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC4286019/ (neuroscientific evidence for defensive avoidance of fear appeals) ; https://pmc.ncbi.nlm.nih.gov/articles/PMC8500063/ (insufficiency → avoidance)
- https://aaltodoc.aalto.fi/bitstreams/c57c8b11-c860-4cb9-a193-6010ab956481/download (self-custody wallet usability — seed-phrase anxiety/dropoff) ; https://dl.acm.org/doi/10.1145/3576915.3623218 (mental models & multi-device wallets, ACM CCS 2023)

**Design implication:** **never state a self-custody risk without an immediately-doable efficacy action
attached in the same view.** The recovery-phrase step pairs "there is no reset button" with a concrete,
verify-once "save it now" flow; the backup nudge pairs the risk with "Back up now"; any "you are the
bank" copy is followed by the specific protective step. Keep threat calibrated and *singular* — one
plain idea, never a wall of risk bullets (numbing). This is *why* the manifesto's no-caveat-wall rule
and friction ladder are correct; PMT is the mechanism. See R20 (filed).

### F25 — Distribute the risk curriculum across teachable moments; don't front-load it into an onboarding wall

**Confidence: medium-high — just-in-time intervention evidence is solid; the full staging plan is a
reasoned synthesis.**

F24 says *pair risk with efficacy*; F25 says *when*. **Just-in-time, teachable-moment education** —
delivered at the moment of relevance rather than front-loaded — has direct evidence: a controlled study
found just-in-time feedback delivered *immediately after* a user fell for a simulated phish reduced
susceptibility to a later phish; contextual micro-training at the moment of failure is reported to
sustain 60–80% improvement where generic front-loaded training does not, and the teachable window is
**brief** (the lesson must arrive *at* the moment, not before or long after). Front-loading, by
contrast, is the numbing/overload condition of F24 — an onboarding sequence that recites every
self-custody hazard up front spends its threat budget when the user has *no funds at stake and no way
to act*, so it produces avoidance and is forgotten by the time it matters.

Applied to Cairn, the self-custody "curriculum" has natural teachable moments, each with a *present,
actionable* stake:

| Lesson | Teachable moment | Paired efficacy action |
|---|---|---|
| "There's no reset button — this phrase is the only recovery" | recovery-phrase step (during wallet creation) | verify-once "save it now" |
| "Back it up now that there's real money here" | first funds arrive / balance crosses a threshold | "Back up now" (ties R2 R14 / gt05.5) |
| "This address is only yours to receive on" | first Receive | own-node/mechanism microcopy (R2 R15 / gt05.6) |
| "A lost cosigner key can lock the funds for everyone" | shared-wallet (multisig) creation | roster/threshold explanation, backup-each-key step |
| "A spend is irreversible" | first send review | the slide gesture + semantic-transparency check (F21) |

- https://www.cambridge.org/core/product/4F5DF23A7AB0DC81561A1778E06802E2/core-reader (just-in-time phishing feedback at the teachable moment reduces repeat susceptibility)
- https://www.researchgate.net/publication/383955604 (same — just-in-time intervention improves online security)

**Design implication:** move the self-custody risk lessons **out of a front-loaded onboarding wall** and
attach each to its teachable moment, short (one plain idea) and efficacy-paired (F24). This is the
*staging* that keeps F24 from collapsing into overload. Spans several surfaces (onboarding,
first-deposit, receive, multisig creation, send). See R21 (filed).

### F26 — Notification fatigue is governed by actionability and severity-tiering, not cadence alone

**Confidence: high — mature alarm-fatigue literature with quantified actionability rates.**

R2's F16 covered cadence *decay* (habituation, the metronome problem). F26 goes to the structural cause
the medical/industrial alarm literature identifies: **most alarms are non-actionable, and treating all
alarms alike is what desensitizes people to the actionable ones.** In clinical settings **only ~5–13% of
alarms are actionable**; the remedy is not "fewer" in the abstract but **tiering by consequence ×
time-to-respond** (not by deviation magnitude), so that "truly time-critical events interrupt
immediately while lower-priority messages are routed more appropriately," and **non-actionable classes
are demoted to informational or off.** The failure mode (R2 F16's alarm-fatigue endpoint) is the direct
consequence of *not* tiering: cry-wolf on the non-actionable and the one true alarm is missed.

Cairn emits four notification classes, and they are **not the same tier**:

| Class | Actionable? | Time-critical? | Tier / treatment |
|---|---|---|---|
| **tx confirmed / received** | No (informational) | No | **Batch / digest.** A growth signal, not an alarm. Never individual push. |
| **backup due / wallet unbacked** | Yes | No (hours–days) | In-app nudge, **decay cadence** (R2 R14 / gt05.5). No push. |
| **cosigner: your signature is needed** | **Yes** | **Sometimes** (a pending payment awaits you) | The **only** class that might justify near-real-time — and only if genuinely awaited. Otherwise in-app. (PENDING-ALEX push question, §3.) |
| **system-health (node/Electrum/storage)** | Sometimes | Rarely | **Fold into the Health object** (spec §2.6b), not individual pings. Degraded self-heals; only a persistent, action-needing state surfaces. |

Notice this *already aligns* with existing doctrine: price notifications are banned (manifesto — the
ultimate non-actionable class); the Health object is designed to aggregate system-health at three
altitudes rather than ping. F26 generalizes that instinct into an explicit **severity × actionability
matrix** across all four classes.

- https://array.aami.org/doi/full/10.2345/0899-8205-54.1.12 (AAMI "Right Alert, Right Time" — clinically meaningful, actionable alarms; tier by consequence)
- https://amsn.org/AMP_EDN/833/ (reducing non-actionable alarms; demote to informational/off)
- https://www.ncbi.nlm.nih.gov/books/NBK555522/ (alarm-fatigue review — non-actionable rates, desensitization; via R2 F16)

**Design implication:** build a **notification taxonomy** keyed to (actionable? × time-critical?):
batch/digest the non-actionable (tx), decay-nudge the actionable-not-urgent (backup), fold system-health
into Health, and treat cosigner-needed as the single candidate for near-real-time — pending the §3
push-boundary decision. See R22 (filed).

### F27 — Every notification costs interruption; the wallet's "task" is the user's life, so default to pull

**Confidence: high — interruption-cost / resumption-lag literature is well-established.**

Even a *perfectly targeted* notification isn't free: interrupting a task incurs **resumption lag** — the
time to reload the interrupted task into working memory — and cumulative interruptions raise cognitive
workload and error rates. Controlled results converge: **constant notification delivery raised workload
(NASA-TLX), lowered heart-rate variability, and worsened accuracy versus 15-minute batching**; batching
to a few times a day **improved end-of-day productivity** (moderate effect); and delivering at
**breakpoints** (natural task boundaries) reduces resumption lag, frustration, and errors versus
interrupting mid-task. The wallet-specific reframe: unlike a work app where the interrupted task is
*also on the screen*, a wallet's user is usually interrupted **mid-life** — so a push pays the full
interruption cost against, for most classes, near-zero time-value (a tx that confirmed is equally good
news in a batched evening digest).

The design consequence is a **default to pull over push**: let the user *come to* the information at a
breakpoint of their choosing. The spec's **avatar bell-badge** (§2.7) is exactly a pull surface — an
ambient, non-interrupting unread count the user checks when *they* are at a breakpoint — and the
notification panel is a digest. That architecture is already the right shape; F27 says lean into it:
push is the rare exception (the actionable-urgent tier of F26), pull is the default home for everything
else.

- https://interruptions.net/literature/Iqbal-CHI08.pdf (Iqbal & Bailey — intelligent notification management; batching/deferral to breakpoints)
- https://www.interruptions.net/literature/Altmann-CogSci04.pdf (Altmann & Trafton — resumption lag, memory-for-goals)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/ (task-interruption from app notifications — strain & performance; constant vs 15-min batch)
- https://www.mdpi.com/2076-3417/8/10/1780 (interruption cost by workload & performance across coordination modes)

**Design implication:** treat the **avatar bell-badge + notification panel as the primary (pull)
surface** and route all batched classes there; reserve push for the F26 actionable-urgent exception
only. This is the interruption-cost complement to F26's severity tiering — same taxonomy, seen from the
cost side. Folded into R22.

---

## 2. Prioritized improvements

Effort: **S** ≤ 1 day, **M** ≈ 2–4 days, **L** ≥ 1 week. "Requires doctrine amendment" flags whether
the item needs a Manifesto change or is blocked on an R2 PENDING-ALEX decision.

| # | Improvement | Finding | Effort | Touches | Doctrine / pending |
|---|---|---|---|---|---|
| R17 | Semantic-transparency send review + own-node trust anchor | F20, F21 | **S/M** | ReviewDisplay, send review/sign, first-deposit confirm | **No** — filed gt05.11 |
| R18 | Attribution-complete failure grammar (locus/stability/controllability) | F22 | **S/M** | node/broadcast/Electrum banners | **Pending** — R2 §3.1 color (not re-filed) |
| R19 | Retry-safety statement on send/broadcast failures | F23 | **S** | send state machine error paths | **No** — filed gt05.7 |
| R20 | Pair every self-custody risk line with a doable efficacy action (PMT) | F24 | **M** | recovery-phrase step, backup nudge | **No** — filed gt05.8 |
| R21 | Distribute risk curriculum across teachable moments | F25 | **M/L** | onboarding, first-deposit, receive, multisig create, send | **No** — filed gt05.10 |
| R22 | Notification severity × actionability taxonomy (batch/pull default) | F26, F27 | **M** | notify scheduler, Health aggregation, notification panel | **No** — filed gt05.9 (+ §3 push candidate) |
| R23 | Competence-cue audit — own-node/mechanism as the trust anchor | F20 | **S** | first-deposit, receive, explorer, wallet-detail | **No** — folded into R17 |

### R17 — Semantic-transparency send review + own-node trust anchor (S/M) — *do this first*

F20 + F21: interface-familiarity substitutes for verification (64% trust the interface over the data);
semantic transparency lifts correct identification 67.9%→84.2%. The shipped `ReviewDisplay` already
restates amount + recipient as the hero — harden it into a **deliberate first-person verification act**:
- Phrase the review as a check the user *owns*: "Confirm this payment is going to the right place" —
  not a generic "Review." Recognition, not recall (R1 R2/R4).
- Reuse R1's **R2 recognition aids** (grouped address, emphasized first/last characters) on the review.
- Surface the **own-node authority** as the competence cue at the confirm — "your node will broadcast
  this" / at first-deposit "your node confirmed this" — the F20 structural-assurance substitute.
- **Guardrail:** competence cue, *not* reassurance banner. No seals, no "bank-grade," no badge wall
  (manifesto ban; F21 dark-pattern inverse). Keep to the *one* load-bearing fact (destination) —
  transparency has an inverted-U; don't bury it in a data wall.
- Rides gt05.2 (Send) and complements R2 R10 (re-personalized multi-party check). **Filed: gt05.11.**

### R18 — Attribution-complete failure grammar (S/M) — *copy buildable now; color PENDING-ALEX*

F22: error copy is an attribution instrument; answer whose-fault (locus), will-it-recur (stability),
can-I-fix (controllability), and steer blame away from both "you" and "your money."
- Extend R2 R13's banner grammar so each failure explicitly answers all three attribution questions:
  locus ("this is the connection to your node — not your money, and not something you did"), stability
  ("temporary, reconnecting" vs "needs a change"), controllability (the concrete next step).
- Non-accusatory, plain-language (NN/g heuristic 9); never bare "Error"/"failed"/"invalid."
- **Why not re-filed:** the *copy* is buildable, but the stability dimension implies the
  **degraded-vs-broken color** boundary, which is **R2 §3.1 PENDING-ALEX** and R2 deliberately did not
  file it. R18 is recorded as the copy-half of R2 R13; it ships when §3.1 is decided. **Not a new bead.**

### R19 — Retry-safety statement on send/broadcast failures (S)

F23: the after-failure question in irreversible money is "is it safe to try again?"; silence there
freezes the user.
- Every send/broadcast failure states **fund-state + retry-safety** in plain words: "*This payment was
  not sent. Nothing left your wallet — you can safely try again.*"
- **Preserve the draft** — never dump the user to an empty create screen (reads as "my work/money
  vanished").
- Non-color, non-accusatory; complements R18's grammar but is independently shippable (this is the
  genuinely-new part that does *not* wait on the color decision). **Filed: gt05.7.**

### R20 — Pair every self-custody risk line with a doable efficacy action (M)

F24: fear without efficacy produces defensive avoidance (the seed-phrase dropoff); efficacy is the
strongest PMT predictor.
- **Rule:** never state a self-custody risk without an immediately-doable action in the same view.
  Recovery-phrase step = "no reset button" + verify-once "save it now"; backup nudge = risk + "Back up
  now"; any "you are the bank" copy + the specific protective step.
- Keep threat **singular and calibrated** — one plain idea, never a risk-bullet wall (numbing).
- Implements the manifesto's no-caveat-wall rule with the PMT mechanism behind it. **Filed: gt05.8.**

### R21 — Distribute the risk curriculum across teachable moments (M/L)

F25: front-loaded risk education numbs; just-in-time education at the moment of relevance lands.
- Move each self-custody lesson to **its** teachable moment (table in F25), short and efficacy-paired
  (R20): "no reset" at recovery-phrase; "back it up" at first funds (ties gt05.5); "only yours" at
  first receive (ties gt05.6); "a lost cosigner key locks funds" at shared-wallet creation; "spends are
  irreversible" at first send review (ties R17).
- Removes the onboarding warning-wall. Spans several surfaces — the larger item. **Filed: gt05.10.**

### R22 — Notification severity × actionability taxonomy (M)

F26 + F27: fatigue is driven by non-actionable alarms treated like actionable ones, and every push
costs interruption; default to pull.
- Classify the four classes by **(actionable? × time-critical?)**: batch/digest **tx** (informational);
  decay-nudge **backup** in-app (gt05.5); fold **system-health** into the Health object (spec §2.6b);
  treat **cosigner-needed** as the sole near-real-time candidate.
- Make the **avatar bell-badge + notification panel the primary pull surface** for all batched classes;
  push is the rare F26 exception only.
- Implements the manifesto notification-throttling MUST; no doctrine change *except* the push-boundary
  question (§3). **Filed: gt05.9.**

### R23 — Competence-cue audit: own-node/mechanism as the trust anchor (S) — *folded into R17*

F20: with no company to trust, the own-node explorer + signing-mechanism line + integrity copy are the
trust anchors a brand would otherwise carry. Audit the trust-fragile surfaces (first-deposit confirm,
receive, explorer, wallet-detail "how this wallet signs") to ensure the **own-node/mechanism cue is
present and the missing vendor is not replaced by vendor-shaped reassurance** (badges/seals — banned).
Small and additive; recorded here and **folded into R17/gt05.11** rather than filed separately (same
surfaces, same trust-anchor mechanism).

---

## 3. Prepared for Alex's decision

Two carried-over R2 items plus one genuinely new candidate from this round. Laid out neutrally; **not
decided here**, and (per R2's practice) **not filed as beads** while gated.

### 3.0 Carried over from R2 (still PENDING-ALEX) — now with more findings leaning on them

- **R2 §3.1 — degraded-vs-broken color taxonomy.** F22 (attribution: the *stability* dimension) and F23
  both need the amber-degraded / red-broken boundary to render correctly. R18's copy is buildable
  without it; R18's *color* is not. This decision now blocks **two** rounds' worth of failure-grammar
  work — its priority has effectively risen.
- **R2 §3.2 — non-color-redundancy for semantic states.** Unaffected by R3 directly, but F26's
  severity-tiering will introduce new state-bearing indicators (notification tier chips), which are
  exactly the "hue-only status" surface §3.2 is about — decide §3.2 before those chips are designed, or
  they'll need re-work.
- **USD-vs-sats default (`cairn-4vh2a`).** Untouched by R3; not treated as decided.

### 3.1 (NEW) Is push *ever* allowed, or is Cairn pull-only?

**Rule at stake.** The manifesto explicitly bans **push notifications on price** ("prohibited by
design") but is **silent on whether push is allowed for anything else.** F26 identifies exactly one
class that could justify near-real-time delivery — **"a cosigner's signature is genuinely needed on a
pending payment"** (actionable *and* sometimes time-critical) — while F27 argues the interruption-cost
default should be **pull** (the avatar bell-badge). A developer wiring the cosigner-notify hook today
has no doctrinal rule for whether it may push.

**Evidence.** F27: every push costs resumption lag; batching/pull beats constant delivery on workload,
accuracy, strain. F26: only the actionable-*and*-urgent tier earns an interrupt; everything else demotes
to informational/pull. R2 F13: a pending signature is *waiting-anxiety* fuel, and the custody plan
already forbids turn-taking / heartbeat pings — which argues *against* an aggressive push here.

**Options.**
- **A. Pull-only (strict).** No push ever; all four classes live on the avatar bell-badge + panel.
  Simplest, most interruption-respecting, consistent with the price-push ban's spirit. Risk: a cosigner
  who rarely opens the app is slow to sign, extending R2 F13's waiting state for the other party.
- **B. Pull-only + one opt-in exception.** Default pull; allow the user to *opt in* to a single push
  class — "tell me when someone needs my signature" — rate-limited (shares R2 R11's remind rate-limit).
  Preserves the default, gives the one high-value interrupt to those who want it. Most defensible.
- **C. Case-by-case.** No doctrine; each notify hook decides. Cheap now, guarantees drift and an
  eventual price-push-adjacent mistake — the exact thing the manifesto's throttling MUST exists to
  prevent.

**Blast radius.** One clause in the manifesto's Notification MUST section ("push is prohibited on price
and *default-off elsewhere*; the sole opt-in push class is cosigner-signature-needed, rate-limited").
Then R22 implements the taxonomy against the decided boundary. Effort **S** for the doctrine text; the
scheduler work is R22 either way.

---

## 4. Beads filed

Five clearly-buildable, non-doctrine improvements filed as children of epic **cairn-gt05**, referencing
this doc and the finding id in each description (matching R2's convention):

| Bead | Improvement | Finding | Priority | Effort |
|---|---|---|---|---|
| **cairn-gt05.7** | Retry-safety statement on send/broadcast failures | F23 / R19 | P2 | S |
| **cairn-gt05.8** | Pair every self-custody risk line with a doable efficacy action (PMT) | F24 / R20 | P2 | M |
| **cairn-gt05.9** | Notification severity × actionability taxonomy (batch/pull default) | F26+F27 / R22 | P2 | M |
| **cairn-gt05.10** | Distribute risk curriculum across teachable moments | F25 / R21 | P3 | M/L |
| **cairn-gt05.11** | Semantic-transparency send review + own-node trust anchor | F20+F21 / R17 | P3 | S/M |

**Not filed, and why.** R18 (attribution-complete failure *color*) is gated on **R2 §3.1 PENDING-ALEX**
and recorded as the copy-half of R2 R13, not a new bead — R19/gt05.7 carries the buildable, non-color
part. R23 is folded into R17/gt05.11 (same surfaces, same trust-anchor mechanism). The §3.1 push-boundary
question is a **doctrine decision**, not a bead.

---

## 5. Source list

**Peer-reviewed / primary:**
- McKnight, Choudhury & Kacmar 2002 — initial-trust constructs (competence/benevolence/integrity + structural assurance): https://verdi.cs.ucl.ac.uk/constructDB/publications/mcknight-impact-2002.html
- Lankton, McKnight & Tripp 2015 — human-like vs system-like trust in technology (JAIS): https://aisel.aisnet.org/jais/vol16/iss10/1/
- Fogg 2003 — Prominence-Interpretation Theory (Stanford Web Credibility): https://credibility.stanford.edu/pdf/PITheory.pdf
- "What I Sign Is Not What I See" 2026 — crypto-wallet signature verification, semantic transparency (64% interface-trust; 67.9%→84.2%): https://arxiv.org/html/2601.16751
- How transparency modulates trust in AI — inverted-U, explanations can backfire (PMC9023880): https://pmc.ncbi.nlm.nih.gov/articles/PMC9023880/
- Trust, distrust & appropriate reliance in (X)AI — over-trust vs disuse, calibration (arXiv 2312.02034): https://arxiv.org/pdf/2312.02034
- "Blaming Luck, Claiming Skill" 2025 — self-attribution bias in error assignment (bioRxiv): https://www.biorxiv.org/content/10.1101/2025.03.18.644058.full.pdf
- Rogers — Protection Motivation & Self-Efficacy: revised theory of fear appeals: https://www.researchgate.net/publication/222055931
- PMT & information-security behaviour — meta-analysis (efficacy strongest predictor): https://www.researchgate.net/publication/292677114
- Differential effectiveness of fear appeals in infosec — two-stage meta-analysis 2023: https://www.researchgate.net/publication/369943863
- Neuroscientific evidence for defensive avoidance of fear appeals (PMC4286019): https://pmc.ncbi.nlm.nih.gov/articles/PMC4286019/
- Insufficiency → avoidance in acute-risk information behaviour (PMC8500063): https://pmc.ncbi.nlm.nih.gov/articles/PMC8500063/
- Just-in-time phishing feedback at the teachable moment (Cambridge Core, Behavioural Public Policy): https://www.cambridge.org/core/product/4F5DF23A7AB0DC81561A1778E06802E2/core-reader
- Analyzing usability issues in self-custody wallets — seed-phrase anxiety/dropoff (Aalto thesis): https://aaltodoc.aalto.fi/bitstreams/c57c8b11-c860-4cb9-a193-6010ab956481/download
- Mental models & multi-device crypto-wallets (ACM CCS 2023): https://dl.acm.org/doi/10.1145/3576915.3623218
- AAMI "Right Alert, Right Time" — clinically meaningful, actionable alarm design: https://array.aami.org/doi/full/10.2345/0899-8205-54.1.12
- Task-interruption from app notifications — strain & performance; constant vs 15-min batch (PMC10244611): https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/
- Iqbal & Bailey — intelligent notification management, breakpoint deferral (CHI 2008): https://interruptions.net/literature/Iqbal-CHI08.pdf
- Altmann & Trafton — task-resumption lag, memory-for-goals (CogSci 2004): https://www.interruptions.net/literature/Altmann-CogSci04.pdf
- Interruption cost by cognitive workload & task performance (MDPI Applied Sciences): https://www.mdpi.com/2076-3417/8/10/1780
- Alarm-fatigue review — non-actionable rates, desensitization (NCBI Bookshelf NBK555522, via R2 F16): https://www.ncbi.nlm.nih.gov/books/NBK555522/

**UX research orgs / standards:**
- NN/g error-message guidelines (non-accusatory, plain, actionable): https://www.nngroup.com/articles/error-message-guidelines/
- NN/g Prominence-Interpretation Theory: https://www.nngroup.com/articles/prominence-interpretation-theory/
- UX Tigers — Nielsen heuristic 9, error-message usability: https://www.uxtigers.com/post/heuristic-9-error-messages
- Reducing non-actionable clinical alarms (AMSN): https://amsn.org/AMP_EDN/833/

**Practitioner / secondary (direction only, magnitude flagged in-text):**
- "Who is to blame?" — software-blaming vs self-blaming, locus of control in UI (UX Magazine): https://uxmag.com/articles/who-is-to-blame
- Just-in-time intervention improves online security (ResearchGate mirror): https://www.researchgate.net/publication/383955604

**Flagged-inferential in this round (mechanism solid; the specific mapping is reasoned, not measured):**
the McKnight/Fogg trust transfer to *vendorless self-custody* (F20 — no initial-trust study of
self-hosted wallets); the exact three-question ↔ Weiner-dimension mapping for money errors (F22 — a
well-grounded synthesis, not a single cited experiment); the retry-double-spend *fear* specificity
(F23 — reasoned from irreversibility, abandonment direction is established); the ~70% seed-phrase
dropoff *magnitude* (F24 — practitioner-sourced, direction corroborated by PMT/EPPM); the full
teachable-moment *staging plan* (F25 — just-in-time evidence is solid, the per-surface schedule is my
synthesis).
