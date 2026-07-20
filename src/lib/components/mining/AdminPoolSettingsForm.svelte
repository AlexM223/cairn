<script lang="ts">
	/**
	 * AdminPoolSettingsForm — the mining engine's own config section
	 * (cairn-vn43.10). Posts to this route's `?/save` action, mirroring
	 * admin/settings/+page.svelte's per-section save-button + use:enhance
	 * pattern exactly (pending state set on submit, not on the buttons'
	 * click handlers — a click-handler-disabled submit button cancels the
	 * browser's own submission before it fires, per that page's cairn-unp
	 * lesson).
	 */
	import { enhance } from '$app/forms';
	import Term from '$lib/components/Term.svelte';
	import { STRATUM_TIP, STRATUM_V2_TIP } from '$lib/termGlosses';
	import type { AdminMiningSettingsView, MiningBind } from './adminMiningView';

	let {
		settings,
		saved = false,
		error = null
	}: {
		settings: AdminMiningSettingsView;
		saved?: boolean;
		error?: string | null;
	} = $props();

	// Seeded once from the load; a poll never overwrites these (the live
	// refresh only merges engine/pool/miners/blocks — see +page.svelte) so an
	// admin mid-edit here never gets clobbered out from under them.
	// svelte-ignore state_referenced_locally
	let enabled = $state(settings.enabled);
	// svelte-ignore state_referenced_locally
	let bind = $state<MiningBind>(settings.bind);
	// svelte-ignore state_referenced_locally
	let port = $state(settings.port);
	// svelte-ignore state_referenced_locally
	let shareDifficulty = $state(settings.shareDifficulty);
	// svelte-ignore state_referenced_locally
	let vardiffEnabled = $state(settings.vardiffEnabled);
	// svelte-ignore state_referenced_locally
	let vardiffTargetPerMin = $state(settings.vardiffTargetPerMin);
	// svelte-ignore state_referenced_locally
	let poolTag = $state(settings.poolTag);
	// svelte-ignore state_referenced_locally
	let asicPortEnabled = $state(settings.asicPortEnabled);
	// svelte-ignore state_referenced_locally
	let asicStratumPort = $state(settings.asicStratumPort);
	// svelte-ignore state_referenced_locally
	let asicShareDifficulty = $state(settings.asicShareDifficulty);
	// svelte-ignore state_referenced_locally
	let sv2Enabled = $state(settings.sv2Enabled);
	// svelte-ignore state_referenced_locally
	let sv2Port = $state(settings.sv2Port);
	// svelte-ignore state_referenced_locally
	let sv2ShareDifficulty = $state(settings.sv2ShareDifficulty);
	// svelte-ignore state_referenced_locally
	let sv2VersionRolling = $state(settings.sv2VersionRolling);

	let saving = $state(false);

	const showLanConsent = $derived(bind === 'lan' || bind === 'all');
</script>

<form
	method="POST"
	action="?/save"
	class="hw-section settings-form"
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			saving = false;
			await update({ reset: false });
		};
	}}
