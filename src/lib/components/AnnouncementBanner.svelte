<script lang="ts">
	// One announcement banner — used both for the real thing (app layout, below
	// the nav) and as the live preview on /admin/announcements (preview mode
	// disables the dismiss POST but keeps the visuals identical, so what the
	// admin sees IS what users get). Body is rendered as plain text on purpose:
	// no markdown/HTML, so admin input can never become markup.
	import Icon from '$lib/components/Icon.svelte';

	interface BannerAnnouncement {
		id?: number;
		type: string;
		title: string;
		body: string;
		linkUrl?: string | null;
		linkText?: string | null;
		dismissible?: boolean;
	}

	let {
		announcement,
		preview = false
	}: { announcement: BannerAnnouncement; preview?: boolean } = $props();

	const ICONS: Record<string, string> = {
		info: 'info',
		warning: 'alert-triangle',
		urgent: 'alert-triangle',
		promotion: 'zap'
	};

	// Optimistic hide: the banner disappears the moment the user dismisses; the
	// POST records it server-side so it stays gone across browsers. If the POST
	// fails the banner simply returns on the next load — the safe direction.
	let hidden = $state(false);
	async function dismiss() {
		if (preview || !announcement.id) return;
		hidden = true;
		try {
			await fetch(`/api/announcements/${announcement.id}/dismiss`, { method: 'POST' });
		} catch {
			// Best-effort; see above.
		}
	}

	// Site-relative CTA links stay in-tab; external ones open a new tab.
	const external = $derived(/^https?:/i.test(announcement.linkUrl ?? ''));

	// An unknown type (shouldn't happen — the server validates) renders as info.
	const kind = $derived(ICONS[announcement.type] ? announcement.type : 'info');
</script>

{#if !hidden}
	<div class="announcement type-{kind}" role="status">
		<Icon name={ICONS[kind]} size={16} />
		<span class="grow">
			<strong>{announcement.title}</strong>
			<span class="body">{announcement.body}</span>
			{#if announcement.linkUrl}
				<a
					href={announcement.linkUrl}
					target={external ? '_blank' : undefined}
					rel={external ? 'noopener noreferrer' : undefined}
				>{announcement.linkText || 'Learn more'}</a>
			{/if}
		</span>
		{#if announcement.dismissible ?? true}
			<button type="button" class="dismiss" aria-label="Dismiss" onclick={dismiss}>
				<Icon name="x" size={14} />
			</button>
		{/if}
	</div>
{/if}

<style>
	/* Matches the backup/reminder banners in the (app) layout: same shape,
	   spacing and typography; only the tint varies by type. */
	.announcement {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		border-radius: var(--radius-control);
	}

	.announcement :global(svg) {
		flex-shrink: 0;
	}

	.announcement strong {
		color: var(--text);
		margin-right: 6px;
	}

	.announcement .body {
		margin-right: 6px;
		white-space: pre-line; /* admin newlines survive; still plain text */
	}

	.announcement a {
		color: var(--accent);
		font-weight: 500;
		white-space: nowrap;
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	/* The design system has no blue, so "info" is the neutral surface tint
	   (like the backup reminder); the other three map to the status palette. */
	.type-info {
		background: var(--surface);
		border: 1px solid var(--border-subtle);
	}
	.type-info :global(svg) {
		color: var(--text-muted);
	}

	.type-warning {
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
	}
	.type-warning :global(svg) {
		color: var(--warning);
	}

	.type-urgent {
		background: var(--error-muted);
		border: 1px solid var(--error-border);
	}
	.type-urgent :global(svg) {
		color: var(--error);
	}

	.type-promotion {
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
	}
	.type-promotion :global(svg) {
		color: var(--accent);
	}

	.dismiss {
		display: flex;
		align-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		flex-shrink: 0;
	}

	.dismiss:hover {
		color: var(--text);
	}
</style>
