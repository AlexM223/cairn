# Disclaimer

Cairn is self-hosted software for watching Bitcoin wallets and building transactions. Read this before you use it or run it for others. Plain language, no fine print — these are the things that can actually cost you money or funds.

## No custody

Cairn never holds your private keys or your bitcoin. Your keys stay on your own devices — hardware wallets, signing apps, seed backups you control. Cairn stores only public keys (xpubs) and wallet configuration, so it can show balances and help you assemble transactions. It cannot spend, freeze, move, or recover funds, and neither can whoever runs the instance you use.

## No warranty

Cairn is free, open-source software under the [MIT License](./LICENSE). It is provided "as is", without warranty of any kind. There is no guarantee it will be available, correct, secure, or fit for any purpose. You use it at your own risk. The Cairn project and its contributors are not liable for any loss arising from its use.

## Transactions are irreversible

Once a transaction is signed and broadcast, it cannot be undone, cancelled, or refunded. Before you approve a send:

- **Verify the destination address on your signing device**, not just on screen.
- **Verify the amount.** A single wrong digit is permanent.
- **Verify the fee.** Overpaying is your loss; underpaying can strand a transaction.

Bitcoin has no support line and no chargebacks. There is no one to reverse a mistake.

## Your keys and backups are your responsibility

Cairn is watch-only. The server holds nothing that can spend, which means recovering your funds depends entirely on backups only you have:

- Your **seed phrase(s)** for every wallet.
- For a **multisig** wallet: **every public key (xpub) and the wallet descriptor.** Missing even one, or the descriptor, can make funds unrecoverable even when you still hold the seeds.
- The **backup files Cairn lets you download.** Save them somewhere safe and durable.

If you lose your keys or backups — or if the instance you use disappears and you kept no backup of your own — your funds may be permanently lost. No one can restore them for you.

## Operator responsibility

Anyone can run a Cairn instance. Whoever runs the one you use — the **operator** — is responsible for that server: keeping it running, securing it, backing up its data, its uptime, and any terms they set with their users. The operator is providing infrastructure, not custody and not a financial service.

**The Cairn project is not the operator of your instance.** We do not run your server, hold your data, or have any relationship with its users. If you operate an instance, that responsibility is yours; if you use someone else's, those obligations are theirs, not the Cairn project's.

## No financial advice

Cairn is a tool, not advisor. Nothing in it or in this document is investment, financial, legal, or tax advice.

## Privacy

Cairn is built to keep your data on the server you (or your operator) control. It does not use analytics or third-party trackers.

**Stored locally on the instance's server:**

- Your account (email or passkey credentials).
- Wallet public keys (xpubs) and multisig descriptors.
- Labels, saved recipients, transaction drafts (PSBTs), and balance snapshots.
- **Never private keys, seed phrases, or anything that can spend.**

**What leaves the server:**

- **Address and transaction lookups** go to the chain backends the operator configures — by default an Electrum server (`electrum.blockstream.info`) and a block explorer / Esplora API (`mempool.space`). These see the addresses and transactions you query and broadcast. An operator running their own nodes keeps even this in-house.
- **Fiat price** is fetched only if you turn it on. It is **off by default**; while off, no price service is contacted. When enabled, the current BTC price is fetched through the operator's configured explorer (falling back to the public mempool.space).

That is the whole picture. If any of it is unacceptable for your situation, do not use Cairn — or run your own instance against your own Bitcoin node so nothing leaves your control.
