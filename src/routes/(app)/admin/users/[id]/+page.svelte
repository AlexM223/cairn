<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const GROUPS: { category: string; title: string }[] = [
		{ category: 'wallet', title: 'Wallet' },
		{ category: 'hardware', title: 'Hardware devices' },
		{ category: 'notifications', title: 'Notification channels' },
		{ category: 'upcoming', title: 'Upcoming features' }
	];

	const grouped = $derived(
		GROUPS.map((g) => ({
			...g,
			flags: data.flags.filter((f) => f.category === g.category)
		})).filter((g) => g.flags.length > 0)
	);

	// The three segmented-control options. "Inherit" resolves to the instance
	// value; the other two pin this one user regardless of the global toggle.
	function stateOf(flag: { override: boolean | null }): 'inherit' | 'on' | 'off' {
		if (flag.override === null) return 'inherit';
		return flag.override ? 'on' : 'off';
	}
</script>

<svelte:head>
	<title>{data.subject.displayName} — Users — Admin — Heartwood</title>
</svelte:head>

<a class="back" href="/admin/users">← All users</a>

<div class="user-head">
	<div class="avatar">{data.subject.displayName.slice(0, 1).toUpperCase()}</div>
	<div>
		<h1 class="page-title">{data.subject.displayName}</h1>
		<span class="user-email">{data.subject.email}</span>
	</div>
	{#if data.subject.isAdmin}<span class="badge badge-accent">Admin</span>{/if}
	{#if data.subject.disabled}<span class="badge badge-error">Disabled</span>{/if}
</div>

<p class="lead">
	Feature overrides for this user. <strong>Inherit</strong> follows the instance-wide
	<a href="/admin/feature-flags">feature flags</a>; <strong>Force on</strong> / <strong>Force off</strong>
	pin the feature for this user regardless of the global setting.
</p>

{#if form?.error}
	<div class="form-error" role="alert" style="margin-bottom: 14px">{form.error}</div>
{/if}

<div class="stack">
	{#each grouped as group (group.category)}
		<section class="hw-section fade-in">
			<h2 class="hw-title">{group.title}</h2>
			<ul class="hw-rows">
				{#each group.flags as flag (flag.key)}
					{@const state = stateOf(flag)}
					<li class="hw-row">
						<div class="flag-main">
							<span class="flag-label">{flag.label}</span>
							<span class="flag-sub">
								Inherits <strong>{flag.globalEnabled ? 'on' : 'off'}</strong> ·
								<span class:muted={flag.resolved} class:off={!flag.resolved}>
									currently {flag.resolved ? 'enabled' : 'disabled'}
								</span>
							</span>
						</div>
						<div class="seg" role="group" aria-label="{flag.label} override">
							{#each [{ v: 'inherit', l: 'Inherit' }, { v: 'on', l: 'Force on' }, { v: 'off', l: 'Force off' }] as opt (opt.v)}
								<form method="POST" action="?/setOverride" use:enhance>
									<input type="hidden" name="key" value={flag.key} />
									<input type="hidden" name="state" value={opt.v} />
									<button
										type="submit"
										class="seg-btn"
										class:active={state === opt.v}
										class:danger={opt.v === 'off' && state === 'off'}
										aria-pressed={state === opt.v}
									>
										{opt.l}
									</button>
								</form>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.back {
		display: inline-block;
		font-size: 12.5px;
		color: var(--text-muted);
		margin-bottom: 14px;
	}

	.back:hover {
		color: var(--accent);
	}

	.user-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.avatar {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		font-weight: 600;
	}

	.user-email {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.lead {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.5;
		margin-bottom: 20px;
		max-width: 660px;
	}

	.lead a {
		color: var(--accent);
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

	.flag-sub {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	/* Forced-off is a deliberate admin nudge, not an error — amber per the
	   "never red outside genuine failures" rule. */
	.flag-sub .off {
		color: var(--attention);
	}

	.flag-sub .muted {
		color: var(--text-muted);
	}

	/* Segmented control: three little forms side by side, no gaps, shared border. */
	.seg {
		display: flex;
		flex-shrink: 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.seg form + form .seg-btn {
		border-left: 1px solid var(--border-subtle);
	}

	.seg-btn {
		display: block;
		padding: 5px 11px;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.seg-btn:hover {
		background: var(--surface);
		color: var(--text);
	}

	.seg-btn.active {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.seg-btn.danger {
		background: var(--attention-muted);
		color: var(--attention);
	}
</style>
