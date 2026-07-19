"""
m_min sensitivity Monte-Carlo for docs/COINBASE-POOL-ANALYSIS-ADDENDUM-2026-07-19.md (Thread 1).

Model (from analysis §5.6):
  A round ends when the POOL finds a block. Round total pool work ~ Exp(mean=D_net).
  Miner i with pool-share sigma_i = h_i / H_pool accrues per-round work
      W_i = sigma_i * (round pool work)  ~  Exp(mean = sigma_i * D_net).
  Miner is ON THE BOARD at round close iff W_i >= m_min.
  => P(on board) = exp(-m_min / (sigma_i * D_net)) = exp(-c_eff),  c_eff = m_min/(sigma_i*D_net).

Design choice under test: m_min = COEF * sigma_min * D_net0  (COEF=0.1 nominal),
  set ONCE at config time with network difficulty D_net0 and design-smallest pool-share sigma_min.

Everything reduces to the effective coefficient
      c_eff = m_min / (sigma_i * D_net)
            = COEF * (sigma_min/sigma_i) * (D_net0/D_net).
We MC Exp(1) draws (u = W_i/(sigma_i*D_net)) and compare to c_eff; closed form exp(-c_eff) cross-checks.

All RNG seeded; seeds recorded in PROVENANCE below.
"""
import numpy as np

PROV = dict(seed_base=20260719, trials=4_000_000, numpy="2.5.1")
D_NET0 = 127.17e12          # network difficulty at config time (doc §3 input)
COEF_NOM = 0.10             # the coefficient under scrutiny

def incl_mc(c_eff, trials, rng):
    """MC inclusion prob P(Exp(1) >= c_eff)."""
    u = rng.exponential(1.0, size=trials)
    return float(np.mean(u >= c_eff))

def incl_cf(c_eff):
    return float(np.exp(-c_eff))

def line(): print("-"*78)

rng = np.random.default_rng(PROV["seed_base"])
T = PROV["trials"]

print("="*78)
print("THREAD 1 — m_min = COEF * sigma_min * D_net0 ;  P(on board) = exp(-c_eff)")
print(f"COEF_nom={COEF_NOM}  D_net0={D_NET0:.3e}  trials/cell={T:,}  seed={PROV['seed_base']}")
print("="*78)

# ---- 0. Baseline: confirm exp(-c) at the design point (sigma_i=sigma_min, D_net=D_net0) ----
print("\n[0] BASELINE closed-form vs MC (c_eff = COEF, design point):")
print(f"{'COEF':>6} {'c_eff':>7} {'MC incl':>10} {'exp(-c)':>10} {'abs err':>10}")
for coef in [0.05, 0.10, 0.15, 0.20, 0.50, 1.00]:
    mc = incl_mc(coef, T, rng); cf = incl_cf(coef)
    print(f"{coef:>6.2f} {coef:>7.3f} {mc:>10.5f} {cf:>10.5f} {abs(mc-cf):>10.2e}")

# ---- 1. Network difficulty swing +/-50% over an epoch, m_min STATIC (not re-pegged) ----
# c_eff = COEF * (D_net0/D_net) for the MARGINAL miner (sigma_i=sigma_min) and a 2x miner.
print("\n[1] D_net SWING with STATIC m_min (config COEF=0.10). Rising D_net -> longer rounds -> MORE work -> higher inclusion.")
print(f"{'D_net/D_net0':>12} {'c_eff(marg)':>12} {'incl marginal':>14} {'incl 2x-miner':>14} {'incl 5x-miner':>14}")
for mult in [0.50, 0.75, 1.00, 1.25, 1.50, 2.00]:
    ratio = 1.0/mult                       # D_net0/D_net
    for size_mult, tag in [(1.0,'m'),(2.0,'x2'),(5.0,'x5')]:
        pass
    c_marg = COEF_NOM * ratio * 1.0
    c_2x   = COEF_NOM * ratio * (1/2.0)
    c_5x   = COEF_NOM * ratio * (1/5.0)
    print(f"{mult:>12.2f} {c_marg:>12.4f} {incl_mc(c_marg,T,rng):>14.4f} {incl_mc(c_2x,T,rng):>14.4f} {incl_mc(c_5x,T,rng):>14.4f}")

# ---- 2. sigma_min MIS-SIZING: operator sized for design-smallest, but an actual miner is smaller/larger ----
# c_eff = COEF * (sigma_min / sigma_actual). ratio r = sigma_actual/sigma_min.
print("\n[2] sigma_min MIS-SIZING (D_net=D_net0). Miner of size r x design-smallest. r<1 = SMALLER than design point.")
print(f"{'r=size/design':>14} {'c_eff':>8} {'inclusion':>11} {'note':>28}")
for r in [0.25, 0.5, 1.0, 2.0, 5.0, 10.0]:
    c = COEF_NOM / r
    note = 'below design point (frozen)' if r < 1 else ('design point' if r==1 else 'above design point')
    print(f"{r:>14.2f} {c:>8.4f} {incl_mc(c,T,rng):>11.4f} {note:>28}")

