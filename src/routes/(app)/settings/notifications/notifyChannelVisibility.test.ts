import { describe, it, expect } from 'vitest';
import { channelFlagKey, isChannelVisible, visibleChannelIds, type NotifyChannelId } from './notifyChannelVisibility';

const ALL_CHANNELS: NotifyChannelId[] = ['email', 'telegram', 'ntfy', 'nostr', 'webhook'];

describe('channelFlagKey', () => {
	it('maps each channel id to its notify_* registry key', () => {
		expect(channelFlagKey('email')).toBe('notify_email');
		expect(channelFlagKey('telegram')).toBe('notify_telegram');
		expect(channelFlagKey('ntfy')).toBe('notify_ntfy');
		expect(channelFlagKey('nostr')).toBe('notify_nostr');
		expect(channelFlagKey('webhook')).toBe('notify_webhook');
	});
});

describe('isChannelVisible', () => {
	it('is visible when flags is undefined (no flags object on page.data yet)', () => {
		expect(isChannelVisible('email', undefined)).toBe(true);
	});

	it('is visible when flags is null', () => {
		expect(isChannelVisible('email', null)).toBe(true);
	});

	it('is visible when the flags object has no entry for this channel', () => {
		expect(isChannelVisible('email', {})).toBe(true);
	});

	it('is visible when the resolved flag is explicitly true', () => {
		expect(isChannelVisible('telegram', { notify_telegram: true })).toBe(true);
	});

	it('is hidden only when the resolved flag is explicitly false', () => {
		expect(isChannelVisible('ntfy', { notify_ntfy: false })).toBe(false);
	});

	it('a false flag on one channel does not affect another channel', () => {
		const flags = { notify_webhook: false };
		expect(isChannelVisible('webhook', flags)).toBe(false);
		expect(isChannelVisible('email', flags)).toBe(true);
		expect(isChannelVisible('telegram', flags)).toBe(true);
		expect(isChannelVisible('ntfy', flags)).toBe(true);
		expect(isChannelVisible('nostr', flags)).toBe(true);
	});
});

describe('visibleChannelIds', () => {
	const channels = ALL_CHANNELS.map((id) => ({ id, label: id }));

	it('returns every channel when no flags are off', () => {
		expect(visibleChannelIds(channels, {}).map((c) => c.id)).toEqual(ALL_CHANNELS);
	});

	it('drops exactly the channels whose flag is off, preserving order', () => {
		const flags = { notify_telegram: false, notify_nostr: false };
		expect(visibleChannelIds(channels, flags).map((c) => c.id)).toEqual([
			'email',
			'ntfy',
			'webhook'
		]);
	});

	it('returns an empty list when every notify_* flag is off (all-channels-disabled empty state)', () => {
		const flags = Object.fromEntries(ALL_CHANNELS.map((id) => [channelFlagKey(id), false]));
		expect(visibleChannelIds(channels, flags)).toEqual([]);
	});

	it('returns every channel when flags is undefined', () => {
		expect(visibleChannelIds(channels, undefined).map((c) => c.id)).toEqual(ALL_CHANNELS);
	});
});
