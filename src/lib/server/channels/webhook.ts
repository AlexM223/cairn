// TODO(notify): real implementation — see docs/NOTIFICATION-PLAN.md §2.6
//
// Stub for the Webhook (generic HTTP POST) channel. Shape only. Real transport
// (fetch POST, HMAC signing, and the SSRF guard) lands in Unit 7.

import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const webhookChannel: NotificationChannelPlugin = {
	id: 'webhook',
	label: 'Webhook',
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

export default webhookChannel;
