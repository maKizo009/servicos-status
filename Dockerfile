FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/

RUN groupadd --system appgroup && useradd --system --no-create-home -g appgroup appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok?0:1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
