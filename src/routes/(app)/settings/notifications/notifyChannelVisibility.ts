// Pure flag-filtering logic for the Channels section (cairn-lv2t). Server
// enforcement of notify_* flags already 403s a disabled channel's save (see
// requireFeature(event, `notify_${channel}`) in
// /api/notifications/channels/[channel]/+server.ts) — this fixes the
// client-side counterpart: a channel whose notify_* flag is off for the
// signed-in user should never even render as an option, mirroring the
// "hide, don't grey out" convention DevicePicker.svelte already uses for its
// hw_* flags (src/lib/components/DevicePicker.svelte).
//
// Extracted into its own module (rather than inlined in +page.svelte)
// because this repo has no DOM-rendering test harness (no jsdom /
// @testing-library/svelte — see qrScannerLogic.ts's header comment for the
// precedent), so this is the testable surface in place of mounting the
// component.

export type NotifyChannelId = 'email' | 'telegram' | 'ntfy' | 'nostr' | 'webhook';

/** notify_<id> is this channel's key in the feature flag registry (registry.ts). */
export function channelFlagKey(id: NotifyChannelId): string {
	return `notify_${id}`;
}

/**
 * A flag resolves to false only when the admin explicitly disabled it for
 * this user; an absent flags object (or a missing key) leaves the channel
 * visible — the same `!== false` convention every other flag-gated UI in
 * this app uses (DevicePicker, RecipientCombobox, wallets/new, ...).
 */
export function isChannelVisible(
	id: NotifyChannelId,
	flags: Record<string, boolean> | null | undefined
): boolean {
	return flags?.[channelFlagKey(id)] !== false;
}

/** Filters a list of `{ id }` channel entries down to the visible ones, in order. */
export function visibleChannelIds<T extends { id: NotifyChannelId }>(
	channels: T[],
	flags: Record<string, boolean> | null | undefined
): T[] {
	return channels.filter((c) => isChannelVisible(c.id, flags));
}
