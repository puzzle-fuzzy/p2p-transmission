FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY package.json bun.lock turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_API_URL=https://p2p.yxswy.com
ARG VITE_TURN_MODE=api
ARG VITE_STUN_URLS=
ARG VITE_APP_VERSION=
RUN VITE_API_URL="$VITE_API_URL" VITE_TURN_MODE="$VITE_TURN_MODE" VITE_STUN_URLS="$VITE_STUN_URLS" VITE_APP_VERSION="$VITE_APP_VERSION" bun run --cwd apps/web build

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
