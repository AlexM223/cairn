# UX Psychology Research — 2026-07-15

Research digest: user psychology for money/financial apps, distilled into prioritized Heartwood
improvements. Scoped to five questions: behavioral economics in fintech UX, trust formation,
denomination psychology (sats vs BTC vs fiat), error-prevention in irreversible-payment UX, and
onboarding psychology for self-custody.

Doctrine context: `docs/DESIGN-MANIFESTO.md` (evergreen identity, sats-first MUST rules,
friction ladder, multi-horizon deltas) and `docs/UX-REDESIGN-SPEC.md` (epic cairn-gt05,
3-tier disclosure, Venmo-shaped Send). Findings are checked against both; anything that
*challenges* doctrine is flagged explicitly in §3 rather than buried.

**Source-quality note.** Preference order used: peer-reviewed (CHI/SOUPS/JDM/J. Political
Economy/psych journals) > NN/g and equivalent UX research orgs > practitioner writeups. Two
widely-circulated claims could **not** be traced to a primary source and are flagged as
unverified where they appear: (a) "visual security communication increased trust by 42%"
(appears only in agency listicles), (b) "wallet onboarding churn is >70% because of seed-phrase
shock" (industry claim, no public methodology). Neither is load-bearing for any recommendation
below.

---

## 1. Findings

### F1 — Myopic loss aversion: evaluation frequency is the lever, not the loss itself

The canonical result (Benartzi & Thaler 1995; replicated experimentally in Thaler, Tversky,
Kahneman & Schwartz 1997 and in field data on private investors) is that loss-averse people who
*evaluate* a volatile position more frequently experience more losses, take less risk, and end
up worse off — the harm scales with **how often the value is re-framed as a gain/loss event**,
not with the underlying volatility. Investors given less frequent feedback invest more and earn
more; the effect is robust in 2016–2021 empirical and NBER replications.

- https://www.sciencedirect.com/science/article/abs/pii/S0378426616300401 (Lee & Veld-Merkoulova 2016, J. Banking & Finance — empirical, private investors)
- https://www.nber.org/system/files/working_papers/w28730/w28730.pdf (NBER w28730)
- https://arxiv.org/pdf/2107.02334 (uncertainty visualization reduces MLA in retirement decisions)

**Heartwood read:** this is the exact research base the manifesto's sats-first rule, the
no-price-notifications rule, and the multi-horizon-delta rule already cite. The research
**confirms doctrine** and adds one sharpening: the lever is *evaluation events*, so anything
that creates an extra "how much is it worth now?" moment (a fiat line that repaints on every
tick, a widget, a badge) is a loss-aversion tax even if it never turns red. Fiat secondary
lines should update lazily (on load, not live-tick).

### F2 — Denomination psychology: numerosity and unit bias cut both ways

Two distinct, well-established effects:

1. **Unit bias / "can't afford a whole one."** People treat one whole unit as the natural
   quantity; fractional ownership feels paltry. Denominating in sats ("34,500 sats" vs
   "0.000345 BTC") removes the decimal wall and demonstrably feels more substantial.
   - https://bitcoinmagazine.com/glossary/unit-bias
   - https://learncrypto.com/blog/grow-your-stack/do-you-suffer-from-crypto-unit-bias-1
2. **Numerosity heuristic.** People over-weight the number and under-weight the unit: the same
   value expressed in more units is perceived as larger. This is peer-reviewed and robust
   across pricing, loyalty points, and virtual currencies (Bagchi & Davis 2016 review;
   Pandelaere et al. "unit effect"; ISR 2020 on virtual-item pricing).
   - https://www.sciencedirect.com/science/article/abs/pii/S2352250X15003176 (Bagchi & Davis, role of numerosity in JDM)
   - https://pubsonline.informs.org/doi/10.1287/isre.2020.0955 (numerosity → perceived expensiveness of virtual items)

**Heartwood read:** numerosity **strongly supports sats-first for the balance** (a growing
6-digit number reads as wealth accumulating; the same growth in BTC decimals is invisible).
But the identical mechanism means: (a) an **outgoing amount** displayed sats-first reads
*larger* — more pain of paying for the same send; (b) a **fee** displayed sats-first reads
more expensive than fiat+time framing; (c) at large balances the digit string outruns
comprehension (2.1 BTC = 210 000 000 sats — subitizing fails, the number becomes noise).
See flags in §3.

