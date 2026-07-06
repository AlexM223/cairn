# Locked out of Cairn?

Cairn is self-hosted and doesn't send email, so there is no "forgot password"
link. Recovery is manual — but it's quick. Three paths, from gentlest to
nuclear:

## 1. Another admin resets your password

If your instance has more than one administrator, any of them can help:

**Admin → Users → Reset password** on your row. Cairn generates a temporary
password and shows it to them once. They pass it to you, you sign in, and you
change it in Settings. All your old sessions are signed out as part of the
reset.

## 2. Sole admin, locked out: use the CLI script

If you *are* the only admin, reset your password directly against the database
file with the bundled script. Run it on the machine that hosts Cairn:

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

## 3. Nuclear: start over

If all else fails, stop the app and delete the database file (`data/cairn.db`,
plus its `-wal` and `-shm` siblings if present). On next start, Cairn returns
to first-run setup and the first account created becomes the administrator.

Everything is lost: users, wallets, invites, settings. But note what *isn't*
lost — Cairn wallets are watch-only (xpubs, no private keys), so **no funds are
at risk**. Re-adding a wallet is just pasting the xpub back in.
