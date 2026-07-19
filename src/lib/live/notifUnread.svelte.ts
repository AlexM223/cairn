// Shared unread-notification count (UX-REDESIGN-SPEC.md §2.7, cairn-gt05.4):
// written by NotificationPanel (initial /api/notifications fetch + live SSE
// `notification` frames), read by the shell avatars — the unread badge lives on
// the avatar now that the standalone bell left the chrome and the panel opens
// from the account menu. Two mounted panels (desktop sidebar + mobile top bar)
// both write the same server-derived value, so the shared cell is idempotent.

let count = $state(0);

export const notifUnread = {
	get count(): number {
		return count;
	},
	set count(v: number) {
		count = v;
	}
};
