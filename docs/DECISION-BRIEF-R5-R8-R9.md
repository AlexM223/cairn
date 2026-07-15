# Decision Brief — R5 / R8 / R9 (UX-psychology follow-up)

Three calls left open by `docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md` because they amend
`docs/DESIGN-MANIFESTO.md` doctrine (R9, R5) or approve net-new scope (R8). One page each:
the rule at stake, deepened evidence, concrete options, a recommendation, and blast radius.
Decisions are independent — each can be approved or rejected alone.

---

## Decision 1 — R9: sats-first legibility threshold (doctrine amendment)

### Doctrine at stake

Manifesto §3, money rule 3 (MUST): *"BTC / sats is the hero; fiat is a muted secondary line —
by default."* and rule 4: *"Sats grouped with thin spaces (`4 020 000 sats`); BTC to sensible
precision (`0.0402 BTC`)."* The rules never say when sats vs BTC carries the hero — in
practice the app is sats-first at every magnitude. The proposed amendment: above a threshold,
the hero flips to BTC with sats demoted to the muted secondary. **The load-bearing MUST
(bitcoin-first, fiat-muted) is untouched either way** — this is a legibility question inside
the bitcoin denomination, not a fiat question.

### Evidence

**For a threshold.**
- Large-number cognition: people estimate roughly linearly *within* a scale word (thousands,
  millions…) and "reset" at each scale boundary; comprehension of magnitude collapses for
  numbers past the familiar band, and improves when values are rescaled down
  ([Landy et al., "Dealing with Big Numbers"](https://www.researchgate.net/publication/305749828_Dealing_with_Big_Numbers_Representation_and_Understanding_of_Magnitudes_Outside_of_Human_Experience);
  corroborated in [The Conversation](https://theconversation.com/brains-are-bad-at-big-numbers-making-it-impossible-to-grasp-what-a-million-covid-19-deaths-really-means-179081)
  and [NPR](https://www.npr.org/2024/01/03/1198909057/brain-struggles-big-numbers-neuroscience)).
  A 9-digit "210 000 000 sats" is texture, not a quantity — the growth drumbeat the sats hero
  exists to deliver is exactly what dies first.
- Redenomination: whole countries drop zeros because face-value numerosity distorts perception
  and expectations — the digits carry noise, not signal
  ([Mosley, "Dropping Zeros, Gaining Credibility"](https://www.researchgate.net/publication/229051710_Dropping_Zeros_Gaining_Credibility_Currency_Redenomination_in_Developing_Nations);
  [Wertenbroch et al., JCR — currency numerosity is reference-dependent](https://academic.oup.com/jcr/article/34/1/1/1787177)).
- Industry convergence: the [Bitcoin Design Guide](https://bitcoin.design/guide/designing-products/units-and-symbols/)
  recommends BTC-with-decimals as the on-chain default (sats for lightning-scale amounts) and
  explicitly lists "automatic switches between whole bitcoin and satoshi" as a legitimate
  setting.

**Against / cost.**
- The same guide flags the dual convention's real cost: mixed decimal/integer rendering
  "creates unpredictability in the product experience." A unit that changes under the user is
  a comprehension tax of its own.
- Research doc F5: sats↔BTC is a 10⁸× slip amplifier. An *automatic* unit flip anywhere near
  amount **entry** is a fat-finger factory. Whatever is decided for balances must never apply
  inside Send input or review.
- No formal academic study of sats-vs-BTC display exists (searched; only practitioner
  material) — the threshold number itself is judgment, not measurement.

### Options

- **A. Global auto-threshold at 0.1 BTC** (10 000 000 sats — the first 9-digit balance).
  Below: sats hero. At/above: BTC hero to 4 decimals (`2.1034 BTC`), sats as the muted
  secondary line. One seam in the shared formatter.
- **B. Same, threshold 0.01 BTC** (1 000 000 sats). Flips earlier — but 7-digit sats are still
  comfortably legible when thin-space grouped, and 0.01–0.1 BTC is the heart of the
  small-stack-saver audience; taking their drumbeat away early costs more than it saves.
- **C. User setting only, no automatic behavior.** Doctrinally cleanest, but defaults are the
  product; the median user never opens Settings and large-balance users get the illegible hero
  forever.

### Recommendation: **A**, scoped to display heroes only

Threshold 0.1 BTC, applied to *display* surfaces (Home hero, wallet-detail hero, tx-row
amounts optionally). Send amount entry and review **always stay in the user's chosen entry
unit** — no auto-switching where slips are irreversible. Add a Settings → Display override
("Always show sats"). Amend manifesto §3 rule 4 with one sentence; restate that the MUST is
bitcoin-first-vs-fiat, and sats-vs-BTC within it is legibility-governed. Keep the muted sats
secondary under a BTC hero so small deposits still visibly move a number.

**Touches:** `src/lib/format.ts` (one `pickUnit`/`formatAmount` seam — `formatBtc`/`formatSats`
already exist), `src/lib/components/Amount.svelte`, Home + wallet-detail heroes, manifesto §3
(one paragraph), `format.test.ts`. Effort **S**.

---

## Decision 2 — R5: mechanism-fact carve-out to the reassurance ban (doctrine clarification)

### Doctrine at stake

Manifesto §7 AVOID: *"Badge-wall security theater — no wall of lock/shield badges. Privacy is
an active control, not a reassurance banner."* And §5 privacy gesture: *"we do not editorialize
about danger."* Read strictly, these could prohibit R5's one-line commit-moment microcopy
("You approve this on your device. Cairn only ever holds your public key.").

### Evidence

**Badges genuinely don't work (ban is correct).**
- [Schechter et al. 2007, "The Emperor's New Security Indicators" (IEEE S&P)](https://dl.acm.org/doi/10.1109/SP.2007.35)
  ([pdf](https://stuartschechter.org/papers/emperor.pdf)): 100% of real bank customers logged
  in after HTTPS indicators were stripped — passive security signals don't even register.
- [CXL's trust-seal research](https://cxl.com/research-study/trust-seals/): recognition, not
  security, drives whatever small effect seals have; ~half of respondents "don't know / no
  preference" across all badges.

**Procedural transparency does work (carve-out is warranted).**
- Buell & Norton, ["The Labor Illusion"](https://www.hbs.edu/faculty/Pages/item.aspx?num=40158):
  showing the *work being done* increases perceived value — users prefer a slower system that
  shows its mechanism over an instant opaque one.
- Buell, Porter & Norton, ["Surfacing the Submerged State"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2349801)
  (+ [Management Science follow-up](https://pubsonline.informs.org/doi/10.1287/mnsc.2015.2411)):
  operational transparency measurably increases trust and engagement.
- [NN/g](https://www.nngroup.com/articles/trustworthy-design/): credibility comes from upfront
  disclosure and correct content, not reassurance assets.

The distinction is clean: badges are unverifiable *claims*; mechanism copy is *information*
about what is about to happen. The evidence runs opposite directions for the two.

### Options

- **A. Amend the manifesto with a falsifiable "mechanism-fact test"** and ship R5's microcopy.
  Proposed rule text: *"Banned: security claims — quality adjectives ('secure', 'bank-grade',
  'protected'), lock/shield iconography, certification badges, at any location. Allowed: at a
  commit moment, one muted `--t-label` line stating a verifiable mechanism fact about this
  action ('You approve this on your device', 'Your own node broadcasts this — no third party
  sees it first'). Test: if deleting the line leaves the user knowing less about what will
  happen, it is information — keep it. If it leaves them merely less reassured, it is theater
  — cut it. Maximum one per screen; never inside an alert or banner component."*
- **B. No amendment; treat the spec's "How this wallet signs" as an unwritten precedent.**
  Zero cost now, but the strict reading will keep striking legitimate copy in future reviews
  — rule drift in the wrong direction.
- **C. Amend but restrict to the Send flow only.** Forfeits Receive and Health, where the same
  pattern is already proven ("A fresh address, every time" is a mechanism fact).

### Recommendation: **A**

The evidence is unusually one-directional: passive reassurance is among the weakest-measured
trust interventions, procedural transparency among the strongest. The test is falsifiable,
which matches the manifesto's style (§6), and it *strengthens* the badge ban by stating
precisely why badges fail. This converts Heartwood's actual trust asset — the sovereignty
architecture — into felt trust at the only moments it matters.

**Touches:** manifesto §7 (one clause under "Badge-wall security theater") + §5 cross-reference;
then R5 itself is copy-only — Send sign step, broadcast step, Receive, Health. Effort **S**.

---

## Decision 3 — R8: wallet purpose-naming + goal ring (go/no-go on net-new scope)

### Not doctrine — scope

M/L net-new feature. Doctrine constrains the rendering (rings vocabulary, growth-only motion,
amber-never-nag), but the decision is whether to build at all, and how much.

### Evidence

**For.**
- Gargano & Rossi — **verified**: published in the *Journal of Finance* 79(3), 2024,
  pp. 1931–1976 ([Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.13339),
  [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3579275)). Difference-in-differences
  on randomized beta-tester assignment in a real fintech app: setting a named goal **causally
  increases saving rates**, does not cannibalize outside savings, and helps lowest-propensity
  savers most. This is the strongest single piece of evidence in the whole research doc.
- Cheema & Soman 2011, *J. Marketing Research*
  ([SAGE](https://journals.sagepub.com/doi/10.1509/jmkr.48.SPL.S14),
  [pdf](https://www-2.rotman.utoronto.ca/facbios/file/earmarking-jmrPP.pdf)): field experiment,
  146 low-income households — earmarking savings with a labeled purpose increased saving;
  *partitioning* into two labeled envelopes increased it a further ~72% over one envelope.
  Labels alone carry effect; partitions amplify. **Heartwood's wallets are already the
  partitions** — purpose-naming just activates the mental account.

**Against / downsides (real, and designable-around).**
- ["Goal Missed, Self Hit" (Frontiers in Psychology 2021)](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2021.704790/full)
  ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8490751/)): failing a high, specific goal
  measurably lowers affect, self-esteem, and subsequent motivation vs attaining it.
- The what-the-hell effect (Polivy & Herman): one lapse against a rigid goal triggers full
  abandonment. The documented harm attaches to goals that are **specific + difficult +
  deadlined**; a stalled progress display becomes a guilt surface — the exact calm-instrument
  anti-pattern.
- Mitigation is straightforward: goals denominate in sats (progress moves only on deposits,
  which the user controls — price can never fail a goal), **no deadlines, no "behind
  schedule" state, no goal notifications**, ring never regresses. A target without a date is a
  direction, not a pass/fail.

### Options

- **A. v1 slice now: name chips only.** Purpose-suggestive chips at wallet creation
  ("Everyday", "Savings", "Family fund", custom) + purpose shown on the wallet card. Captures
  the earmarking effect (which Cheema & Soman show carries weight on its own). Effort **S/M**
  (~1–2 days: wizard step, wallet metadata field, card display).
- **B. Full build: chips + optional sats-target goal ring** on the wallet dial (one more
  unsealed ring; native rings-vocabulary fit). Effort **M/L** (~1 week on top of A: schema,
  dial variant, create/edit/complete states, settings).
- **C. No-go.** Defensible only on focus grounds; the evidence for the core effect is causal,
  published in a top journal, and the feature reinforces sats-first for free.

### Recommendation: **A now, B as a follow-up bead**

Ship the chips in the wallet-create wizard pass (they ride gt05 work naturally). File the goal
ring as its own bead with the anti-guilt constraints written in *now* (sats-denominated,
deposits-only progress, no deadline, no regression, no nag — cite the goal-failure literature
in the bead), and go/no-go it after chips have been in the wild. This banks the causal upside
at S/M effort while deferring the only part with a documented failure mode.

**Touches (A):** wallet-create wizard (single-sig + multisig trees), wallet name/purpose
metadata, wallet card/detail header. **Touches (B, deferred):** wallets schema (goal_sats),
`BurialRings`/`EpochDial` ring variant, wallet detail, Settings.

---

*Prepared 2026-07-15. Sources verified across two independent locations where load-bearing
(Gargano & Rossi journal publication, Schechter study results, Cheema & Soman field numbers,
large-number scale-resetting). No product code or manifesto text changed by this brief.*
