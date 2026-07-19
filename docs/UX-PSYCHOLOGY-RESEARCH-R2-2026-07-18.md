# UX Psychology Research — Round 2 — 2026-07-18

Second research pass, scoped to six gaps the first round
(`docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md`, findings F1–F10 → improvements R1–R9) did not
cover. Continues that document's numbering: findings **F11–F19**, improvements **R10–R16**.
Priority order of the brief was preserved — topics 1–3 and 5 are deep; 4 and 6 are lighter.

Doctrine context unchanged: `docs/DESIGN-MANIFESTO.md` (evergreen identity, sats-first MUSTs,
friction ladder, growth-only motion, semantic-color language) and `docs/UX-REDESIGN-SPEC.md`
(epic cairn-gt05, 3-tier disclosure). Two feature contexts are load-bearing for topic 1 and
are cited from the repo, not the web: `docs/COLLABORATIVE-CUSTODY-PLAN.md` (contacts,
`multisig_shares`, the frozen signing roster, no turn-taking, `redactMultisigKeysForViewer`,
404-not-403) and the `QuorumArc` / `EpochDial` / `BurialRings` ring vocabulary.

**Source-quality note.** Same preference order as round 1: peer-reviewed > NN/g and equivalent
research orgs > practitioner writeups (used for direction, never magnitude). Where the
literature is genuinely thin — **topic 1 (multisig custody psychology) and topic 6 (density
priming)**, exactly as the brief predicted — that is stated at the finding and the reasoning is
drawn from adjacent, better-established results with the extrapolation **marked as speculation**.
One practitioner statistic recurs and is flagged wherever used: **"3–6 push notifications cause
40% of users to disable notifications"** (OneSignal/vendor benchmark, no peer-reviewed
methodology) — direction is corroborated by the habituation literature; the magnitude is not.

---

## Executive summary

- **The single largest un-addressed risk is social, not visual: diffusion of responsibility in
  multi-party signing (F11).** When two people both sign, classic social-psychology predicts
  *each* checks the address less carefully than a lone signer would — the wrong-paste that F5
  (round 1) fought at the individual level gets *worse*, not better, with a second signer,
  unless the UI explicitly re-personalizes the check. This is the highest-leverage new finding
  and the collaborative-custody flow is being designed right now, so the timing is ideal.
- **Trust-repair after a failure is a real, separate skill from trust-formation, and the
  evidence is sobering (F14): the "service recovery paradox" lifts *satisfaction* but not
  *repurchase, word-of-mouth, or trust* — you do not get credit for a good recovery, you only
  avoid the penalty for a bad one.** The design implication is unglamorous: recover cleanly and
  attribute cause honestly; never manufacture or dramatize a failure to look competent fixing it.
