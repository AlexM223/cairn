<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '$lib/components/Banner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		OFFICIAL_STORE_URLS,
		REFERRAL_DEVICE_IDS,
		REFERRAL_DEVICE_LABELS
	} from '$lib/referrals';

	let { data, form } = $props();

	let savingUrls = $state(false);
	let savingService = $state(false);

	// Which service cards the "how users see it" preview shows: the currently
	// ACTIVE rows, exactly as the multisig wizard renders them.
	const activeServices = $derived(data.services.filter((s) => s.active));
</script>

<svelte:head>
	<title>Referral links — Admin — Heartwood</title>
</svelte:head>

{#if data.flags?.referral_links === false}
	<!-- The page stays reachable with the flag off — an admin configures links
	     BEFORE enabling them — but says clearly that nothing is shown to users. -->
	<div class="flag-notice fade-in" role="status">
		<Icon name="info" size={16} />
		<div>
			<strong>Referral links are currently turned off.</strong>
			<p>
				Nothing you configure here is shown to users until you enable the
				<a href="/admin/feature-flags">Referral links feature flag</a>. Official troubleshooting
				links are always shown and aren't affected by this page.
			</p>
		</div>
	</div>
{/if}

<!-- ======================= Section 1: per-device buy links ======================= -->
<section class="hw-section section-card fade-in">
	<span class="hw-title">Buy-a-device links</span>
	<p class="hint">
		Shown in the wallet wizards and signing flows when someone doesn't have a device yet. Leave a
		field blank to link to the official store; paste your own (e.g. affiliate) link to override it.
	</p>
	<form
		method="POST"
		action="?/saveDeviceUrls"
		class="stack"
		style="gap: 12px"
		use:enhance={({ cancel }) => {
			if (savingUrls) return cancel();
			savingUrls = true;
			return async ({ update }) => {
				savingUrls = false;
				await update({ reset: false });
			};
		}}
	>
		{#each REFERRAL_DEVICE_IDS as device (device)}
			<div class="field device-field">
				<label class="label" for="url_{device}">{REFERRAL_DEVICE_LABELS[device]}</label>
				<input
					class="input"
					id="url_{device}"
					name="url_{device}"
					type="url"
					placeholder={OFFICIAL_STORE_URLS[device]}
					value={data.buyUrlOverrides[device]}
				/>
				<span class="hint">Blank = official store ({OFFICIAL_STORE_URLS[device]})</span>
			</div>
		{/each}

		{#if form?.deviceUrlError}
			<Banner variant="error">{form.deviceUrlError}</Banner>
		{:else if form?.deviceUrlsSaved}
			<p class="saved-note" role="status"><Icon name="check" size={14} /> Saved.</p>
		{/if}

		<div>
			<button class="btn btn-primary" disabled={savingUrls}>
				{#if savingUrls}<span class="spinner"></span>{/if}
				Save buy links
			</button>
		</div>
	</form>
</section>

<!-- ================= Section 2: managed multisig services ================= -->
<section class="hw-section section-card fade-in">
	<span class="hw-title">Managed multisig services</span>
	<p class="hint">
		Optional suggestions shown in the multisig wizard for people who'd rather use a managed
		service (Casa, Nunchuk, Unchained, …) than run a do-it-yourself multisig. Only
		<strong>active</strong> services are shown, in display order.
	</p>

	{#if form?.serviceError}
		<Banner variant="error">{form.serviceError}</Banner>
	{/if}

	<!-- Add a service -->
	<form
		method="POST"
		action="?/createService"
		class="service-form"
		use:enhance={({ cancel }) => {
			if (savingService) return cancel();
			savingService = true;
			return async ({ update }) => {
				savingService = false;
				await update();
			};
		}}
	>
		<div class="field">
			<label class="label" for="new-name">Name</label>
			<input class="input" id="new-name" name="name" placeholder="e.g. Casa" maxlength="100" />
		</div>
		<div class="field">
			<label class="label" for="new-url">Link</label>
			<input class="input" id="new-url" name="url" type="url" placeholder="https://…" />
		</div>
		<div class="field wide">
			<label class="label" for="new-description">Description <span class="opt">optional</span></label>
			<input
				class="input"
				id="new-description"
				name="description"
				maxlength="300"
				placeholder="One plain-language sentence about what they offer"
			/>
		</div>
		<div class="field">
			<label class="label" for="new-logo">Logo URL <span class="opt">optional</span></label>
			<input class="input" id="new-logo" name="logoUrl" type="url" placeholder="https://…/logo.png" />
		</div>
		<div class="field narrow">
			<label class="label" for="new-order">Display order</label>
			<input class="input" id="new-order" name="displayOrder" type="number" value="0" />
		</div>
		<label class="check-row">
			<input type="checkbox" name="active" checked />
			<span>Active</span>
		</label>
		<button type="submit" class="btn btn-primary" disabled={savingService}>
			{#if savingService}<span class="spinner"></span>{:else}<Icon name="plus" size={15} />{/if}
			Add service
		</button>
	</form>

	{#if data.services.length === 0}
		<div class="empty-state">
			<div class="empty-title">No services yet</div>
			<p>Add one above — nothing is shown to users until a service is active.</p>
		</div>
	{:else}
		<div class="service-list">
			{#each data.services as service (service.id)}
				<form
					method="POST"
					action="?/updateService"
					class="service-row"
					class:inactive={!service.active}
					use:enhance={() => {
						return async ({ update }) => {
							await update({ reset: false });
						};
					}}
				>
					<input type="hidden" name="id" value={service.id} />
					<div class="field">
						<label class="label" for="name-{service.id}">Name</label>
						<input
							class="input"
							id="name-{service.id}"
							name="name"
							value={service.name}
							maxlength="100"
						/>
					</div>
					<div class="field">
						<label class="label" for="url-{service.id}">Link</label>
						<input class="input" id="url-{service.id}" name="url" type="url" value={service.url} />
					</div>
					<div class="field wide">
						<label class="label" for="description-{service.id}">Description</label>
						<input
							class="input"
							id="description-{service.id}"
							name="description"
							maxlength="300"
							value={service.description ?? ''}
						/>
					</div>
					<div class="field">
						<label class="label" for="logo-{service.id}">Logo URL</label>
						<input
							class="input"
							id="logo-{service.id}"
							name="logoUrl"
							type="url"
							value={service.logoUrl ?? ''}
						/>
					</div>
					<div class="field narrow">
						<label class="label" for="order-{service.id}">Order</label>
						<input
							class="input"
							id="order-{service.id}"
							name="displayOrder"
							type="number"
							value={service.displayOrder}
						/>
					</div>
					<label class="check-row">
						<input type="checkbox" name="active" checked={service.active} />
						<span>Active</span>
					</label>
					<div class="row-actions">
						<button class="btn btn-secondary btn-sm">Save</button>
						<button class="btn btn-ghost btn-sm" formaction="?/deleteService">Delete</button>
					</div>
				</form>
			{/each}
		</div>
	{/if}

	<!-- Preview: how the wizard's card renders the ACTIVE services -->
	{#if activeServices.length > 0}
		<div class="preview-block">
			<span class="label">Preview — how users see it in the multisig wizard</span>
			<div class="services-card">
				<p class="services-lead">Want a managed multisig service instead?</p>
				<ul class="services-list">
					{#each activeServices as service (service.id)}
						<li class="service-item">
							{#if service.logoUrl}
								<img class="service-logo" src={service.logoUrl} alt="{service.name} logo" />
							{/if}
							<div class="service-body">
								<a href={service.url} target="_blank" rel="noopener" class="service-name">
									{service.name} →
								</a>
								{#if service.description}
									<span class="service-desc">{service.description}</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
</section>

<style>
	/* Quiet flag-off note above the first hairline — amber, no box. */
	.flag-notice {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding-bottom: 18px;
		margin-bottom: 22px;
		border-bottom: 1px solid var(--hairline);
		font-size: 13px;
		line-height: 1.55;
		color: var(--attention);
	}

	.flag-notice :global(svg) {
		color: var(--attention);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.flag-notice p {
		color: var(--text-secondary);
		margin-top: 3px;
	}

	.flag-notice a {
		color: var(--accent);
	}

	.section-card {
		gap: 14px;
	}

	.device-field {
		max-width: 460px;
	}

	.saved-note {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--sage);
	}

	.opt {
		font-weight: 400;
		color: var(--text-muted);
	}

	/* --- service forms --- */

	.service-form,
	.service-row {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.service-form .field,
	.service-row .field {
		flex: 1;
		min-width: 150px;
	}

	.service-form .wide,
	.service-row .wide {
		flex: 2;
		min-width: 220px;
	}

	.service-form .narrow,
	.service-row .narrow {
		flex: 0 0 90px;
		min-width: 90px;
	}

	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--text-secondary);
		padding-bottom: 9px;
	}

	/* Editable services split by hairlines, not boxes. */
	.service-list {
		display: flex;
		flex-direction: column;
	}

	.service-row {
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.service-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.service-row.inactive {
		opacity: 0.6;
	}

	.row-actions {
		display: flex;
		gap: 8px;
		padding-bottom: 1px;
	}

	/* --- preview (mirrors the wizard's services card) --- */

	.preview-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* The preview keeps a filled input-tone surface so it reads as an inset
	   mirror of the wizard, not page content. */
	.services-card {
		border-radius: var(--radius-strip);
		background: var(--bg-input);
		padding: 14px 16px;
		max-width: 460px;
	}

	.services-lead {
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.services-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.service-item {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}

	.service-logo {
		width: 24px;
		height: 24px;
		object-fit: contain;
		border-radius: 4px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.service-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.service-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
	}

	.service-name:hover {
		text-decoration: underline;
	}

	.service-desc {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.5;
	}
</style>
