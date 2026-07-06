// POST /api/notifications/channels/:channel/test — fire a channel plugin's
// test() for the signed-in user and return the ChannelSendResult inline (§4.1).
// Same send path as a real notification, so a green result means it truly works.

import { json, requireUser, requireFeature } from '$lib/server/api';
import { childLogger } from '$lib/server/logger';
import { CHANNELS } from '$lib/server/notifications';
import type { ChannelSendResult, NotificationChannelId } from '$lib/server/notifyTypes';
import type { RequestHandler } from './$types';

const log = childLogger('notify:test-api');

// Every channel that has a plugin (i.e. not the always-on in-app channel).
type ExternalChannel = Exclude<NotificationChannelId, 'inapp'>;

function isTestableChannel(c: string): c is ExternalChannel {
	return c in CHANNELS;
}

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const channel = event.params.channel;

	if (!isTestableChannel(channel)) {
		return json({ ok: false, error: `Unknown channel: ${channel}` }, { status: 404 });
	}
	// A disabled channel can't be test-fired (same send path as a real delivery).
	requireFeature(event, `notify_${channel}`);

	const plugin = CHANNELS[channel];

	// Don't attempt a send the plugin can't make — surface a friendly reason.
	if (!plugin.isConfigured(user.id)) {
		return json(
			{ ok: false, error: 'This channel is not configured yet. Fill in and save its settings first.' },
			{ status: 400 }
		);
	}

	let result: ChannelSendResult;
	try {
		result = await plugin.test(user.id);
	} catch (e) {
		// A plugin should return ChannelSendResult rather than throw, but never let
		// a throw become a 500 with no useful body for the UI.
		log.error({ err: e, userId: user.id, channel }, 'channel test() threw');
		result = {
			ok: false,
			error: e instanceof Error ? e.message : 'The test failed unexpectedly.'
		};
	}

	// Always 200 at the HTTP layer; ok:false is the application-level failure the
	// UI renders as a red badge (mirrors the Electrum/Esplora test pattern).
	return json(result);
};
