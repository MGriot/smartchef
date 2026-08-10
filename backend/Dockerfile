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

EXPOSE 3000
CMD ["node", "dist/src/index.js"]
