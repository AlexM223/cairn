// TODO(notify): real implementation — see docs/NOTIFICATION-PLAN.md §2.5
//
// Stub for the Nostr (encrypted DM, NIP-04/NIP-44) channel. Shape only. Real
// transport (nostr-tools, instance sender identity, relay publish) lands in Unit 6.

import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const nostrChannel: NotificationChannelPlugin = {
	id: 'nostr',
	label: 'Nostr',
	isConfigured(_userId: number): boolean {
		return false;
	},
	async send(_userId: number, _payload: NotificationPayload): Promise<ChannelSendResult> {
		return { ok: false, error: 'Channel not yet configured', retryable: false };
	},
	async test(_userId: number): Promise<ChannelSendResult> {
		return { ok: false, error: 'Channel not yet configured', retryable: false };
	}
};

export default nostrChannel;
