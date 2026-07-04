<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import { isWebHidAvailable } from '$lib/hw/ledger';
	import type { ConstructedPsbt } from '$lib/server/bitcoin/psbt';
	import type { SavedTransaction } from '$lib/server/transactions';
	import DeviceCard from './_components/DeviceCard.svelte';
	import ColdCardSigner from './_components/ColdCardSigner.svelte';
	import LedgerSigner from './_components/LedgerSigner.svelte';
	import QrSigner from './_components/QrSigner.svelte';
	import type { DeviceMethod, SignerContext } from './_components/signerContract';

	let { data } = $props();

	type StepKey = 'create' | 'review' | 'sign' | 'confirm' | 'sent';

	const STEPS: { key: StepKey; label: string }[] = [
		{ key: 'create', label: 'Create' },
		{ key: 'review', label: 'Review' },
		{ key: 'sign', label: 'Sign' },
		{ key: 'confirm', label: 'Confirm' },
		{ key: 'sent', label: 'Sent' }
	];

	const SATS_PER_BTC = 100_000_000;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const walletId = data.wallet.id;

	// The saved row load guarantees resume.transaction is non-null (it 404s
	// otherwise), but its inferred type still admits null — pin it here. Load
	// data is a per-navigation snapshot; a resume re-runs this component.
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeTx: SavedTransaction | null = data.resume?.transaction ?? null;
	// svelte-ignore state_referenced_locally — per-navigation constant
	const resumeComplete = data.resume?.summary?.complete ?? false;

	// --- resume: derive the starting step from the saved row's lifecycle ------
	function initialStep(): StepKey {
		if (!resumeTx) return 'create';
		if (resumeTx.status === 'completed') return 'sent';
		if (resumeTx.status === 'awaiting_signature') {
			// Signed enough to broadcast? jump to Confirm, else stay on Sign.
			return resumeComplete ? 'confirm' : 'sign';
		}
		return 'review'; // draft
	}

	// svelte-ignore state_referenced_locally — intentional per-load seed
	let step = $state<StepKey>(initialStep());

	// The in-flight draft: the server row is the source of truth. `draft` holds
	// the saved transaction row; `details` holds the rich ConstructedPsbt from
	// the build response (only present when built this session — on resume we
	// reconstruct a display shape from the saved row + summary).
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let draft = $state<SavedTransaction | null>(resumeTx);
	let details = $state<ConstructedPsbt | null>(null);
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let signedComplete = $state<boolean>(resumeComplete);

	// Rebuild a review shape when resuming without a fresh build. The saved row
	// carries recipient/amount/fee/feeRate; UTXO inputs + change aren't stored,
	// so those areas note that detail is available after a rebuild.
	const review = $derived.by<ConstructedPsbt | null>(() => {
		if (details) return details;
		if (!draft) return null;
		return {
			psbtBase64: draft.psbt,
			fee: draft.fee,
			feeRate: draft.feeRate,
			vsize: draft.fee && draft.feeRate ? Math.round(draft.fee / draft.feeRate) : 0,
			amount: draft.amount,
			recipient: draft.recipient,
			change: null,
			inputs: []
		};
	});

	// Keep ?tx= in the URL in sync so a reload resumes the same draft.
	function syncTxParam(id: number) {
		try {
			const url = new URL(window.location.href);
			if (url.searchParams.get('tx') === String(id)) return;
			url.searchParams.set('tx', String(id));
			replaceState(url, {});
		} catch {
			/* pre-hydration or blocked — the in-memory draft still drives the flow */
		}
	}

	// ------------------------------------------------------------- CREATE step
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let recipient = $state(resumeTx?.recipient ?? '');
	let amountMode = $state<'btc' | 'max'>('btc');
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let amountBtc = $state(
		resumeTx && resumeTx.amount > 0 ? formatBtc(resumeTx.amount, { trim: true }) : ''
	);

	type FeeChoice = 'fast' | 'normal' | 'economy' | 'custom';
	let feeChoice = $state<FeeChoice>('normal');
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let customFee = $state(String(data.fees?.halfHour ?? 5));

	const feeRate = $derived.by(() => {
		const fallback = Number(customFee) || 1;
		if (feeChoice === 'fast') return data.fees?.fastest ?? fallback;
		if (feeChoice === 'normal') return data.fees?.halfHour ?? fallback;
		if (feeChoice === 'economy') return data.fees?.economy ?? fallback;
		return Math.max(1, fallback);
	});

	// Basic client-side shape check — the server does authoritative validation.
	const recipientLooksValid = $derived(
		/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{6,90}$/.test(recipient.trim())
	);
	const amountValid = $derived(
		amountMode === 'max' || (Number(amountBtc) > 0 && Number.isFinite(Number(amountBtc)))
	);
	const canBuild = $derived(
		recipient.trim().length > 0 && recipientLooksValid && amountValid && feeRate >= 1
	);

	let building = $state(false);
	let buildError = $state<string | null>(null);

	async function build() {
		if (!canBuild || building) return;
		building = true;
		buildError = null;
		const amount: number | 'max' =
			amountMode === 'max' ? 'max' : Math.round(Number(amountBtc) * SATS_PER_BTC);
		try {
			const res = await fetch(`/api/wallets/${walletId}/psbt`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ recipient: recipient.trim(), amount, feeRate })
			});
			const body = await res.json();
			if (!res.ok) {
				buildError = body.error ?? 'Could not build the transaction.';
				return;
			}
			draft = body.draft as SavedTransaction;
			details = body.details as ConstructedPsbt;
			signedComplete = false;
			syncTxParam(draft.id);
			step = 'review';
		} catch {
			buildError = 'Could not reach Cairn to build the transaction.';
		} finally {
			building = false;
		}
	}

	// ------------------------------------------------------------- REVIEW step
	let inputsOpen = $state(false);

	const feePctOfAmount = $derived.by(() => {
		if (!review || review.amount <= 0) return null;
		return (review.fee / review.amount) * 100;
	});

	// ------------------------------------------------------------- SIGN step
	let signedPsbtText = $state('');
	let attaching = $state(false);
	let signError = $state<string | null>(null);

	async function readFileAsBase64(file: File): Promise<string> {
		const buf = new Uint8Array(await file.arrayBuffer());
		// A raw binary .psbt file starts with the magic bytes "psbt\xff"
		// (0x70 0x73 0x62 0x74 0xff). Base64-encode those. Anything else is
		// treated as text (the base64/hex a user exported and saved).
		const isBinary =
			buf[0] === 0x70 && buf[1] === 0x73 && buf[2] === 0x62 && buf[3] === 0x74 && buf[4] === 0xff;
		if (isBinary) {
			let bin = '';
			for (const b of buf) bin += String.fromCharCode(b);
			return btoa(bin);
		}
		return new TextDecoder().decode(buf).trim();
	}

	async function onSignedFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			signedPsbtText = await readFileAsBase64(file);
			await attachSigned();
		} catch {
			signError = 'Could not read that file.';
		}
	}

	// Central attach path: EVERY signing method — the generic file card and each
	// device signer — funnels its signed PSBT through this PATCH, where the
	// server-side substitution guard verifies the signatures commit to the same
	// transaction the user reviewed before the flow may advance to Confirm.
	async function attachSignedPsbt(psbt: string) {
		if (!psbt || attaching || !draft) return;
		attaching = true;
		signError = null;
		try {
			const patch = await fetch(`/api/wallets/${walletId}/transactions/${draft.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ psbt })
			});
			const patchBody = await patch.json();
			if (!patch.ok) {
				signError = patchBody.error ?? 'That PSBT could not be attached.';
				return;
			}
			draft = patchBody.transaction as SavedTransaction;

			// Confirm signatures are actually present before letting Confirm open —
			// the PATCH response summarizes the PSBT it just stored.
			const complete = Boolean(patchBody?.summary?.complete);
			signedComplete = complete;
			if (complete) {
				step = 'confirm';
			} else {
				signError =
					'This PSBT was attached but still is not fully signed. Sign it with your wallet and upload it again.';
			}
		} catch {
			signError = 'Could not reach Cairn to attach the signed transaction.';
		} finally {
			attaching = false;
		}
	}

	async function attachSigned() {
		await attachSignedPsbt(signedPsbtText.trim());
	}

	// ------------------------------------------------------------ CONFIRM step
	let broadcasting = $state(false);
	let broadcastError = $state<string | null>(null);
	let broadcastRejected = $state(false);
	// svelte-ignore state_referenced_locally — intentional per-load seed
	let sentTxid = $state<string | null>(resumeTx?.txid ?? null);

	async function broadcast() {
		if (broadcasting || !draft) return;
		broadcasting = true; // disabled immediately — no double-broadcast
		broadcastError = null;
		broadcastRejected = false;
		try {
			const res = await fetch(`/api/wallets/${walletId}/transactions/${draft.id}/broadcast`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const body = await res.json();
			if (res.status === 409) {
				// Already sent — recover the txid if we can and jump to Sent.
				sentTxid = body?.transaction?.txid ?? sentTxid;
				step = 'sent';
				return;
			}
			if (!res.ok) {
				broadcastError = body.error ?? 'Broadcast failed.';
				broadcastRejected = body.code === 'rejected';
				return;
			}
			sentTxid = body.txid as string;
			draft = body.transaction as SavedTransaction;
			step = 'sent';
		} catch {
			broadcastError = 'Could not reach Cairn to broadcast.';
		} finally {
			broadcasting = false;
		}
	}

	// -------------------------------------------------------------- navigation
	// Forward navigation is gated: you can only move to a step whose prereq is
	// met. Backward navigation to Create (to edit) is always allowed while the
	// draft is unsigned/unsent.
	function goCreate() {
		if (step === 'sent') return;
		step = 'create';
	}

	const fileUrl = $derived(
		draft ? `/api/wallets/${walletId}/transactions/${draft.id}/file` : '#'
	);
	const explorerUrl = $derived(sentTxid ? `/explorer/tx/${sentTxid}` : '#');

	// ---------------------------------------------------- Sign: method selection
	// One signing method is active (expanded) at a time; the rest collapse to
	// selectable tiles. `null` = nothing chosen yet (pure method selection).
	type SignMethod = 'file' | 'ledger' | 'coldcard' | 'qr';
	let activeMethod = $state<SignMethod | null>(null);
	// Bumped to remount the active signer from scratch — a clean retry after the
	// server-side guard rejects what a device returned.
	let signerEpoch = $state(0);

	// Availability is probed client-side only (navigator.* does not exist during
	// SSR) — start pessimistic and re-check after mount, like the signers do.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// The device signer methods, gated per the DeviceMethod contract. The generic
	// file card is handled separately (it is always available and hosts its own
	// upload/paste UI); Trezor stays a disabled "coming soon" tile for now.
	const deviceMethods: (DeviceMethod & {
		key: Exclude<SignMethod, 'file'>;
		icon: string;
		unavailableReason: string;
	})[] = [
		{
			key: 'ledger',
			name: 'Ledger',
			blurb: 'Sign on-device over USB (WebHID) — nothing leaves the device but signatures',
			icon: 'shield',
			available: () => isWebHidAvailable(),
			unavailableReason:
				'Needs WebHID, which is only in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost.'
		},
		{
			key: 'coldcard',
			name: 'ColdCard (microSD)',
			blurb: 'Air-gapped signing over a microSD card — no cable, no connection',
			icon: 'shield',
			// Pure file round-trip: works in any browser that can download + upload.
			available: () => true,
			unavailableReason: ''
		},
		{
			key: 'qr',
			name: 'Animated QR (SeedSigner, Passport, Jade)',
			blurb: 'Air-gapped signing over the camera — QR codes cross the gap in both directions',
			icon: 'qr',
			// Displaying the unsigned QR always works; the signer itself falls back
			// to a paste box when the browser can't camera-scan the signature back.
			available: () => true,
			unavailableReason: ''
		}
	];

	// Only one Svelte component per method key — the {#each} below picks from here.
	const SIGNER_COMPONENTS = {
		ledger: LedgerSigner,
		coldcard: ColdCardSigner,
		qr: QrSigner
	} as const;

	function selectMethod(m: SignMethod) {
		activeMethod = m;
		signError = null;
		signerEpoch += 1;
	}

	function collapseMethod() {
		activeMethod = null;
		signError = null;
	}

	// Every signer hands its result here → same substitution-guard PATCH as the
	// generic file method, then the stepper advances identically.
	function handleDeviceSigned(signedPsbtBase64: string) {
		void attachSignedPsbt(signedPsbtBase64.trim());
	}

	// The PSBT the signers consume: the server row is the source of truth (it is
	// refreshed by every successful attach), with the build response as fallback.
	const unsignedPsbt = $derived(draft?.psbt ?? details?.psbtBase64 ?? '');

	// Human-readable context so each signer can tell the user what to verify on
	// the device screen. Null until a draft + review exist (i.e. before build).
	const signerContext = $derived.by<SignerContext | null>(() => {
		if (!draft || !review) return null;
		return {
			walletId,
			draftId: draft.id,
			scriptType: data.wallet.scriptType,
			destinationAddress: review.recipient,
			amountSats: review.amount,
			feeSats: review.fee,
			changeSats: review.change?.value ?? 0
		};
	});
</script>

<svelte:head>
	<title>Send · {data.wallet.name} · Cairn</title>
</svelte:head>

<div class="send-page">
	<header class="page-head">
		<a class="back" href={`/wallets/${walletId}`}>
			<Icon name="chevron-left" size={15} />
			<span>{data.wallet.name}</span>
		</a>
		<h1 class="page-title">Send bitcoin</h1>
	</header>

	<div class="stepper-wrap card card-pad">
		<Stepper steps={STEPS} current={step} />
	</div>

	<!-- ============================================================ CREATE -->
	{#if step === 'create'}
		<section class="step-body fade-in">
			<HowItWorks id="send-psbt">
				<p>
					Cairn builds an <Term
						tip="A Partially Signed Bitcoin Transaction — an unsigned proposal your hardware wallet reviews and signs. Your private keys never touch Cairn's server."
						>unsigned transaction (a PSBT)</Term
					> — a proposal describing exactly what will be sent. You take it to your hardware
					wallet or signing app, which reviews it and adds your signature.
				</p>
				<p>
					<strong>Your keys never touch Cairn.</strong> Cairn is watch-only: it can build and
					broadcast, but only your device can authorize the spend.
				</p>
			</HowItWorks>

			{#if data.scanError}
				<div class="form-error" role="alert">
					Couldn't reach your node to load spendable coins: {data.scanError}
				</div>
			{/if}

			<div class="card card-pad stack" style="gap: 18px">
				<div class="field">
					<label class="label" for="recipient">Recipient address</label>
					<input
						id="recipient"
						class="input mono"
						placeholder="bc1q…"
						bind:value={recipient}
						autocomplete="off"
						spellcheck="false"
						aria-invalid={recipient.length > 0 && !recipientLooksValid}
					/>
					{#if recipient.length > 0 && !recipientLooksValid}
						<p class="hint" style="color: var(--warning)">
							That doesn't look like a Bitcoin address yet.
						</p>
					{/if}
				</div>

				<div class="field">
					<div class="row amount-head">
						<span class="label" id="amount-label">Amount</span>
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
					{#if amountMode === 'btc'}
						<div class="amount-input">
							<input
								class="input tabular"
								inputmode="decimal"
								placeholder="0.00000000"
								bind:value={amountBtc}
								aria-labelledby="amount-label"
							/>
							<span class="unit">BTC</span>
						</div>
						{#if Number(amountBtc) > 0}
							<p class="hint tabular">
								{formatSats(Math.round(Number(amountBtc) * SATS_PER_BTC))} sats
							</p>
						{/if}
					{:else}
						<div class="max-note">
							<Icon name="zap" size={15} />
							<span>Sweeps the entire spendable balance to this address, minus the fee.</span>
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
						<p class="hint">
							Live fee estimates are unavailable — set a custom sat/vB rate.
						</p>
					{/if}
				</div>

				{#if buildError}
					<div class="form-error" role="alert">{buildError}</div>
				{/if}

				<div class="row" style="justify-content: flex-end; gap: 10px">
					<a class="btn btn-ghost" href={`/wallets/${walletId}`}>Cancel</a>
					<button class="btn btn-primary" onclick={build} disabled={!canBuild || building}>
						{#if building}<span class="spinner"></span> Building…{:else}Review transaction<Icon
								name="arrow-right"
								size={15}
							/>{/if}
					</button>
				</div>
			</div>
		</section>

	<!-- ============================================================ REVIEW -->
	{:else if step === 'review' && review}
		<section class="step-body fade-in">
			<p class="step-lead">
				Check every detail. Once you sign and broadcast, this transaction
				<strong>cannot be reversed.</strong>
			</p>

			<div class="card review-hero">
				<div class="review-line">
					<span class="overline">Sending</span>
					<span class="hero-number send-amount">{formatBtc(review.amount)} <em>BTC</em></span>
					<span class="text-muted tabular">{formatSats(review.amount)} sats</span>
				</div>
				<div class="review-arrow"><Icon name="arrow-down-left" size={20} /></div>
				<div class="review-line">
					<span class="overline">To recipient</span>
					<span class="recipient mono">{review.recipient}</span>
				</div>
			</div>

			<div class="card card-pad detail-list">
				<div class="detail-row">
					<span class="text-secondary">Network fee</span>
					<span class="detail-val tabular">
						{formatSats(review.fee)} sats
						<span class="text-muted"
							>· {formatFeeRate(review.feeRate)}{#if feePctOfAmount != null}
								· {feePctOfAmount < 0.01 ? '<0.01' : feePctOfAmount.toFixed(2)}% of amount{/if}</span
						>
					</span>
				</div>
				{#if review.change}
					<div class="detail-row">
						<span class="text-secondary">Change back to your wallet</span>
						<span class="detail-val tabular">{formatSats(review.change.value)} sats</span>
					</div>
				{/if}
				{#if review.inputs.length > 0}
					{@const totalIn = review.inputs.reduce((s, i) => s + i.value, 0)}
					<div class="detail-row">
						<span class="text-secondary">Total input</span>
						<span class="detail-val tabular">{formatSats(totalIn)} sats</span>
					</div>
					<button class="utxo-toggle" onclick={() => (inputsOpen = !inputsOpen)}>
						<Icon name={inputsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
						<span
							>Coins being spent ({review.inputs.length}
							{review.inputs.length === 1 ? 'input' : 'inputs'})</span
						>
					</button>
					{#if inputsOpen}
						<div class="utxo-list fade-in">
							{#each review.inputs as inp (inp.txid + inp.vout)}
								<div class="utxo-row">
									<span class="mono text-muted">{truncateMiddle(inp.txid, 10, 8)}:{inp.vout}</span>
									<span class="tabular">{formatSats(inp.value)} sats</span>
								</div>
							{/each}
						</div>
					{/if}
				{:else}
					<p class="hint">
						Input details load after building this session — resume from Create to see the exact
						coins.
					</p>
				{/if}
			</div>

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={goCreate}>
					<Icon name="chevron-left" size={15} /> Back &amp; edit
				</button>
				<button class="btn btn-primary" onclick={() => (step = 'sign')}>
					Looks good — sign <Icon name="arrow-right" size={15} />
				</button>
			</div>
		</section>

	<!-- ============================================================== SIGN -->
	{:else if step === 'sign'}
		<section class="step-body fade-in">
			<div class="key-frame">
				<span class="badge badge-accent">Key 1 of 1</span>
				<span class="text-secondary">Sign this transaction with your wallet</span>
			</div>

			<HowItWorks id="send-sign">
				<p>
					Signing happens <strong>on your device</strong>, never here. Pick how your signer receives
					the unsigned transaction — USB, a microSD card, QR codes, or a plain file — then review
					the amount and address <em>on the device screen</em> and approve. Cairn verifies that
					every returned signature commits to the exact transaction you reviewed before it can be
					broadcast.
				</p>
			</HowItWorks>

			<div class="method-grid">
				<!-- Generic / file method: always available, hosts its own upload UI. -->
				{#if activeMethod === 'file'}
					<div class="card card-pad method-active">
						<div class="method-head">
							<span class="method-icon"><Icon name="wallet" size={18} /></span>
							<div>
								<h3 class="method-title">Generic wallet / file</h3>
								<p class="method-sub">Sparrow, ColdCard, Electrum, BlueWallet, or any PSBT-capable signer</p>
							</div>
						</div>

						<ol class="sign-steps">
							<li>
								<div class="sign-step-body">
									<span class="sign-step-title">Download the unsigned PSBT</span>
									<a class="btn btn-secondary btn-sm" href={fileUrl} download>
										<Icon name="arrow-down-left" size={14} /> Download .psbt
									</a>
								</div>
							</li>
							<li>
								<div class="sign-step-body">
									<span class="sign-step-title">Sign it in your wallet</span>
									<span class="hint">
										Open the file in Sparrow / ColdCard / Electrum, verify the recipient and amount on
										the device, and export the signed PSBT.
									</span>
								</div>
							</li>
							<li>
								<div class="sign-step-body">
									<span class="sign-step-title">Bring the signed PSBT back</span>
									<label class="file-drop">
										<input type="file" accept=".psbt,.txt,text/plain,application/octet-stream" onchange={onSignedFile} />
										<Icon name="arrow-up-right" size={15} />
										<span>Upload signed .psbt file</span>
									</label>
									<div class="or-divider"><span>or paste base64 / hex</span></div>
									<textarea
										class="input mono"
										rows="3"
										placeholder="cHNidP8BA…"
										bind:value={signedPsbtText}
									></textarea>
									{#if signError}
										<div class="form-error" role="alert">{signError}</div>
									{/if}
									<button
										class="btn btn-primary"
										onclick={attachSigned}
										disabled={attaching || signedPsbtText.trim().length === 0}
									>
										{#if attaching}<span class="spinner"></span> Checking signatures…{:else}Attach signed transaction{/if}
									</button>
								</div>
							</li>
						</ol>

						<div class="method-foot">
							<button type="button" class="btn btn-ghost btn-sm" onclick={collapseMethod}>
								<Icon name="x" size={14} /> Use a different method
							</button>
						</div>
					</div>
				{:else}
					<DeviceCard
						name="Generic wallet / file"
						hint="Sparrow, Electrum, BlueWallet, or any PSBT-capable signer — download, sign, upload"
						icon="wallet"
						disabled={false}
						onselect={() => selectMethod('file')}
					/>
				{/if}

				<!-- Device signers: selecting one mounts its component; the guard-side
				     attach path is shared with the file method via handleDeviceSigned. -->
				{#each deviceMethods as m (m.key)}
					{#if activeMethod === m.key && signerContext}
						{#key signerEpoch}
							{@const Signer = SIGNER_COMPONENTS[m.key]}
							<Signer
								{unsignedPsbt}
								context={signerContext}
								onsigned={handleDeviceSigned}
								oncancel={collapseMethod}
							/>
						{/key}
					{:else}
						<DeviceCard
							name={m.name}
							hint={m.blurb}
							icon={m.icon}
							disabled={!mounted || !m.available()}
							badge="Unavailable"
							reason={mounted && !m.available() ? m.unavailableReason : undefined}
							onselect={() => selectMethod(m.key)}
						/>
					{/if}
				{/each}

				<!-- Trezor is still a seam — its live card lands with the Trezor bead. -->
				<DeviceCard name="Trezor" hint="USB signing" />
			</div>

			<!-- Shared attach status for device signers: the components report their
			     own device errors, but the substitution-guard verdict lives here. -->
			{#if activeMethod !== null && activeMethod !== 'file'}
				{#if attaching}
					<div class="attach-status" role="status">
						<span class="spinner"></span> Checking signatures against the transaction you reviewed…
					</div>
				{:else if signError}
					<div class="form-error" role="alert">
						{signError}
						<div class="reject-actions">
							<button class="btn btn-secondary btn-sm" onclick={() => selectMethod(activeMethod!)}>
								<Icon name="refresh" size={14} /> Try again
							</button>
							<button class="btn btn-ghost btn-sm" onclick={collapseMethod}>
								Choose another method
							</button>
						</div>
					</div>
				{/if}
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'review')}>
					<Icon name="chevron-left" size={15} /> Back to review
				</button>
			</div>
		</section>

	<!-- =========================================================== CONFIRM -->
	{:else if step === 'confirm' && review}
		<section class="step-body fade-in">
			<div class="confirm-warning" role="alert">
				<Icon name="alert-triangle" size={18} />
				<div>
					<strong>You are about to broadcast this transaction.</strong>
					Broadcasting is <em>irreversible</em> — once the network accepts it, the coins are gone.
				</div>
			</div>

			<div class="card card-pad confirm-summary">
				<div class="confirm-row">
					<span class="text-secondary">Sending</span>
					<span class="detail-val tabular">{formatBtc(review.amount)} BTC</span>
				</div>
				<div class="confirm-row">
					<span class="text-secondary">To</span>
					<span class="mono confirm-recipient">{review.recipient}</span>
				</div>
				<div class="confirm-row">
					<span class="text-secondary">Fee</span>
					<span class="detail-val tabular"
						>{formatSats(review.fee)} sats · {formatFeeRate(review.feeRate)}</span
					>
				</div>
			</div>

			{#if broadcastError}
				<div class="form-error" role="alert">
					{broadcastError}
					{#if broadcastRejected || draft}
						<div class="reject-actions">
							<a class="btn btn-secondary btn-sm" href={fileUrl} download>
								<Icon name="arrow-down-left" size={14} /> Download PSBT
							</a>
							<button class="btn btn-ghost btn-sm" onclick={() => (step = 'sign')}>
								Re-sign
							</button>
						</div>
					{/if}
				</div>
			{/if}

			<div class="row step-actions">
				<button class="btn btn-secondary" onclick={() => (step = 'sign')} disabled={broadcasting}>
					<Icon name="chevron-left" size={15} /> Back
				</button>
				<button class="btn btn-primary" onclick={broadcast} disabled={broadcasting}>
					{#if broadcasting}<span class="spinner"></span> Broadcasting…{:else}<Icon
							name="zap"
							size={15}
						/> Broadcast transaction{/if}
				</button>
			</div>
		</section>

	<!-- ============================================================== SENT -->
	{:else if step === 'sent'}
		<section class="step-body fade-in sent-body">
			<div class="sent-check">
				<Icon name="check" size={30} strokeWidth={2.5} />
			</div>
			<h2 class="sent-title">Broadcast!</h2>
			<p class="text-secondary">Your transaction is on its way to the network.</p>

			{#if sentTxid}
				<a class="sent-txid mono" href={explorerUrl}>
					{truncateMiddle(sentTxid, 12, 12)}
					<Icon name="arrow-up-right" size={15} />
				</a>
				<div class="sent-copy"><CopyText value={sentTxid} display="Copy transaction ID" mono={false} /></div>
			{/if}

			{#if review}
				<div class="card card-pad sent-summary">
					<div class="confirm-row">
						<span class="text-secondary">Sent</span>
						<span class="detail-val tabular">{formatBtc(review.amount)} BTC</span>
					</div>
					<div class="confirm-row">
						<span class="text-secondary">To</span>
						<span class="mono confirm-recipient">{truncateMiddle(review.recipient, 14, 12)}</span>
					</div>
					<div class="confirm-row">
						<span class="text-secondary">Fee</span>
						<span class="detail-val tabular">{formatSats(review.fee)} sats</span>
					</div>
				</div>
			{/if}

			<div class="row step-actions" style="justify-content: center">
				<a class="btn btn-secondary" href={`/wallets/${walletId}`}>Back to wallet</a>
				<a class="btn btn-primary" href={`/wallets/${walletId}/send`} data-sveltekit-reload
					>Send another</a
				>
			</div>
		</section>
	{/if}
</div>

<style>
	.send-page {
		max-width: 680px;
		margin: 0 auto;
	}

	.page-head {
		margin-bottom: 18px;
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

	.stepper-wrap {
		padding: 22px 24px;
		margin-bottom: 24px;
	}

	.step-body {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.step-lead {
		font-size: 14px;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.step-lead strong {
		color: var(--text);
	}

	.step-actions {
		justify-content: space-between;
		gap: 10px;
	}

	/* ---- Create: amount + fee ---- */
	.amount-head {
		justify-content: space-between;
	}

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
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
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
		font-family: var(--font-serif);
		font-variation-settings: 'opsz' 40;
	}

	.amount-input .unit {
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
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
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

	/* ---- Review ---- */
	.review-hero {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		text-align: center;
	}

	.review-line {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		width: 100%;
		min-width: 0;
	}

	.send-amount {
		font-size: 34px;
	}

	.send-amount em {
		font-style: normal;
		font-size: 0.5em;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.review-arrow {
		color: var(--text-muted);
	}

	.recipient {
		font-size: 13.5px;
		word-break: break-all;
		max-width: 100%;
		color: var(--text);
		background: var(--bg);
		padding: 8px 12px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border-subtle);
	}

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
		padding: 11px 0;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 13.5px;
	}

	.detail-row:first-child {
		padding-top: 0;
	}

	.detail-val {
		color: var(--text);
		font-weight: 500;
		text-align: right;
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
		padding: 11px 0 0;
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
		justify-content: space-between;
		gap: 10px;
		font-size: 12.5px;
		padding: 7px 10px;
		background: var(--bg);
		border-radius: var(--radius-chip);
	}

	/* ---- Sign ---- */
	.key-frame {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
	}

	.method-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 12px;
	}

	.method-active {
		border-color: var(--border);
	}

	.method-head {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 16px;
	}

	.method-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-control);
		background: var(--accent-muted);
		color: var(--accent);
	}

	.method-title {
		font-size: 15px;
		font-weight: 600;
	}

	.method-sub {
		font-size: 12.5px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.sign-steps {
		list-style: none;
		counter-reset: sign;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sign-steps li {
		counter-increment: sign;
		display: flex;
		gap: 12px;
	}

	.sign-steps li::before {
		content: counter(sign);
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sign-step-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		flex: 1;
	}

	.sign-step-title {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text);
	}

	.file-drop {
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-control);
		padding: 12px;
		color: var(--text-secondary);
		font-size: 13px;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.file-drop:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.file-drop input {
		display: none;
	}

	.or-divider {
		display: flex;
		align-items: center;
		text-align: center;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.or-divider::before,
	.or-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
	}

	.or-divider span {
		padding: 0 10px;
	}

	.method-foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.attach-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 12px 14px;
	}

	/* ---- Confirm ---- */
	.confirm-warning {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-card);
		padding: 14px 16px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text);
	}

	.confirm-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.confirm-warning strong {
		display: block;
	}

	.confirm-summary,
	.sent-summary {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.confirm-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
		font-size: 13.5px;
	}

	.confirm-recipient {
		word-break: break-all;
		text-align: right;
		max-width: 70%;
	}

	.reject-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	/* ---- Sent ---- */
	.sent-body {
		align-items: center;
		text-align: center;
		padding-top: 12px;
	}

	.sent-check {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		background: var(--success-muted);
		color: var(--success);
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 4px;
	}

	.sent-title {
		font-family: var(--font-serif);
		font-variation-settings: 'opsz' 48;
		font-size: 26px;
		font-weight: 560;
	}

	.sent-txid {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		padding: 10px 16px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.sent-copy {
		font-size: 12.5px;
	}

	.sent-summary {
		width: 100%;
		text-align: left;
		margin-top: 8px;
	}

	@media (max-width: 520px) {
		.fee-grid {
			grid-template-columns: 1fr;
		}

		.send-amount {
			font-size: 28px;
		}

		.confirm-recipient {
			max-width: 60%;
		}
	}
</style>
