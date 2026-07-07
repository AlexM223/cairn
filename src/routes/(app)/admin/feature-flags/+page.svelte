<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Category display order + headings. `upcoming` groups flags for features not
	// built yet — the toggle still works, it just gates nothing until the feature
	// ships (and its enforcement call site is wired).
	const GROUPS: { category: string; title: string; hint?: string }[] = [
		{ category: 'wallet', title: 'Wallet' },
		{ category: 'hardware', title: 'Hardware devices' },
		{ category: 'notifications', title: 'Notification channels' },
		{
			category: 'upcoming',
			title: 'Upcoming features',
			hint: 'Reserved for features still in development — toggling now takes effect the moment they ship.'
		}
	];

	const grouped = $derived(
		GROUPS.map((g) => ({
			...g,
			flags: data.flags.filter((f) => f.category === g.category)
		})).filter((g) => g.flags.length > 0)
	);
</script>

<svelte:head>
	<title>Feature flags — Admin — Heartwood</title>
</svelte:head>

<p class="lead">
	Turn features on or off for the whole instance. Everything is on by default. A per-user
	exception (either direction) can be set from a user's page under <a href="/admin/users">Users</a>.
</p>

{#if form?.error}
	<div class="form-error" role="alert" style="margin-bottom: 14px">{form.error}</div>
{/if}

<div class="stack">
	{#each grouped as group (group.category)}
		<section class="hw-section fade-in">
			<div class="group-head">
				<h2 class="hw-title">{group.title}</h2>
				{#if group.hint}<p class="hint">{group.hint}</p>{/if}
			</div>
			<ul class="hw-rows">
				{#each group.flags as flag (flag.key)}
					<li class="hw-row">
						<div class="flag-main">
							<span class="flag-label">{flag.label}</span>
							{#if flag.description}<span class="flag-desc">{flag.description}</span>{/if}
							{#if flag.overrideCount > 0}
								<a class="override-badge" href="/admin/users" title="Users with a per-user override for this flag">
									{flag.overrideCount} user override{flag.overrideCount === 1 ? '' : 's'}
								</a>
							{/if}
						</div>
						<form method="POST" action="?/toggle" use:enhance>
							<input type="hidden" name="key" value={flag.key} />
							<input type="hidden" name="enabled" value={(!flag.enabled).toString()} />
							<button
								type="submit"
								class="switch"
								class:on={flag.enabled}
								role="switch"
								aria-checked={flag.enabled}
								aria-label="{flag.enabled ? 'Disable' : 'Enable'} {flag.label}"
							>
								<span class="knob"></span>
							</button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.lead {
		font-size: 13.5px;
		color: var(--text-secondary);
		line-height: 1.5;
		margin-bottom: 20px;
		max-width: 640px;
	}

	.lead a {
		color: var(--accent);
	}

	.group-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.flag-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.flag-label {
		font-size: 13.5px;
		font-weight: 500;
	}

	.flag-desc {
		font-size: 12px;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.override-badge {
		align-self: flex-start;
		margin-top: 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-chip);
		padding: 1px 7px;
	}

	/* Switch: a submit button styled as a toggle. The whole flag row's form posts
	   ?/toggle on click, so state is server-authoritative (no optimistic flip). */
	.switch {
		flex-shrink: 0;
		position: relative;
		width: 40px;
		height: 22px;
		border-radius: 999px;
		border: none;
		background: var(--border-control);
		cursor: pointer;
		transition: background 140ms var(--ease);
		padding: 0;
	}

	.switch.on {
		background: var(--accent);
	}

	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent-core);
		transition: transform 140ms var(--ease);
	}

	.switch.on .knob {
		transform: translateX(18px);
	}
</style>
