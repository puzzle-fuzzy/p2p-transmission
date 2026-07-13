FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY package.json bun.lock turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd services/api build

FROM oven/bun:1.3.14

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build --chown=bun:bun /app/services/api/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["bun", "dist/index.js"]
