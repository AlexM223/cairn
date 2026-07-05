<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import type { ConstructedVaultPsbt, VaultSigningProgress } from '$lib/server/bitcoin/vaultPsbt';
	import type { SigningMass } from '$lib/server/bitcoin/signingMass';
	import type { StatelessScanResult } from '$lib/server/stateless';
	import { quorumLabel, VAULT_SCRIPT_LABELS } from '../labels';
	// Reused signers: the QR signer is a props-driven pass-through (the DEVICE
	// does the multisig math) and the Trezor signer needs no server state at
	// all (Trezor keeps no multisig memory — the full cosigner set travels with
	// every request), so both work unchanged for a vault that was never saved.
	// File and Ledger get stateless-local siblings (see _components/) because
	// their persistent versions depend on vault API endpoints.
	import QrSigner from '../../wallets/[id]/send/_components/QrSigner.svelte';
	import type { SignerContext } from '../../wallets/[id]/send/_components/signerContract';
	import VaultTrezorSigner from '../[id]/send/_components/VaultTrezorSigner.svelte';
	import StatelessFileSigner from './_components/StatelessFileSigner.svelte';
	import StatelessLedgerSigner from './_components/StatelessLedgerSigner.svelte';

	let { data } = $props();

	const SATS_PER_BTC = 100_000_000;

	// ── The whole model: three phases over client-held state ─────────────────
	// 'load'  — paste/upload a config, see balance + addresses
	// 'build' — recipient/amount/fee → unsigned PSBT + review
	// 'sign'  — per-key signing via /api/stateless/combine, then broadcast
	// Nothing lives on the server between calls; the source is re-posted with
	// every request (Caravan's config-file-only model).
	type Phase = 'load' | 'build' | 'sign';
	let phase = $state<Phase>('load');

	let source = $state('');
	let scan = $state<StatelessScanResult | null>(null);
	let scanning = $state(false);
	let scanError = $state<string | null>(null);

	const config = $derived(scan?.config ?? null);
	const vaultLabel = $derived(config?.name || 'Stateless vault');
	const quorum = $derived(config ? quorumLabel(config.threshold, config.totalKeys) : '');

	// ── sessionStorage survival (mirrors Caravan) ─────────────────────────────
	// Caravan caches its working state in sessionStorage so a reload doesn't
	// lose the config or a half-signed PSBT — but closing the tab wipes it.
	// Same here: source + scan + PSBT + progress survive a reload; nothing
	// survives the tab. This is the ONLY place any of it is written, and it
	// never leaves the browser.
	const STORAGE_KEY = 'cairn:stateless:v1';
	let restored = false;

	onMount(() => {
		try {
			const raw = sessionStorage.getItem(STORAGE_KEY);
			if (raw) {
				const saved = JSON.parse(raw) as {
					phase?: Phase;
					source?: string;
					scan?: StatelessScanResult | null;
					details?: ConstructedVaultPsbt | null;
					progress?: VaultSigningProgress | null;
					psbt?: string | null;
					sentTxid?: string | null;
				};
				if (saved.source && saved.scan) {
					source = saved.source;
					scan = saved.scan;
					details = saved.details ?? null;
					progress = saved.progress ?? null;
					psbt = saved.psbt ?? null;
					sentTxid = saved.sentTxid ?? null;
					phase = saved.phase ?? 'load';
				}
			}
		} catch {
			/* corrupt cache — start clean */
		}
		restored = true;
	});

	$effect(() => {
		// Touch everything that must survive a reload, then persist as one blob.
		const snapshot = { phase, source, scan, details, progress, psbt, sentTxid };
		if (!restored) return;
		try {
			if (scan) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
			else sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			/* storage full/blocked — the in-memory state still drives the flow */
		}
	});

	function startOver() {
		phase = 'load';
		scan = null;
		source = '';
		details = null;
		progress = null;
		psbt = null;
		sentTxid = null;
		scanError = null;
		buildError = null;
		try {
			sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			/* nothing to clean */
		}
	}

	// ── Phase 1: load ─────────────────────────────────────────────────────────

	async function onConfigFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			source = (await file.text()).trim();
		} catch {
			scanError = 'Could not read that file.';
		} finally {
			input.value = '';
		}
	}

	async function loadConfig() {
		if (scanning || source.trim().length === 0) return;
		scanning = true;
		scanError = null;
		try {
			const res = await fetch('/api/stateless/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source })
			});
			const body = await res.json();
			if (!res.ok) {
				scanError = body.error ?? 'Could not read that config.';
				return;
			}
			scan = body as StatelessScanResult;
			// A fresh load invalidates any prior working transaction.
			details = null;
			progress = null;
			psbt = null;
			sentTxid = null;
		} catch {
			scanError = 'Could not reach Cairn to scan that config.';
		} finally {
			scanning = false;
		}
	}

	// ── Phase 2: build ────────────────────────────────────────────────────────
	// Single recipient for v1 (batch sends stay on the persistent vault flow
	// for now — the API already accepts a recipients array, so batching here
	// is a UI-only follow-up).

	let recipient = $state('');
	let amountBtc = $state('');
	let amountMode = $state<'btc' | 'max'>('btc');

	type FeeChoice = 'fast' | 'normal' | 'economy' | 'custom';
	let feeChoice = $state<FeeChoice>('normal');
	// svelte-ignore state_referenced_locally — per-navigation seed
	let customFee = $state(String(data.fees?.halfHour ?? 5));

	const feeRate = $derived.by(() => {
		const fallback = Number(customFee) || 1;
		if (feeChoice === 'fast') return data.fees?.fastest ?? fallback;
		if (feeChoice === 'normal') return data.fees?.halfHour ?? fallback;
		if (feeChoice === 'economy') return data.fees?.economy ?? fallback;
		return Math.max(1, fallback);
	});

	const looksLikeAddress = (a: string) => /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{6,90}$/.test(a.trim());
	const isMax = $derived(amountMode === 'max');
	const canBuild = $derived(
		looksLikeAddress(recipient) &&
			(isMax || (Number(amountBtc) > 0 && Number.isFinite(Number(amountBtc)))) &&
			feeRate >= 1
	);

	// Optional coin control over the scan's UTXO list.
	let coinsOpen = $state(false);
	let selectedCoins = $state<Set<string>>(new Set());
	function toggleCoin(key: string) {
		const next = new Set(selectedCoins);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		selectedCoins = next;
	}

	let details = $state<ConstructedVaultPsbt | null>(null);
	let progress = $state<VaultSigningProgress | null>(null);
	/** The CURRENT combined PSBT — the client-held state every combine updates. */
	let psbt = $state<string | null>(null);
	let building = $state(false);
	let buildError = $state<string | null>(null);

	const signingMass = $derived<SigningMass | null>(details?.signingMass ?? null);

	async function build() {
		if (!canBuild || building) return;
		building = true;
		buildError = null;
		const onlyUtxos =
			selectedCoins.size > 0
				? [...selectedCoins].map((k) => {
						const [txid, vout] = k.split(':');
						return { txid, vout: Number(vout) };
					})
				: undefined;
		try {
			const res = await fetch('/api/stateless/psbt', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					source,
					recipients: [
						{
							address: recipient.trim(),
							amount: isMax ? 'max' : Math.round(Number(amountBtc) * SATS_PER_BTC)
						}
					],
					feeRate,
					onlyUtxos
				})
			});
			const body = await res.json();
			if (!res.ok) {
				buildError = body.error ?? 'Could not build the transaction.';
				return;
			}
			details = body.details as ConstructedVaultPsbt;
			progress = body.progress as VaultSigningProgress;
			psbt = details.psbtBase64;
			sentTxid = null;
			activeKeyIdx = null;
			signFlash = null;
			signError = null;
		} catch {
			buildError = 'Could not reach Cairn to build the transaction.';
		} finally {
			building = false;
		}
	}

	// ── Phase 3: sign & broadcast ─────────────────────────────────────────────
	// Per-key progress chips come from the parsed config's key roster; the
	// server's progress object (fingerprint attribution straight from the
	// PSBT) is the only authority. The config carries no device routing, so
	// every key offers the four generic methods as selectable cards.

	type SignMethod = 'file' | 'qr' | 'trezor' | 'ledger';
	const METHODS: { key: SignMethod; label: string; blurb: string }[] = [
		{ key: 'file', label: 'File / SD card', blurb: 'Download, sign anywhere, upload back' },
		{ key: 'qr', label: 'QR camera', blurb: 'SeedSigner, Passport, Keystone, Jade' },
		{ key: 'trezor', label: 'Trezor', blurb: 'Sign over USB (WebUSB)' },
		{ key: 'ledger', label: 'Ledger', blurb: 'Sign over USB (WebHID)' }
	];

	let activeKeyIdx = $state<number | null>(null);
	let methodByKey = $state<Record<number, SignMethod>>({});
	let signerEpoch = $state(0);
	let signFlash = $state<string | null>(null);
	let attaching = $state(false);
	let signError = $state<string | null>(null);

	const required = $derived(config?.threshold ?? 0);
	const signedFps = $derived(new Set(progress?.signedFingerprints ?? []));
	const collected = $derived(progress?.collected ?? 0);
	const remainingNeeded = $derived(Math.max(0, required - collected));
	const complete = $derived(progress?.complete ?? false);

	function isSigned(idx: number): boolean {
		const fp = config?.keys[idx]?.fingerprint;
		return !!fp && fp !== '00000000' && signedFps.has(fp);
	}

	const unsignedIdxs = $derived(
		config ? config.keys.map((_, i) => i).filter((i) => !isSigned(i)) : []
	);
	const activeIdx = $derived(
		activeKeyIdx !== null && unsignedIdxs.includes(activeKeyIdx)
			? activeKeyIdx
			: (unsignedIdxs[0] ?? null)
	);
	const activeKey = $derived(activeIdx !== null ? (config?.keys[activeIdx] ?? null) : null);
	const activeMethod = $derived(activeIdx !== null ? (methodByKey[activeIdx] ?? 'file') : 'file');
	const hasPlaceholderFp = $derived(config?.keys.some((k) => k.fingerprint === '00000000') ?? false);

	function chooseKey(idx: number) {
		activeKeyIdx = idx;
		signError = null;
		signFlash = null;
		signerEpoch += 1;
	}

	function chooseMethod(m: SignMethod) {
		if (activeIdx === null) return;
		methodByKey = { ...methodByKey, [activeIdx]: m };
		signError = null;
		signerEpoch += 1;
	}

	// The cosigner roster in the shape the USB drivers take — public material only.
	const signKeys = $derived(
		(config?.keys ?? []).map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
	);

	const signerContext = $derived.by<SignerContext | null>(() => {
		if (!details || !config) return null;
		return {
			walletId: 0, // no persisted wallet/draft exists — display-only context
			draftId: 0,
			scriptType: config.scriptType,
			destinationAddress: details.recipient,
			amountSats: details.amount,
			feeSats: details.fee,
			changeSats: details.change?.value ?? 0
		};
	});

	// Central attach path: every signing method funnels through the stateless
	// combine — the server merges, re-checks it against the reviewed
	// transaction, and returns the new combined PSBT + fresh progress. The
	// CLIENT keeps the result; nothing is stored.
	async function attachSignedPsbt(signed: string) {
		if (!signed || attaching || !psbt) return;
		attaching = true;
		signError = null;
		const before = new Set(progress?.signedFingerprints ?? []);
		try {
			const res = await fetch('/api/stateless/combine', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source, base: psbt, incoming: signed })
			});
			const body = await res.json();
			if (!res.ok) {
				signError = body.error ?? 'That PSBT could not be combined.';
				return;
			}
			const prevCollected = progress?.collected ?? 0;
			psbt = body.psbt as string;
			progress = body.progress as VaultSigningProgress;

			if (progress.complete) {
				signFlash = null;
				return;
			}
			if (progress.collected > prevCollected) {
				const newFp = progress.signedFingerprints.find((fp) => !before.has(fp));
				const who = newFp ? config?.keys.find((k) => k.fingerprint === newFp)?.name : undefined;
				const more = progress.required - progress.collected;
				signFlash = `${who ? `Signature from ${who}` : 'Signature'} added — ${more} more ${
					more === 1 ? 'signature' : 'signatures'
				} needed.`;
				activeKeyIdx = null;
				signerEpoch += 1;
			} else {
				signError =
					'That PSBT was read, but it added no new signature — it may already be counted, or the wrong device signed. Pick the next key and sign the freshly downloaded file.';
			}
		} catch {
			signError = 'Could not reach Cairn to combine the signed transaction.';
		} finally {
			attaching = false;
		}
	}

	function handleSigned(signedPsbtBase64: string) {
		void attachSignedPsbt(signedPsbtBase64.trim());
	}

	let broadcasting = $state(false);
	let broadcastError = $state<string | null>(null);
	let sentTxid = $state<string | null>(null);

	async function broadcast() {
		if (broadcasting || !psbt || !complete) return;
		broadcasting = true;
		broadcastError = null;
		try {
			const res = await fetch('/api/stateless/broadcast', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source, psbt })
			});
			const body = await res.json();
			if (!res.ok) {
				broadcastError = body.error ?? 'Broadcast failed.';
				return;
			}
			sentTxid = body.txid as string;
		} catch {
			broadcastError = 'Could not reach Cairn to broadcast.';
		} finally {
			broadcasting = false;
		}
	}
