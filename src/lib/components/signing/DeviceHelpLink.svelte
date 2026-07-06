<script lang="ts">
	import { page } from '$app/state';
	import {
		OFFICIAL_SUPPORT_URLS,
		REFERRAL_DEVICE_LABELS,
		type ReferralDeviceId
	} from '$lib/referrals';

	// One hint-sized help line for signer cards (cairn-81ba). Two distinct kinds,
	// kept conceptually separate on purpose:
	//
	//  - kind="support": the device's OFFICIAL troubleshooting resource. Hardcoded
	//    client-safe constant, not promotional, ALWAYS rendered — a user staring
	//    at a device error gets help regardless of any admin setting.
	//  - kind="buy": a referral link for the device-unavailable/"don't have one"
	//    states. The URL comes off page.data.referralBuyUrls, which the server
	//    load only populates when the referral_links flag is on — no URL, no link,
	//    so this component renders nothing when referrals are disabled.
	let { device, kind }: { device: ReferralDeviceId; kind: 'buy' | 'support' } = $props();

	const label = $derived(REFERRAL_DEVICE_LABELS[device]);
	const href = $derived(
		kind === 'support'
			? OFFICIAL_SUPPORT_URLS[device]
			: ((page.data.referralBuyUrls?.[device] as string | undefined) ?? null)
	);
</script>

{#if href}
	<p class="help-line">
		{#if kind === 'support'}
			Still stuck? The <a {href} target="_blank" rel="noopener">official {label} support site</a>
			covers connection and device problems.
		{:else}
			Don't have a {label} yet?
			<a {href} target="_blank" rel="noopener">Get one here →</a>
		{/if}
	</p>
{/if}

<style>
	.help-line {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.5;
		margin-top: 8px;
	}

	.help-line a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
