# Handoff: Wave B Unit B2 — assisted-connect save path (cairn-6uok)

Status: Unit B1 (detect probe + settings plumbing) is DONE — see
`docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md` and bead `cairn-ylz5`. This doc is
a handoff for Unit B2, which touches a file outside the B1 session's edit
ownership boundary (`src/routes/(app)/admin/**/+page.server.ts`).

## What's blocking B2

`src/routes/(app)/admin/settings/+page.server.ts`, the `default`/save action:

- Lines ~101-131: the entire `if (connectionMode === 'custom') { ... }` block.
- Lines 123-130 specifically write `core_rpc_url`, `core_rpc_user`,
  `core_rpc_pass` — but ONLY inside that custom-mode conditional.

```ts
if (connectionMode === 'custom') {
	// ... electrum_host/port/tls, esplora_url ...

	setSetting('core_rpc_url', String(form.get('coreRpcUrl') ?? '').trim());
	setSetting('core_rpc_user', String(form.get('coreRpcUser') ?? '').trim());
	const rpcPass = String(form.get('coreRpcPass') ?? '');
	if (rpcPass !== '') setSecretSetting('core_rpc_pass', rpcPass);
	if (form.get('clearCoreRpcPass') === 'on') setSecretSetting('core_rpc_pass', '');
}
```

This contradicts `getChainConfig()` (`src/lib/server/settings.ts` ~L210-240),
which returns `coreRpc*` fields in **both** `public` and `custom`
`connection_mode` — Core RPC has no public-mode fallback and is "configured"
purely based on whether `core_rpc_url` is set, independent of the Electrum
connection mode. So today, a `public`-mode admin cannot ever persist Core RPC
settings through this form action at all (they'd have to first flip to
`custom` — which also changes their Electrum connection, an unwanted side
effect).

The JSON endpoint `src/routes/api/admin/settings/+server.ts` (~L22-24) already
writes `core_rpc_*` unconditionally, so the two save paths already disagree —
this isn't a new bug introduced by Wave B, just one Wave B's assisted-connect
flow can't ship without fixing.

## Why this matters for Wave B

Unit B2 (assisted-connect save path, see design doc §9/§12) needs a way to
persist `core_rpc_url` = `http://10.21.21.8:8332`, `core_rpc_user` = `umbrel`,
plus an admin-pasted password, **regardless of `connection_mode`**, and to
stamp `core_rpc_provisioned_by = 'umbrel-detect'` — all **without** flipping
`connection_mode` to `'custom'` as a side effect (that would silently change
the operator's Electrum connection too, which the design doc explicitly rules
out — Core and Electrum are independent concerns).

The current code structure makes that impossible without first touching this
file, which is why B2 is filed as a separate, blocked bead (`cairn-6uok`)
rather than folded into B1.

## Suggested fix direction (design doc §9 "Save-path wrinkle to fix")

Either:

1. Lift the three `core_rpc_*` writes out of the `connectionMode === 'custom'`
   block so they run unconditionally on every save — mirroring what the JSON
   endpoint already does — and add the assisted-connect fields
   (`coreRpcAssisted='umbrel'` hidden marker → stamp
   `core_rpc_provisioned_by='umbrel-detect'`) as an additive change to the
   same action.
2. Or give the assisted-connect flow its own dedicated form action
   (a new `assistedConnectCore` action alongside `default`/`testElectrum`)
   that writes only Core settings + the provenance stamp, runs
   `testCoreRpc()` before persisting (matching the existing validation
   convention used elsewhere in this file), and never touches
   `connection_mode`.

Either way: run `testCoreRpc()` before persisting (existing pattern already
used for the Electrum test action in this same file), and do not regress the
existing custom-mode Electrum behavior in lines 101-121.

## What Unit B1 already shipped (context, no action needed here)

- `src/lib/server/umbrelCoreProbe.ts` (new): `probeAndDetectUmbrelCore()`,
  exports `UMBREL_CORE_RPC_URL`/`UMBREL_CORE_RPC_USER` constants for B2/B3 to
  reuse as prefill values.
- `src/lib/server/settings.ts`: reads `core_rpc_detected` /
  `core_rpc_provisioned_by` into `getInstanceSettings()` (and therefore
  `getPublicInstanceSettings()` for free).
- `src/lib/types.ts`: `InstanceSettings` gained `coreRpcDetected` and
  `coreRpcProvisionedBy` fields.
- `src/hooks.server.ts`: calls `probeAndDetectUmbrelCore()` right after the
  Wave A Electrum probe, folding its returned keys into `seededThisBoot`.

None of the above touch `+page.server.ts`'s save action — B2 is purely
additive/corrective work on top of what B1 shipped.

## Test coverage needed (not yet written — testing orchestrator owns this)

- Assisted-connect submit writes `core_rpc_*` + stamps
  `core_rpc_provisioned_by='umbrel-detect'` even when
  `connection_mode === 'public'`.
- Assisted-connect submit does **not** mutate `connection_mode`.
- Wrong password → `testCoreRpc()` failure surfaced, nothing persisted.
- Existing custom-mode Electrum save behavior (lines 101-121) is unchanged by
  whichever fix direction is taken.

See also `docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md` §10 for the full Wave B
test plan (Unit B1 unit tests, Unit B2 settings/UI tests, Unit B4 live-Umbrel
verification).
