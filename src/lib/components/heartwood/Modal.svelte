<script lang="ts">
	/**
	 * Modal — the shared irreversible-action confirm dialog. Per spec,
	 * modals exist for irreversible acts only; the "Once it takes a ring,
	 * there is no undo."-style copy is the caller's job via `message`.
	 *
	 * Cancel is a plain text button; Confirm is the one copper pill.
	 * Backdrop click and Escape both cancel. Focus moves to the panel on
	 * open (minimal trap — not a full a11y audit).
	 */
	let {
		open = $bindable(false),
		title,
		message,
		confirmLabel = 'Confirm',
		onConfirm = undefined,
		onCancel = undefined
	}: {
		open?: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		onConfirm?: () => void;
		onCancel?: () => void;
	} = $props();

	let panel: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (open && panel) panel.focus();
	});

	function cancel() {
		open = false;
		onCancel?.();
	}

	function confirm() {
		open = false;
		onConfirm?.();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<!-- Backdrop click-to-cancel is a convenience duplicate of Escape (handled
	     on window above), so the static-element interaction is intentional. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class="backdrop"
		onclick={(e) => {
			if (e.target === e.currentTarget) cancel();
		}}
	>
		<div class="panel" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" bind:this={panel}>
			<h2 class="title">{title}</h2>
			<p class="message">{message}</p>
			<div class="actions">
				<button type="button" class="btn btn-ghost" onclick={cancel}>Cancel</button>
				<button type="button" class="btn btn-primary" onclick={confirm}>{confirmLabel}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: rgba(10, 8, 7, 0.62);
	}

	.panel {
		width: min(420px, 100%);
		padding: 26px 28px;
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		/* Modal radius isn't in the token set; 16px sits between
		   --radius-toggle and --radius-status-pill. */
		border-radius: 16px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
		outline: none;
	}

	.title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text-hero);
		letter-spacing: -0.01em;
	}

	.message {
		margin-top: 10px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 24px;
	}
</style>
