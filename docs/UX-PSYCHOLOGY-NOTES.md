# UX Psychology Notes — What Makes Hobbyist Solo Mining Sticky

**Date:** 2026-07-19
**Status:** RESEARCH NOTES (feeds hash-attraction roadmap; no implementation authorized here)
**Inputs:** docs/HASH-ATTRACTION-STRATEGY.md, docs/DIFFICULTY-RAFFLE-ANALYSIS.md,
docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md, docs/DESIGN-MANIFESTO.md doctrine
(amber = attention not error, green = growth only, plain language, sats-first),
web research 2026-07-19 (citations inline).

**One-line thesis:** Solo mining is already a perfectly engineered engagement machine —
a variable-ratio jackpot with real money, real identity, and real near-misses built into the
physics. Heartwood's job is not to add slot-machine tricks; it is to *surface what is already
true* (odds, best shares, cumulative work, community wins) and to draw a hard ethical line
where casinos deliberately blur one.

---

## Summary table: mechanism → Heartwood feature → status

| # | Mechanism | Heartwood feature | Status |
|---|---|---|---|
| 1 | Variable-ratio reward (Skinner) | Block-find = jackpot; solo-win celebration + press kit | Planned (cairn-7msai); explorer block celebration shipped |
| 1 | Variable-ratio, small-reward layer | "Community wins" feed (ckpool/Bitaxe block finds as in-app news) | Proposed (new bead) |
| 2 | Near-miss effect (Reid 1986; Clark 2009) | Best-share tracking + verifiable best-share leaderboard | Planned (cairn-192dr); best-share currently hidden (bead 20k25) |
| 2 | Near-miss, honest variant | "How close was that?" share context line (X% of block target) | Proposed (new bead) |
| 3 | Social comparison (Festinger 1954) | Instance leaderboard + public pool stats page | Planned (cairn-192dr, cairn-19o5e) |
| 3 | Cross-instance comparison | No-payout leaderboard federation (bragging rights) | Planned (cairn-34epf, gated on cz3q) |
| 4 | Loss aversion / endowment (Kahneman-Tversky 1979) | Backup nudge escalation on first funds (FUNDED bucket) | Spec'd (cairn-gt05.5) |
| 5 | Goal-gradient + progress viz (Hull 1932; Kivetz 2006) | Cumulative work counter + "your odds so far" panel | Partially shipped (MiningOddsPanel); cumulative framing proposed |
| 5 | Streaks (uptime, not login) | Miner uptime streak ("47 days hashing") | Proposed (new bead) |
| 6 | IKEA effect / identity (Norton et al. 2012) | Worker naming, hardware profiles, miner identity card | Proposed (new bead); worker names exist at stratum level |
| 7 | Lottery framing / probability overweighting | Honest-odds copy doctrine ("years per block", never earnings) | Shipped (soloOdds anti-hype doctrine); copy patterns below |
| 8 | Ethical guardrails | Heartwood honest-mechanics doctrine (this doc, §8) | Proposed (adopt into DESIGN-MANIFESTO) |

---

## 1. Variable-ratio reward schedules — the jackpot is the physics