### F3 — Trust is formed by observed competence, not by reassurance assets

NN/g's long-running position (two dedicated articles + ecommerce trust report): credibility
comes from **design quality, upfront disclosure, comprehensive/correct content, and visible
attention to detail** — and trust accrues from repeated interactions where the system behaves
as promised. Typos, layout inconsistency, and vague copy destroy trust faster than badges
build it. Practitioner fintech research converges: users tolerate a *slower* experience that
explains itself over a fast one that leaves them uncertain; clarity beats speed.

- https://www.nngroup.com/articles/trustworthy-design/ (4 credibility factors)
- https://www.nngroup.com/articles/communicating-trustworthiness/
- https://phenomenonstudio.com/article/fintech-ux-design-patterns-that-build-trust-and-credibility/

The frequently quoted "security badges raised trust 42%" claim traces only to agency blogs —
**treat as unverified**. What *is* defensible: contextual, plain-language explanation of what
the system is doing at the moment of a sensitive action ("you approve this on your device";
"your node broadcasts this directly") measurably reduces uncertainty and reads as competence
rather than theater — because it is *information*, not reassurance.

**Heartwood read:** confirms the manifesto's badge-wall ban. Sharpens it: the anti-theater rule
should not crowd out **competence microcopy at action moments** — one quiet factual line about
the mechanism, at the step where the user is about to commit, is trust-forming and doctrinally
clean (the spec's "How this wallet signs" line is exactly this pattern; extend it to Send).

### F4 — Warnings habituate within two exposures; friction must be rare and varied

fMRI + eye-tracking work (Anderson, Kirwan, Vance et al., CHI 2015 and follow-ups): neural
response to a security warning **collapses after the second exposure**; by week's end users
click through without processing. Warnings that vary their appearance ("polymorphic") resist
habituation dramatically better in lab and 3-week field studies. NN/g independently: overused
confirmation dialogs *increase* error rates because users rush to counteract the inefficiency.

- https://dl.acm.org/doi/10.1145/2702123.2702322 (CHI 2015, polymorphic warnings fMRI)
- https://scholarsarchive.byu.edu/facpub/9293/ (longitudinal fMRI habituation study)
- https://www.nngroup.com/articles/confirmation-dialog/

**Heartwood read:** confirms the friction ladder (friction ∝ stakes, undo > dialog). Adds two
concrete design consequences: (1) the slide-to-send review works *because* it restates amount
+ recipient as the hero — recognition of specifics, not a generic "are you sure"; keep it
information-bearing, never let it degrade into a ritual. (2) Any *extra* check reserved for
unusual sends (first send to a new address, send > N% of balance) should be **stake-triggered
and visually distinct from the routine flow** — rarity and variation are what keep it neurally
alive.

### F5 — Slips vs mistakes: irreversible-payment errors need different defenses each

Norman's taxonomy via NN/g: **slips** are right-goal/wrong-execution (paste the wrong address,
fat-finger a zero, enter sats in a BTC field); **mistakes** are wrong mental model (misjudge a
fee, misunderstand what "remove wallet" does). Slips are fought with constraints, good
defaults, and previews at the moment of action; mistakes are fought with clear conceptual
copy and disclosure. Confirmation dialogs mainly catch slips — and only when they surface the
*specifics* the user can recognize as wrong.

- https://www.nngroup.com/articles/slips/
- https://www.nngroup.com/articles/user-mistakes/
- https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/ (dangerous-action patterns: reversibility × frequency × complexity)

**Heartwood read:** the single highest-stakes slip surface in the app is **Send amount entry
with a unit toggle** — a sats/BTC switch is a 100,000,000× slip amplifier, and a fiat/BTC
switch a further one. The second is recipient-paste. Both are cheap to defend (see R1, R2).
Bech32 checksums catch *typos* but not *wrong-paste* — the checksum passes on the wrong
address.

### F6 — Pain of paying is real, neural, and proportional to payment transparency

Prelec & Loewenstein 1998 ("The Red and the Black"); a 2024 meta-analysis of the cashless
effect (Journal of Retailing) confirms: more transparent/salient payment = more pain = more
deliberate spending; decoupled, low-salience payment = overspending. Neuroimaging shows the
aversive response is literal.

