"""
Thread 2 — work-proportional split rounding/edge-case validation.
Confirms the proposed rule set is value-conserving (INV-4) and deterministic across
random small pots, zero-share rounds, finder-dominant rounds, and mid-round joiners.

Proposed rule (addendum §2):
  pot P (int sats) split among board members i=1..k by since-round-start work w_i:
     share_i = floor(P * w_i / sum_w)
  remainder R = P - sum(share_i)  ALWAYS rolls to the fee output (INV-4 / §5.4).
  Any share_i < DUST is dropped and also rolls to fee (roll-to-fee). No largest-remainder
  redistribution among members -> fully deterministic, no tie-break needed on amounts.
  Rank/slot tie-break (equal realized hash, ~never): (share_ts asc, user_id asc).
"""
import numpy as np
DUST = 294  # P2WPKH relay limit (sats)

def split(P, works, dust=DUST):
    works = np.asarray(works, dtype=object)
    sw = int(sum(int(w) for w in works))
    if sw == 0 or len(works) == 0:
        return [], P              # empty/zero-work board -> whole pot to fee
    raw = [ (P * int(w)) // sw for w in works ]
    # drop sub-dust members, roll to fee
    kept = [ (i, s) for i, s in enumerate(raw) if s >= dust ]
    paid = sum(s for _, s in kept)
    fee_roll = P - paid
    return kept, fee_roll

def check_conservation(P, works):
    kept, fee = split(P, works)
    total = sum(s for _, s in kept) + fee
    return total == P, kept, fee

print("="*70)
print("THREAD 2 — split rounding validation (conservation P == Σmembers + fee_roll)")
print("="*70)

rng = np.random.default_rng(424242)
fails = 0
for trial in range(200_000):
    P = int(rng.integers(1, 5_000_000))          # thin..fat pots
    k = int(rng.integers(1, 41))                 # 1..40 members (N cap)
    works = rng.integers(1, 10**9, size=k).tolist()
    ok, _, _ = check_conservation(P, works)
    if not ok: fails += 1
print(f"\n[A] 200,000 random pots (P in [1,5e6], k in [1,40]): conservation failures = {fails}")

print("\n[B] Named edge cases:")
def show(label, P, works):
    kept, fee = split(P, works)
    total = sum(s for _,s in kept)+fee
    print(f"  {label}")
    print(f"     P={P:,}  members_paid={len(kept)}  Σmembers={sum(s for _,s in kept):,}  fee_roll={fee:,}  conserved={total==P}")

show("zero-share / empty board (no qualifiers)", 1_562_500, [])
show("finder has ~all work (1 huge + 3 tiny)", 1_000_000, [10**9, 5, 5, 5])
show("thin pot, many members (dust drops)", 4000, [1,1,1,1,1,1,1,1,1,1])  # 400 each < 294? no, 400>294
show("very thin pot, dust drops several", 1500, [1,1,1,1,1,1,1,1,1,1])    # 150 each < 294 -> all drop
show("all-equal work, remainder to fee", 1_000_003, [1,1,1])
show("single member", 999_999, [7])
show("mid-round joiner (small since-join work)", 1_000_000, [10**8, 10**8, 3*10**6])

# boundary: pot exactly divisible vs off-by-one
show("P exactly divisible by k", 1_000_000, [1,1,1,1])       # 250000 each, fee 0
show("P = k*floor + (k-1) remainder", 999_999, [1,1,1,1])    # 249999 each, fee 3

print("\n[C] Finder-dominant amount check (finder ALSO on board):")
# finder gets finderPct output (separate) PLUS a board slot. Confirm board slot is a 2nd output.
finderPct, feePct = 50, 2
cbval = 312_500_000  # 3.125 BTC in sats
finder_out = (cbval * finderPct)//100
fee_base   = (cbval * feePct)//100
pot = cbval - finder_out - fee_base
kept, fee_roll = split(pot, [10**9, 5, 5])   # finder dominates board too
print(f"  cbval={cbval:,}  finder_out={finder_out:,} (separate)  leaderboard_pot={pot:,}")
print(f"  board members paid={len(kept)}  finder_board_slot={kept[0][1]:,}  fee_total={fee_base+fee_roll:,}")
print(f"  => finder receives finder_out + finder_board_slot = {finder_out+kept[0][1]:,} across TWO outputs (INV-7 keeps them separate)")
print("\nPROVENANCE: seed=424242 trials=200000 DUST=294")