**Research.** Skinner and Ferster's operant-conditioning work established that
variable-ratio schedules (reward after an unpredictable number of responses) produce the
highest response rates and the strongest resistance to extinction of any schedule — behavior
persists through long dry spells precisely because the next response might pay
([Ferster & Skinner 1957, *Schedules of Reinforcement*; overview](https://www.simplypsychology.org/schedules-of-reinforcement.html)).
Gambling is the canonical human example: slot machines are variable-ratio devices, and
mixing occasional large payouts with frequent small ones produces the most persistent
behavior of any schedule tested ([Lumen/OpenStax psych text](https://courses.lumenlearning.com/waymaker-psychology/chapter/reading-reinforcement-schedules/)).

**Products.** Slot machines, loot boxes, pull-to-refresh feeds. Closest to us:
solo.ckpool's block finds. Every ckpool/Bitaxe win becomes a press cycle (40+ solo blocks
since mid-2023; a ~480 GH/s Bitaxe winning ~$258k made mainstream news — see
HASH-ATTRACTION-STRATEGY §2). The *community-level* reward schedule matters: even when
**you** don't win, **someone like you** wins every few weeks, which functions as a
vicarious reinforcement event for the whole segment.

**Heartwood.** Solo mining IS a variable-ratio schedule with a real jackpot — nothing to
manufacture. Two gaps:

- **The jackpot moment must be unmissable.** cairn-7msai (solo-win celebration + verifiable
  press kit) is the single highest-leverage engagement feature: full-screen celebration,
  permanent "blocks this house has found" ledger, one-click shareable proof.
- **Proposed: community-wins feed (bead-sized).** A small card on /mining: "A 1.2 TH/s
  Bitaxe found block 957,382 last week." Sourced from a curated static list updated per
  release (no phone-home). This supplies the *small frequent reinforcement* layer the raw
  block schedule lacks, using true events. Honest by construction — it's news, not odds
  inflation.

## 2. Near-miss effect — best shares as engineered near-misses

**Research.** Reid ([1986, *J. Gambling Behavior*](https://www.semanticscholar.org/paper/The-psychology-of-the-near-miss-Reid/0354b802ddb721407b5e3c7f71dd9fbf4275d81c))
established that near-misses encourage continued play even in pure-chance games. Clark et
al. ([2009, *Neuron* 61(3):481-490](https://pubmed.ncbi.nlm.nih.gov/19217383/)) showed
near-misses are rated *less pleasant* than full misses yet *increase desire to play*, and
recruit the same striatal/insula circuitry as actual wins. Crucially, the effect was
strongest when subjects had personal control over their gamble — and a miner pointing
their own hardware at their own node is maximal personal control.

**Products.** Slot machines deliberately weight reels to show jackpot-adjacent stops —
this is the *misappropriated* version that has been litigated (Nevada banned virtual-reel
near-miss inflation in 1988). ckpool shows best-share-ever per worker; the Bitaxe UI's
best-difficulty display is arguably the single stickiest number in home mining — owners
screenshot it and post it.

**Heartwood.** A high-difficulty share is a *genuine* near-miss: it is real PoW that
really was close to the target. DIFFICULTY-RAFFLE-ANALYSIS shows best-share is exactly
hashrate-proportional and self-authenticating — our near-miss display is *verifiable*,
which no casino can say.

- Best-share is currently computed but hidden (bead 20k25) and recorded only as the
  vardiff floor, not the achieved value (RAFFLE-ANALYSIS precision pitfall —
  `ShareEvent` must carry the raw hash value). Fixing that is prerequisite to everything
  in this section, and to cairn-192dr.
- **Proposed: share-context line (bead-sized).** When a new personal best lands, show it
  in plain language: "Your best share so far reached 0.4% of what a block needs. A block
  needs ~250,000× more — but every share has the same tiny chance of being the one."
- **Ethical line (vs slots):** we display near-misses that *actually happened*, at their
  *actual* closeness, with the honest reminder that hashing is memoryless — a near-miss
  does NOT mean you're "getting closer." Casinos manufacture near-miss frequency; we must
  never reorder, inflate, or dramatize share difficulty. Copy must avoid "so close!" /
  "almost!" framing that implies progress toward an inevitable win.

## 3. Leaderboards, social proof, relative comparison

**Research.** Festinger's social comparison theory (1954): people evaluate themselves
against similar others when objective standards are absent. Gamification meta-analyses
(e.g. [Hamari, Koivisto & Sarsa 2014](https://www.sciencedirect.com/science/article/pii/S0747563221002867))
find leaderboards generally effective but context-dependent; a
[PLOS One study](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0249283)
found leaderboards raised saving intentions, and fitness-app research finds comparison
against *similar-level* peers motivates while comparison against far-superior ones
demotivates. Design implication: rank bands and personal-best framing beat one global
ladder dominated by whales.

**Products.** Strava segments (compare within your own cohort), Duolingo leagues
(30-person brackets, weekly reset — everyone can win *their* bracket), ckpool's bare
worker stats (weak social layer — an explicit gap named in HASH-ATTRACTION §4).

**Heartwood.** Already the plan of record: cairn-192dr (verifiable best-share
leaderboard) and cairn-19o5e (public opt-in stats page) are roadmap items #1-#2.
Psychology refinements to bake into 192dr's spec:

- **Window resets = Duolingo leagues.** A weekly best-share window gives every Bitaxe a
  fresh shot at #1 (RAFFLE-ANALYSIS already requires fixed windows for fairness — the
  fairness fix and the psychology fix are the same fix).
- **Rank by luck-normalized best share, not hashrate**, at least in one view: best share
  ÷ expected best share for your hashrate. A 500 GH/s Bitaxe can beat a 100 TH/s rack on
  luck — that's the whole appeal, and it keeps small miners on the board.
- **Federated bragging rights** (cairn-34epf) extends comparison across instances with no
  money movement — the highest-value social feature that needs no legal gate.

## 4. Loss aversion & endowment framing — backups, not streak-guilt

**Research.** Kahneman & Tversky's prospect theory
([1979, *Econometrica* 47(2):263-291](https://en.wikipedia.org/wiki/Prospect_theory)):
losses loom roughly 2× larger than equivalent gains; people are risk-averse in gains,
risk-seeking in losses. The endowment effect (Thaler 1980; Kahneman, Knetsch & Thaler
1990): once something is *yours*, giving it up hurts more than acquiring it pleased.

**Products.** Duolingo's streak is loss-aversion incarnate — users defend the 180 days
they *have*, not day 181; it drives ~55% MAU retention but also documented anxiety and
hollow "streak-saving" engagement ([Duolingo's own habit-research post](https://blog.duolingo.com/how-duolingo-streak-builds-habit/);
[critique](https://dev.to/pocket_linguist/why-duolingos-gamification-works-and-when-it-doesnt-1d4)).
Fitness apps sell streak freezes — monetizing the anxiety they created.

**Heartwood.** Use loss aversion **where the loss is real and ours to prevent** — an
unbacked wallet holding sats — and refuse it for manufactured stakes:

- The backup-nudge spec (cairn-gt05.5) already does this correctly: the FUNDED escalation
  fires when real money lands in an unbacked wallet, and copy shifts from "good hygiene"
  to endowment framing: "This wallet now holds 210,000 sats. Right now, this device is
  the only thing standing between you and losing them." That is honest loss aversion —
  the loss is real, the urgency is real.
- **Anti-pattern to refuse:** "your streak will die" mechanics for mining. A miner's
  uptime streak (see §5) may lapse and resume without shame — no streak freezes for sale,
  no red numbers, no "don't lose your progress!" push notifications. The only loss we
  dramatize is one where a user can genuinely lose bitcoin.

## 5. Streaks, goal-gradient, progress visualization

**Research.** Hull's goal-gradient hypothesis (1932: rats run faster nearer food) was
revived by Kivetz, Urminsky & Zheng
([2006, *J. Marketing Research* 43:39-58](https://journals.sagepub.com/doi/abs/10.1509/jmkr.43.1.39)):
coffee-card customers buy faster near the free coffee, and *illusory progress* (a
12-stamp card with 2 pre-stamps) speeds completion versus an empty 10-stamp card even
though remaining effort is identical. The endowed-progress lesson: showing accumulated
work motivates, even when the endowment is framing.

**Products.** Duolingo/GitHub streaks; fitness rings; loyalty cards. Note the trap for us:
goal-gradient assumes a *deterministic* goal you approach. A memoryless lottery has no
gradient — implying one is the gambler's fallacy weaponized.

**Heartwood.** Progress framing must attach to things that genuinely accumulate:

- **Cumulative work counter (proposed, bead-sized).** "Your miners have computed 4.7×10¹⁸
  hashes since March — that work was real and yours" plus cumulative probability: "odds
  you'd have found a block by now: 1 in 1,900." This is endowed progress that is *true*
  (work done, odds consumed) without implying you're "due" — pair with a fixed gloss:
  "past work never changes future odds."
- **Uptime streak (proposed, bead-sized).** "47 days hashing without a gap" rewards the
  behavior we actually want (stable hardware, stratum reliability — synergy with
  cairn-54m1q surfacing). Uptime is a real, deterministic accumulator, so streak framing
  is honest here. Lapse handling per §4: neutral copy, auto-resume, longest-streak kept
  as a personal best rather than "lost."
- MiningOddsPanel already shows odds as years-per-block (anti-hype doctrine). The
  "your odds so far" cumulative view completes it: prospective odds stay sober, while
  retrospective accumulation supplies the warm progress feeling.

## 6. Ownership, IKEA effect, identity — "I am a miner"

**Research.** Norton, Mochon & Ariely
([2012, *J. Consumer Psychology* 22(3):453-460](https://myscp.onlinelibrary.wiley.com/doi/abs/10.1016/j.jcps.2011.08.002)):
self-assembly inflates valuation — people price their own wobbly IKEA boxes near expert
work — but only when the build *succeeds* (incomplete builds kill the effect). Identity
research (e.g. self-perception, effort justification) says labels people adopt ("I am a
runner") predict retention far better than incentives.

**Products.** Bitaxe *is* the IKEA effect — a solder-it-yourself open-source miner whose
owners name their devices, post photos, and identify as miners. RGB gamer hardware,
Tamagotchi, Strava's "athlete" label. The home-mining segment already self-selects for
this; Heartwood inherits it if the UI treats devices as *theirs*.

**Heartwood.** Success condition per Norton et al.: the setup wizard (cairn-8tfek) must
end in an unmistakable "it's alive" moment — first accepted share celebrated ("Your miner
just did real work on the Bitcoin network") — because a completed build is what converts
labor into love.

- **Proposed: worker identity cards (bead-sized).** Stratum worker names already exist;
  give each a card: editable friendly name, hardware type, first-seen date, best share
  ever, lifetime hashes. Turns a connection row into a *pet*.
- **Proposed: house badges (bead-sized, later).** Milestones for true events only: first
  share, first week of uptime, personal-best share, block found. No manufactured tiers,
  no XP economy — badges are memories, not currency.

## 7. Sweepstakes/lottery psychology — selling the dream honestly

**Research.** Prospect theory's probability-weighting function overweights small
probabilities — the same inverse-S curve explains lottery tickets *and* insurance
([Kahneman & Tversky 1979; overview](https://en.wikipedia.org/wiki/Prospect_theory);
[AEA discussion of overweighting rare events](https://www.aeaweb.org/research/can-it-be-rational-overweight-unlikely-events)).
Lottery demand scales with jackpot size even as odds worsen; vivid winner stories drive
availability bias ("someone has to win" — and winners are the only players you ever hear
about). People buy a multi-day *fantasy license*, not an EV calculation — and at $1-2 a
week that can be a fair trade.

**Products.** Powerball marketing sells winner stories, never odds. ckpool's viral block
finds are organic winner stories with better properties: the winner is a hobbyist "like
me," the win is on-chain verifiable, and the "ticket price" (electricity for a 15 W
Bitaxe) is genuinely trivial.

**Heartwood.** The dream is legitimate to sell because the cost is honest and disclosed:

- **Copy pattern (adopt in cairn-8tfek + /mining):** "At 1 TH/s expect a block roughly
  every 3,700 years. Someone with those odds has already won — several times. Your
  electricity buys a real ticket to that draw every single second." All three sentences
  are true; together they respect both the math and the dream.
- **Never:** earnings projections, "you're due," countdowns, or odds stated per-share
  ("1 in 10²²!") to make the number look better or worse than the yearly framing.
  Anchor the honest number (years/block) *first*, then the dream — order matters, because
  the first number sets the reference point (anchoring, Tversky & Kahneman 1974).
- The community-wins feed (§1) is our winner-stories channel — verifiable, non-fabricated,
  and each one doubles as marketing (HASH-ATTRACTION press-kit loop, cairn-7msai).

## 8. Ethical guardrails — where this becomes a dark pattern

Casino design (Schüll, [*Addiction by Design*, Princeton UP 2012](https://press.princeton.edu/books/paperback/9780691160887/addiction-by-design))
documents the "machine zone": time-on-device maximized via manufactured near-misses,
losses disguised as wins, and removal of natural stopping points. Every mechanism above
has a dark twin. Heartwood's stance — proposed for adoption as a DESIGN-MANIFESTO
addendum:

| Honest (do) | Dark twin (never) |
|---|---|
| Display real odds prominently, years-per-block first | Bury odds; per-share framing; earnings projections |
| Show near-misses at true value with "memoryless" gloss | Inflate/reorder near-misses; "you're getting closer!" |
| Celebrate real events (shares, blocks, uptime) | Manufactured urgency, countdowns, FOMO windows |
| Uptime streaks that lapse gracefully | Streak-loss guilt, streak freezes for sale |
| Loss-aversion copy only for real loss (unbacked funds) | Loss-aversion copy for engagement metrics |
| Badges as memories of true milestones | XP economies, paid tiers, variable-reward loot |
| Leaderboards with luck-normalized + windowed views | Whale-dominated ladders that shame small miners |
| Quiet by default; user pulls stats | Push notifications engineered for re-engagement |

Three bright lines:

1. **Real money means casino-grade care, not casino-grade tricks.** Users spend real
   electricity chasing real BTC. Any mechanic that would be scummy in a casino is
   *more* scummy here, not less, because we also hold their wallet.
2. **Never exploit the gambler's fallacy.** Every probabilistic display carries the
   memoryless truth within one glance (gloss, not footnote).
3. **Engagement is a byproduct, not the goal.** We optimize for *sovereignty felt* —
   the metric is activated instances and retained miners (cairn-qqmbq), not session
   minutes. If a feature's only defense is "it increases time-on-app," cut it.

---

## Proposed new beads (each small enough to be one bead)

1. **[ux-psych] Community solo-wins feed card on /mining** — curated static list shipped
   per release; ties into cairn-7msai press-kit loop. (§1)
2. **[ux-psych] Best-share context line + personal-best moment** — plain-language "X% of
   block target" with memoryless gloss; depends on raw-hashValue fix from
   RAFFLE-ANALYSIS / 20k25. (§2)
3. **[ux-psych] Cumulative work + "your odds so far" panel** — lifetime hashes +
   cumulative block probability on /mining; extends MiningOddsPanel. (§5)
4. **[ux-psych] Miner uptime streak (graceful)** — current/longest uptime streak, neutral
   lapse copy; synergy with cairn-54m1q. (§5)
5. **[ux-psych] Worker identity cards** — name, hardware, first-seen, best share,
   lifetime hashes per worker. (§6)
6. **[ux-psych] House badges for true milestones** — first share / first week / PB share /
   block found; no XP, no tiers. (§6, lower priority)
7. **[ux-psych] Honest-mechanics doctrine → DESIGN-MANIFESTO addendum** — the §8 table +
   three bright lines as reviewable doctrine. (§8)

## Sources

- Ferster & Skinner 1957, *Schedules of Reinforcement*; https://www.simplypsychology.org/schedules-of-reinforcement.html ; https://courses.lumenlearning.com/waymaker-psychology/chapter/reading-reinforcement-schedules/
- Reid 1986, "The psychology of the near miss," *J. Gambling Behavior* 2:32-39 — https://www.semanticscholar.org/paper/The-psychology-of-the-near-miss-Reid/0354b802ddb721407b5e3c7f71dd9fbf4275d81c
- Clark, Lawrence, Astley-Jones & Gray 2009, *Neuron* 61(3):481-490 — https://pubmed.ncbi.nlm.nih.gov/19217383/
- Festinger 1954, "A theory of social comparison processes," *Human Relations* 7:117-140
- Hamari, Koivisto & Sarsa 2014, "Does gamification work?" HICSS; leaderboard evidence: https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0249283
- Kahneman & Tversky 1979, "Prospect theory," *Econometrica* 47(2):263-291 — https://en.wikipedia.org/wiki/Prospect_theory ; https://www.aeaweb.org/research/can-it-be-rational-overweight-unlikely-events
- Kivetz, Urminsky & Zheng 2006, *J. Marketing Research* 43:39-58 — https://journals.sagepub.com/doi/abs/10.1509/jmkr.43.1.39
- Norton, Mochon & Ariely 2012, "The IKEA effect," *J. Consumer Psychology* 22(3):453-460 — https://myscp.onlinelibrary.wiley.com/doi/abs/10.1016/j.jcps.2011.08.002
- Duolingo streak mechanics: https://blog.duolingo.com/how-duolingo-streak-builds-habit/ ; https://dev.to/pocket_linguist/why-duolingos-gamification-works-and-when-it-doesnt-1d4
- Schüll 2012, *Addiction by Design: Machine Gambling in Las Vegas*, Princeton UP — https://press.princeton.edu/books/paperback/9780691160887/addiction-by-design
- ckpool/Bitaxe solo-win virality: see docs/HASH-ATTRACTION-STRATEGY.md §2 sources

*End of notes.*
