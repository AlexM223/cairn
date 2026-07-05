// TODO(notify): real implementation — see docs/NOTIFICATION-PLAN.md §2.2
//
// Stub for the Email (SMTP + optional PGP) channel. Shape only — enough for the
// dispatcher and queue worker to compile and run. Real transport (nodemailer +
// openpgp), config reads from notification_channel_config / user_pgp_keys, and
// the instance-wide SMTP settings all land in Unit 3.

import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';

const emailChannel: NotificationChannelPlugin = {
	id: 'email',
	label: 'Email',
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

export default emailChannel;
