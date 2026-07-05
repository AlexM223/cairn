<script lang="ts" module>
	// Stroke icons for the three key categories (lucide-style geometry),
	// local to the vault pages so the shared Icon set stays lean.
	const PATHS: Record<string, string> = {
		// cpu — a hardware signing device
		hardware:
			'M6 6h12v12H6zM9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2',
		// smartphone — a phone wallet
		mobile: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
		// archive box — a seed backup kept somewhere safe
		recovery: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4'
	};
</script>

<script lang="ts">
	let {
		category,
		size = 16,
		strokeWidth = 1.75
	}: { category: string; size?: number; strokeWidth?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	style="flex-shrink: 0"
>
	<path d={PATHS[category] ?? PATHS.hardware} />
</svg>
