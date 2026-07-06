<script lang="ts" module>
	// Minimal 24x24 stroke icon set (lucide-style geometry).
	const PATHS: Record<string, string> = {
		dashboard:
			'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
		blocks:
			'M12 2 3 7v10l9 5 9-5V7l-9-5zM3 7l9 5m0 0 9-5m-9 5v10',
		wallet:
			'M20 7H5a2 2 0 0 1 0-4h13v4m2 0v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5m13 8h4',
		settings:
			'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2z',
		shield:
			'M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z',
		search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3',
		logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
		plus: 'M12 5v14M5 12h14',
		copy: 'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
		check: 'M20 6 9 17l-5-5',
		x: 'M18 6 6 18M6 6l12 12',
		'chevron-right': 'm9 18 6-6-6-6',
		'chevron-left': 'm15 18-6-6 6-6',
		'chevron-down': 'm6 9 6 6 6-6',
		'arrow-right': 'M5 12h14m-6-6 6 6-6 6',
		'arrow-down-left': 'M17 7 7 17m0 0h8m-8 0V9',
		'arrow-up-right': 'M7 17 17 7m0 0H9m8 0v8',
		refresh: 'M21 12a9 9 0 1 1-2.6-6.3L21 8m0-5v5h-5',
		clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v6l4 2',
		zap: 'M13 2 3 14h7l-1 8 12-14h-8l0-6z',
		users:
			'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m8-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 9v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
		ticket:
			'M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a2.5 2.5 0 0 0 0 5v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2.5 2.5 0 0 0 0-5zm10-4v2m0 10v2m0-8v2',
		server:
			'M4 3h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 10h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm2-6h.01M6 17h.01',
		qr: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v2h-2zM15 19h2v2h-2zM19 19h2v2h-2z',
		eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
		trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-6 5v6m4-6v6',
		info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01',
		'alert-triangle':
			'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01',
		activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
		flame:
			'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 2.5.5 5 2.5 5 6a4.5 4.5 0 1 1-9 0c0-1.5.5-3 1.5-4 0 1.5 1 3.5 1 3.5zM12 2s4 3.5 4 7c2 1.5 4 4 4 7.5a8 8 0 0 1-16 0C4 11 8 8.5 8 6c0-2 4-4 4-4z'
	};
</script>

<script lang="ts">
	let {
		name,
		size = 16,
		strokeWidth = 1.75
	}: { name: string; size?: number; strokeWidth?: number } = $props();
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
	<path d={PATHS[name] ?? ''} />
</svg>
