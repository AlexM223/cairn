# Locked out of Cairn?

Cairn is self-hosted and doesn't send email, so there is no "forgot password"
link — and, despite what an older version of this page said, there is also
**no "Admin → Users → Reset password" button anywhere in the admin UI.** The
admin Users page can only enable/disable an account, promote/demote admin
status, delete a user, or (see §1 below) mint a one-time recovery code for a
credential-less restored account
(`src/routes/api/admin/users/+server.ts`). None of those reset an existing
password. Recovery is manual — three paths, from gentlest to nuclear:

## 1. Restored account with no password and no passkey

If your account came from a backup restore, it has no credentials at all
until an admin gives it one. On **Admin → Users**, restored accounts are
flagged "Needs recovery code" — an admin clicks **Mint recovery code** there,
Cairn shows them a single-use code, and they pass it to you to redeem at
`/recover`. This path only works when the account has *neither* a password
nor a passkey; it's refused outright for admin accounts and for anyone who
already has a password or a passkey set (they aren't locked out of
*everything*, just possibly one credential).

## 2. Forgot your password, or every passkey is gone

If you already have a password or passkeys but can't use any of them, the
only way back in is the bundled script, run directly against the database on
the machine that hosts Cairn — there is no admin-UI or in-app equivalent, and
you don't need to already be an admin to run it, just access to the host:

```sh
node scripts/reset-password.mjs you@example.com
```

Running in Docker:

```sh
docker compose exec cairn node scripts/reset-password.mjs you@example.com
```

The script looks for the database at `./data/cairn.db` by default and respects
the `CAIRN_DB` environment variable. If your database lives somewhere else,
point at it explicitly:

```sh
node scripts/reset-password.mjs you@example.com --db /path/to/cairn.db
```

It prints a temporary password **once**, signs out all sessions for that
account, and exits. Sign in with the temporary password and change it right
away. The app can be running or stopped — either is fine.

If you're the sole admin and want to avoid ever needing host access for this,
an operator can opt in *ahead of time* to a break-glass login: set
`CAIRN_ADMIN_RECOVERY=true` and `CAIRN_ADMIN_PASSWORD` (or `APP_PASSWORD`) in
the deployment's environment. While enabled, that password logs in as the
bootstrap admin whenever that account currently has no usable passkeys — it
never applies to any other account. This has to be configured *before* you're
locked out; it isn't something you can turn on from within the app once
you're stuck.

## 3. Nuclear: start over

If all else fails, stop the app and delete the database file (`data/cairn.db`,
plus its `-wal` and `-shm` siblings if present). On next start, Cairn returns
to first-run setup and the first account created becomes the administrator.

Everything is lost: users, wallets, invites, settings. But note what *isn't*
lost — Cairn wallets are watch-only (xpubs, no private keys), so **no funds are
at risk**. Re-adding a wallet is just pasting the xpub back in.