- https://en.wikipedia.org/wiki/Pain_of_paying (overview w/ primary refs)
- https://www.sciencedirect.com/science/article/pii/S0022435924000216 (2024 meta-analysis, cashless effect)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11444724/ (mobile payment & attentional mechanism)

**Heartwood read:** confirms the manifesto's own line that broadcast "is where the pain of
paying *should* be felt." For a **savings instrument**, sends should be salient and deliberate
(slide gesture, restated hero amount = high transparency — correct). The complement: don't
*add* pain where no decision exists — fees framed as fiat + time ("$0.42 · about 30 min") is
the right low-salience framing for a non-decision, and the manifesto's "ordinary spend is
`--text`, never red" is supported.

### F7 — Self-custody onboarding: the recovery-phrase moment is the anxiety peak, and users fear their own errors more than attackers

Peer-reviewed base: Voskobojnikov, Wiese, Mehrabi Koushki, Roth & Beznosov (CHI 2021) analyzed
6,859 wallet app reviews — both new *and experienced* users hit domain-specific UX failures
that can cause "dangerous errors and irreversible monetary losses"; fear of self-inflicted
loss dominates. Krombholz et al. (2016) large-scale survey found widespread misconceptions
about what keys/backups actually do. Practitioner research consistently locates the single
highest-anxiety, highest-dropout point at **seed-phrase presentation**, and finds users balk
at copying sensitive material *before understanding its purpose*. (The specific ">70% churn"
figure is an industry claim without public methodology — direction is corroborated,
magnitude is not.)

- https://dl.acm.org/doi/abs/10.1145/3411764.3445407 (CHI 2021, "The U in Crypto Stands for Usable")
- https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445679 (CHI 2021, "Bits Under the Mattress" — risk perceptions of crypto users)
- https://arxiv.org/pdf/1802.04351 (Eskandari et al., first look at bitcoin key-management usability)
- https://www.theblock.co/post/386514/user-experience-in-crypto-wallets-how-to-increase-adoption-and-engagement (industry corroboration)