>
	<div class="section-head">
		<span class="hw-title">Pool settings</span>
		<p class="hint">Configure the <Term tip={STRATUM_TIP}>Stratum</Term> server your users' miners connect to.</p>
	</div>

	{#if error}
		<p class="error-line" role="alert">{error}</p>
	{/if}
	{#if saved}
		<p class="save-note" role="status">Saved — the engine has been reconfigured.</p>
	{/if}

	<label class="switch-row">
		<input type="checkbox" name="enabled" bind:checked={enabled} role="switch" aria-checked={enabled} />
		<span class="switch-track" class:on={enabled}><span class="switch-knob"></span></span>
		<span class="switch-text">Enable mining</span>
	</label>

	<div class="field">
		<label class="label" for="bind">Network exposure</label>
		<select class="input" id="bind" name="bind" bind:value={bind}>
			<option value="loopback">This device only</option>
			<option value="lan">This network (LAN)</option>
			<option value="all">Any network</option>
		</select>
		{#if showLanConsent}
			<p class="consent-note">
				Exposes a raw TCP port to your network. Only do this to let other devices on your LAN
				mine here.
			</p>
		{/if}
	</div>

	<div class="row-fields">
		<div class="field port-field">
			<label class="label" for="port"><Term tip={STRATUM_TIP}>Stratum</Term> port</label>
			<input
				class="input mono"
				id="port"
				name="port"
				type="number"
				min="1"
				max="65535"
				bind:value={port}
			/>
		</div>
		<div class="field">
			<label class="label" for="poolTag">Pool tag</label>
			<input
				class="input mono"
				id="poolTag"
				name="poolTag"
				maxlength="24"
				placeholder="Heartwood"
				bind:value={poolTag}
			/>
			<span class="hint">Plain ASCII, up to 24 characters. Stamped into every block's coinbase.</span>
		</div>
	</div>

	<div class="subgroup">
		<span class="subgroup-title">Share difficulty</span>
		<div class="row-fields">
			<div class="field">
				<label class="label" for="shareDifficulty">Fixed / starting difficulty</label>
				<input
					class="input mono"
					id="shareDifficulty"
					name="shareDifficulty"
					type="number"
					min="0.001"
					step="0.001"
					bind:value={shareDifficulty}
				/>
			</div>
		</div>

		<label class="switch-row">
			<input
				type="checkbox"
				name="vardiffEnabled"
				bind:checked={vardiffEnabled}
				role="switch"
				aria-checked={vardiffEnabled}
			/>
			<span class="switch-track" class:on={vardiffEnabled}><span class="switch-knob"></span></span>
			<span class="switch-text">Auto-adjust difficulty (vardiff)</span>
		</label>

		{#if vardiffEnabled}
			<div class="field fade-in" style="max-width: 260px">
				<label class="label" for="vardiffTargetPerMin">Target shares per minute</label>
				<input
					class="input mono"
					id="vardiffTargetPerMin"
					name="vardiffTargetPerMin"
					type="number"
					min="1"
					max="60"
					bind:value={vardiffTargetPerMin}
				/>
			</div>
		{/if}
	</div>

	<div class="subgroup">
		<span class="subgroup-title">Big-machine port</span>

		<label class="switch-row">
			<input
				type="checkbox"
				name="asicPortEnabled"
				bind:checked={asicPortEnabled}
				role="switch"
				aria-checked={asicPortEnabled}
			/>
			<span class="switch-track" class:on={asicPortEnabled}><span class="switch-knob"></span></span>
			<span class="switch-text">Run a separate port for big machines</span>
		</label>

		<p class="hint">
			Big machines (Antminer-class) should connect to this separate port. Its higher share bar
			keeps them from drowning the pool in paperwork. Small miners keep using the main port above.
		</p>

		{#if asicPortEnabled}
			<div class="row-fields fade-in">
				<div class="field port-field">
					<label class="label" for="asicStratumPort">Big-machine port</label>
					<input
						class="input mono"
						id="asicStratumPort"
						name="asicStratumPort"
						type="number"
						min="1"
						max="65535"
						bind:value={asicStratumPort}
					/>
				</div>
				<div class="field">
					<label class="label" for="asicShareDifficulty">Starting difficulty for big machines</label>
					<input
						class="input mono"
						id="asicShareDifficulty"
						name="asicShareDifficulty"
						type="number"
						min="1"
						step="1"
						bind:value={asicShareDifficulty}
					/>
					<span class="hint">Higher than the main port's, so a fast machine doesn't flood shares.</span>
				</div>
			</div>
		{:else}
			<!-- Keep the fields present-but-hidden (not removed) so a submit while
			     collapsed still posts the last-known values — same fix and same
			     reasoning as the SV2 subgroup's hidden inputs below (cairn-qfez8.27):
			     without these, +page.server.ts's unconditional asicStratumPort/
			     asicShareDifficulty validation 400s a toggle-off + save. -->
			<input type="hidden" name="asicStratumPort" value={asicStratumPort} />
			<input type="hidden" name="asicShareDifficulty" value={asicShareDifficulty} />
		{/if}
	</div>

	<div class="subgroup">
		<span class="subgroup-title">Next-generation miner connections (Stratum V2)</span>

		<label class="switch-row">
			<input
				type="checkbox"
				name="sv2Enabled"
				bind:checked={sv2Enabled}
				role="switch"
				aria-checked={sv2Enabled}
			/>
			<span class="switch-track" class:on={sv2Enabled}><span class="switch-knob"></span></span>
			<span class="switch-text">Enable <Term tip={STRATUM_V2_TIP}>Stratum V2</Term></span>
		</label>

		<p class="hint">
			Encrypted and verified — miners that speak this newer protocol can confirm they're really
			talking to your server. Off by default; existing miners keep working either way.
		</p>

		{#if sv2Enabled}
			<div class="row-fields fade-in">
				<div class="field port-field">
					<label class="label" for="sv2Port">Stratum V2 port</label>
					<input
						class="input mono"
						id="sv2Port"
						name="sv2Port"
						type="number"
						min="1"
						max="65535"
						bind:value={sv2Port}
					/>
				</div>
				<div class="field">
					<label class="label" for="sv2ShareDifficulty">Starting difficulty</label>
					<input
						class="input mono"
						id="sv2ShareDifficulty"
						name="sv2ShareDifficulty"
						type="number"
						min="0.001"
						step="0.001"
						bind:value={sv2ShareDifficulty}
					/>
					<span class="hint">Fixed for now — this listener doesn't auto-adjust difficulty yet.</span>
				</div>
			</div>

			<label class="switch-row">
				<input
					type="checkbox"
					name="sv2VersionRolling"
					bind:checked={sv2VersionRolling}
					role="switch"
					aria-checked={sv2VersionRolling}
				/>
				<span class="switch-track" class:on={sv2VersionRolling}><span class="switch-knob"></span></span>
				<span class="switch-text">Allow version rolling</span>
			</label>
		{:else}
			<!-- Keep the fields present-but-hidden (not removed) so a submit while
			     collapsed still posts the last-known values, matching the ASIC
			     subgroup's fade-in/hide pattern above — nothing to persist here
			     since the inputs simply don't render; the server keeps the prior
			     stored value via readMiningSettings' unset-falls-back-to-DEFAULTS
			     rule, and the hidden inputs below preserve the operator's last
			     edited values across a re-toggle within this session. -->
			<input type="hidden" name="sv2Port" value={sv2Port} />
			<input type="hidden" name="sv2ShareDifficulty" value={sv2ShareDifficulty} />
		{/if}
	</div>

	<div class="save-row">
		<button class="btn btn-primary" disabled={saving}>
			{#if saving}<span class="spinner"></span>{/if}
			Save pool settings
		</button>
	</div>
</form>

<style>
	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.error-line {
		font-size: 13px;
		color: var(--error);
		margin: 0;
	}

	.save-note {
		font-size: 13px;
		color: var(--sage);
		margin: 0;
	}

	.row-fields {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.port-field {
		max-width: 160px;
	}

	.subgroup {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding-top: 14px;
		border-top: 1px solid var(--hairline);
	}

	.subgroup-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.consent-note {
		margin: 6px 0 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--attention);
	}

	.save-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	/* Switch: a real checkbox (for correct multi-field-form semantics on
	   submit), visually replaced by the track/knob pair — same visual grammar
	   as feature-flags' pill switch, reimplemented here (that one is a
	   single-field auto-submit button, not usable inside this multi-field
	   form). */
	.switch-row {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		width: fit-content;
		cursor: pointer;
	}

	.switch-row input {
		position: absolute;
		opacity: 0;
		width: 40px;
		height: 22px;
		margin: 0;
		cursor: pointer;
	}

	.switch-track {
		position: relative;
		flex-shrink: 0;
		width: 40px;
		height: 22px;
		border-radius: 999px;
		background: var(--border-control);
		transition: background 140ms var(--ease);
	}

	.switch-track.on {
		background: var(--accent);
	}

	.switch-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent-core);
		transition: transform 140ms var(--ease);
	}

	.switch-track.on .switch-knob {
		transform: translateX(18px);
	}

	.switch-text {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-rows);
	}
</style>
