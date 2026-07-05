// TODO(notify): real implementation — see docs/NOTIFICATION-PLAN.md §2.3
//
// Stub for the Telegram (Bot API) channel. Shape only. Real transport (plain
// HTTPS to api.telegram.org, chat-id config, error-code mapping) lands in Unit 4.

import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const telegramChannel: NotificationChannelPlugin = {
	id: 'telegram',
	label: 'Telegram',
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

export default telegramChannel;
