<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import QuorumArc from '$lib/components/heartwood/QuorumArc.svelte';
	import BurialRings from '$lib/components/heartwood/BurialRings.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import type { ConstructedMultisigPsbt, MultisigSigningProgress } from '$lib/server/bitcoin/multisigPsbt';
	import type { SigningMass } from '$lib/server/bitcoin/signingMass';
	import type { StatelessScanResult } from '$lib/server/stateless';
	import type { FeeEstimates } from '$lib/types';
	import { quorumLabel, MULTISIG_SCRIPT_LABELS } from '../labels';
	// Reused signers: the QR signer is a props-driven pass-through (the DEVICE
	// does the multisig math) and the Trezor signer needs no server state at
	// all (Trezor keeps no multisig memory — the full cosigner set travels with
	// every request), so both work unchanged for a multisig that was never saved.
	// The Ledger signer takes its stateless path when `multisig.multisigId` is
	// absent: it re-runs the on-device BIP-388 registration each session instead
	// of persisting the HMAC. Only File keeps a stateless-local sibling (see
	// _components/) because its persistent version depends on multisig API
	// endpoints.
	import QrSigner from '../../[id]/send/_components/QrSigner.svelte';
	import type { SignerContext } from '../../[id]/send/_components/signerContract';
	import TrezorSigner from '$lib/components/signing/TrezorSigner.svelte';
	import StatelessFileSigner from './_components/StatelessFileSigner.svelte';
	import LedgerSigner from '$lib/components/signing/LedgerSigner.svelte';

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
	const multisigLabel = $derived(config?.name || 'Stateless multisig');
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
					details?: ConstructedMultisigPsbt | null;
					progress?: MultisigSigningProgress | null;
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
			scanError = 'Could not reach Heartwood to scan that config.';
		} finally {
			scanning = false;
		}
	}

	// ── Phase 2: build ────────────────────────────────────────────────────────
	// Single recipient for v1 (batch sends stay on the persistent multisig flow
	// for now — the API already accepts a recipients array, so batching here
	// is a UI-only follow-up).

	let recipient = $state('');
	let amountBtc = $state('');
	let amountMode = $state<'btc' | 'max'>('btc');

	type FeeChoice = 'fast' | 'normal' | 'economy' | 'custom';
	let feeChoice = $state<FeeChoice>('normal');
	let customFee = $state('5');

	// Live fee estimates stream in from the server (data.fees is a promise, not a
	// value) so the page shell paints without waiting on a chain round-trip. Seed a
	// safe null, fill it in once the promise settles, and reseed the custom-fee box
	// from the half-hour rate unless the user has already typed one.
	let fees = $state<FeeEstimates | null>(null);
	let customFeeTouched = false;
	$effect(() => {
		let stale = false;
		void data.fees.then((f) => {
			if (stale) return;
			fees = f;
			if (!customFeeTouched && f?.halfHour != null) customFee = String(f.halfHour);
		});
		return () => {
			stale = true;
		};
	});

	const feeRate = $derived.by(() => {
		const fallback = Number(customFee) || 1;
		if (feeChoice === 'fast') return fees?.fastest ?? fallback;
		if (feeChoice === 'normal') return fees?.halfHour ?? fallback;
		if (feeChoice === 'economy') return fees?.economy ?? fallback;
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

	let details = $state<ConstructedMultisigPsbt | null>(null);
	let progress = $state<MultisigSigningProgress | null>(null);
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
			details = body.details as ConstructedMultisigPsbt;
			progress = body.progress as MultisigSigningProgress;
			psbt = details.psbtBase64;
			sentTxid = null;
			activeKeyIdx = null;
			signFlash = null;
			signError = null;
		} catch {
			buildError = 'Could not reach Heartwood to build the transaction.';
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
			progress = body.progress as MultisigSigningProgress;

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
			signError = 'Could not reach Heartwood to combine the signed transaction.';
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
			broadcastError = 'Could not reach Heartwood to broadcast.';
		} finally {
			broadcasting = false;
		}
	}
</script>

<svelte:head>
	<title>Stateless signer · Heartwood</title>
