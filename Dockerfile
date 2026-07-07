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

# SQLite database lives on the /data volume — mount it or lose it.
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
# NOTE: deliberately no ADDRESS_HEADER default. adapter-node THROWS on any
# getClientAddress() call when the configured header is absent, which breaks
# login for direct (unproxied) deployments. Deployments that sit behind a
# reverse proxy which sets X-Forwarded-For (e.g. Umbrel's app_proxy) should
# set ADDRESS_HEADER=x-forwarded-for themselves.
ENV NODE_ENV=production

RUN mkdir -p /data && chown cairn:cairn /data
VOLUME /data
USER cairn

EXPOSE 3000 3443

# Alpine images ship no curl/wget; probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
