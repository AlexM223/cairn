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

RUN addgroup -S cairn && adduser -S cairn -G cairn

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# SQLite database lives on the /data volume — mount it or lose it.
ENV CAIRN_DB=/data/cairn.db
ENV PORT=3000
# adapter-node: take the client IP from X-Forwarded-For. Only safe when the
# container sits behind a reverse proxy that sets/overwrites this header.
ENV ADDRESS_HEADER=x-forwarded-for
ENV NODE_ENV=production

RUN mkdir -p /data && chown cairn:cairn /data
VOLUME /data
USER cairn

EXPOSE 3000

# Alpine images ship no curl/wget; probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build"]
