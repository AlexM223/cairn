// TODO(notify): real implementation — see docs/NOTIFICATION-PLAN.md §2.4
//
// Stub for the ntfy (self-hosted push) channel. Shape only. Real transport
// (plain HTTP POST via fetch, server/topic/accessToken config, priority mapping)
// lands in Unit 5.

import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const ntfyChannel: NotificationChannelPlugin = {
	id: 'ntfy',
	label: 'ntfy',
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

export default ntfyChannel;