- **Recurring nudges must be state-driven and polymorphic, not a fixed schedule (F16).** The
  brain habituates to a warning by the *second* exposure (Anderson, round 1's F4); medical
  alarm fatigue shows the endpoint (72–99% false-alarm rates → clinicians miss the real one).
  A fixed weekly "back up now" amber is on the road to wallpaper. The fix is decay + escalation
  keyed to state changes and varied presentation — never a metronome.
- **The semantic palette has two colorblind failure pairs that carry *opposite* meanings
  (F18): amber "attend" vs green "all-good," and salmon "quorum-risk" vs red "broken."** ~8% of
  men can't reliably separate them. The manifesto deliberately dodges the classic red/green
  ledger trap (sends aren't red), which is a real strength — but these two pairs need non-color
  redundancy, and mandating that touches the minimalist color-count doctrine, so it is prepared
  for decision, not decided here.
- Two findings are lighter and confirmatory: **first-deposit "is this really mine" anxiety
  (F17)** is intolerance-of-uncertainty + waiting anxiety, answered by agency (check once,
  auto-updates) and mechanism copy, not reassurance; **desktop density priming (F19)** — higher
  visual complexity measurably raises arousal, which *supports* the manifesto's existing
  "quarantine density in bordered glass" rule; the specific "denser layout primes a
  trading-terminal mindset" claim is plausible but **speculative** (no direct study found).

Doctrine-amendment candidates (in the final section, laid out neutrally, **not decided**): a
**degraded-vs-broken color taxonomy** for failure states (the manifesto currently lists "node
unreachable" under amber *and* "node down" under red without a boundary), and a
**non-color-redundancy rule** for the load-bearing semantic states.

---

## 1. Findings

### F11 — Diffusion of responsibility: a second signer checks the address *less*, not more

**Confidence: medium-high on the mechanism; medium on the magnitude in this exact context.**

The canonical result: when responsibility for an outcome is shared, each individual expends
less effort and feels less personally accountable, and the effect grows with the number of
people involved (Latané's social loafing; Darley & Latané's diffusion of responsibility). The
mechanism is precisely "someone else is presumably handling it." Recent work also shows
diffusion of responsibility measurably **reduces sense of agency and outcome monitoring** — i.e.
people literally attend to the result less when responsibility is shared (Beyond self-serving
bias, PMC5390744).

Applied to a 2-of-3 multisig send: the destination address is verified by whoever builds the
transaction, and then "verified again" by each co-signer — except the literature predicts the
opposite of redundant vigilance. Each signer, seeing that others will also sign, rationally
under-invests in the check ("Alice built it, she checked; Bob will check too"). The
wrong-paste slip that round 1's F5 identified as the app's highest-stakes individual error
becomes a *collective* blind spot: the very structure meant to add safety (more eyes) can
subtract it, because no pair of eyes owns the check.

This is the **inverse of the banking four-eyes / maker-checker principle**, which works
*because* roles are explicitly separated and named — the maker initiates, a *distinct* checker
independently approves, and the system assigns each role rather than leaving "someone will
check" to diffuse. Maker-checker's documented error-reduction benefit is contingent on that
role assignment; a multisig UI that shows every signer the same undifferentiated "review and
sign" screen throws away exactly the structure that makes four-eyes work.

- https://en.wikipedia.org/wiki/Diffusion_of_responsibility
- https://pmc.ncbi.nlm.nih.gov/articles/PMC5390744/ (diffusion of responsibility reduces sense of agency and outcome monitoring)
- https://en.wikipedia.org/wiki/Maker-checker ; https://en.wikipedia.org/wiki/Social_loafing

**Design implication:** the collaborative sign flow must **re-personalize the address check** —
assign it, don't diffuse it. Each signer sees "*You* are confirming this payment goes to
[address]" as a first-person act they own, ideally with light role differentiation (the builder
sees "you entered this"; each co-signer sees "confirm the builder got this right"), converting
diffuse group vigilance back into maker-checker's assigned vigilance. See R10.

*Literature-thinness note:* there is **no study of address verification in Bitcoin multisig
specifically** (searched). F11 extrapolates from robust general social-psychology to this
context; the direction is well-established, the effect size in a 2–3 person crypto-signing
setting is an inference, not a measurement — **treat the magnitude as speculation.**

### F12 — Trust in an invite is "swift trust": presumptive, fragile, and reinforced by action not assurance

**Confidence: medium on mechanism; the joint-account thread is high-confidence, well-replicated.**

Trust between two people newly sharing a wallet forms the way it forms in temporary teams:
**swift trust** (Meyerson, Weick & Kramer) — a provisional, presumptive trust that arises fast
among people who must coordinate before deep relational trust can develop. Its defining
property is **fragility**: it is cognitive rather than relational, so it needs continual
"reinforcement and calibration by action" — a sense of shared expectations and accountability —
or it collapses. This maps directly onto the invite → accept → share-wallet → co-sign sequence:
the relationship is real (spouse, family, business partner) but the *tool-mediated* trust
("does this shared-wallet feature do what I think, and is the other person seeing what I'm
seeing?") is brand-new and brittle.

The adjacent, stronger literature is joint-account behavioral research: couples who pool into a
joint account behave **less transactionally and more communally** — "if all money is everyone's
money, partners don't need to keep score" (Kellogg/Northwestern; JCR 2023, "Common Cents") —
and report higher relationship quality in a *randomized* study (not just correlation). The
mechanism is a shift from transactional ("who paid, who owes") to communal norms. But the same
literature flags the shadow: shared financial control can become **coercive control** in abusive
dynamics, and *new* couples do better retaining some independence. A shared-custody feature
inherits both the upside (communal framing) and the responsibility (don't design as if every
share is between equals in a healthy relationship).

- https://journals.sagepub.com/doi/10.1177/10464964251348901 (swift trust in temporary systems, 2026 systematic review)
- https://academic.oup.com/jcr/article/50/4/704/7077142 (Common Cents: bank-account structure and couple dynamics, JCR 2023)
- https://insight.kellogg.northwestern.edu/article/key-to-happy-marriage-joint-bank-account
- https://www.sciencedirect.com/science/article/pii/S016748702030074X (benefits of joint vs separate management)

**Design implication:** invite/contact flows should (a) reinforce the fragile new trust with
**observable, honest signals of shared state** — both parties can see the same wallet, the same
balance, the same roster — which is swift-trust "calibration by action," not a reassurance
banner; (b) keep the contacts feature's **identity-revealing framing explicit** ("this shows
your name and email to whoever you add" — already in the custody plan §5), because swift trust
needs accurate expectations, and a surprise about what the other person can see is exactly the
action-level betrayal that collapses it; (c) never editorialize the relationship as adversarial
(no "protect yourself from your co-signer" framing) — the communal frame is the healthy default
and the manifesto's calm voice already forbids danger-theater. See R12.

### F13 — "Waiting on someone else to sign" is waiting anxiety, and it drives compulsive checking

**Confidence: medium-high — the underlying intolerance-of-uncertainty literature is strong.**

A pending multi-party signature is a textbook **waiting-under-uncertainty** state, and the
psychology is well-characterized: intolerance of uncertainty produces **certainty-seeking
behavior** — repeated checking and reassurance-seeking that reduces anxiety momentarily but
restores only "a flicker of agency," not resolution (the elevator-button effect). Newer work
names "waiting anxiety" as anticipatory distress with rumination and physiological arousal
*even when the awaited outcome is positive and rationally certain* — which is exactly the
Heartwood case: "Bob will sign eventually, the money is fine," yet Alice still refreshes.

The design failure mode is a status surface that **invites the checking loop** — a live "still
waiting…" that the anxious user reloads, or worse, a notification cadence that pings on every
non-event. The custody plan already made two correct calls that this finding endorses:
**no turn-taking / no "whose turn is it"** (that would manufacture a blame-tinged waiting
target), and **notify at creation + on each real signature only** (state changes, not
heartbeat). Maker-checker framing helps here too: a *dual-authorization* step reframed as a
deliberate feature ("two approvals keep this wallet safe") reads as chosen safety rather than
someone-is-late friction.

- https://www.psychologytoday.com/us/blog/living-with-emotional-intensity/202607/waiting-mode-anxiety-and-the-intolerance-of-uncertainty
- https://www.simplypsychology.org/news/when-waiting-feels-unbearable-we-chase-clues
- https://www.bartoszek-laboratory.com/uploads/1/2/5/9/125920195/bartoszek_et_al._2022_-_intolerance_of_uncertainty_and_information-seeking_behavior.pdf

**Design implication:** render the waiting state as a **calm, complete, single-glance status**
that answers the anxious question once — who has signed, who is still owed, expressed in the
ring vocabulary (`QuorumArc`: an arc partly sealed) — with **no live "waiting" motion, no red,
no turn-shaming**, and a plain forward sentence ("2 of 3 signatures collected. This will be
ready to send once one more person signs."). Give the user *one* meaningful action (a gentle
"remind" that is rate-limited so it can't become a checking/nagging loop for either party)
rather than a refresh reflex. See R11.

### F14 — Trust repair after failure: the recovery paradox lifts satisfaction but NOT trust

**Confidence: high — grounded in a formal meta-analysis.**

The **service recovery paradox** (post-recovery satisfaction exceeding no-failure satisfaction)
is widely repeated as folk wisdom, but the meta-analysis (De Matos, Henrique & Rossi 2007, 21
studies) is precise and deflating: the paradox is **significant and positive for satisfaction**,
but **non-significant for repurchase intention, word-of-mouth, and corporate image**. Translated:
a great recovery can make someone feel okay in the moment, but it does **not** buy you loyalty
or restored trust. You do not come out ahead by failing well — at best you climb back to
neutral. More recent work adds that **blame attribution governs the damage**: unresolved cases
with no identified cause drove ~40% higher churn *even when refunded* — uncertainty about *why*
it broke is more corrosive than the breakage.

For a self-custody Bitcoin app, the "failures" are node-unreachable, rejected broadcast,
Electrum disconnect, stale tip. These are largely **infrastructure** events the user cannot fix
and did not cause — which is the most trust-fragile category, because the user's mental model
("is my money okay? did I break it? is this app broken?") fills the vacuum with the worst
explanation unless the UI supplies a better one.

- https://journals.sagepub.com/doi/10.1177/1094670507303012 (SRP meta-analysis, De Matos et al. 2007)
- https://www.deep-insight.com/service-recovery-paradox-fact-or-myth/ (practitioner summary of the nuance)

**Design implication:** (1) **Do not manufacture or dramatize failure to look good recovering
from it** — there is no trust dividend, only downside avoidance. (2) The recovery's entire job
is to **prevent the worst attribution**: state plainly *what* happened, *whose* problem it is
(almost always "the connection to your node," not "your money" and not "you"), that funds are
untouched, and the *next step or ETA*. (3) Distinguish **degraded** (transient, self-healing:
"reconnecting to your node…") from **broken** (action-blocking: "this broadcast was rejected")
— they deserve different color and different copy, and the manifesto is currently ambiguous
about which is which (see the doctrine candidate). See R13.

### F15 — Error-message grammar and proactive status: silence costs more than the fix

**Confidence: high — NN/g canon plus convergent incident-communication practice.**

Two convergent bodies. **Error-message HCI** (Nielsen heuristic #9; NN/g error-message
guidelines): messages must help users *recognize, diagnose, and recover*; be plain-language and
specific; be **non-accusatory** — avoid "invalid," "illegal," "incorrect," "failed" as bare
verdicts — and always offer a constructive next step. "The connection to your node dropped —
reconnecting now" beats "Error: RPC timeout." **Incident-communication** practice converges from
the ops side: proactive, plain, regular updates during an outage build more trust than perfect
uptime does; the recurring practitioner figure is that proactive communicators see materially
lower churn than silent ones, and "users lose trust faster when there's no communication than
when there's no fix." (Churn magnitudes here are vendor blog numbers — direction only.)

- https://www.nngroup.com/articles/error-message-guidelines/
- https://www.atlassian.com/incident-management/incident-communication
- https://www.openstatus.dev/docs/concept/best-practices-status-page

**Design implication:** every failure banner follows a fixed grammar — *plain name of what
happened · whose layer it's on · reassurance that funds/keys are safe · the next step or what
the app is already doing about it* — in the manifesto's calm voice, amber for degraded and red
reserved for genuinely broken (per F14). Round 1's error line "We paused this transfer to
confirm it's you…" is the right register; generalize it to the node/broadcast/Electrum surfaces.
This is copy-and-color, not new architecture. See R13.

### F16 — Recurring nudges habituate to wallpaper; cadence must be state-driven, decaying, and polymorphic

**Confidence: high — three independent literatures agree.**

Round 1's F4 established the neural result (Anderson et al., CHI 2015 / MISQ 2018): response to
a warning **collapses after the second exposure** and polymorphic (varied-appearance) warnings
resist this markedly. Round 2 adds the *cadence* dimension the brief asked about, from two more
sources. **Medical alarm fatigue** is the fully-developed endpoint of a bad cadence: because
72–99% of monitor alarms are false or non-actionable, clinicians desensitize, **respond slower
to the real ones**, and the FDA logged 500+ alarm-related deaths in five years — the cost of
crying wolf is not annoyance, it's that the one true alarm is missed. **Notification-cadence
research** converges on a bell curve with steep drop-offs: too few → disengagement, too many →
opt-out/uninstall; the widely-cited (vendor, unverified-magnitude) "3–6 pushes → 40% disable"
sits here, and the peer-reviewed micro-randomized-trial direction (PMC10337295) is that
**dynamic, state-responsive** notification beats any fixed schedule.

- https://www.ncbi.nlm.nih.gov/books/NBK555522/ (alarm fatigue review — false-alarm rates, desensitization)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10357676/ (stats on the desats — alarm fatigue and patient safety)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10337295/ (micro-randomized trial: notifications and engagement)
- https://www.digia.tech/post/designing-non-annoying-nudges-frequency-placement-context/

**Design implication for the "back up now" amber nudge:** it must **not** re-surface on a fixed
timer. A defensible schedule: appear once at the earned moment (first funds arrive / wallet has
meaningful balance), then **decay** — re-surface at widening intervals (e.g. day 3, day 10, day
30, then quarterly), **escalate only on state change that raises stakes** (balance crosses a
threshold, a *second* wallet is unbacked), **vary presentation** across re-surfacings
(polymorphism — different phrasing/illustration each time, never the identical amber row), and
**cap** so it can never become a per-session ritual. Crucially, it stays in Health's calm amber
grammar, never a modal, never red — an un-actioned backup is *attention*, not an *error*, and
the moment it reads as an alarm it starts down the alarm-fatigue road. See R14.

### F17 — First-deposit / empty-wallet anxiety: "is this really mine" is intolerance of uncertainty, answered by agency not reassurance

**Confidence: medium — inference from strong adjacent literature; no wallet-specific study.**

Before the first deposit, a new self-custody user sits in a gap: they've been told "this is
yours, only you control it," but *nothing has happened yet* to confirm it, and the abstraction
(keys, addresses) offers no felt proof. The moment they send the first deposit, they enter the
**waiting-under-uncertainty** state of F13 — "did it arrive? did I use the right address? is it
lost?" — which intolerance-of-uncertainty research says provokes **verification-seeking and
compulsive checking** (block-explorer refreshing is the crypto-native form of the elevator
button). The distinctive twist for self-custody: unlike a bank, there is no institution to ask
for reassurance, so the *app itself* is the only agency-restoring surface. The classic
information-seeking result is that a single act of checking restores agency; repeated checking
is an anxiety loop — the design goal is to make **one check sufficient**.

- https://www.simplypsychology.org/news/when-waiting-feels-unbearable-we-chase-clues
- https://www.tandfonline.com/doi/full/10.1080/02699931.2026.2671175 (intolerance of uncertainty & checking behaviour)

**Design implication:** the empty-wallet and first-deposit-pending states should **give agency,
not reassurance-theater**. Empty state: mechanism-fact confidence in round 1's R5 register ("This
address is yours. Anything sent here is controlled only by your keys.") rather than "don't
worry." First-deposit-pending: a calm, self-updating status that answers the check *once* — "Seen
your incoming payment. It'll be spendable after the network confirms it (about an hour)." —
using the app's own node as the authority (the sovereignty payoff), so the user doesn't need to
leave for a third-party explorer to get the certainty. Round 1's empty-state doctrine ("This
wallet is ready. Receive your first bitcoin ↙") is the right spine; F17 adds the *pending* half.
See R15.

### F18 — The semantic palette has two colorblind failure pairs carrying opposite meanings

**Confidence: high — prevalence and confusion-pair behavior are well-established; the specific
hex-pair assessments are reasoned from CVD simulation principles.**

~8% of men and ~0.5% of women have a color-vision deficiency; red-green types are ~99% of cases
(deuteranomaly ~5% of men alone). The universal rule (WCAG 1.4.1 "Use of Color," Level A) is
that color must **never be the sole carrier** of meaning — pair it with text, icon, shape, or
position. The manifesto deliberately makes hue load-bearing and semantic ("**green means
growth, gold means attend, red means about to be destroyed**"), and its own falsifiable
color-count test (§6) prizes a minimal palette. Mapping the actual semantic tokens against
red-green deficiency:

| Role (token) | Hex | CVD risk | Verdict |
|---|---|---|---|
| growth/health/confirmed (`--sage`) | `#83b892` | **Confusable with `--attention` gold under deutan/protan** — both become mid-luminance yellow-beige | **Redundancy needed** |
| needs-attention (`--attention`) | `#d9b47e` | **Same pair.** Carries the *opposite* meaning to green (attend vs all-good) — the worst kind of collision | **Redundancy needed** |
| destructive/broken (`--error`) | `#e0664f` | **Confusable with `--caution` salmon** — adjacent orange-reds collapse together, and reds darken toward brown under protan | **Redundancy needed** |
| quorum-risk (`--caution`) | `#d87a55` | **Same pair.** Manifesto already flags it "the last orange-adjacent hue" | **Redundancy needed** |
| action (`--accent`) | `#6796c9` | Blue is the safest hue across all CVD types; ~90° from green; distinct | **Safe as-is** |

Two genuinely dangerous pairs, both carrying meanings a user must not confuse:

1. **Amber "attend" vs green "all-good."** These are the two non-destructive semantics and they
   mean nearly opposite things ("act on this" vs "nothing to do"). Under deuteranomaly they
   converge toward the same warm mid-tone. **Highest-priority pair.**
2. **Salmon "quorum-risk" vs red "broken."** Both live in the "something's off" family, so a
   confusion is *less* catastrophic than pair 1, but the manifesto itself predicts this collision.

**The manifesto's real strength worth stating:** it **avoids the classic red/green ledger trap**
by doctrine — outgoing sends are `--text`, never red, and received `+` is green but never sits
opposite a red `−`. So the single most common colorblind finance-UI failure (can't tell a
debit from a credit) **does not exist here.** The remaining exposure is narrower: the two
semantic-state pairs above, plus any place a lone colored dot/ring encodes status with no label.

Redundancy is already partially present — green confirmation is *also* rings sealing inward
(shape), amber nudges *also* carry text ("Back up now"). The gap is the places that lean on hue
alone: status dots, a bare colored `QuorumArc`, connection indicators.

- https://colorblind.io/learn/statistics ; https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-without-color.html
- Okabe-Ito CVD-safe palette (reference): https://www.nceas.ucsb.edu/sites/default/files/2022-06/Colorblind%20Safe%20Color%20Schemes.pdf

**Design implication:** guarantee non-color redundancy on every *state-bearing* use of amber,
green, salmon, and red — a shape/icon or text token alongside the hue, so meaning survives
grayscale. Much of this is additive and doctrinally free (text labels already exist on most
nudges); the part that bites doctrine is **mandating a glyph/shape on the minimalist semantic
states** and possibly retuning salmon away from red. That's the doctrine candidate. See R16.

### F19 — Desktop density does raise arousal (supports doctrine); the "trading-terminal mindset" claim is plausible but unproven

**Confidence: medium on the arousal link; LOW / speculative on the mental-model claim.**

Visual-complexity research (Tuch et al. 2009, physiological study; Deng & Poole on web
complexity and affect) establishes that **higher visual complexity raises arousal and cognitive
load and lowers pleasure**, and that the complexity→pleasantness relationship is **curvilinear**
(optimal-stimulation: moderate density is most pleasant; both sparse and dense extremes cost).
This is a direct, measured (skin-conductance / self-report) result and it **supports the
manifesto's existing layout doctrine**: "calm by default, quarantine density inside bordered
glass," "reading lanes cap, data lanes fill," and desktop rule 6 ("density stays in bordered
glass"). A desktop layout that lets density spill loose onto the calm surface would, by this
literature, raise arousal app-wide — the opposite of the savings-instrument calm the whole
manifesto defends.

The brief's specific hypothesis — that a *denser desktop layout primes a trading-terminal
mental model that undermines calm framing* — is **plausible but I found no direct study of
it.** It chains three defensible steps (density → arousal → arousal biases toward
checking/trading behavior) but the last link (density specifically evoking a *trading* schema
and thereby changing financial behavior) is an inference, **explicitly speculative**. The
adjacent support is real (arousal is linked to more frequent evaluation, which round 1's F1 ties
to myopic loss aversion) but no one has shown "Bloomberg-terminal-looking UI makes savers trade
more." **Do not cite this as established.**

- https://www.sciencedirect.com/science/article/abs/pii/S107158190900055X (Tuch et al., visual complexity: experience, physiology, performance, memory)
- https://hci-basel.ch/MA/2007_Tuch.pdf (full text)

**Design implication:** none new — this finding **ratifies** the desktop-widening rules already
in manifesto §9. The one actionable nuance: because the density→pleasure curve is *curvilinear*,
the risk on wide desktop is not just "too dense" but also the temptation to fill surplus width
with *more* equal-weight tiles; the "surplus width becomes margin and quiet rails, never a
second hero" rule (§9.1) is what keeps desktop on the pleasant side of the curve. No R-item
beyond "hold the line on §9." See the note under R-items.

---

## 2. Prioritized improvements

Effort: **S** ≤ 1 day, **M** ≈ 2–4 days, **L** ≥ 1 week. "Doctrine amendment" flags whether the
item needs a Manifesto change (those are detailed neutrally in §3, not decided here).

| # | Improvement | Finding | Effort | Touches | Requires doctrine amendment |
|---|---|---|---|---|---|
| R10 | Re-personalized address check in multi-party signing | F11 | **S/M** | collab sign/review flow | **No** |
| R11 | Calm "waiting on signatures" status (QuorumArc, no turn-taking, rate-limited remind) | F13 | **M** | collab sign-session UI | **No** |
| R12 | Swift-trust invite/contact copy + shared-state visibility | F12 | **S** | contacts + share flow | **No** |
| R13 | Failure-banner grammar: degraded vs broken, plain + cause + next step | F14, F15 | **S/M** | node/broadcast/Electrum banners | **Candidate** (color taxonomy) |
| R14 | Decaying, polymorphic, state-driven backup nudge cadence | F16 | **M** | Health nudge, notify scheduler | **No** |
| R15 | First-deposit confidence: agency-giving empty + pending states | F17 | **S** | Receive, empty states, tx-pending | **No** |
| R16 | Non-color redundancy on semantic states (amber/green, salmon/red) | F18 | **S/M** | semantic tokens, status glyphs | **Candidate** (minimalism/color-count) |

### R10 — Re-personalize the address check in multi-party signing (S/M) — *do this first*

F11 says a second signer checks *less*. Defeat the diffusion by **assigning** the check per
signer instead of showing everyone the same generic review:
- Each co-signer's review restates the destination as a **first-person owned act**: "*You* are
  confirming this payment of [amount] to [address]." — recognition of specifics (round 1's F4/F5
  pattern), phrased as personal responsibility, not "review the transaction."
- Light **maker-checker role differentiation**: the builder sees "You entered this recipient";
  each co-signer sees "Confirm [builder] entered the right recipient" — naming that *their*
  independent check is the point, which is exactly why four-eyes works and undifferentiated group
  review doesn't.
- Reuse round 1's **R2 recognition aids** (grouped address, ends emphasized) on every signer's
  screen, not just the builder's.
- No new red, no accusatory framing toward the builder. Rides gt05.2 (Send) + the collaborative
  custody sign-flow work (custody plan Unit 7).

### R11 — Calm "waiting on signatures" status (M)

F13: a pending signature is waiting-anxiety fuel; the surface must answer once, not invite a
checking loop.
- Render quorum progress in the **ring vocabulary** (`QuorumArc` partly sealed) — a complete,
  single-glance answer: who has signed, who is still owed, in plain names.
- **No live "waiting…" motion, no red, no "whose turn"** (the custody plan already forbids
  turn-taking — this finding is why that was right). One forward sentence: "2 of 3 signatures
  collected. Ready to send once one more person signs."
- Exactly **one** action: a **rate-limited "remind"** (so it can't become a nag loop for the
  sender or a checking loop pretext for the waiter). Reminders piggyback the custody plan's
  `sign_session_waiting` notify hook; the rate-limit shares R14's cadence discipline.
- Extends custody plan Unit 7 (roster UI). Effort M.

### R12 — Swift-trust invite/contact copy + shared-state visibility (S)

F12: tool-mediated trust between newly-sharing users is swift trust — fragile, reinforced by
honest observable signals.
- After a share is accepted, show **both parties the same shared state** (same wallet, balance,
  roster, "Shared by Alice" badge from custody plan §7) — visible shared state *is* swift-trust
  "calibration by action," worth more than any reassurance line.
- Keep the contacts feature's **identity-revealing framing explicit** ("Adding a contact shows
  your name and email to them") — accurate expectations prevent the surprise that collapses swift
  trust. (Custody plan §5 already specifies this; R12 makes it a UX requirement, not just a
  backend note.)
- **Communal, never adversarial** copy — no "protect yourself from your co-signer." Aligns with
  the manifesto's no-danger-theater voice. Effort S; rides the contacts/share UI (custody plan
  Units 1, 6).

### R13 — Failure-banner grammar: degraded vs broken (S/M)

F14 + F15: recovery buys back neutral at best, and the worst attribution ("my money broke / I
broke it") must be pre-empted. Fixed banner grammar for node-unreachable, rejected-broadcast,
Electrum-disconnect, stale-tip:
- *Plain name of what happened · whose layer (almost always "the connection to your node," not
  your money, not you) · funds/keys are safe · what the app is doing or the next step.*
  Example (degraded): "Reconnecting to your node — your balances may be a moment out of date.
  Your bitcoin is safe." Example (broken): "This send was rejected by the network. Nothing left
  your wallet. [What to try]."
- **Non-accusatory, plain-language, actionable** (NN/g heuristic 9); never bare "Error" / "failed".
- **Distinguish degraded (transient, self-healing) from broken (action-blocking).** This is where
  R13 touches doctrine: the manifesto lists "node unreachable" under amber `--attention` *and*
  "node down" under red `--error` with no stated boundary. R13 needs that boundary drawn — see
  §3.1. The *copy* is buildable now; the *color rule* is the decision.

### R14 — Decaying, polymorphic, state-driven backup nudge cadence (M)

F16: a fixed-interval "back up now" amber is on the road to wallpaper (and then alarm fatigue).
- **Never a fixed timer.** Surface once at the earned moment (first meaningful balance), then
  **decay** to widening intervals (illustrative: day 3 → day 10 → day 30 → quarterly).
- **Escalate only on stakes-raising state change** (balance crosses a threshold; a second wallet
  goes unbacked) — never on the clock alone.
- **Polymorphism** (Anderson): vary phrasing/illustration across re-surfacings; never the
  byte-identical amber row twice.
- **Cap** re-surfacing so it can never become per-session; stays in Health's calm amber grammar,
  never a modal, never red.
- Buildable now — Health nudge + a small cadence/scheduler seam. No doctrine change (it
  *implements* the notification-throttling MUST and the amber grammar). Effort M.

### R15 — First-deposit confidence: agency-giving empty + pending states (S)

F17: pre-first-funds "is this really mine" and first-deposit-pending are intolerance-of-
uncertainty; answer with agency + mechanism, not reassurance.
- **Empty/receive** state carries a mechanism-fact (round 1 R5 register): "This address is
  yours. Anything sent here is controlled only by your keys." — not "don't worry."
- **First-deposit-pending** state answers the check *once*, self-updating from the user's own
  node: "Seen your incoming payment. Spendable after the network confirms it (about an hour)." —
  removing the reason to leave for a third-party explorer (sovereignty payoff).
- Reuses round 1's empty-state doctrine; adds the pending half. Buildable now; no doctrine
  change. Effort S.

### R16 — Non-color redundancy on semantic states (S/M)

F18: amber/green and salmon/red are colorblind-confusable and carry opposed meanings; ~8% of men
affected.
- **Buildable-now, doctrine-free part:** guarantee a **text or shape** cue anywhere a semantic
  state currently rides hue alone — status dots gain a label or icon, the `QuorumArc`/connection
  indicators pair color with a glyph or text, confirmation keeps its ring-sealing shape (already
  redundant). Most nudges already carry text; this is filling the gaps.
- **Doctrine-touching part (see §3.2):** whether to **mandate** a shape/icon token on the
  minimalist semantic palette app-wide, and whether to **retune `--caution` salmon** further from
  `--error` red (the manifesto already invites this: "shift toward amber if any 'orange' read
  survives QA"). Because the manifesto makes hue deliberately load-bearing and its §6 test prizes
  color minimalism, a blanket "every semantic state must also carry a non-color cue" is an
  amendment, not a bugfix — prepared for decision, not decided.

### Note on F19 (density priming) — no R-item

F19 ratifies existing doctrine (manifesto §9). No change recommended; the actionable content is
"hold the §9 line, especially the surplus-width-becomes-margin rule on wide desktop." Flagged
here so a future desktop pass doesn't read the absence of an R-item as absence of a finding.

---

## 3. Prepared for Alex's decision (doctrine-amendment candidates)

Two items require a Manifesto amendment or clarification. Laid out neutrally in the
`DECISION-BRIEF` style — rule at stake, evidence, options, blast radius — **not decided here.**
These are *not* filed as beads (doctrine-gated).

### 3.1 Degraded-vs-broken color taxonomy for failure states

**Rule at stake.** Manifesto §2 lists **"node unreachable"** under `--attention` (amber) and
**"node down"** and **"broadcast rejected, invalid PSBT, node down"** under `--error` (red),
with no stated boundary between them. §5's friction ladder and §7 AVOID both insist red is
**destructive-confirm and irrecoverable-failure only**. Today a developer wiring a
node-connection banner has no doctrinal rule for whether it's amber or red — and F14/F15 say the
distinction is exactly what pre-empts the worst user attribution.

**Evidence.** F14 (service-recovery meta-analysis): recovery doesn't build trust, it only avoids
the penalty — so the color must not over-alarm a *transient, self-healing, user-can't-act* event
(that manufactures a red-day-style loss-aversion hit on a non-decision, which the whole manifesto
is built to avoid). F15 / incident-comms: transient degradation is best communicated calmly and
proactively; red is for the genuinely broken and action-blocking. Amber already means "attend,
expected swing, not an error" in doctrine — a reconnecting node fits amber precisely; a rejected
broadcast (action failed, needs a decision) fits red.

**Options.**
- **A. Draw the boundary on *actionability + reversibility*.** Amber `--attention` =
  **degraded/transient/self-healing, no user action possible** (reconnecting to node, Electrum
  reconnecting, tip momentarily stale). Red `--error` = **broken/action-blocking/needs a
  decision** (broadcast rejected, invalid PSBT, sign failed). Amend §2 to state this test; move
  "node unreachable/node down" onto the correct side by *which* condition it is (a reconnect is
  amber; a hard, persistent, blocking outage is red).
- **B. Keep both hues but add a third middle only if QA finds A too binary** (salmon `--caution`
  already exists as a between tier — reuse rather than invent).
- **C. No amendment; case-by-case per banner.** Cheap now; guarantees drift and inconsistent
  alarm coloring across the node/broadcast/Electrum surfaces — the exact silent-desync the
  manifesto's token discipline exists to prevent.

**Blast radius.** One paragraph in §2 (semantics table note) + the falsifiable §6 test could gain
a "reconnecting node shows amber, not red" clause. Then R13 is copy + a token pick per banner.
Effort **S** for the doctrine text; the banners are R13.

### 3.2 Non-color-redundancy rule for the semantic palette

**Rule at stake.** The manifesto makes hue **deliberately semantic** ("green means growth, gold
means attend, red means about to be destroyed") and its §6 color-count test prizes a **minimal**
palette (one accent, three greys, two non-destructive semantics, red-only-destructive). F18 shows
two confusable pairs carrying opposed meanings for ~8% of men, and WCAG 1.4.1 (Level A) requires
color never be the sole carrier. The tension: universal redundancy vs the minimalist,
hue-carries-meaning aesthetic.

**Evidence.** F18: ~8% male CVD prevalence; amber/green and salmon/red converge under
deuteranomaly/protanopia; the app already dodges the classic red/green ledger trap by doctrine
(a real strength) so the exposure is *narrow* — confined to semantic-*state* indicators, not the
balance or tx ledger. Much redundancy is already present (rings = shape, nudges = text). The
residual risk is hue-only status indicators (dots, bare arcs, connection lights).

**Options.**
- **A. Minimal rule — "no hue-only status."** Amend §6/§7: *any state-bearing use of a semantic
  color must carry a second cue (text or shape); the balance and prose are exempt (already
  found-by-size, not hue).* Cheapest defensible fix; leaves the palette and aesthetic intact,
  just forbids the lone colored dot. Plus retune `--caution` toward amber (already invited by the
  manifesto).
- **B. Full redundancy system — a shape/icon token per semantic** (e.g. a consistent glyph for
  attend / good / broken) used app-wide. Most robust for CVD and for grayscale/print, but adds
  iconography the minimalist identity deliberately avoids, and risks reading as the "compliance
  caveat wall" §7 bans if over-applied.
- **C. No amendment; treat as QA-only.** Leaves 8% of male users relying on luminance guesses
  between opposite-meaning states; fails WCAG 1.4.1 where any hue-only indicator exists.

**Blast radius (A).** One clause in §6 and/or §7; a `--caution` retune (values-only, like the
round-1 palette swap); an audit of status indicators for hue-only usage. Effort **S/M**. **(B)**
adds an icon token set + component work, **M/L**.

---

## 4. Beads filed

Two clearly-buildable, non-doctrine improvements filed as p3 research beads under epic
cairn-gt05 (IDs in the final report). The doctrine-gated items (R13's color rule, R16's mandate)
are **not** filed — they await the §3 decisions. R10/R11/R12 are not filed because they depend on
the collaborative-custody feature, which is a planning doc (`COLLABORATIVE-CUSTODY-PLAN.md`), not
yet built — they belong to that epic when it opens, and are recorded here as its UX requirements.

---

## 5. Source list

Peer-reviewed / primary:
- Service Recovery Paradox meta-analysis — De Matos, Henrique & Rossi 2007: https://journals.sagepub.com/doi/10.1177/1094670507303012
- Diffusion of responsibility reduces sense of agency / outcome monitoring (PMC5390744): https://pmc.ncbi.nlm.nih.gov/articles/PMC5390744/
- Swift trust in temporary systems — systematic review 2026: https://journals.sagepub.com/doi/10.1177/10464964251348901
- Common Cents: bank-account structure & couple dynamics, JCR 2023: https://academic.oup.com/jcr/article/50/4/704/7077142
- Benefits of joint vs separate financial management: https://www.sciencedirect.com/science/article/pii/S016748702030074X
- Anderson et al., polymorphic warnings / habituation (CHI 2015; via round 1): https://dl.acm.org/doi/10.1145/2702123.2702322
- Alarm fatigue review (NCBI Bookshelf NBK555522): https://www.ncbi.nlm.nih.gov/books/NBK555522/
- Alarm fatigue & patient safety (PMC10357676): https://pmc.ncbi.nlm.nih.gov/articles/PMC10357676/
- Notifications & engagement, micro-randomized trial (PMC10337295): https://pmc.ncbi.nlm.nih.gov/articles/PMC10337295/
- Intolerance of uncertainty & checking behaviour: https://www.tandfonline.com/doi/full/10.1080/02699931.2026.2671175
- Tuch et al. 2009, visual complexity — physiology/experience/performance: https://www.sciencedirect.com/science/article/abs/pii/S107158190900055X (full text: https://hci-basel.ch/MA/2007_Tuch.pdf)

UX research orgs / standards:
- NN/g error-message guidelines: https://www.nngroup.com/articles/error-message-guidelines/
- WCAG 1.4.1 Use of Color (Level A): https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-without-color.html
- Atlassian incident-communication best practice: https://www.atlassian.com/incident-management/incident-communication
- openstatus status-page best practices: https://www.openstatus.dev/docs/concept/best-practices-status-page
- Okabe-Ito CVD-safe palette (NCEAS): https://www.nceas.ucsb.edu/sites/default/files/2022-06/Colorblind%20Safe%20Color%20Schemes.pdf
- Color-blindness prevalence statistics: https://colorblind.io/learn/statistics

Reference (mechanism overviews):
- Maker-checker / four-eyes principle: https://en.wikipedia.org/wiki/Maker-checker
- Diffusion of responsibility / social loafing: https://en.wikipedia.org/wiki/Diffusion_of_responsibility ; https://en.wikipedia.org/wiki/Social_loafing
- Waiting mode & intolerance of uncertainty: https://www.psychologytoday.com/us/blog/living-with-emotional-intensity/202607/waiting-mode-anxiety-and-the-intolerance-of-uncertainty
- "When waiting feels unbearable, we chase clues": https://www.simplypsychology.org/news/when-waiting-feels-unbearable-we-chase-clues

Practitioner / vendor (direction only, magnitude unverified — flagged in-text):
- Notification-cadence "3–6 pushes → 40% disable" and bell-curve cadence: https://www.digia.tech/post/designing-non-annoying-nudges-frequency-placement-context/
- Incident-comms churn/trust figures: https://www.openstatus.dev/docs/concept/best-practices-status-page

**Flagged-speculative in this round (do not build load-bearing decisions on):** the exact
diffusion-of-responsibility *effect size* in Bitcoin multisig address-checking (F11 — mechanism
solid, magnitude inferred); the "denser desktop layout primes a *trading-terminal mental model*
that changes financial behavior" claim (F19 — plausible chain, no direct study); the "3–6
pushes → 40% disable" magnitude (F16 — vendor benchmark, direction corroborated by habituation
literature).