# ---- 3. POOL GROWTH: m_min static in difficulty-units pegged to old H_pool; pool grows g x ----
# sigma_min(effective for fixed h_min) = h_min/(g*H_pool0) = sigma_min0/g  => c_eff = COEF * g.
print("\n[3] POOL GROWTH with STATIC m_min. Pool hashrate grows g x; fixed smallest miner h_min. c_eff = COEF*g.")
print(f"{'pool growth g':>14} {'c_eff':>8} {'incl smallest':>14}")
for g in [1.0, 1.5, 2.0, 3.0, 5.0, 10.0]:
    c = COEF_NOM * g
    print(f"{g:>14.2f} {c:>8.4f} {incl_mc(c,T,rng):>14.4f}")

# ---- 4. BOUNDARY behavior: round-to-round flicker (Bernoulli variance p(1-p)) vs c_eff ----
print("\n[4] BOUNDARY flicker: a miner at c_eff has per-round board presence ~ Bernoulli(exp(-c_eff)).")
print("    Presence VARIANCE p(1-p) is maximized at p=0.5 -> c_eff=ln2=0.693. That miner's size = COEF/ln2 x design-smallest.")
print(f"{'c_eff':>7} {'p=incl':>8} {'var p(1-p)':>12} {'std(flicker)':>13} {'miner size vs design':>22}")
for c in [0.10, 0.30, 0.50, 0.693, 1.00, 1.50, 2.00]:
    p = incl_cf(c); v = p*(1-p)
    size = COEF_NOM / c   # sigma/sigma_min such that c_eff=c
    print(f"{c:>7.3f} {p:>8.4f} {v:>12.4f} {v**0.5:>13.4f} {size:>22.3f}")

# ---- 5. MIXED POPULATION: expected legit qualifiers per round, and how D_net swing thins the board ----
# Pool mix (pool-shares sum to 1). Design-smallest = 0.05 (a 50 TH/s miner in a 1 PH/s pool).
print("\n[5] MIXED POPULATION — expected # legit qualifiers/round; board thinning under D_net swing.")
mix = {
    '1x50% + 2x15% + 4x5%':      [0.50, 0.15, 0.15, 0.05, 0.05, 0.05, 0.05],
    'Pareto-ish 20 miners':      None,  # generated below
}
def pareto_mix(n, seed):
    r = np.random.default_rng(seed)
    w = r.pareto(1.5, size=n) + 1.0
    return list(w / w.sum())
mix['Pareto-ish 20 miners'] = pareto_mix(20, 777)
sigma_min_design = 0.05   # design-smallest pool-share
m_min_units = COEF_NOM * sigma_min_design * D_NET0  # static config value in difficulty-units

for name, shares in mix.items():
    shares = np.array(shares)
    print(f"\n  mix: {name}   (#miners={len(shares)}, smallest sigma={shares.min():.4f}, design sigma_min={sigma_min_design})")
    print(f"  {'D_net/D_net0':>12} {'E[qualifiers]':>14} {'E[legit small(<=design) on board]':>34}")
    for mult in [0.50, 1.00, 1.50]:
        D = D_NET0 * mult
        # c_eff per miner = m_min_units / (sigma_i * D)
        c_eff = m_min_units / (shares * D)
        p = np.exp(-c_eff)
        e_qual = p.sum()
        small_mask = shares <= sigma_min_design * 1.0001
        e_small = p[small_mask].sum()
        print(f"  {mult:>12.2f} {e_qual:>14.3f} {e_small:>34.3f}")

# ---- 6. SYBIL bound sanity: attacker at pool-share sigma_evil funds k = sigma_evil*D_net/m_min identities ----
print("\n[6] SYBIL identity bound k = sigma_evil * D_net / m_min = (sigma_evil/sigma_min)/COEF  (independent of D swings if m_min re-pegged).")
print(f"    With STATIC m_min and D_net swing: k = (sigma_evil/sigma_min) * (D_net/D_net0) / COEF")
print(f"{'sigma_evil':>10} {'D_net/D0':>9} {'k (identities)':>15}")
for se in [0.10, 0.50, 0.90]:
    for mult in [0.5, 1.0, 1.5]:
        k = (se/sigma_min_design) * mult / COEF_NOM
        print(f"{se:>10.2f} {mult:>9.2f} {k:>15.1f}")

print("\nPROVENANCE:", PROV)