**Heartwood read:** explain **before** reveal ("what these 12 words control; what happens if
you lose them; what Cairn can and cannot see"), never scare copy, verification-by-recognition
after, and a legitimate deferred path whose reminder lives in Health's calm amber grammar
(already doctrine). The anxiety driver is *responsibility without confidence* — so the fix is
confidence-building copy and a rehearsal, not more warnings.

### F8 — Progressive disclosure has direct evidence, including for perceived learning

NN/g (canonical): progressive disclosure improves learnability, efficiency, and error rate.
Recent academic support: Anik & Bunt (2026) found progressive disclosure enhanced *perceived
learning* — users felt they understood the system better when complexity arrived staged.
Fintech-specific practitioner data (choice overload → decision paralysis in onboarding)
points the same way.

- https://www.nngroup.com/articles/progressive-disclosure/
- https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/

**Heartwood read:** straight confirmation of the spec's 3-tier disclosure architecture and the
jargon-gloss (`<Term>`) mechanism. No change required; cited here as evidence the spine is
sound.

### F9 — Mental accounting and goal-setting: labels and goals causally increase saving

Thaler's mental accounting: people treat labeled pots as non-fungible, and labeling changes
behavior. Save More Tomorrow (Thaler & Benartzi 2004, J. Political Economy) shows
present-bias is beaten by pre-commitment framed to avoid felt loss (savings rates 3.5%→13.6%
over 40 months). Gargano & Rossi ("Goal Setting and Saving in the FinTech Era") provide
causal field evidence that merely **setting a named savings goal in an app significantly
increases saving rates**.

- https://www.journals.uchicago.edu/doi/10.1086/380085 (Save More Tomorrow)
- https://economics.ucr.edu/wp-content/uploads/2022/03/3-10-22-Rossi-2.pdf (Gargano & Rossi, goal setting in fintech)
- https://onlinelibrary.wiley.com/doi/10.1002/9781119440895.ch6 (mental accounting in household decisions)

**Heartwood read:** Heartwood cannot buy bitcoin for the user (not an exchange), so SMarT-style
auto-escalation is out of scope. What's in scope: **wallet naming as mental accounting** (the
spec's own examples "Everyday Spending" / "Cold Storage" are jars) and an optional per-wallet
**goal** ("sealing" toward a named target fits the rings vocabulary natively).

### F10 — Perceived wealth is attention-dependent (minor, supporting)

Sussman & Shafir (2012, Psychological Science): perceived wealth is shaped by what the display
draws attention to, not net position alone; people also chronically under-attend to balances.
Supports the one-hero-number rule and multi-horizon framing; no new mechanism beyond F1/F2.

- https://journals.sagepub.com/doi/abs/10.1177/0956797611421484

---

## 2. Prioritized improvements

Ordered by (irreversible-money risk first, then trust/retention leverage). Effort: S ≤ 1 day,
M ≈ 2–4 days, L ≥ 1 week. Screens named per `UX-REDESIGN-SPEC.md`.

| # | Improvement | Finding | Effort | Surface |
|---|---|---|---|---|
| R1 | Unit-slip guards on Send amount entry | F5, F2 | **S** | Send create (`wallets/[id]/send`, AmountEntry) |
| R2 | Recipient recognition aids + stake-triggered address check | F4, F5 | **S/M** | Send review (`ReviewDisplay`) |
| R3 | "Sending in 5s — Cancel" broadcast grace window | F4, F5, F6 | **M** | Send confirm step (post-slide, pre-broadcast) |
| R4 | Explain-before-reveal backup flow + recognition verify | F7 | **M** | Wallet-create wizard; Health backup nudge |
| R5 | Competence microcopy at commit moments | F3 | **S** | Send sign step, Receive, Health |
| R6 | Ship the multi-horizon delta + lazy fiat repaint | F1, F10 | **M** | Home (Phase-1 retrofit), wallet detail |
| R7 | Fee framing: %-of-send context line | F6, F2 | **S** | Send review fee line |
| R8 | Wallet purpose-naming + optional goal ring | F9 | **M/L** | Wallet-create wizard; wallet detail |
| R9 | Sats legibility threshold rule (doctrine amendment) | F2 | **S** | app-wide formatter (`formatAmount` seam) |

### R1 — Unit-slip guards on Send amount entry (S) — *do this first*

The amount field with a unit toggle ("tap to switch to BTC") is the app's largest slip
amplifier (F5): sats↔BTC is 10⁸×, fiat↔BTC another multiplier. Defenses, all cheap:
- **Always render the live conversion line** directly under the amount hero in the *other*
  unit(s) — never let an amount exist on screen in only one unit while editing.
- Group sats digits with thin spaces **as the user types** (numerosity legibility, F2).
- If the entered amount exceeds a proportion threshold (e.g. > 50% of spendable balance),
  show one calm `--text-secondary` line: "That's most of this wallet's balance." — amber
  grammar, not red (doctrine-compliant: amber = attention, this is not an error).
- Unit switch never converts a typed number silently; it either converts *with* the visible
  equivalence line or clears with focus retained.

### R2 — Recipient recognition aids + stake-triggered check (S/M)

Bech32 checksums stop typos, not wrong-pastes (F5). On the review card:
- Render the address **grouped** (`bc1q x8k2 … 9f4d`) with first/last groups at full
  `--text` and the middle muted — the eye verifies the ends, which is what forensics of
  wrong-sends shows people actually compare. Saved contacts show name + address, never name
  alone.
- **Stake-triggered only** (F4 — rarity keeps it alive): first-ever send to this address *and*
  amount above a user-relative threshold → one extra distinct step ("Verify the last 4
  characters of the address: ____") that is visually unlike anything else in the flow. Routine
  repeat sends never see it. Do not add a checkbox or generic dialog — those habituate by the
  second exposure.

### R3 — Broadcast grace window: "Sending in 5s — Cancel" (M)

The manifesto's own hierarchy says **undo beats warning** — but broadcast is irreversible, so
today all safety must live *before* the commit. A 5-second post-slide, pre-broadcast hold with
a single calm Cancel affordance manufactures an undo window at the exact point of maximum
regret-availability (people notice the wrong-paste *right after* committing — the classic
post-completion recognition moment). This converts Heartwood's one irreversible action into a
briefly reversible one, which is the strongest error-recovery pattern available (F5, NN/g;
Gmail's undo-send is the proven precedent).
- Countdown rendered in ring vocabulary (an unwinding arc), not an alarm timer.
- Skippable per-send ("Send now") and disableable in Settings → Display for power users.
- No new red; Cancel is a ghost button.

### R4 — Explain-before-reveal backup flow (M)

Sequence the recovery-phrase moment (F7): one screen of plain-language stakes *before* any
words render ("These 12 words are your wallet. Anyone with them has your bitcoin; without
them, nobody — including Cairn — can recover it."), then reveal, then a
**recognition-based** verify (pick word #3 from four options — recall quizzes punish and
stall), then a calm success state in growth grammar ("Backed up. This wallet can now outlive
this device."). Deferral stays legitimate: "Do this later" drops to Health's amber row, never
a blocking nag. Never the word "WARNING", never a skull-and-crossbones register — the
research says the anxiety is *responsibility without confidence*; supply confidence.

### R5 — Competence microcopy at commit moments (S)

One quiet factual line, `--t-label` muted, at each commit point (F3):
- Sign step: "You approve this on your device. Cairn only ever holds your public key."
- Broadcast: "Your own node broadcasts this — no third party sees it first."
- Receive: keep "A fresh address, every time." (already the reference pattern).
This is information, not reassurance — doctrinally distinct from the banned badge wall, and
it converts the sovereignty architecture (the actual trust asset) into *felt* trust.

### R6 — Actually ship the multi-horizon delta + lazy fiat (M)

The manifesto mandates 1d/30d/1yr/all-time shown together (MUST) but Home Phase 1 shipped
before the money-rules retrofit. F1 sharpens the spec: the fiat secondary line should update
**on navigation, not on live tick** — every repaint is an evaluation event and therefore a
loss-aversion exposure, even without color or motion. Percent-framing leads growth stories
("+8% this month"), absolute sats one layer down.

### R7 — Fee % -of-send context line (S)

On the review fee line, when the fee is a small fraction of the send, append muted context:
"$0.42 · about 30 min · less than 1% of this payment." Anchoring the fee against the payment
(rather than against zero) is a benign anchor that matches how people actually judge
transaction costs (F6). Suppress the fraction when it's unflattering (> ~5%) — never spin,
just omit; the raw numbers remain.

### R8 — Wallet purpose-naming + optional goal (M/L)

At wallet creation, offer purpose-suggestive name chips ("Everyday", "Savings", "Family
fund") — labeling is mental accounting and changes behavior (F9). Optional per-wallet goal:
a named sats target rendered as one more unsealed ring on the wallet's dial (native fit with
the rings vocabulary; goal-setting has causal field evidence of increasing saving — Gargano
& Rossi). Goal state must obey doctrine: progress animates on *deposits* only; never
regresses visually on price (goals denominate in sats, which also quietly reinforces
sats-first).

### R9 — Sats legibility threshold (S, doctrine amendment — see flag §3.1)

Codify in the shared amount formatter: balances render sats-first up to a legibility
threshold (proposal: < 0.1 BTC → sats hero; ≥ 0.1 BTC → BTC hero at sensible precision with
sats muted secondary). Rationale in §3.1. One formatter seam, no per-screen logic.

---

## 3. Findings that challenge current doctrine (flagged, not hidden)

### 3.1 Sats-first is double-edged — numerosity doesn't only work for you

Doctrine (manifesto §3, MUST): sats/BTC-first everywhere, fiat muted. The **balance** case is
strongly supported (F1 + F2: monotone growth + numerosity amplification). But the same
numerosity mechanism (F2) predicts:

1. **Send amounts read larger in sats** — "1 200 000 sats" feels like more money leaving than
   "0.012 BTC" or "$1,250". For a savings instrument this extra pain-of-paying is arguably a
   *feature* (F6, and the manifesto agrees for broadcast), so no change recommended — but it
   is a real, uncited side effect the doctrine should own knowingly.
2. **Large balances defeat comprehension.** Above ~7–8 digits the numeral stops being read as
   a quantity and becomes texture; the growth signal the sats-hero exists to deliver (the
   drumbeat of an increasing number) is lost when the number is illegible. A 2-BTC saver's
   "210 000 000 sats" communicates *less* growth than "2.10 BTC" ticking to "2.11".
   **Recommendation R9** amends, not repeals: sats-first below a threshold, BTC-first above.
   This is a genuine (small) contradiction of the blanket rule and should be decided
   explicitly, not slipped in.

### 3.2 "No reassurance banners" needs a carve-out for contextual security explanation

Doctrine bans badge-wall security theater (correct per F3 — badges are unverifiable claims).
But the evidence also says *uncertainty at commit moments* is the main trust-killer, and that
plain factual explanation of the mechanism at the point of action increases trust. The
manifesto's privacy-gesture section ("we do not editorialize about danger") could be
over-read to prohibit R5's microcopy. Proposed doctrinal clarification: **banned = claims
("bank-grade security", lock badges); allowed = mechanism facts at the moment they're
relevant** ("you approve on your device"). The spec already contains one instance ("How this
wallet signs") — R5 generalizes it.

### 3.3 The friction ladder's top rung has no undo — R3 changes that

Doctrine: "undo beats a warning dialog," yet the highest-stakes action (broadcast) is pure
pre-commit friction because the network makes undo impossible. The 5-second grace window (R3)
is technically *pre*-broadcast, so it doesn't violate Bitcoin's rules — but it does add a
deliberate latency to the app's most important action, which tension the manifesto's
"confident, not scary" framing should adjudicate. Recommended as default-on because the
post-commit recognition moment is when wrong-paste slips actually surface (F5), and 5 seconds
of an unwinding ring is calm, not scary.

### 3.4 Hide-balance is also loss-aversion hygiene (reframe, no conflict)

The manifesto frames the eye-toggle purely as privacy empowerment. F1 adds a second,
research-backed benefit worth capturing in copy/positioning someday: masking the balance
reduces evaluation frequency, which is MLA hygiene ("your numbers, when you want them" is
accidentally optimal). No change required; noted so future copy doesn't drift toward
danger-framing.

---

## 4. Source list

Peer-reviewed / primary:
- Benartzi & Thaler 1995 (myopic loss aversion; via NBER/JBF replications): https://www.nber.org/system/files/working_papers/w28730/w28730.pdf ; https://www.sciencedirect.com/science/article/abs/pii/S0378426616300401
- Thaler & Benartzi 2004, Save More Tomorrow, J. Political Economy: https://www.journals.uchicago.edu/doi/10.1086/380085
- Prelec & Loewenstein 1998 + 2024 cashless-effect meta-analysis: https://en.wikipedia.org/wiki/Pain_of_paying ; https://www.sciencedirect.com/science/article/pii/S0022435924000216
- Bagchi & Davis 2016 (numerosity review): https://www.sciencedirect.com/science/article/abs/pii/S2352250X15003176
- ISR 2020, numerosity & perceived expensiveness: https://pubsonline.informs.org/doi/10.1287/isre.2020.0955
- Anderson et al. CHI 2015, polymorphic warnings fMRI: https://dl.acm.org/doi/10.1145/2702123.2702322 ; longitudinal follow-up: https://scholarsarchive.byu.edu/facpub/9293/
- Voskobojnikov et al. CHI 2021: https://dl.acm.org/doi/abs/10.1145/3411764.3445407
- "Bits Under the Mattress" CHI 2021: https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445679
- Eskandari et al., bitcoin key-management usability: https://arxiv.org/pdf/1802.04351
- Sussman & Shafir 2012, perceived wealth: https://journals.sagepub.com/doi/abs/10.1177/0956797611421484
- Gargano & Rossi, goal setting in fintech: https://economics.ucr.edu/wp-content/uploads/2022/03/3-10-22-Rossi-2.pdf
- Uncertainty visualization & MLA: https://arxiv.org/pdf/2107.02334

UX research orgs:
- NN/g slips: https://www.nngroup.com/articles/slips/
- NN/g mistakes: https://www.nngroup.com/articles/user-mistakes/
- NN/g confirmation dialogs: https://www.nngroup.com/articles/confirmation-dialog/
- NN/g progressive disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- NN/g trustworthy design: https://www.nngroup.com/articles/trustworthy-design/ ; https://www.nngroup.com/articles/communicating-trustworthiness/

Practitioner / industry (used only for direction, never magnitude):
- https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/
- https://phenomenonstudio.com/article/fintech-ux-design-patterns-that-build-trust-and-credibility/
- https://www.theblock.co/post/386514/user-experience-in-crypto-wallets-how-to-increase-adoption-and-engagement
- https://bitcoinmagazine.com/glossary/unit-bias ; https://learncrypto.com/blog/grow-your-stack/do-you-suffer-from-crypto-unit-bias-1
- https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/

Flagged-unverified claims (do not build on): "42% trust lift from security badges"
(agency listicles only); ">70% onboarding churn from seed-phrase shock" (industry figure,
no public methodology — direction corroborated by CHI 2021 work, magnitude not).
