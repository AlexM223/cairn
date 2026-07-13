# ---- build stage ----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Toolchain for node-gyp: the `usb` native addon is a HARD transitive dependency
# of @trezor/connect-web, so `npm ci` must build it — even though Cairn only ever
# uses Trezor Connect client-side (browser popup) and never loads `usb` on the
# server. These tools live only in this (discarded) build stage; the runtime
# image below stays lean.
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# Pin cairn to UID/GID 1000 (replacing the base image's `node` user, which owns
# those IDs): Umbrel bind-mounts app data owned by 1000:1000 and runs services
# as `user: "1000:1000"`, so the in-image user must match for /data to be
# writable there.
RUN deluser node \
	&& addgroup -S -g 1000 cairn \
	&& adduser -S -u 1000 -G cairn cairn

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Custom entry: adapter-node's handler on HTTP plus the optional self-signed
# HTTPS listener (cairn-wgr8 — secure context for hardware signing on Umbrel).
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/scripts/tls-cert.mjs ./scripts/tls-cert.mjs
COPY --from=build /app/scripts/serverProto.mjs ./scripts/serverProto.mjs

# SQLite database lives on the /data volume — mount it or lose it.
# Rebrand note (Cairn → Heartwood): these CAIRN_* env vars and the /data paths
# are the real operational values for every existing install and must NOT be
# renamed in place (that would orphan users' databases on upgrade). The app also
# accepts HEARTWOOD_DB / HEARTWOOD_LOG_FILE as aliases (they take precedence
# when set, falling back to CAIRN_*) — see src/lib/server/db.ts and logger.ts.
ENV CAIRN_DB=/data/cairn.db
# Keep the rotating log on the same volume (the in-container default would be
# /app/data/logs, i.e. the ephemeral writable layer — history lost on recreate).
ENV CAIRN_LOG_FILE=/data/logs/cairn.log
ENV PORT=3000
# Self-signed HTTPS listener (secure context for WebHID/Web Serial hardware
# signing + camera QR scanning on plain-HTTP hosts like Umbrel). The cert is
# generated at first boot into /data/tls. Publish the port to enable it;
# an unpublished port is harmless. Set CAIRN_HTTPS_PORT="" to disable.
ENV CAIRN_HTTPS_PORT=3443
# Wave 5 item 6 (log-request.md §1-C / §6): adapter-node's own default here is
# a silent 512K, which 400s any request over that size WITHOUT going through
# handle()/handleError — invisible in application logs (only Wave 1's
# server.mjs access log ever sees it). A large multisig PSBT legitimately
# exceeds 512K: a measured worst case — 20 inputs, 15-of-15 P2SH (legacy, so
# no witness discount), each carrying a full nonWitnessUtxo (P2SH inputs
# REQUIRE the whole previous transaction, not just its output) — serializes to
# ~85KB base64'd inside its JSON request body (measured via a throwaway
# script built on this repo's own @scure/btc-signer + multisigPsbt.ts sizing
# constants; see the Wave 5 commit message for the exact figure). 200K is
# ~2.3x that measured worst case: enough headroom for a legitimate large
# multisig send/import without opening the limit up so wide it stops being a
# meaningful DoS guard. Rollback: remove this line to restore adapter-node's
# 512K default.
ENV BODY_SIZE_LIMIT=200K
# NOTE: deliberately no ADDRESS_HEADER default. adapter-node THROWS on any
# getClientAddress() call when the configured header is absent, which breaks
# login for direct (unproxied) deployments. Deployments that sit behind a
# reverse proxy which sets X-Forwarded-For (e.g. Umbrel's app_proxy) should
# set ADDRESS_HEADER=x-forwarded-for themselves.
# NOTE (cairn-wrph, cairn-9njl): direct/unproxied deployments (no ORIGIN set)
# now get correct per-listener protocol resolution by default — server.mjs
# sets PROTOCOL_HEADER=x-forwarded-proto and fills that header per listener
# (scripts/serverProto.mjs) whenever a request arrives without one, so plain
# HTTP logins keep a non-Secure session cookie instead of getting one the
# browser silently drops. A TLS-terminating reverse proxy sitting in front of
# the HTTP port MUST set X-Forwarded-Proto itself (this fill is
# fill-when-absent — it never overwrites an inbound value), or set
# ORIGIN/CAIRN_ORIGIN to your externally-visible https URL instead.
ENV NODE_ENV=production

RUN mkdir -p /data && chown cairn:cairn /data
VOLUME /data
USER cairn

EXPOSE 3000 3443

# Alpine images ship no curl/wget; probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