</svelte:head>

<div class="stateless-page hw-owns-header">
	<GroveField volume={sentTxid ? 'grove' : 'present'} />

	<div class="page-content">
	<!-- Mobile flow header (8b/8c): back circle + centered eyebrow + spacer —
	     this page composes its own so the shell's bare fallback is suppressed. -->
	<header class="flow-header">
		<BackCircle href="/wallets" />
		<span class="flow-eyebrow">Stateless signer</span>
		<span class="flow-spacer"></span>
	</header>

	<div class="eyebrow-row">
		<EyebrowBreadcrumb path={['Wallets']} current="Stateless signer" />
	</div>

	<p class="lead text-secondary">
		Work a multisig wallet straight from its config file — balance, spend, sign, broadcast —
		without saving anything to Heartwood.
	</p>

	<!-- ============================================================= LOAD -->
	<section class="phase" class:done={phase !== 'load' && scan}>
		<div class="phase-head">
			<span class="phase-num" class:complete={!!scan}>{#if scan && phase !== 'load'}<Icon name="check" size={13} strokeWidth={2.5} />{:else}1{/if}</span>
			<h2 class="phase-title">Load a multisig config</h2>
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

				<HowItWorks id="stateless-multisig">
					<p>
						Paste an <Term
							tip="A single line of text (wsh(sortedmulti(…))) that describes every address a multisig wallet can ever derive — using only PUBLIC keys."
							>output descriptor</Term
						> or a Caravan/Unchained wallet JSON. Heartwood derives the wallet's addresses, checks their
						balance over Electrum, and lets you build and sign a spend — the same
						<Term
							tip="A Partially Signed Bitcoin Transaction — an unsigned proposal each signing device reviews and signs in turn."
							>PSBT</Term
						> ceremony as a saved wallet, minus the saving.
					</p>
				</HowItWorks>

				<div class="load-form">
					<div class="field">
						<label class="sec-label" for="stateless-source">Descriptor or Caravan wallet JSON</label>
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
					<div class="scan-result fade-in">
						<div class="row" style="gap: 10px; flex-wrap: wrap">
							<span class="multisig-icon"><Icon name="shield" size={14} /></span>
							<span class="scan-name grow truncate">{multisigLabel}</span>
							<span class="badge badge-accent">{quorum}</span>
							<span class="hint">{MULTISIG_SCRIPT_LABELS[config.scriptType]}</span>
						</div>

						<div class="balance-block">
							<span class="hero-amount sm tabular" title="{formatSats(scan.balance.confirmed)} sats">
								{formatBtc(scan.balance.confirmed)}
							</span>
							<span class="hero-unit">BTC</span>
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
							wallet's addresses.
						</p>

						<div class="test-address">
							<span class="sec-label">First address (0/0) — cross-check it in another tool</span>
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
							<a href="/wallets/multisig/new">Import it as a multisig wallet instead</a> — same config, one wizard step.
						</p>

						<div class="row" style="justify-content: flex-end">
							<button class="btn btn-primary pill-lg" onclick={() => (phase = 'build')}>
								Build a transaction <Icon name="arrow-right" size={15} />
							</button>
						</div>
					</div>
				{/if}
			</div>
		{:else if scan && config}
			<p class="phase-summary hint">
				“{multisigLabel}” — {quorum} · {formatBtc(scan.balance.confirmed)} BTC ·
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
					<div class="field">
						<label class="sec-label" for="stateless-recipient">Recipient address</label>
						<input
							id="stateless-recipient"
							class="input mono"
							placeholder="bc1q…"
							bind:value={recipient}
							autocomplete="off"
							spellcheck="false"
						/>
						{#if recipient.length > 0 && !looksLikeAddress(recipient)}
							<p class="field-line attention">That doesn't look like a Bitcoin address yet.</p>
						{/if}
						<p class="hint">One recipient for now — batch sends live in the saved-multisig flow.</p>
					</div>

					<div class="field">
						<div class="row" style="justify-content: space-between">
							<span class="sec-label" id="stateless-amount-label">Amount</span>
							<div class="mode-toggles" role="group" aria-label="Amount mode">
								<button
									type="button"
									class="txt-toggle"
									class:active={amountMode === 'btc'}
									onclick={() => (amountMode = 'btc')}>BTC</button
								>
								<button
									type="button"
									class="txt-toggle"
									class:active={amountMode === 'max'}
									onclick={() => (amountMode = 'max')}
									title="Sweep the whole spendable balance">Max</button
								>
							</div>
						</div>
						{#if !isMax}
							<div class="amount-abs">
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
								<p class="field-line tabular muted">
									{formatSats(Math.round(Number(amountBtc) * SATS_PER_BTC))} sats
								</p>
							{/if}
						{:else}
							<div class="max-note">
								<Icon name="zap" size={15} />
								<span>Sweeps the wallet's entire spendable balance to this address, minus the fee.</span>
							</div>
						{/if}
					</div>

					<!-- FEE: text toggles, not a dropdown. -->
					<div class="fee-section">
						<div class="fee-head">
							<span class="sec-label">Fee</span>
							<span class="fee-caption">{formatFeeRate(feeRate)}</span>
						</div>
						<div class="fee-toggles" role="group" aria-label="Fee rate">
							{#each [{ k: 'economy', label: 'Low', rate: fees?.economy }, { k: 'normal', label: 'Medium', rate: fees?.halfHour }, { k: 'fast', label: 'High', rate: fees?.fastest }] as opt (opt.k)}
								<button
									type="button"
									class="txt-toggle"
									class:active={feeChoice === opt.k}
									onclick={() => (feeChoice = opt.k as FeeChoice)}
								>
									{opt.label}{#if opt.rate != null}<span class="toggle-rate tabular"
											>&nbsp;· {opt.rate < 10 ? Number(opt.rate.toFixed(1)) : Math.round(opt.rate)}</span
										>{/if}
								</button>
							{/each}
							<button
								type="button"
								class="txt-toggle"
								class:active={feeChoice === 'custom'}
								onclick={() => (feeChoice = 'custom')}
							>
								Custom
							</button>
						</div>
						{#if feeChoice === 'custom'}
							<div class="custom-fee">
								<input
									class="custom-fee-input tabular"
									inputmode="decimal"
									bind:value={customFee}
									oninput={() => (customFeeTouched = true)}
									aria-label="Custom fee rate in sat/vB"
								/>
								<span class="unit-sm">sat/vB</span>
							</div>
						{/if}
						{#if !fees}
							<p class="fee-caption">Live fee estimates are unavailable — set a custom sat/vB rate.</p>
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
										Leave everything unchecked to let Heartwood pick coins; check specific coins to
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

					<div class="row step-actions" style="justify-content: flex-end">
						<button class="btn btn-primary pill-lg" onclick={build} disabled={!canBuild || building}>
							{#if building}<span class="spinner"></span> Building…{:else}Build &amp; review<Icon
									name="arrow-right"
									size={15}
								/>{/if}
						</button>
					</div>

					{#if details}
						<div class="detail-list fade-in">
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
									<span class="text-secondary">Change back to the wallet</span>
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

						<div class="row step-actions" style="justify-content: flex-end">
							<button class="btn btn-primary pill-lg" onclick={() => (phase = 'sign')}>
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
						<!-- The ring-sweep moment: two cream sweeps (once), a dashed mempool
						     ring pulsing underneath — the transaction waiting for its first ring. -->
						<div class="sweep-stage">
							<span class="sweep s1"></span>
							<span class="sweep s2"></span>
							<BurialRings confirmations={0} direction="out" size={64} />
						</div>
						{#if details}
							<h2 class="sent-title">{formatBtc(details.amount)} BTC is on its way</h2>
						{:else}
							<h2 class="sent-title">Your bitcoin is on its way</h2>
						{/if}
						<p class="sent-sub">
							Authorized by {quorum} keys · in the mempool, waiting for its first ring
						</p>
						<div class="txid-pill">
							<span class="mono">{truncateMiddle(sentTxid, 12, 12)}</span>
							<CopyText value={sentTxid} display="Copy" mono={false} />
						</div>
						<p class="hint">
							Remember: nothing was saved. To track this wallet over time,
							<a href="/wallets/multisig/new">import the config as a multisig wallet</a>.
						</p>
						<div class="row step-actions" style="justify-content: center">
							<a class="btn btn-primary pill-lg" href={`/explorer/tx/${sentTxid}`}
								>Watch it get buried</a
							>
							<button class="btn btn-secondary" onclick={startOver}>Start over</button>
						</div>
					</div>
				{:else}
					<!-- Live quorum progress, straight from the server's PSBT inspection. -->
					<div class="sig-head" role="status" aria-live="polite">
						<h2 class="section-title">Signatures</h2>
						<QuorumArc total={required} collected={collected} active={!complete} size={26} />
						<span class="sig-count">
							{collected} of {required} collected{#if !complete && remainingNeeded > 0}&nbsp;· {remainingNeeded}
								more needed{/if}
						</span>
					</div>

					<!-- Per-key hairline rows (5b): signed / active / queued. -->
					<div class="key-rows">
						{#each config.keys as key, idx (idx)}
							{@const signed = isSigned(idx)}
							{@const active = activeIdx === idx}
							{#if signed}
								<div class="key-row">
									<span class="key-icon" aria-hidden="true">
										<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"></rect><circle cx="10" cy="7" r="2"></circle><path d="M10 9 V12" stroke-linecap="round"></path></svg>
									</span>
									<span class="key-main">
										<span class="key-name">{key.name}</span>
										<span class="key-meta mono">{key.fingerprint}</span>
									</span>
									<span class="key-state signed"
										><Icon name="check" size={13} strokeWidth={2.5} /> Signed</span
									>
								</div>
							{:else}
								<button
									type="button"
									class="key-row selectable"
									class:active
									onclick={() => chooseKey(idx)}
									title={active ? 'Currently signing with this key' : 'Sign with this key instead'}
								>
									<span class="key-icon" aria-hidden="true">
										<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"></rect><circle cx="10" cy="7" r="2"></circle><path d="M10 9 V12" stroke-linecap="round"></path></svg>
									</span>
									<span class="key-main">
										<span class="key-name">{key.name}</span>
										<span class="key-meta mono">{key.fingerprint}</span>
									</span>
									{#if active}
										<span class="key-state pending">Sign below</span>
									{:else}
										<span class="key-cta">Sign now</span>
									{/if}
								</button>
							{/if}
						{/each}
					</div>
					{#if hasPlaceholderFp}
						<p class="never-line">
							Keys without a recorded master fingerprint (00000000) can't be individually ticked
							off — the signature count above is still exact, straight from the transaction
							itself.
						</p>
					{/if}

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
										<strong>First time signing for “{multisigLabel}” on this device? Register the
											multisig wallet on it first.</strong>
										SeedSigner, Passport, and Keystone <em>refuse to sign</em> for a multisig wallet they
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
								<TrezorSigner
									unsignedPsbt={psbt}
									context={signerContext}
									multisig={{
										keyName: activeKey.name,
										multisigName: multisigLabel,
										threshold: config.threshold,
										totalKeys: config.totalKeys,
										scriptType: config.scriptType,
										keys: signKeys
									}}
									onsigned={handleSigned}
									onusefile={() => chooseMethod('file')}
								/>
							{:else if activeMethod === 'ledger'}
								<LedgerSigner
									unsignedPsbt={psbt}
									context={signerContext}
									multisig={{
										keyName: activeKey.name,
										multisigName: multisigLabel,
										threshold: config.threshold,
										totalKeys: config.totalKeys,
										scriptType: config.scriptType,
										keys: signKeys
									}}
									onsigned={handleSigned}
									onusefile={() => chooseMethod('file')}
								/>
							{:else}
								<StatelessFileSigner
									psbtBase64={psbt}
									registration={scan.registration}
									{multisigLabel}
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

						<div class="attention-panel" role="alert">
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
							class="btn btn-primary pill-lg"
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
</div>

<style>
	.stateless-page {
		position: relative;
		/* Bleed the grove field across the shell's content padding so the
		   atmosphere isn't a visible box — same idiom as the send flows. */
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: 100%;
	}

	.page-content {
		position: relative;
		z-index: 1;
		max-width: 680px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	.eyebrow-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
	}

	/* Mobile flow header (8b/8c) — this page composes its own back circle +
	   centered eyebrow + spacer, so the shell's bare fallback is suppressed. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.flow-eyebrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--eyebrow);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.flow-spacer {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
	}

	.lead {
		font-size: 13.5px;
		line-height: 1.6;
	}

	/* ---- phase frame ---- */
	.phase {
		display: flex;
		flex-direction: column;
		gap: 14px;
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
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
	}

	.phase-num.complete {
		background: var(--sage-muted);
		border-color: transparent;
		color: var(--sage);
	}

	.phase-title {
		font-size: 16px;
		font-weight: 600;
		flex: 1;
		color: var(--text);
	}

	.phase-body {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding-left: 34px;
	}

	.phase-summary {
		margin-left: 34px;
	}

	/* ---- Load: ephemeral note + config source ---- */
	.ephemeral-note {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.ephemeral-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.load-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
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

	/* ---- Load: scan result ---- */
	.scan-result {
		display: flex;
		flex-direction: column;
		gap: 12px;
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.multisig-icon {
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
		color: var(--text);
	}

	.balance-block {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.hero-amount {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 44px;
		line-height: 0.96;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
	}

	.hero-amount.sm {
		font-size: 36px;
	}

	.hero-unit {
		font-family: var(--font-serif);
		font-weight: 400;
		font-size: 20px;
		color: var(--eyebrow);
	}

	.test-address {
		display: flex;
		flex-direction: column;
		gap: 6px;
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
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
		padding-top: 6px;
	}

	.addr-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		font-size: 12.5px;
		padding: 7px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.addr-row:last-child {
		border-bottom: none;
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

	/* ---- Build: amount mode toggle + fee toggles (send-flow idioms) ---- */
	.sec-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.mode-toggles {
		display: flex;
		gap: 4px;
	}

	.txt-toggle {
		background: transparent;
		border: none;
		border-radius: 14px;
		padding: 6px 13px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		color: var(--eyebrow-path);
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.txt-toggle:hover {
		color: var(--text-secondary);
	}

	.txt-toggle.active {
		background: rgba(232, 147, 90, 0.1);
		color: var(--accent-bright);
	}

	.toggle-rate {
		font-weight: 400;
	}

	.field-line {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.field-line.attention {
		color: var(--attention);
	}

	.field-line.muted {
		color: var(--text-muted);
	}

	.amount-abs {
		position: relative;
	}

	.amount-abs .input {
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
		border-radius: var(--radius-icon-btn);
		padding: 10px 12px;
		font-size: 13px;
	}

	.fee-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.fee-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.fee-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.custom-fee {
		display: flex;
		align-items: baseline;
		gap: 8px;
		max-width: 180px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 4px;
	}

	.custom-fee-input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 17px;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.unit-sm {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.fee-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
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
		gap: 8px;
		padding-top: 8px;
	}

	.utxo-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
		cursor: pointer;
	}

	.utxo-row:last-child {
		border-bottom: none;
	}

	.utxo-row input {
		accent-color: var(--accent);
		flex-shrink: 0;
	}

	.step-actions {
		justify-content: space-between;
		gap: 10px;
	}

	.pill-lg {
		padding: 13px 26px;
		font-size: 15px;
		border-radius: var(--radius-pill);
	}

	/* ---- Build: review ---- */
	.detail-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		border-top: 1px solid var(--hairline);
	}

	.detail-val {
		color: var(--text-rows);
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
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
	}

	.mass-panel :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}

	.mass-panel strong {
		display: block;
	}

	.mass-panel.amber {
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
	}

	.mass-panel.amber :global(svg) {
		color: var(--attention);
	}

	.mass-panel.red {
		background: var(--error-muted);
		border: 1px solid var(--error-border);
	}

	.mass-panel.red :global(svg) {
		color: var(--error);
	}

	.mass-note {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: var(--text-secondary);
	}

	/* Attention (never red) panels: irreversible-broadcast warning. */
	.attention-panel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
	}

	.attention-panel :global(svg) {
		color: var(--attention);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.attention-panel strong {
		display: block;
	}

	/* ---- Sign: quorum header + per-key hairline rows ---- */
	.sig-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.sig-count {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.key-rows {
		display: flex;
		flex-direction: column;
	}

	.key-rows > :first-child {
		border-top: 1px solid var(--hairline);
	}

	.key-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
	}

	button.key-row.selectable {
		width: 100%;
		background: none;
		border: none;
		border-bottom: 1px solid var(--hairline);
		text-align: left;
		font-family: var(--font-ui);
		cursor: pointer;
		transition: background-color 120ms var(--ease);
	}

	button.key-row.selectable:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.key-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-icon-btn);
		background: var(--surface-elevated);
		color: var(--text-faint);
	}

	.key-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.key-name {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.key-meta {
		font-size: 12px;
		color: var(--text-muted);
	}

	.key-state {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 500;
		flex-shrink: 0;
	}

	.key-state.signed {
		color: var(--accent-bright);
	}

	.key-state.pending {
		color: var(--accent-bright);
	}

	.key-cta {
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		flex-shrink: 0;
	}

	.never-line {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.sign-flash {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--sage);
		background: var(--sage-muted);
		border-radius: var(--radius-icon-btn);
		padding: 10px 12px;
		font-size: 13px;
	}

	/* ---- Sign: method picker (file/QR/Trezor/Ledger) ---- */
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
		background: transparent;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
		padding: 10px 12px;
		cursor: pointer;
		text-align: left;
		font-family: var(--font-ui);
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.method-card:hover {
		border-color: var(--border-ghost);
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
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
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
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
	}

	.reject-actions {
		margin-top: 10px;
	}

	.quorum-done {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--success-muted);
		border-radius: var(--radius-icon-btn);
		padding: 14px 16px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text);
	}

	.quorum-done :global(svg) {
		color: var(--sage);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.session-hint {
		max-width: 340px;
		line-height: 1.5;
	}

	/* ---- Sent: the grove moment ---- */
	.sent-body {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		text-align: center;
		padding: 8px 0;
	}

	.sweep-stage {
		position: relative;
		width: 180px;
		height: 180px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 4px 0;
	}

	/* Two cream ring sweeps — hwSweepOnce plays ONCE (no infinite), staggered.
	   Base opacity 0 keeps them invisible during their delay and after. */
	.sweep {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1.5px solid var(--accent-glow-strong);
		opacity: 0;
		transform: scale(0.18);
		animation: hwSweepOnce 2.4s ease-out forwards;
		pointer-events: none;
	}

	.sweep.s1 {
		animation-delay: 0.2s;
	}

	.sweep.s2 {
		animation-delay: 1s;
	}

	.sent-title {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 32px;
		line-height: 1.1;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
	}

	.sent-sub {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.txid-pill {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
		padding: 9px 16px;
		background: rgba(255, 255, 255, 0.025);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-status-pill);
		color: var(--text-rows);
	}

	.sent-body .hint a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* ---- Mobile (≤900px): flow-page composition ---- */
	@media (max-width: 900px) {
		.stateless-page {
			margin: -20px -18px -48px;
			padding: 16px 18px 48px;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
		}

		.eyebrow-row {
			display: none;
		}

		.phase-body {
			padding-left: 0;
		}

		.phase-summary {
			margin-left: 0;
		}

		.step-actions {
			flex-direction: column-reverse;
			align-items: stretch;
		}

		.step-actions :global(.btn) {
			width: 100%;
			min-height: 46px;
		}

		.sent-title {
			font-size: 26px;
		}
	}

	/* Touch targets: text toggles and selectable key rows are tap targets. */
	@media (max-width: 520px), (pointer: coarse) {
		.txt-toggle {
			min-height: 44px;
			padding: 10px 16px;
		}

		button.key-row.selectable {
			min-height: 44px;
		}

		.utxo-row {
			min-height: 44px;
		}
	}
</style>
