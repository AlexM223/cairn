# Handoff: cairn-o90e — wallet-to-explorer links honor the explorer feature flag

**Status:** mostly fixed (6 files flag-gated in ed873e6, merged). This doc covers the
remainder, which lives in files the UX orchestrator session currently owns
(uncommitted changes in-flight on `src/routes/(app)/activity/+page.svelte` and
`src/routes/(app)/wallets/[id]/+page.svelte`). The infra session (single-sig-full-wallet
branch) deliberately did **not** touch those two files to avoid clobbering that work —
this doc hands the remaining fix to whichever session owns them next.

## Why this is your file, not infra's

Both files below have uncommitted changes from the concurrent UX orchestrator session
as of 2026-07-12. Editing them from another session risks losing that work. Please fold
the guard below into your existing in-flight edits rather than doing a separate pass.

## Exact lines to fix (current, re-verified 2026-07-12)

### `src/routes/(app)/activity/+page.svelte`
- **:347** — tx link: `<a class="mono link" href="/explorer/tx/{txid(e)}">...`
- **:352** — block link: `<a class="mono link" href="/explorer/block/{height(e)}">...`

Neither is guarded by the `explorer` feature flag.

### `src/routes/(app)/wallets/[id]/+page.svelte`
- **:820** — tx link: `· <a href="/explorer/tx/{tx.txid}" class="mono hw-tx-link">...`
- **:1121** — recipient address link: `<a href="/explorer/address/{tx.recipient}" class="mono saved-recipient">...`
- **:1141** — saved-tx link: `<a href="/explorer/tx/{tx.txid}" class="mono">...`

None of the three are guarded.

This is inconsistent with the multisig detail page, which already gates its equivalent
link — see reference implementation below.

## Reference implementation (already in the codebase)

`src/routes/(app)/wallets/multisig/[id]/+page.svelte:771-772` gates its tx link like this:

```svelte
{#if data.flags?.explorer !== false}
  <a href="/explorer/tx/{tx.txid}" class="mono hw-tx-link"
    >{truncateMiddle(tx.txid, 8, 8)}</a
  >
{:else}
  <span class="mono hw-tx-link">{truncateMiddle(tx.txid, 8, 8)}</span>
{/if}
```

## Preferred pattern: degrade, don't hide

`src/lib/components/portfolio/RecentActivity.svelte:21,31-33` uses a slightly nicer
approach — a derived flag plus `<svelte:element>` to swap the tag between `<a>` and
`<div>`, rather than an `{#if}/{:else}` duplicating the inner markup:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  // With the explorer feature flag off, /explorer/** 403s server-side — so
  // each row degrades to a non-interactive summary instead of a dead link.
  const explorerEnabled = $derived(page.data.flags?.explorer !== false);
</script>

<svelte:element
  this={explorerEnabled ? 'a' : 'div'}
  class="row"
  href={explorerEnabled ? `/explorer/tx/${item.txid}` : undefined}
>
  ...
</svelte:element>
```

**Why degrade instead of hiding the link/row entirely:** the layout guard already 403s
direct navigation to `/explorer/**` when the flag is off, so the failure mode of a dead
link is already closed off server-side. Degrading to a non-interactive element (instead
of omitting the whole row) keeps the surrounding transaction/address info visible to the
user — only the click-through affordance disappears. Prefer this pattern for the three
`wallets/[id]/+page.svelte` sites and the two `activity/+page.svelte` sites over the
multisig page's `{#if}/{:else}` duplication, since it avoids repeating the inner markup
twice per site.

Use `page.data.flags?.explorer !== false` (client-side, via `$app/state`) or
`data.flags?.explorer !== false` (whichever the surrounding component already has in
scope — `activity/+page.svelte` and `wallets/[id]/+page.svelte` both receive `data` as a
prop already, so `data.flags?.explorer !== false` is likely the simpler match for those
two files, consistent with the multisig reference implementation).

## Guard re-check (already-gated links, re-verified 2026-07-12 — no regressions found)

These were previously fixed and still carry their guard; no action needed, listed here
only so you don't waste time re-checking them:

- `src/routes/(app)/wallets/multisig/stateless/+page.svelte:880` — `{#if data.flags?.explorer !== false}`
- `src/routes/(app)/wallets/[id]/send/+page.svelte:1540` — `{#if data.flags?.explorer !== false}`
- `src/routes/(app)/wallets/multisig/[id]/send/+page.svelte:1534` — `{#if data.flags?.explorer !== false}`

## When done

Please close `cairn-o90e` with evidence (commit SHA + which lines changed), per the
"beads for every fix" rule — a `br comment` + `br close` referencing the commit is
sufficient. This doc (`docs/HANDOFF-o90e-wallet-explorer-links.md`) is intentionally
left untracked/uncommitted; feel free to delete it once the fix lands, or fold its
content into your commit message.