</script>

<svelte:head>
	<title>Stateless signer · Cairn</title>
</svelte:head>

<div class="stateless-page">
	<header class="page-head">
		<a class="back" href="/vaults">
			<Icon name="chevron-left" size={15} />
			<span>Vaults</span>
		</a>
		<h1 class="page-title">Stateless signer</h1>
		<p class="lead text-secondary">
			Work a multisig vault straight from its config file — balance, spend, sign, broadcast —
			without saving anything to Cairn.
		</p>
	</header>

	<!-- ============================================================= LOAD -->
	<section class="phase" class:done={phase !== 'load' && scan}>
		<div class="phase-head">
			<span class="phase-num" class:complete={!!scan}>{#if scan && phase !== 'load'}<Icon name="check" size={13} strokeWidth={2.5} />{:else}1{/if}</span>
			<h2 class="phase-title">Load a vault config</h2>
			{#if scan && phase !== 'load'}
				<button class="btn btn-ghost btn-sm" onclick={() => (phase = 'load')}>Edit</button>
			{/if}
		</div>

		{#if phase === 'load'}
			<div class="phase-body fade-in">
				<div class="ephemeral-note" role="note">
					<Icon name="alert-triangle" size={15} />
					<div>
						<strong>Nothing is saved</strong> — this page works entirely from the file you just
						provided. Close the tab and it's gone. (A reload within the same tab keeps your
						progress, like Caravan.)
					</div>
				</div>

				<HowItWorks id="stateless-vault">
					<p>
						Paste an <Term
							tip="A single line of text (wsh(sortedmulti(…))) that describes every address a multisig vault can ever derive — using only PUBLIC keys."
							>output descriptor</Term
						> or a Caravan/Unchained wallet JSON. Cairn derives the vault's addresses, checks their
						balance over Electrum, and lets you build and sign a spend — the same
						<Term
							tip="A Partially Signed Bitcoin Transaction — an unsigned proposal each signing device reviews and signs in turn."
							>PSBT</Term
						> ceremony as a saved vault, minus the saving.
					</p>
				</HowItWorks>

				<div class="card card-pad stack" style="gap: 14px">
					<div class="field">
						<label class="label" for="stateless-source">Descriptor or Caravan wallet JSON</label>
						<textarea
							id="stateless-source"
							class="input mono source-input"
							rows="5"
							placeholder={'wsh(sortedmulti(2,[aabbccdd/48h/0h/0h/2h]xpub…/0/*,…))#checksum\nor a Caravan / Unchained wallet .json'}
							bind:value={source}
							spellcheck="false"
						></textarea>
					</div>
					<div class="row" style="justify-content: space-between; gap: 10px; flex-wrap: wrap">
						<label class="btn btn-secondary btn-sm upload-btn">
							<input
								type="file"
								accept=".json,.txt,text/plain,application/json"
								onchange={onConfigFile}
							/>
							<Icon name="arrow-up-right" size={14} /> Upload config file
						</label>
						<button
							class="btn btn-primary"
							onclick={loadConfig}
							disabled={scanning || source.trim().length === 0}
						>
							{#if scanning}<span class="spinner"></span> Scanning…{:else}Load &amp; check balance<Icon
									name="arrow-right"
									size={15}
								/>{/if}
						</button>
					</div>
					{#if scanError}
						<div class="form-error" role="alert">{scanError}</div>
					{/if}
				</div>

				{#if scan && config}
					<div class="card card-pad scan-result fade-in">
						<div class="row" style="gap: 10px; flex-wrap: wrap">
							<span class="vault-icon"><Icon name="shield" size={14} /></span>
							<span class="scan-name grow truncate">{vaultLabel}</span>
							<span class="badge badge-accent">{quorum}</span>
							<span class="hint">{VAULT_SCRIPT_LABELS[config.scriptType]}</span>
						</div>

						<div class="balance">
							<span class="hero-number" title="{formatSats(scan.balance.confirmed)} sats">
								{formatBtc(scan.balance.confirmed)}
							</span>
							<span class="unit">BTC</span>
							{#if scan.balance.unconfirmed !== 0}
								<span class="badge badge-warning">
									{scan.balance.unconfirmed > 0 ? '+' : ''}{formatSats(scan.balance.unconfirmed)} sats
									pending
								</span>
							{/if}
						</div>
						<p class="hint">
							{scan.utxos.length}
							{scan.utxos.length === 1 ? 'spendable coin' : 'spendable coins'} found across the
							vault's addresses.
						</p>

						<div class="test-address">
							<span class="label">First address (0/0) — cross-check it in another tool</span>
							<CopyText value={scan.testAddress} display={scan.testAddress} />
						</div>

						<details class="addr-details">
							<summary>Receive addresses ({scan.addresses.length})</summary>
							<div class="addr-list">
								{#each scan.addresses as a (a.index)}
									<div class="addr-row">
										<span class="hint tabular addr-idx">/0/{a.index}</span>
										<span class="mono addr-text truncate">{a.address}</span>
										{#if a.used}
											<span class="badge">used</span>
										{:else}
											<span class="hint">fresh</span>
										{/if}
									</div>
								{/each}
							</div>
						</details>

						<p class="import-hint hint">
							Want history, labels, and health checks?
							<a href="/vaults/new">Import it as a vault instead</a> — same config, one wizard step.
						</p>

						<div class="row" style="justify-content: flex-end">
							<button class="btn btn-primary" onclick={() => (phase = 'build')}>
								Build a transaction <Icon name="arrow-right" size={15} />
							</button>
						</div>
					</div>
				{/if}
			</div>
		{:else if scan && config}
			<p class="phase-summary hint">
				“{vaultLabel}” — {quorum} · {formatBtc(scan.balance.confirmed)} BTC ·
				{scan.utxos.length}
				{scan.utxos.length === 1 ? 'coin' : 'coins'}
			</p>
		{/if}
	</section>

	<!-- ============================================================ BUILD -->
	{#if scan && config}
		<section class="phase" class:done={phase === 'sign'}>
			<div class="phase-head">
				<span class="phase-num" class:complete={!!details && phase === 'sign'}>{#if details && phase === 'sign'}<Icon name="check" size={13} strokeWidth={2.5} />{:else}2{/if}</span>
				<h2 class="phase-title">Build the transaction</h2>
				{#if details && phase === 'sign'}
					<button class="btn btn-ghost btn-sm" onclick={() => (phase = 'build')}>Edit</button>
				{/if}
			</div>

			{#if phase === 'build'}
				<div class="phase-body fade-in">
					<div class="card card-pad stack" style="gap: 18px">
						<div class="field">
							<label class="label" for="stateless-recipient">Recipient address</label>
							<input
								id="stateless-recipient"
								class="input mono"
								placeholder="bc1q…"
								bind:value={recipient}
								autocomplete="off"
								spellcheck="false"
							/>
							{#if recipient.length > 0 && !looksLikeAddress(recipient)}
								<p class="hint" style="color: var(--warning)">
									That doesn't look like a Bitcoin address yet.
								</p>
							{/if}
							<p class="hint">One recipient for now — batch sends live in the saved-vault flow.</p>
						</div>

						<div class="field">
							<div class="row" style="justify-content: space-between">
								<span class="label" id="stateless-amount-label">Amount</span>
								<div class="seg" role="group" aria-label="Amount mode">
									<button
										type="button"
										class="seg-btn"
										class:active={amountMode === 'btc'}
										onclick={() => (amountMode = 'btc')}>BTC</button
									>
									<button
										type="button"
										class="seg-btn"
										class:active={amountMode === 'max'}
										onclick={() => (amountMode = 'max')}
										title="Sweep the whole spendable balance">Max</button
									>
								</div>
							</div>
							{#if !isMax}
								<div class="amount-input">
									<input
										class="input tabular"
										inputmode="decimal"
										placeholder="0.00000000"
										bind:value={amountBtc}
										aria-labelledby="stateless-amount-label"
									/>
									<span class="unit-abs">BTC</span>
								</div>
								{#if Number(amountBtc) > 0}
									<p class="hint tabular">
										{formatSats(Math.round(Number(amountBtc) * SATS_PER_BTC))} sats
									</p>
								{/if}
							{:else}
								<div class="max-note">
									<Icon name="zap" size={15} />
									<span>Sweeps the vault's entire spendable balance to this address, minus the fee.</span>
								</div>
							{/if}
						</div>

						<div class="field">
							<span class="label">Fee rate</span>
							<div class="fee-grid">
								{#each [{ k: 'fast', label: 'Fast', rate: data.fees?.fastest, eta: '~10 min' }, { k: 'normal', label: 'Normal', rate: data.fees?.halfHour, eta: '~30 min' }, { k: 'economy', label: 'Economy', rate: data.fees?.economy, eta: '~1 hr+' }] as opt (opt.k)}
									<button
										type="button"
										class="fee-card"
										class:active={feeChoice === opt.k}
										onclick={() => (feeChoice = opt.k as FeeChoice)}
									>
										<span class="fee-label">{opt.label}</span>
										<span class="fee-rate tabular">
											{opt.rate != null ? formatFeeRate(opt.rate) : '—'}
										</span>
										<span class="fee-eta">{opt.eta}</span>
									</button>
								{/each}
								<button
									type="button"
									class="fee-card custom"
									class:active={feeChoice === 'custom'}
									onclick={() => (feeChoice = 'custom')}
								>
									<span class="fee-label">Custom</span>
									<div class="custom-input" role="presentation">
										<input
											class="input tabular"
											inputmode="decimal"
											bind:value={customFee}
											onfocus={() => (feeChoice = 'custom')}
											aria-label="Custom fee rate in sat/vB"
										/>
										<span class="unit-sm">sat/vB</span>
									</div>
								</button>
							</div>
							{#if !data.fees}
								<p class="hint">Live fee estimates are unavailable — set a custom sat/vB rate.</p>
							{/if}
						</div>

						{#if scan.utxos.length > 0}
							<div class="field">
								<button
									class="utxo-toggle"
									aria-expanded={coinsOpen}
									onclick={() => (coinsOpen = !coinsOpen)}
								>
									<Icon name={coinsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
									<span
										>Coin control (optional{selectedCoins.size > 0
											? ` — ${selectedCoins.size} selected`
											: ''})</span
									>
								</button>
								{#if coinsOpen}
									<div class="utxo-list fade-in">
										<p class="hint">
											Leave everything unchecked to let Cairn pick coins; check specific coins to
											spend only those.
										</p>
										{#each scan.utxos as u (`${u.txid}:${u.vout}`)}
											{@const key = `${u.txid}:${u.vout}`}
											<label class="utxo-row">
												<input
													type="checkbox"
													checked={selectedCoins.has(key)}
													onchange={() => toggleCoin(key)}
												/>
												<span class="mono text-muted">{truncateMiddle(u.txid, 10, 8)}:{u.vout}</span>
												<span class="grow"></span>
												<span class="tabular">{formatSats(u.value)} sats</span>
											</label>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						{#if buildError}
							<div class="form-error" role="alert">{buildError}</div>
						{/if}

						<div class="row" style="justify-content: flex-end">
							<button class="btn btn-primary" onclick={build} disabled={!canBuild || building}>
								{#if building}<span class="spinner"></span> Building…{:else}Build &amp; review<Icon
										name="arrow-right"
										size={15}
									/>{/if}
							</button>
						</div>
					</div>

					{#if details}
						<div class="card card-pad detail-list fade-in">
							<div class="detail-row">
								<span class="text-secondary">Sending</span>
								<span class="detail-val tabular"
									>{formatBtc(details.amount)} BTC <span class="text-muted"
										>· {formatSats(details.amount)} sats</span
									></span
								>
							</div>
							<div class="detail-row">
								<span class="text-secondary">To</span>
								<span class="detail-val mono recipient-val">{details.recipient}</span>
							</div>
							<div class="detail-row">
								<span class="text-secondary">Network fee</span>
								<span class="detail-val tabular"
									>{formatSats(details.fee)} sats
									<span class="text-muted">· {formatFeeRate(details.feeRate)}</span></span
								>
							</div>
							{#if details.change}
								<div class="detail-row">
									<span class="text-secondary">Change back to the vault</span>
									<span class="detail-val tabular">{formatSats(details.change.value)} sats</span>
								</div>
							{/if}
							<div class="detail-row">
								<span class="text-secondary">Coins spent</span>
								<span class="detail-val tabular"
									>{details.inputs.length}
									{details.inputs.length === 1 ? 'input' : 'inputs'}</span
								>
							</div>
							<div class="detail-row">
								<span class="text-secondary">Signatures required</span>
								<span class="detail-val">{quorum}</span>
							</div>
						</div>

						{#if signingMass && signingMass.warnLevel !== 'none'}
							<div
								class={`mass-panel ${signingMass.warnLevel}`}
								role={signingMass.warnLevel === 'red' ? 'alert' : 'note'}
							>
								<Icon name="alert-triangle" size={16} />
								<div>
									<strong>
										Signing will take roughly {Math.max(
											1,
											Math.round(signingMass.totalSeconds.lo / 60)
										)}–{Math.max(1, Math.round(signingMass.totalSeconds.hi / 60))} minutes across all
										{required} devices.
									</strong>
									Some coins came from large batch payouts, which each device verifies in full.
									<span class="mass-note">The network fee is not affected.</span>
								</div>
							</div>
						{/if}

						<div class="row" style="justify-content: flex-end">
							<button class="btn btn-primary" onclick={() => (phase = 'sign')}>
								Looks good — collect signatures <Icon name="arrow-right" size={15} />
							</button>
						</div>
					{/if}
				</div>
			{:else if details && phase === 'sign'}
				<p class="phase-summary hint tabular">
					{formatBtc(details.amount)} BTC → {truncateMiddle(details.recipient, 12, 10)} ·
					{formatSats(details.fee)} sats fee
				</p>
			{/if}
		</section>
	{/if}

	<!-- ============================================================= SIGN -->
	{#if phase === 'sign' && scan && config && details && psbt && progress}
		<section class="phase">
			<div class="phase-head">
				<span class="phase-num" class:complete={sentTxid !== null}>{#if sentTxid}<Icon name="check" size={13} strokeWidth={2.5} />{:else}3{/if}</span>
				<h2 class="phase-title">Sign &amp; broadcast</h2>
			</div>

			<div class="phase-body fade-in">
				{#if sentTxid}
					<div class="sent-body">
						<div class="sent-check"><Icon name="check" size={30} strokeWidth={2.5} /></div>
						<h3 class="sent-title">Broadcast!</h3>
						<p class="text-secondary">Your {quorum} transaction is on its way to the network.</p>
						<a class="sent-txid mono" href={`/explorer/tx/${sentTxid}`}>
							{truncateMiddle(sentTxid, 12, 12)}
							<Icon name="arrow-up-right" size={15} />
						</a>
						<div class="sent-copy">
							<CopyText value={sentTxid} display="Copy transaction ID" mono={false} />
						</div>
						<p class="hint">
							Remember: nothing was saved. To track this vault over time,
							<a href="/vaults/new">import the config as a vault</a>.
						</p>
						<div class="row" style="justify-content: center; gap: 10px">
							<button class="btn btn-secondary" onclick={startOver}>Start over</button>
							<a class="btn btn-primary" href="/vaults">Back to vaults</a>
						</div>
					</div>
				{:else}
					<!-- Live quorum progress, straight from the server's PSBT inspection. -->
					<div class="card card-pad quorum-card">
						<div class="quorum-head">
							<span class="quorum-count tabular">{collected} of {required} signatures collected</span>
							{#if !complete && remainingNeeded > 0}
								<span class="text-muted"
									>· {remainingNeeded} more {remainingNeeded === 1 ? 'signature' : 'signatures'} needed</span
								>
							{/if}
						</div>
						<div
							class="quorum-bar"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={required}
							aria-valuenow={collected}
							aria-label="Signatures collected"
						>
							<div
								class="quorum-bar-fill"
								style={`width:${Math.min(100, required > 0 ? (collected / required) * 100 : 0)}%`}
							></div>
						</div>

						<div class="key-chips">
							{#each config.keys as key, idx (idx)}
								{@const signed = isSigned(idx)}
								{@const active = activeIdx === idx}
								{#if signed}
									<div class="key-chip signed">
										<Icon name="check" size={13} strokeWidth={2.5} />
										<span class="chip-name">{key.name}</span>
										<span class="chip-meta mono">{key.fingerprint}</span>
									</div>
								{:else}
									<button
										type="button"
										class="key-chip"
										class:active
										onclick={() => chooseKey(idx)}
										title={active ? 'Currently signing with this key' : 'Sign with this key instead'}
									>
										<span class="chip-dot" aria-hidden="true"></span>
										<span class="chip-name">{key.name}</span>
										<span class="chip-meta mono">{key.fingerprint}</span>
									</button>
								{/if}
							{/each}
						</div>
						{#if hasPlaceholderFp}
							<p class="hint">
								Keys without a recorded master fingerprint (00000000) can't be individually ticked
								off — the signature count above is still exact, straight from the transaction
								itself.
							</p>
						{/if}
					</div>

					{#if signFlash}
						<div class="sign-flash" role="status">
							<Icon name="check" size={15} />
							<span>{signFlash}</span>
						</div>
					{/if}

					{#if !complete && activeKey && activeIdx !== null && signerContext}
						<!-- The config carries no device routing — pick a method per key. -->
						<div class="method-grid" role="group" aria-label="Signing method">
							{#each METHODS as m (m.key)}
								<button
									type="button"
									class="method-card"
									class:active={activeMethod === m.key}
									onclick={() => chooseMethod(m.key)}
								>
									<span class="method-name">{m.label}</span>
									<span class="method-blurb">{m.blurb}</span>
								</button>
							{/each}
						</div>

						{#key `${activeIdx}-${activeMethod}-${signerEpoch}`}
							{#if activeMethod === 'qr'}
								<!-- Camera signers refuse to sign for a multisig they were never
								     taught — same hard prerequisite as the persistent flow. The
								     registration file downloads from the file signer card too. -->
								<div class="register-callout" role="note">
									<Icon name="alert-triangle" size={15} />
									<div>
										<strong>First time signing for “{vaultLabel}” on this device? Register the
											vault on it first.</strong>
										SeedSigner, Passport, and Keystone <em>refuse to sign</em> for a multisig they
										don't know. Grab the registration file from the “File / SD card” method and
										import it on the device once, then scan the transaction.
									</div>
								</div>
								<QrSigner
									unsignedPsbt={psbt}
									context={signerContext}
									onsigned={handleSigned}
									oncancel={() => (activeKeyIdx = null)}
								/>
							{:else if activeMethod === 'trezor'}
								<VaultTrezorSigner
									unsignedPsbt={psbt}
									keyName={activeKey.name}
									vaultName={vaultLabel}
									threshold={config.threshold}
									totalKeys={config.totalKeys}
									scriptType={config.scriptType}
									vaultKeys={signKeys}
									destinationAddress={signerContext.destinationAddress}
									amountSats={signerContext.amountSats}
									feeSats={signerContext.feeSats}
									changeSats={signerContext.changeSats}
									onsigned={handleSigned}
									onusefile={() => chooseMethod('file')}
								/>
							{:else if activeMethod === 'ledger'}
								<StatelessLedgerSigner
									unsignedPsbt={psbt}
									keyName={activeKey.name}
									{vaultLabel}
									threshold={config.threshold}
									totalKeys={config.totalKeys}
									scriptType={config.scriptType}
									vaultKeys={signKeys}
									destinationAddress={signerContext.destinationAddress}
									amountSats={signerContext.amountSats}
									feeSats={signerContext.feeSats}
									changeSats={signerContext.changeSats}
									onsigned={handleSigned}
									onusefile={() => chooseMethod('file')}
								/>
							{:else}
								<StatelessFileSigner
									psbtBase64={psbt}
									registration={scan.registration}
									{vaultLabel}
									threshold={config.threshold}
									totalKeys={config.totalKeys}
									keyName={activeKey.name}
									destinationAddress={signerContext.destinationAddress}
									amountSats={signerContext.amountSats}
									feeSats={signerContext.feeSats}
									onsigned={handleSigned}
								/>
							{/if}
						{/key}
					{/if}

					{#if attaching}
						<div class="attach-status" role="status">
							<span class="spinner"></span> Merging the signature and re-checking it against the
							transaction you reviewed…
						</div>
					{:else if signError}
						<div class="form-error" role="alert">
							{signError}
							<div class="reject-actions">
								<button class="btn btn-secondary btn-sm" onclick={() => (signerEpoch += 1)}>
									<Icon name="refresh" size={14} /> Try again
								</button>
							</div>
						</div>
					{/if}

					{#if complete}
						<div class="quorum-done" role="status">
							<Icon name="check" size={16} strokeWidth={2.5} />
							<span>
								<strong>{required} of {required} signatures collected.</strong>
								The quorum is met — this transaction is fully authorized and ready to broadcast.
							</span>
						</div>

						<div class="confirm-warning" role="alert">
							<Icon name="alert-triangle" size={18} />
							<div>
								<strong>You are about to broadcast this transaction.</strong>
								Broadcasting is <em>irreversible</em> — once the network accepts it, the coins are
								gone. Verify one last time: {formatBtc(details.amount)} BTC to
								<span class="mono">{truncateMiddle(details.recipient, 12, 10)}</span>, fee
								{formatSats(details.fee)} sats.
							</div>
						</div>

						{#if broadcastError}
							<div class="form-error" role="alert">{broadcastError}</div>
						{/if}
					{/if}

					<div class="row step-actions">
						<span class="hint session-hint">
							Session-only: your progress survives a reload of this tab, nothing more. Signatures
							live in the PSBT itself — download it from the file method anytime as a backup.
						</span>
						<button
							class="btn btn-primary"
							onclick={broadcast}
							disabled={!complete || broadcasting}
							title={complete
								? 'Broadcast the fully signed transaction'
								: `${collected} of ${required} signatures — the quorum isn't met yet`}
						>
							{#if broadcasting}<span class="spinner"></span> Broadcasting…{:else}<Icon
									name="zap"
									size={15}
								/> Broadcast ({collected} of {required}){/if}
						</button>
					</div>
				{/if}
			</div>
		</section>
	{/if}
</div>

<style>
	.stateless-page {
		max-width: 680px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	.page-head {
		margin-bottom: 2px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 500;
		margin-bottom: 8px;
	}

	.back:hover {
		color: var(--accent);
	}

	.lead {
		font-size: 13.5px;
		margin-top: 4px;
		line-height: 1.6;
	}

	/* ---- phase frame ---- */
	.phase {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.phase-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.phase-num {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
	}

	.phase-num.complete {
		background: var(--success-muted);
		border-color: transparent;
		color: var(--success);
	}

	.phase-title {
		font-size: 16px;
		font-weight: 600;
		flex: 1;
	}

	.phase-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.phase-summary {
		margin-left: 34px;
	}

	.ephemeral-note {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--accent-muted);
		border: 1px solid rgba(232, 147, 90, 0.35);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.ephemeral-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.source-input {
		resize: vertical;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.upload-btn {
		cursor: pointer;
	}

	.upload-btn input {
		display: none;
	}

	/* ---- scan result ---- */
	.scan-result {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.vault-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		flex-shrink: 0;
	}

	.scan-name {
		font-size: 14.5px;
		font-weight: 600;
	}

	.balance {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.balance .hero-number {
		font-size: 28px;
	}

	.unit {
		font-size: 12px;
		color: var(--text-muted);
	}

	.test-address {
		display: flex;
		flex-direction: column;
		gap: 6px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 12.5px;
		word-break: break-all;
	}

	.addr-details summary {
		font-size: 13px;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.addr-details summary:hover {
		color: var(--accent);
	}

	.addr-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding-top: 8px;
	}

	.addr-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		font-size: 12.5px;
		padding: 5px 8px;
		background: var(--bg);
		border-radius: var(--radius-chip);
	}

	.addr-idx {
		flex-shrink: 0;
		min-width: 34px;
	}

	.addr-text {
		flex: 1;
		min-width: 0;
	}

	.import-hint a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* ---- build form (fee grid / seg / amount idioms from the send flows) ---- */
	.seg {
		display: inline-flex;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 2px;
	}

	.seg-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 12px;
		border-radius: var(--radius-chip);
		cursor: pointer;
	}

	.seg-btn.active {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.amount-input {
		position: relative;
	}

	.amount-input .input {
		padding-right: 52px;
		font-size: 18px;
	}

	.unit-abs {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 600;
	}

	.max-note {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 13px;
	}

	.fee-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 8px;
	}

	.fee-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		cursor: pointer;
		text-align: left;
	}

	.fee-card:hover {
		border-color: var(--text-muted);
	}

	.fee-card.active {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.fee-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.fee-rate {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.fee-eta {
		font-size: 11px;
		color: var(--text-muted);
	}

	.fee-card.custom {
		gap: 6px;
	}

	.custom-input {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.custom-input .input {
		padding: 5px 8px;
		font-size: 13px;
	}

	.unit-sm {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.utxo-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 0;
		cursor: pointer;
	}

	.utxo-toggle:hover {
		color: var(--accent);
	}

	.utxo-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 10px;
	}

	.utxo-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
		padding: 7px 10px;
		background: var(--bg);
		border-radius: var(--radius-chip);
		cursor: pointer;
	}

	/* ---- review ---- */
	.detail-list {
		display: flex;
		flex-direction: column;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 11px 0;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		padding-top: 0;
	}

	.detail-row:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	.detail-val {
		color: var(--text);
		font-weight: 500;
		text-align: right;
	}

	.recipient-val {
		font-weight: 400;
		font-size: 12.5px;
		word-break: break-all;
	}

	.mass-panel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.mass-panel.amber {
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
	}

	.mass-panel.amber :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.mass-panel.red {
		background: var(--danger-muted, var(--warning-muted));
		border: 1px solid rgba(220, 90, 90, 0.35);
	}

	.mass-panel.red :global(svg) {
		color: var(--danger, var(--warning));
		flex-shrink: 0;
		margin-top: 1px;
	}

	.mass-panel strong {
		display: block;
	}

	.mass-note {
		display: block;
		color: var(--text-muted);
		font-size: 12px;
		margin-top: 2px;
	}

	/* ---- sign ---- */
	.quorum-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.quorum-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
	}

	.quorum-count {
		font-size: 14px;
		font-weight: 600;
	}

	.quorum-bar {
		height: 6px;
		border-radius: 3px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		overflow: hidden;
	}

	.quorum-bar-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 3px;
		transition: width 240ms var(--ease);
	}

	.key-chips {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.key-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg);
		padding: 9px 12px;
		font-size: 13px;
		text-align: left;
	}

	button.key-chip {
		cursor: pointer;
		font-family: var(--font-ui);
		color: var(--text);
	}

	button.key-chip:hover {
		border-color: var(--text-muted);
	}

	.key-chip.active {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.key-chip.signed {
		color: var(--success);
		border-color: rgba(90, 200, 120, 0.3);
		background: var(--success-muted);
	}

	.chip-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--border);
		flex-shrink: 0;
	}

	.key-chip.active .chip-dot {
		background: var(--accent);
	}

	.chip-name {
		font-weight: 600;
	}

	.chip-meta {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.sign-flash {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--success);
		background: var(--success-muted);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 13px;
	}

	.method-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 8px;
	}

	.method-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
		cursor: pointer;
		text-align: left;
		font-family: var(--font-ui);
	}

	.method-card:hover {
		border-color: var(--text-muted);
	}

	.method-card.active {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.method-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
	}

	.method-blurb {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.register-callout {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.register-callout :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.register-callout strong {
		display: block;
	}

	.attach-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-secondary);
	}

	.reject-actions {
		margin-top: 10px;
	}

	.quorum-done {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(90, 200, 120, 0.3);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.quorum-done :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.quorum-done span {
		color: var(--text-secondary);
	}

	.quorum-done strong {
		color: var(--success);
	}

	.confirm-warning {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.35);
		border-radius: var(--radius-card);
		padding: 14px;
		font-size: 13px;
		line-height: 1.6;
	}

	.confirm-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.step-actions {
		justify-content: space-between;
		gap: 12px;
		align-items: center;
	}

	.session-hint {
		max-width: 340px;
		line-height: 1.5;
	}

	/* ---- sent ---- */
	.sent-body {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
		padding: 20px 0;
	}

	.sent-check {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 60px;
		height: 60px;
		border-radius: 50%;
		background: var(--success-muted);
		color: var(--success);
	}

	.sent-title {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
	}

	.sent-txid {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13.5px;
		color: var(--accent);
	}

	.sent-copy {
		font-size: 12.5px;
	}

	.sent-body .hint a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
