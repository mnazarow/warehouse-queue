# Warehouse Queue — application image
# Node 20 (better-sqlite3@11 requires a modern Node) on Debian so we can install
# the postgresql-client (the PG backend shells out to `psql`) and build the
# better-sqlite3 native module.
FROM node:20-bookworm-slim AS base

# Runtime + build dependencies. python3/make/g++ are needed to compile
# better-sqlite3; postgresql-client provides `psql` for the PostgreSQL backend;
# wget is used by the container HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ postgresql-client wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching. Native modules are
# compiled here for THIS platform (do not copy host node_modules in).
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# App source
COPY . .

# Persisted SQLite data lives on a volume mounted at /app/data.
RUN useradd -m -u 10001 appuser \
 && mkdir -p /app/data \
 && chown -R appuser:appuser /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/warehouse.db

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/warehouses" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
