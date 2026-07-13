# Infra session status — 2026-07-12 (explorer/admin/auto-connect)

## Shipped (commits on single-sig-full-wallet)
- 359f4f2 fix(admin): marketing category in feature-flags grid (cairn-zyk7 CLOSED)
- fbae932 fix(explorer): admin CTA on no-connection banner + non-admin "Back to explorer" escape on CoreRpcRequiredNotice (cairn-obg6, cairn-uibo CLOSED; live-QA'd desktop+mobile via read_page, screenshot pipeline down)
- c90481f fix(ux): single calm neutral banner when chain never configured (isChainNeverConfigured = connection_mode AND chain_provisioned_by both unset), SyncBanner suppressed when its 'unreachable' phase duplicates ChainHealthBanner. cairn-7zjo still IN_PROGRESS — visual pass owed (see Blocked).
- 85a24da feat(infra): Wave B Unit B1 — src/lib/server/umbrelCoreProbe.ts detect-and-surface probe (401-fingerprint of bitcoind at 10.21.21.8:8332, seeds ONLY core_rpc_detected='umbrel'), hooks wiring, settings exposure. Design: docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md (silent auto-connect proven impossible without manifest dependency — creds only injected into dependent apps; no cookie export; no -rest).
- b1c7c6a feat(admin): provenance cards + Core-detected assisted-connect card on admin settings (cairn-mz9p CLOSED; cairn-ylz5 OPEN for B2+B4)

## Handoffs
- cairn-o90e remainder → UX orchestrator: unguarded explorer links in activity/+page.svelte:347,352 and wallets/[id]/+page.svelte:820,1121,1141 (their files, uncommitted changes). See docs/HANDOFF-o90e-wallet-explorer-links.md.
- cairn-6uok (P2, NEW) → whoever owns admin .server.ts: settings form action drops core_rpc_* outside custom mode; blocks Wave B Unit B2. See docs/HANDOFF-wave-b-unit-b2-settings-form.md. The B3 "Dismiss" action (design §9) also needs a .server.ts action — bundle with B2.
- Testing orchestrator: 9-point unit-test list for umbrelCoreProbe.ts is in a cairn-ylz5 comment; tests for isChainNeverConfigured/SyncBanner suppression also welcome.

## Blocked on Alex
- cairn-1ytc (admin flag-matrix QA remainder) + cairn-7zjo visual pass: agents cannot complete /setup-admin (permission system correctly blocks password-form submission). Unblock: open http://localhost:5311/setup-admin, complete the one-time reset for qa-flags@test.local (bootstrap pw QaFlagMatrix!2026x). The fresh 5311 instance is ALSO the perfect first-run repro for 7zjo's banner. QA server + data/qa-flagmatrix.db left running/in place for this.

## New beads filed
- cairn-6uok (P2) core_rpc save-path bug (blocks B2)
- cairn-ogvo (P3) admin settings dual-write drift (form action vs PUT endpoint — suggest shared settingsWrite.ts)
- cairn-32mx (P3) whale-address pagination refetches full Electrum history per page (short-TTL scripthash cache suggested)

## Wave B remaining
B2 = cairn-6uok + assisted-save polish; B4 = live umbrel-s15 verification at next package cut (v0.2.17?).

## Notes for concurrent sessions
- settings.ts was edited by two workers concurrently; isChainNeverConfigured landed in 85a24da rather than c90481f (verified identical, benign). Same-file concurrent edits on this shared tree WILL interleave commits — prefer disjoint files or coordinate.
- Dev-server login form is flaky while workers edit files (Vite restarts); POST /api/auth/login/password with fetch is the reliable QA login. Screenshot pipeline died again this session; read_page fallback works.
