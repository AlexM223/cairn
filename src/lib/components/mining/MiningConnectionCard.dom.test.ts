// Mount-based regression test for the UI half of cairn-bm7c2: when the pool
// is bound to loopback only, an unconditional "point your miner at this
// address" affordance is dishonest — it looks connectable from any device
// but only ever works from this machine. The fix (MiningConnectionCard.svelte)
// swaps the stratum+tcp:// address block for a plain-language access notice
// instead, and only renders the copy-paste address once the pool is actually
// reachable off-box (bind 'lan' or 'all').
//
// Like miningEarnings.dom.test.ts, this only exists in the jsdom project
// (vitest.config.ts) because it requires an actual Svelte client mount.
// $app/state and $app/forms aren't resolvable outside a real SvelteKit build,
// so the dom project aliases them to src/tests/app-state-stub.ts and
// src/tests/app-forms-stub.ts (mirroring the existing $app/environment stub).
import { describe, expect, it, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MiningConnectionCard from './MiningConnectionCard.svelte';
import { page } from '$app/state';

type Bind = 'loopback' | 'lan' | 'all';

function baseProps(bind: Bind) {
	return {
		miningId: 'hw_deadbeef',
		workerFormat: 'hw_deadbeef.<workerName>',
		password: 'x',
		stratumPort: 3333,
		bind,
		asicPort: null as { port: number; shareDifficulty: number } | null,
		hasWorkers: true
	};
}

let mounted: Record<string, unknown> | undefined;

function renderCard(bind: Bind, opts?: { isAdmin?: boolean; asicPort?: { port: number; shareDifficulty: number } }) {
	// Plain URL vs SvelteKit's route-literal-typed `pathname` — runtime shape is
	// identical; the cast only satisfies the generated union type.
	page.url = new URL('http://minerbox.local:3000/mining') as typeof page.url;
	page.data = { user: opts?.isAdmin ? { isAdmin: true } : { isAdmin: false } };

	const target = document.body.appendChild(document.createElement('div'));
	const props = baseProps(bind);
	if (opts?.asicPort) props.asicPort = opts.asicPort;
	mounted = mount(MiningConnectionCard, { target, props }) as Record<string, unknown>;
	flushSync();
	return target;
}

afterEach(() => {
	if (mounted) {
		unmount(mounted);
		mounted = undefined;
	}
	document.body.innerHTML = '';
});

describe('MiningConnectionCard (cairn-bm7c2, UI half)', () => {
	it('shows the honesty notice and no stratum+tcp:// address when bound to loopback', () => {
		const target = renderCard('loopback');
		const text = target.textContent ?? '';

		expect(text).toContain('only reachable from this computer');
		expect(text).not.toContain('stratum+tcp://');
		// The "point your miner at this address" framing must not appear either —
		// it would contradict the honesty notice (v0.2.42 QA note in the component).
		expect(text).not.toContain('Point your Bitaxe, ASIC, or other miner at this address');
	});

	it('shows an admin hint to open the pool only when the viewer is an admin', () => {
		const asAdmin = renderCard('loopback', { isAdmin: true });
		expect(asAdmin.textContent).toContain('An admin can open it to your local network');
		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';

		const asNonAdmin = renderCard('loopback', { isAdmin: false });
		expect(asNonAdmin.textContent).not.toContain('An admin can open it to your local network');
	});

	it('renders the stratum+tcp:// address as the copy target once bound to lan', () => {
		const target = renderCard('lan');
		const text = target.textContent ?? '';

		expect(text).toContain('stratum+tcp://minerbox.local:3333');
		expect(text).not.toContain('only reachable from this computer');
	});

	it('renders the stratum+tcp:// address once bound to all interfaces', () => {
		const target = renderCard('all');
		expect(target.textContent).toContain('stratum+tcp://minerbox.local:3333');
	});

	it('shows both small-miner and ASIC addresses when the ASIC port is open and reachable', () => {
		const target = renderCard('lan', { asicPort: { port: 3334, shareDifficulty: 65536 } });
		const text = target.textContent ?? '';

		expect(text).toContain('stratum+tcp://minerbox.local:3333');
		expect(text).toContain('stratum+tcp://minerbox.local:3334');
		expect(text).toContain('Small miners');
		expect(text).toContain('Big machines');
	});

	it('does not render either stratum address when loopback-only, even with an ASIC port configured', () => {
		const target = renderCard('loopback', { asicPort: { port: 3334, shareDifficulty: 65536 } });
		const text = target.textContent ?? '';

		expect(text).not.toContain('stratum+tcp://');
		expect(text).toContain('only reachable from this computer');
	});
});
