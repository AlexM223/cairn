<script lang="ts" module>
	import type { TxStatus } from '$lib/server/transactions';

	const BADGE: Record<TxStatus, { class: string; label: string }> = {
		draft: { class: 'badge-neutral', label: 'Draft' },
		awaiting_signature: { class: 'badge-warning', label: 'Awaiting signature' },
		completed: { class: 'badge-success', label: 'Broadcast' },
		// Replaced by a fee-bumped (RBF) transaction — kept for the record.
		superseded: { class: 'badge-neutral', label: 'Replaced' }
	};
</script>

<script lang="ts">
	let { status }: { status: TxStatus } = $props();
</script>

<span class="badge {BADGE[status].class}">{BADGE[status].label}</span>
