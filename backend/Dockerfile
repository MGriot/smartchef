FROM node:20-alpine AS builder
WORKDIR /app
# Copy shared into backend folder for tsc rootDir compliance
COPY shared ./backend/shared
COPY backend ./backend
WORKDIR /app/backend
RUN npm install
RUN ./node_modules/.bin/tsc -p tsconfig.docker.json

FROM node:20-alpine
WORKDIR /app
COPY shared ./shared
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm install --omit=dev
COPY --from=builder /app/backend/dist ./dist
# The migration runner reads these at runtime (scripts/migrate.ts). Postgres
# gets its own copy via the compose bind mount, but that one only ever runs
# against an empty data directory — this copy is what lets an EXISTING
# database be brought up to date from inside the container.
COPY db/migrations ./db/migrations

EXPOSE 3000
CMD ["node", "dist/src/index.js"]
